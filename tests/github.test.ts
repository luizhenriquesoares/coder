import { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import type { PullRequestRef } from "../src/domain/change/types.js";
import type { PublicationPlan } from "../src/domain/deliberation/publicationPlanner.js";
import { GitHubError, GitHubSourceControl } from "../src/infrastructure/github/GitHubSourceControl.js";
import { startFakeGitHub, type FakeGitHub, type FakePullRequest } from "./support/fakeGitHub.js";

const ref: PullRequestRef = { provider: "github", owner: "acme", repo: "shop", number: 7 };

const SERVER_BASE = `import express from "express";

const app = express();
app.get("/health", (_req, res) => res.send("ok"));
app.listen(3000);
`;
const SERVER_HEAD = `import express from "express";
import { limiter } from "./limiter";

const app = express();
app.use(limiter);
app.get("/health", (_req, res) => res.send("ok"));
app.listen(3000);
`;
const LIMITER = `const hits = new Map<string, number>();

export function limiter(req, res, next) {
  const count = (hits.get(req.ip) ?? 0) + 1;
  hits.set(req.ip, count);
  if (count > 100) return res.status(429).end();
  next();
}
`;

function pullRequest(): FakePullRequest {
  return {
    number: 7,
    title: "Add rate limiter",
    body: "Limits each IP to 100 requests.",
    author: "dev-ana",
    headSha: "head-1",
    baseTipSha: "base-tip",
    mergeBaseSha: "merge-base",
    files: [
      { path: "src/server.ts", status: "modified", base: SERVER_BASE, head: SERVER_HEAD },
      { path: "src/limiter.ts", status: "added", head: LIMITER },
      { path: "src/util/clock.ts", previousPath: "src/clock.ts", status: "renamed", base: "export const now = () => Date.now();\n", head: "export const now = (): number => Date.now();\n" },
      { path: "assets/logo.png", status: "added" },
      { path: "docs/old.md", status: "removed", base: "# Old\n" },
    ],
  };
}

let github: FakeGitHub | undefined;
afterEach(async () => {
  await github?.close();
  github = undefined;
});

async function connect(options: { token?: string } = { token: "ghp_test" }) {
  github = await startFakeGitHub("acme", "shop", [pullRequest()]);
  const octokit = new Octokit({
    baseUrl: github.baseUrl,
    ...(options.token ? { auth: options.token } : {}),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const source = new GitHubSourceControl({ octokit, repositories: [{ owner: "acme", repo: "shop" }], authenticated: Boolean(options.token) });
  return { source, github };
}

describe("GitHub adapter against the REST API", () => {
  it("lists the open pull requests of the configured repositories", async () => {
    const { source } = await connect();
    expect(await source.listOpenPullRequests()).toEqual([
      {
        ref,
        title: "Add rate limiter",
        author: { login: "dev-ana", avatarUrl: expect.stringContaining("/avatars/dev-ana") },
        url: "https://github.com/acme/shop/pull/7",
        baseBranch: "main",
        headBranch: "feature/7",
        headSha: "head-1",
        updatedAt: "2026-11-21T12:00:00Z",
        draft: false,
        state: "open",
      },
    ]);
  });

  it("lists every page of open pull requests, and reads one summary with one request", async () => {
    github = await startFakeGitHub("acme", "shop", [7, 8, 9, 10, 11].map((number) => ({ ...pullRequest(), number, state: number === 10 ? "merged" : "open" })));
    const octokit = new Octokit({ baseUrl: github.baseUrl, auth: "ghp_test", log: { debug() {}, info() {}, warn() {}, error() {} } });
    const source = new GitHubSourceControl({ octokit, repositories: [{ owner: "acme", repo: "shop" }], authenticated: true });

    expect((await source.listOpenPullRequests()).map((summary) => summary.ref.number)).toEqual([7, 8, 9, 11]);
    expect(github.calls.filter((call) => call.path === "/repos/acme/shop/pulls")).toHaveLength(2);
    expect(github.calls[0]!.query).toMatchObject({ per_page: "100", state: "open" });

    github.calls.length = 0;
    expect(await source.getSummary({ ...ref, number: 10 })).toMatchObject({ ref: { number: 10 }, state: "merged", headSha: "head-1" });
    expect(github.calls.map((call) => call.path)).toEqual(["/repos/acme/shop/pulls/10"]);
    expect(source.refreshIntervalMs).toBe(60_000);
  });

  it("reads a snapshot: every page of files, and the merge base rather than the base tip", async () => {
    const { source, github } = await connect();
    const snapshot = await source.getSnapshot(ref);

    expect(snapshot).toMatchObject({ title: "Add rate limiter", description: "Limits each IP to 100 requests.", baseSha: "merge-base", headSha: "head-1" });
    expect(snapshot.files.map((f) => [f.path, f.status])).toEqual([
      ["src/server.ts", "modified"],
      ["src/limiter.ts", "added"],
      ["src/util/clock.ts", "renamed"],
      ["assets/logo.png", "added"],
      ["docs/old.md", "removed"],
    ]);
    expect(snapshot.files[2]!.previousPath).toBe("src/clock.ts");
    expect(github.calls.filter((call) => call.path.endsWith("/files"))).toHaveLength(3); // 5 files, 2 per page
    expect(github.calls.every((call) => call.authorization === "token ghp_test")).toBe(true);

    const changeSet = ChangeSet.fromSnapshot(snapshot);
    expect(changeSet.stats).toEqual({ files: 5, additions: 11, deletions: 2 });
    expect(changeSet.file("assets/logo.png")!.binary).toBe(true);
    expect(changeSet.isCommentable("src/server.ts", 5)).toBe(true); // app.use(limiter)
    expect(changeSet.isCommentable("src/limiter.ts", 6)).toBe(true);
    expect(changeSet.isCommentable("docs/old.md", 1)).toBe(false); // nothing on the new side
  });

  it("falls back to the base tip only when GitHub cannot compare the commits", async () => {
    const { source, github } = await connect();
    github.failPath = { prefix: "/compare/", status: 404 };
    expect((await source.getSnapshot(ref)).baseSha).toBe("base-tip");
    github.failPath = { prefix: "/compare/", status: 500 };
    await expect(source.getSnapshot(ref)).rejects.toThrow(/GitHub could not read acme\/shop#7/);
  });

  it("reads both sides of a file at the right commits", async () => {
    const { source, github } = await connect();
    const snapshot = await source.getSnapshot(ref);
    github.calls.length = 0;

    expect(await source.getFileContents(snapshot, "src/server.ts")).toEqual({ path: "src/server.ts", original: SERVER_BASE, modified: SERVER_HEAD });
    expect(github.calls.map((call) => [call.path, call.query.ref]).sort()).toEqual([
      ["/repos/acme/shop/contents/src/server.ts", "head-1"],
      ["/repos/acme/shop/contents/src/server.ts", "merge-base"],
    ]);
    expect(github.calls.every((call) => call.accept.includes("raw"))).toBe(true);

    // Added: nothing to fetch on the base side. Removed: nothing on the head side.
    expect(await source.getFileContents(snapshot, "src/limiter.ts")).toEqual({ path: "src/limiter.ts", original: "", modified: LIMITER });
    expect(await source.getFileContents(snapshot, "docs/old.md")).toEqual({ path: "docs/old.md", original: "# Old\n", modified: "" });
    // Renamed: the base side lives at the previous path.
    expect(await source.getFileContents(snapshot, "src/util/clock.ts")).toMatchObject({
      original: "export const now = () => Date.now();\n",
      modified: "export const now = (): number => Date.now();\n",
    });

    // Binary files are never downloaded.
    github.calls.length = 0;
    expect(await source.getFileContents(snapshot, "assets/logo.png")).toEqual({ path: "assets/logo.png", original: "", modified: "" });
    expect(github.calls).toHaveLength(0);

    await expect(source.getFileContents(snapshot, "nope.ts")).rejects.toThrow(GitHubError);
  });

  const plan: PublicationPlan = {
    decision: "request_changes",
    councilDecision: "request_changes",
    body: "## Council verdict",
    summaryFindings: 0,
    comments: [
      { path: "src/limiter.ts", line: 6, body: "Never expires" },
      { path: "src/limiter.ts", line: 5, startLine: 4, body: "Patch\n\n```suggestion\n  const count = 1;\n```" },
    ],
  };

  it("publishes the review on the reviewed commit with inline and multi-line comments", async () => {
    const { source, github } = await connect();
    const snapshot = await source.getSnapshot(ref);
    const published = await source.publishReview(snapshot, plan);

    expect(published).toEqual({
      url: "https://github.com/acme/shop/pull/7#pullrequestreview-901",
      decision: "request_changes",
      inlineComments: 2,
      simulated: false,
    });
    expect(github.reviewAttempts).toEqual([
      {
        commit_id: "head-1",
        event: "REQUEST_CHANGES",
        body: "## Council verdict",
        comments: [
          { path: "src/limiter.ts", line: 6, side: "RIGHT", body: "Never expires" },
          { path: "src/limiter.ts", line: 5, side: "RIGHT", start_line: 4, start_side: "RIGHT", body: plan.comments[1]!.body },
        ],
      },
    ]);
  });

  it("falls back to a plain comment when GitHub refuses the verdict (your own pull request)", async () => {
    const { source, github } = await connect();
    github.rejectReview = (review) => (review.event === "COMMENT" ? null : 422);
    const published = await source.publishReview(await source.getSnapshot(ref), plan);

    expect(published).toMatchObject({ decision: "comment", inlineComments: 2 });
    expect(github.reviewAttempts.map((attempt) => attempt.event)).toEqual(["REQUEST_CHANGES", "COMMENT"]);
    expect(github.reviewAttempts[1]!.body).toBe(plan.body); // its headline already states the verdict, in the session language
  });

  it("keeps every comment in the body when GitHub refuses the inline comments too", async () => {
    const { source, github } = await connect();
    github.rejectReview = (review) => (review.comments.length > 0 ? 422 : null);
    const published = await source.publishReview(await source.getSnapshot(ref), plan);

    expect(published).toMatchObject({ decision: "comment", inlineComments: 0 });
    const body = github.reviewAttempts.at(-1)!.body;
    expect(body).toContain("`src/limiter.ts:6`");
    expect(body).toContain("Never expires");
    expect(body).toContain("`src/limiter.ts:4-5`");
    expect(body).toContain("```suggestion");
  });

  it("reports a refused review instead of pretending it was published", async () => {
    const { source, github } = await connect();
    github.rejectReview = () => 422;
    await expect(source.publishReview(await source.getSnapshot(ref), plan)).rejects.toThrow(/could not publish the review/);
    expect(github.reviewAttempts).toHaveLength(3);
  });

  it("refuses to publish without a token and reads public repositories without one", async () => {
    const { source, github } = await connect({});
    const snapshot = await source.getSnapshot(ref);
    expect(github.calls.every((call) => call.authorization === undefined)).toBe(true);
    await expect(source.publishReview(snapshot, plan)).rejects.toThrow(/GITHUB_TOKEN/);
    expect(github.reviewAttempts).toHaveLength(0);
  });

  it("turns API failures into messages a person can act on", async () => {
    const { source, github } = await connect();
    github.failNext = { status: 401, message: "Bad credentials" };
    await expect(source.listOpenPullRequests()).rejects.toThrow("GitHub rejected the token. Check GITHUB_TOKEN.");
    github.failNext = { status: 403, message: "API rate limit exceeded for 203.0.113.9." };
    await expect(source.listOpenPullRequests()).rejects.toThrow(/rate limit/);
    github.failNext = { status: 403, message: "Resource not accessible by personal access token" };
    await expect(source.listOpenPullRequests()).rejects.toThrow(/may lack permission/);
    github.failNext = { status: 500, message: "Server Error" };
    await expect(source.listOpenPullRequests()).rejects.toThrow(/could not list pull requests of acme\/shop/);
  });

  it("says so when a pull request does not exist or is not visible", async () => {
    const { source } = await connect();
    await expect(source.getSnapshot({ ...ref, number: 99 })).rejects.toThrow(/not found, or the token cannot see it/);
  });
});
