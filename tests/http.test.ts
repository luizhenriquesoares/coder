import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoderApi } from "../src/application/api.js";
import type { AutoReview } from "../src/application/AutoReview.js";
import { ApplicationError } from "../src/application/errors.js";
import { silentLogger } from "../src/application/ports.js";
import { createStandaloneApplication } from "../src/composition/standalone.js";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { instantPace } from "../src/infrastructure/demo/ScriptedCouncil.js";
import { buildHttpServer } from "../src/infrastructure/http/server.js";
import { foldEvents } from "../src/domain/deliberation/state.js";
import { ApiError, HttpCoderApi } from "../web/src/api/HttpCoderApi.js";
import { followUntilConcluded } from "./support/follow.js";

const noAutoReview = { consider: async () => null } as unknown as AutoReview;
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(api: CoderApi, options: { webRoot?: string } = {}): Promise<string> {
  const server = await buildHttpServer({ api, autoReview: noAutoReview, logger: silentLogger, ...options });
  servers.push(server);
  return server.listen({ port: 0, host: "127.0.0.1" });
}

const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe("HTTP event stream", () => {
  it("streams events as they happen and releases the subscription when the client leaves", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const { sessionId } = await application.startReview({ provider: "demo", owner: "acme", repo: "storefront", number: 131 }, { language: "en" });

    let listener: ((event: DomainEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const api: CoderApi = Object.assign(Object.create(application) as CoderApi, {
      subscribe: async (_id: string, _after: number, deliver: (event: DomainEvent) => void) => {
        listener = deliver;
        return unsubscribe;
      },
    });
    const url = await serve(api);

    const response = await fetch(`${url}/api/sessions/${sessionId}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-cache");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    await until(() => listener !== undefined);

    const event = { type: "RoundStarted", sessionId, seq: 7, at: "2026-11-27T10:00:00.000Z", payload: { round: "debate" } } as DomainEvent;
    listener!(event);
    let received = "";
    while (!received.includes("\n\nid: 7")) received += (await reader.read()).value;
    expect(received).toBe(`: connected\n\nid: 7\ndata: ${JSON.stringify(event)}\n\n`);

    expect(unsubscribe).not.toHaveBeenCalled();
    await reader.cancel();
    await until(() => unsubscribe.mock.calls.length === 1);
  });

  it("releases the subscription even when the client leaves while the replay is loading", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const { sessionId } = await application.startReview({ provider: "demo", owner: "acme", repo: "storefront", number: 131 }, { language: "en" });

    const unsubscribe = vi.fn();
    let subscribing = false;
    let finishSubscribing = () => {};
    const api: CoderApi = Object.assign(Object.create(application) as CoderApi, {
      subscribe: () => {
        subscribing = true;
        return new Promise((resolve) => (finishSubscribing = () => resolve(unsubscribe)));
      },
    });
    const url = await serve(api);

    const abort = new AbortController();
    const response = await fetch(`${url}/api/sessions/${sessionId}/events`, { signal: abort.signal });
    await until(() => subscribing);
    abort.abort(); // the tab closes before the subscription is ready
    await response.body!.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    finishSubscribing();
    await until(() => unsubscribe.mock.calls.length === 1);
  });

  it("answers 404 as JSON for a session that does not exist", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const url = await serve(application);
    const response = await fetch(`${url}/api/sessions/missing/events`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Review session missing not found" } });
  });
});

describe("HTTP static web app", () => {
  it("serves the built web app with a single-page fallback, but never for API routes", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "coder-web-"));
    try {
      await writeFile(join(webRoot, "index.html"), "<!doctype html><title>CodeR</title>");
      const { application } = createStandaloneApplication({ pace: instantPace });
      const url = await serve(application, { webRoot });

      expect(await (await fetch(`${url}/`)).text()).toContain("<title>CodeR</title>");
      expect(await (await fetch(`${url}/pulls/demo/acme/storefront/128`)).text()).toContain("<title>CodeR</title>");
      const missing = await fetch(`${url}/api/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("is an API-only server when the web app has not been built", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const url = await serve(application, { webRoot: join(tmpdir(), "coder-web-does-not-exist") });
    expect((await fetch(`${url}/`)).status).toBe(404);
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
  });
});

const STOREFRONT = { provider: "demo", owner: "acme", repo: "storefront", number: 131 } as const;

/** The two deliveries of the same application: in process, and over HTTP through the workspace's own client. */
const deliveries: [string, () => Promise<{ api: CoderApi; missing: object }>][] = [
  ["in process", async () => ({ api: createStandaloneApplication({ pace: instantPace }).application, missing: { code: "not_found" } })],
  [
    "over HTTP",
    async () => {
      const url = await serve(createStandaloneApplication({ pace: instantPace }).application);
      return { api: new HttpCoderApi(url, () => null), missing: { status: 404, code: "not_found" } };
    },
  ],
];

describe.each(deliveries)("CoderApi %s", (_name, deliver) => {
  it("lists, reviews, streams, decides and previews with the same answers", async () => {
    const { api, missing } = await deliver();
    const inbox = await api.inbox();
    expect(inbox.items.map((item) => item.pullRequest.ref)).toContainEqual(STOREFRONT);
    const detail = await api.pullRequest(STOREFRONT);
    expect(detail.files.length).toBeGreaterThan(0);

    const { sessionId } = await api.startReview(STOREFRONT, { language: "en" });
    const events = await followUntilConcluded(api, sessionId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)!.type).toBe("ReviewSessionConcluded");
    const state = await api.session(sessionId);
    expect(foldEvents(events)).toEqual(state);

    const finding = state.findings[0]!;
    const decided = await api.decide(sessionId, { target: { kind: "finding", id: finding.id }, action: "dismiss" });
    expect(decided.decisions[`finding:${finding.id}`]).toMatchObject({ action: "dismiss" });
    const plan = await api.publicationPreview(sessionId);
    expect(plan.body).not.toContain(finding.title);

    await expect(api.session("missing")).rejects.toMatchObject(missing);
  });
});

describe("HttpCoderApi event stream", () => {
  it("tells the caller when the server refuses the stream for good, instead of going quiet", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const { sessionId } = await application.startReview(STOREFRONT, { language: "en" });
    let reads = 0;
    const api: CoderApi = Object.assign(Object.create(application) as CoderApi, {
      session: (id: string) => (++reads === 1 ? application.session(id) : Promise.reject(new ApplicationError("not_found", "Review session is gone"))),
    });
    const client = new HttpCoderApi(await serve(api), () => null);

    const lost = vi.fn();
    const unsubscribe = await client.subscribe(sessionId, 0, () => {}, lost);
    await until(() => lost.mock.calls.length > 0);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0]![0]).toBeInstanceOf(ApiError);
    expect(lost.mock.calls[0]![0]).toMatchObject({ status: 404, code: "not_found" });
    unsubscribe();
  });
});

