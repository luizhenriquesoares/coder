import { createHmac } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig, Inbox, PullRequestDetail } from "../src/application/api.js";
import { silentLogger } from "../src/application/ports.js";
import { loadConfig } from "../src/composition/config.js";
import { createServerApplication } from "../src/composition/server.js";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import type { PublicationPlan } from "../src/domain/deliberation/publicationPlanner.js";
import type { SessionState } from "../src/domain/deliberation/state.js";
import { buildHttpServer } from "../src/infrastructure/http/server.js";
import { HttpCoderApi } from "../web/src/api/HttpCoderApi.js";
import { followUntilConcluded as follow } from "./support/follow.js";
import { startFakeAnthropic, type FakeAnthropic, type RecordedRequest, type Reply } from "./support/fakeAnthropic.js";
import { startFakeGitHub, type FakeGitHub, type FakePullRequest } from "./support/fakeGitHub.js";

/**
 * Live mode, end to end: the real composition root and HTTP server, the real
 * Anthropic SDK and Octokit, talking to local stand-ins for the two APIs.
 */

const API_TOKEN = "local-test-token-0123456789";
const WEBHOOK_SECRET = "webhook-s3cret";
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
    files: [{ path: "src/limiter.ts", status: "added", head: LIMITER }],
  };
}

function councilReply(request: RecordedRequest): Reply {
  switch (request.round) {
    case "opening":
      return {
        json: {
          statement: `Opening from ${request.seat}.`,
          findings:
            request.seat === "Staff Engineer"
              ? [
                  {
                    severity: "major",
                    category: "correctness",
                    title: "Counters never reset",
                    rationale: "After 100 requests an IP is blocked forever and the map grows without bound.",
                    recommendation: "Count per time window and evict old entries.",
                    principle: "",
                    path: "src/limiter.ts",
                    line: 1,
                    quote: "const hits = new Map<string, number>();",
                  },
                ]
              : [],
        },
      };
    case "debate":
      return { json: { statement: "Agreed.", positions: request.seat === "Staff Engineer" ? [] : [{ findingId: "F-1", stance: "agree", argument: "Confirmed." }] } };
    case "implementation":
      return {
        json: {
          statement: "Windowed the counter.",
          patches: [
            {
              findingIds: ["F-1"],
              path: "src/limiter.ts",
              original: "  const count = (hits.get(req.ip) ?? 0) + 1;\n  hits.set(req.ip, count);",
              replacement: "  const count = window.hit(req.ip);",
              explanation: "Counts per minute.",
            },
          ],
          declined: [],
        },
      };
    case "verdict":
      return { json: { statement: "Fix before merging.", decision: "request_changes", mergeRisk: "medium", summary: "One major defect, patched.", humanAttention: [] } };
  }
}

interface Running {
  readonly server: FastifyInstance;
  readonly url: string;
  readonly github: FakeGitHub;
  readonly anthropic: FakeAnthropic;
  readonly dataDir: string;
  readonly pr: FakePullRequest;
}

let running: Running | undefined;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  running = undefined;
});

async function boot(dataDir: string, github: FakeGitHub, anthropic: FakeAnthropic): Promise<{ server: FastifyInstance; url: string }> {
  const config = loadConfig({
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_BASE_URL: anthropic.baseURL,
    GITHUB_TOKEN: "ghp_test",
    GITHUB_API_URL: github.baseUrl,
    GITHUB_REPOSITORIES: "acme/shop",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CODER_API_TOKEN: API_TOKEN,
    CODER_DATA_DIR: dataDir,
    CODER_DEMO: "false",
    CODER_LANGUAGE: "pt",
  });
  const { application, autoReview, conductReview } = await createServerApplication(config, silentLogger);
  const server = await buildHttpServer({ api: application, autoReview, logger: silentLogger, apiToken: config.apiToken!, webhookSecret: config.github.webhookSecret! });
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(async () => {
    await conductReview.whenSettled();
    await server.close();
  });
  return { server, url };
}

