import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { unifiedDiff } from "../../src/infrastructure/demo/lineDiff.js";

export interface FakeFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  /** Content at the merge base and at the head. Omit both for a binary file. */
  readonly base?: string;
  readonly head?: string;
}

export interface FakePullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly author: string;
  readonly draft?: boolean;
  /** Defaults to open. Only open pull requests are listed. */
  state?: "open" | "closed" | "merged";
  updatedAt?: string;
  headSha: string;
  readonly baseTipSha: string;
  readonly mergeBaseSha: string;
  readonly files: readonly FakeFile[];
}

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly accept: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeGitHub {
  readonly baseUrl: string;
  readonly calls: RecordedCall[];
  /** Every review GitHub was asked to create, accepted or not. */
  readonly reviewAttempts: ReviewBody[];
  /** Decide how to answer a review: return an HTTP status to reject it. */
  rejectReview: (review: ReviewBody) => number | null;
  /** Fail the next request with this status (once). */
  failNext: { status: number; message: string } | null;
  close(): Promise<void>;
}

export interface ReviewBody {
  readonly commit_id: string;
  readonly event: string;
  readonly body: string;
  readonly comments: { path: string; line: number; side: string; start_line?: number; start_side?: string; body: string }[];
}

const PAGE_SIZE = 2; // small on purpose: listing files and pull requests must follow pagination

/** A local stand-in for the parts of GitHub's REST API the adapter uses, for one repository. */
export async function startFakeGitHub(owner: string, repo: string, pullRequests: FakePullRequest[]): Promise<FakeGitHub> {
  const calls: RecordedCall[] = [];
  const reviewAttempts: ReviewBody[] = [];
  const root = `/repos/${owner}/${repo}`;

  const describe = (pr: FakePullRequest, baseUrl: string) => ({
    number: pr.number,
    title: pr.title,
    body: pr.body,
    html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
    state: pr.state === "merged" ? "closed" : (pr.state ?? "open"),
    draft: pr.draft ?? false,
    merged_at: pr.state === "merged" ? (pr.updatedAt ?? "2026-11-21T12:00:00Z") : null,
    created_at: "2026-11-20T10:00:00Z",
    updated_at: pr.updatedAt ?? "2026-11-21T12:00:00Z",
    user: { login: pr.author, avatar_url: `${baseUrl}/avatars/${pr.author}` },
    base: { ref: "main", sha: pr.baseTipSha },
    head: { ref: `feature/${pr.number}`, sha: pr.headSha },
  });

  const describeFile = (file: FakeFile) => {
    const binary = file.base === undefined && file.head === undefined;
    const diff = binary ? null : unifiedDiff(file.base ?? "", file.head ?? "");
    return {
      filename: file.path,
      ...(file.previousPath ? { previous_filename: file.previousPath } : {}),
      status: file.status,
      additions: diff?.additions ?? 0,
      deletions: diff?.deletions ?? 0,
      changes: (diff?.additions ?? 0) + (diff?.deletions ?? 0),
      ...(diff && diff.patch ? { patch: diff.patch } : {}),
    };
  };

  const fake: FakeGitHub = {
    baseUrl: "",
    calls,
    reviewAttempts,
    rejectReview: () => null,
    failNext: null,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // do not wait for keep-alive sockets
      }),
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", fake.baseUrl);
      const path = decodeURIComponent(url.pathname);
      const query = Object.fromEntries(url.searchParams);
      const body: unknown = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? "", path, query, accept: String(req.headers.accept), authorization: req.headers.authorization, body });

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
        res.end(JSON.stringify(payload));
      };
      const notFound = () => json(404, { message: "Not Found" });

      if (fake.failNext) {
        const { status, message } = fake.failNext;
        fake.failNext = null;
        return json(status, { message });
      }
      if (!path.startsWith(root)) return notFound();
      const rest = path.slice(root.length);

      const page = (items: readonly unknown[], path: string) => {
        const number = Number(query.page ?? 1);
        const hasNext = number * PAGE_SIZE < items.length;
        const next = `${fake.baseUrl}${root}${path}?per_page=${query.per_page}&page=${number + 1}`;
        return json(200, items.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE), hasNext ? { link: `<${next}>; rel="next"` } : {});
      };
      if (req.method === "GET" && rest === "/pulls") {
        return page(pullRequests.filter((pr) => (pr.state ?? "open") === "open").map((pr) => describe(pr, fake.baseUrl)), "/pulls");
      }

      const pull = /^\/pulls\/(\d+)(\/files|\/reviews)?$/.exec(rest);
      if (pull) {
        const pr = pullRequests.find((candidate) => candidate.number === Number(pull[1]));
        if (!pr) return notFound();
        if (req.method === "GET" && !pull[2]) return json(200, describe(pr, fake.baseUrl));
        if (req.method === "GET" && pull[2] === "/files") return page(pr.files.map(describeFile), `/pulls/${pr.number}/files`);
        if (req.method === "POST" && pull[2] === "/reviews") {
          const review = body as ReviewBody;
          reviewAttempts.push(review);
          const rejected = fake.rejectReview(review);
          if (rejected) return json(rejected, { message: "Unprocessable Entity", errors: ["Review cannot be created like this"] });
          return json(200, { id: 900 + reviewAttempts.length, html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}#pullrequestreview-${900 + reviewAttempts.length}` });
        }
      }

      const compare = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
      if (req.method === "GET" && compare) {
        const pr = pullRequests.find((candidate) => candidate.baseTipSha === compare[1] && candidate.headSha === compare[2]);
        return pr ? json(200, { merge_base_commit: { sha: pr.mergeBaseSha }, commits: [], files: [] }) : notFound();
      }

      if (req.method === "GET" && rest.startsWith("/contents/")) {
        const filePath = rest.slice("/contents/".length);
        for (const pr of pullRequests) {
          const atHead = query.ref === pr.headSha;
          const atBase = query.ref === pr.mergeBaseSha;
          const file = pr.files.find((candidate) => (atHead ? candidate.path === filePath : (candidate.previousPath ?? candidate.path) === filePath));
          const content = file && (atHead ? file.head : atBase ? file.base : undefined);
          if (content !== undefined) {
            res.writeHead(200, { "content-type": "application/vnd.github.raw+json; charset=utf-8" });
            return res.end(content);
          }
          if (file && file.base === undefined && file.head === undefined && (atHead || atBase)) {
            res.writeHead(200, { "content-type": "application/vnd.github.raw+json; charset=utf-8" });
            return res.end("\u0089PNG\r\n\u0000\u0000binary");
          }
        }
        return notFound();
      }
      return notFound();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (fake as { baseUrl: string }).baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