describe("HTTP API token", () => {
  const TOKEN = "local-test-token-0123456789";

  async function guardedServer(): Promise<{ server: FastifyInstance; sessionId: string }> {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const { sessionId } = await application.startReview(STOREFRONT, { language: "en" });
    const server = await buildHttpServer({ api: application, autoReview: noAutoReview, logger: silentLogger, apiToken: TOKEN, webhookSecret: "s3cret" });
    servers.push(server);
    return { server, sessionId };
  }

  it("guards the route that matched, however its URL is spelled", async () => {
    const { server, sessionId } = await guardedServer();
    const requests = [
      { method: "GET", url: "/api/config" },
      { method: "GET", url: "/%61pi/config" },
      { method: "GET", url: "/ap%69/pulls" },
      { method: "POST", url: "/%61pi/pulls/demo/acme/storefront/131/reviews" },
      { method: "POST", url: `/%61pi/sessions/${sessionId}/publish` },
      { method: "GET", url: `/api/sessions/${sessionId}/even%74s` },
    ] as const;
    for (const request of requests) {
      const response = await server.inject(request);
      expect(response.statusCode, request.url).toBe(401);
    }
    const authorized = await server.inject({ method: "GET", url: "/%61pi/config", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authorized.statusCode).toBe(200);
  });

  it("leaves the health check and the signed webhook reachable without the token", async () => {
    const { server } = await guardedServer();
    expect((await server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const webhook = await server.inject({ method: "POST", url: "/api/webhooks/github", payload: {}, headers: { "x-hub-signature-256": "sha256=wrong" } });
    expect(webhook.statusCode).toBe(401);
    expect(webhook.json()).toMatchObject({ error: { message: "Invalid webhook signature" } });
  });
});

describe("HTTP without an API token", () => {
  async function localServer(): Promise<FastifyInstance> {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const server = await buildHttpServer({ api: application, autoReview: noAutoReview, logger: silentLogger, webhookSecret: "s3cret" });
    servers.push(server);
    return server;
  }
  const reviews = "/api/pulls/demo/acme/storefront/131/reviews";

  it("refuses what a foreign web page sends, or a request that reached it under a foreign host name", async () => {
    const server = await localServer();
    const refused = [
      { method: "POST", url: reviews, headers: { origin: "https://evil.example" } },
      { method: "POST", url: reviews, headers: { origin: "null" } },
      { method: "POST", url: reviews, headers: { "sec-fetch-site": "cross-site" } },
      { method: "GET", url: "/api/pulls", headers: { host: "evil.example:4317" } },
      { method: "GET", url: "/%61pi/pulls", headers: { host: "evil.example:4317" } },
    ] as const;
    for (const request of refused) {
      const response = await server.inject(request);
      expect(response.statusCode, JSON.stringify(request.headers)).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "forbidden" } });
    }
  });

  it("answers the workspace on this machine and the webhook from anywhere", async () => {
    const server = await localServer();
    const sameOrigin = await server.inject({
      method: "POST",
      url: reviews,
      headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.statusCode).toBe(200);
    for (const host of ["localhost:5173", "[::1]:4317", "127.0.0.1"]) {
      expect((await server.inject({ method: "GET", url: "/api/config", headers: { host } })).statusCode, host).toBe(200);
    }
    const webhook = await server.inject({ method: "POST", url: "/api/webhooks/github", payload: {}, headers: { host: "coder.example", "x-hub-signature-256": "sha256=wrong" } });
    expect(webhook.statusCode).toBe(401); // reached, and refused by its signature
  });
});

describe("HTTP errors", () => {
  it("answers 404 for a pull request the source does not have, and logs the stack of a 500", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const errors: Record<string, unknown>[] = [];
    const logger = { ...silentLogger, error: (_message: string, data?: Record<string, unknown>) => void errors.push(data ?? {}) };
    const broken: CoderApi = Object.assign(Object.create(application) as CoderApi, {
      config: () => Promise.reject(new TypeError("config is broken")),
    });
    const server = await buildHttpServer({ api: broken, autoReview: noAutoReview, logger });
    servers.push(server);

    const missing = await server.inject({ method: "GET", url: "/api/pulls/demo/acme/storefront/999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "There is no demo pull request demo:acme/storefront#999" } });

    const failed = await server.inject({ method: "GET", url: "/api/config" });
    expect(failed.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
    expect(errors).toEqual([{ error: "config is broken", stack: expect.stringContaining("TypeError: config is broken") }]);
  });
});