async function start(): Promise<Running> {
  const pr = pullRequest();
  const github = await startFakeGitHub("acme", "shop", [pr]);
  const anthropic = await startFakeAnthropic(councilReply);
  const dataDir = await mkdtemp(join(tmpdir(), "coder-live-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }), github.close, anthropic.close);
  running = { ...(await boot(dataDir, github, anthropic)), github, anthropic, dataDir, pr };
  return running;
}

async function call<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<{ status: number; body: T }> {
  const { token = API_TOKEN, ...rest } = init;
  const response = await fetch(`${running!.url}${path}`, {
    ...rest,
    headers: { ...(rest.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...rest.headers },
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** Follows the session through the workspace's own HTTP client until the council concludes. */
function followUntilConcluded(sessionId: string, afterSeq = 0): Promise<DomainEvent[]> {
  return follow(new HttpCoderApi(running!.url, () => API_TOKEN), sessionId, afterSeq);
}

const PULL = "/api/pulls/github/acme/shop/7";

describe("live mode over HTTP", () => {
  it("requires the API token when one is configured", async () => {
    await start();
    expect((await call("/api/pulls", { token: null })).status).toBe(401);
    expect((await call("/api/pulls", { token: "wrong-token-000000000000000" })).status).toBe(401);
    expect((await call("/api/health", { token: null })).status).toBe(200); // liveness, outside the guard
    expect((await call("/api/config")).status).toBe(200);
  });

  it("reviews a GitHub pull request with the Claude council and publishes the review", async () => {
    const { github, anthropic } = await start();

    const config = (await call<AppConfig>("/api/config")).body;
    expect(config).toMatchObject({
      mode: "server",
      engines: [
        { engine: "claude", available: true, model: "claude-opus-5-5" },
        { engine: "scripted", available: false },
      ],
      github: { configured: true, canPublish: true, repositories: ["acme/shop"] },
    });

    const inbox = (await call<Inbox>("/api/pulls")).body;
    expect(inbox.errors).toEqual([]);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ pullRequest: { title: "Add rate limiter", headSha: "head-1" }, latestSession: null, stale: false });

    const detail = (await call<PullRequestDetail>(PULL)).body;
    expect(detail).toMatchObject({ stats: { files: 1, additions: 8, deletions: 0 }, engines: ["claude"] });
    expect(detail.files[0]).toMatchObject({ path: "src/limiter.ts", status: "added", language: "typescript" });
    const file = (await call<{ original: string; modified: string }>(`${PULL}/file?path=${encodeURIComponent("src/limiter.ts")}`)).body;
    expect(file).toMatchObject({ original: "", modified: LIMITER });

    // Convene the council and follow it live.
    const started = await call<{ sessionId: string }>(`${PULL}/reviews`, { method: "POST", body: JSON.stringify({ language: "pt" }) });
    expect(started.status).toBe(200);
    const { sessionId } = started.body;
    const events = await followUntilConcluded(sessionId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]!.type).toBe("ReviewSessionConvened");
    expect(events.at(-1)!.type).toBe("ReviewSessionConcluded");
    for (const type of ["RoundStarted", "ReviewerStartedThinking", "StatementMade", "FindingRaised", "PositionTaken", "ConsensusComputed", "PatchProposed", "VerdictIssued"]) {
      expect(events.map((event) => event.type), type).toContain(type);
    }
    expect(anthropic.requests).toHaveLength(10);
    expect(anthropic.requests[0]!.body.system[0].text).toContain("   1| const hits = new Map<string, number>();".trimStart());

    const state = (await call<SessionState>(`/api/sessions/${sessionId}`)).body;
    expect(state).toMatchObject({ status: "concluded", engine: "claude", language: "pt", verdict: { decision: "request_changes", mergeRisk: "medium" } });
    expect(state.consensus["F-1"]).toMatchObject({ level: "endorsed" });
    expect(state.patches[0]).toMatchObject({ applicable: true, startLine: 4, endLine: 5 });

    // A resumed stream replays only what the client has not seen.
    const tail = await followUntilConcluded(sessionId, events.length - 2);
    expect(tail.map((event) => event.seq)).toEqual([events.length - 1, events.length]);

    // The human accepts the patch, previews and publishes.
    const decided = await call<SessionState>(`/api/sessions/${sessionId}/decisions`, { method: "POST", body: JSON.stringify({ target: { kind: "patch", id: "P-1" }, action: "accept" }) });
    expect(decided.body.decisions["patch:P-1"]).toMatchObject({ action: "accept" });

    const plan = (await call<PublicationPlan>(`/api/sessions/${sessionId}/publication`)).body;
    expect(plan).toMatchObject({ decision: "request_changes", councilDecision: "request_changes", summaryFindings: 0 });
    expect(plan.comments).toHaveLength(2);

    const published = await call<SessionState>(`/api/sessions/${sessionId}/publish`, { method: "POST" });
    expect(published.status).toBe(200);
    expect(published.body.publication).toMatchObject({ simulated: false, decision: "request_changes", inlineComments: 2, url: expect.stringContaining("pullrequestreview") });

    expect(github.reviewAttempts).toHaveLength(1);
    const review = github.reviewAttempts[0]!;
    expect(review).toMatchObject({ commit_id: "head-1", event: "REQUEST_CHANGES" });
    expect(review.body).toContain("CodeR Council — Pedir mudanças");
    expect(review.comments.find((comment) => comment.line === 1)!.body).toContain("F-1 · Counters never reset");
    const suggestion = review.comments.find((comment) => comment.start_line === 4)!;
    expect(suggestion).toMatchObject({ path: "src/limiter.ts", line: 5, side: "RIGHT", start_side: "RIGHT" });
    expect(suggestion.body).toContain("```suggestion\n  const count = window.hit(req.ip);\n```");

    // Publishing is once-only, and closes the decisions.
    expect((await call(`/api/sessions/${sessionId}/publish`, { method: "POST" })).status).toBe(409);
    expect(github.reviewAttempts).toHaveLength(1);
    const late = await call(`/api/sessions/${sessionId}/decisions`, { method: "POST", body: JSON.stringify({ target: { kind: "finding", id: "F-1" }, action: "dismiss" }) });
    expect(late.status).toBe(409); // closed decisions conflict with the session's state

    // The inbox now knows this pull request was reviewed.
    const after = (await call<Inbox>("/api/pulls")).body;
    expect(after.items[0]!.latestSession).toMatchObject({ sessionId, status: "concluded", decision: "request_changes", findings: 1, endorsedFindings: 1, patches: 1, published: true });
  });

  it("refuses to publish a review of an outdated commit and flags it as stale", async () => {
    const { pr, github } = await start();
    const { sessionId } = (await call<{ sessionId: string }>(`${PULL}/reviews`, { method: "POST", body: "{}" })).body;
    await followUntilConcluded(sessionId);

    pr.headSha = "head-2"; // the author pushes a new commit
    const published = await call<{ error: { code: string; message: string } }>(`/api/sessions/${sessionId}/publish`, { method: "POST" });
    expect(published.status).toBe(409);
    expect(published.body.error.message).toMatch(/new commits/);
    expect(github.reviewAttempts).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const inbox = (await call<Inbox>("/api/pulls")).body;
    expect(inbox.items[0]).toMatchObject({ stale: true, pullRequest: { headSha: "head-2" }, latestSession: { headSha: "head-1" } });
  });

  it("convenes the council from a signed GitHub webhook, once per commit", async () => {
    const { anthropic } = await start();
    const payload = JSON.stringify({
      action: "opened",
      repository: { name: "shop", owner: { login: "acme" } },
      pull_request: {
        number: 7,
        title: "Add rate limiter",
        html_url: "https://github.com/acme/shop/pull/7",
        draft: false,
        state: "open",
        updated_at: "2026-11-21T12:00:00Z",
        user: { login: "dev-ana" },
        base: { ref: "main" },
        head: { ref: "feature/7", sha: "head-1" },
      },
    });
    const sign = (body: string, secret = WEBHOOK_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const deliver = (body: string, signature: string, event = "pull_request") =>
      call<{ sessionId?: string | null; ignored?: string }>("/api/webhooks/github", {
        method: "POST",
        token: null, // GitHub does not send our API token: the signature is the credential
        body,
        headers: { "x-hub-signature-256": signature, "x-github-event": event },
      });

    expect((await deliver(payload, sign(payload, "wrong-secret"))).status).toBe(401);
    expect((await deliver(payload, "")).status).toBe(401);
    expect(anthropic.requests).toHaveLength(0);

    expect((await deliver(payload, sign(payload), "push")).body).toEqual({ ignored: "not a pull_request event" });
    const closed = payload.replace('"opened"', '"closed"');
    expect((await deliver(closed, sign(closed))).body).toEqual({ ignored: "not a reviewable action" });

    const accepted = await deliver(payload, sign(payload));
    expect(accepted.status).toBe(202);
    const sessionId = accepted.body.sessionId!;
    expect(sessionId).toBeTruthy();
    await followUntilConcluded(sessionId);
    const state = (await call<SessionState>(`/api/sessions/${sessionId}`)).body;
    expect(state).toMatchObject({ status: "concluded", trigger: "webhook", language: "pt" });

    // GitHub redelivers: the same commit is not reviewed (and paid for) twice.
    expect((await deliver(payload, sign(payload))).body).toEqual({ sessionId: null });
    expect(anthropic.requests).toHaveLength(10);
  });

  it("keeps review sessions across a restart", async () => {
    const { dataDir, github, anthropic } = await start();
    const { sessionId } = (await call<{ sessionId: string }>(`${PULL}/reviews`, { method: "POST", body: "{}" })).body;
    const events = await followUntilConcluded(sessionId);
    expect(await readdir(join(dataDir, "sessions"))).toEqual([`${sessionId}.jsonl`]);

    const restarted = await boot(dataDir, github, anthropic);
    running = { ...running!, ...restarted };
    const state = (await call<SessionState>(`/api/sessions/${sessionId}`)).body;
    expect(state).toMatchObject({ status: "concluded", lastSeq: events.length, verdict: { decision: "request_changes" } });
    expect((await call<Inbox>("/api/pulls")).body.items[0]!.latestSession).toMatchObject({ sessionId });
    // The restored session is still a live aggregate: it can be decided on and published.
    expect((await call(`/api/sessions/${sessionId}/publish`, { method: "POST" })).status).toBe(200);
  });

  it("imports a pull request from its URL and rejects what is not one", async () => {
    await start();
    const imported = await call("/api/pulls/import", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/shop/pull/7/files" }) });
    expect(imported).toEqual({ status: 200, body: { provider: "github", owner: "acme", repo: "shop", number: 7 } });
    expect((await call("/api/pulls/import", { method: "POST", body: JSON.stringify({ url: "https://example.com/x" }) })).status).toBe(400);
    const missing = await call<{ error: { code: string } }>("/api/pulls/import", { method: "POST", body: JSON.stringify({ url: "acme/shop#99" }) });
    expect(missing).toMatchObject({ status: 502, body: { error: { code: "upstream_failure" } } });
    expect((await call("/api/sessions/unknown")).status).toBe(404);
    expect((await call(`${PULL}/reviews`, { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await call(`${PULL}/reviews`, { method: "POST", body: JSON.stringify({ engine: "scripted" }) })).status).toBe(200); // falls back to an engine that can review it
  });
});
