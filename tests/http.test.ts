import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoderApi } from "../src/application/api.js";
import type { AutoReview } from "../src/application/AutoReview.js";
import { silentLogger } from "../src/application/ports.js";
import { createStandaloneApplication } from "../src/composition/standalone.js";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { instantPace } from "../src/infrastructure/demo/ScriptedCouncil.js";
import { buildHttpServer } from "../src/infrastructure/http/server.js";

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
