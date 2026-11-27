import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { CoderApi } from "../../application/api.js";
import type { AutoReview } from "../../application/AutoReview.js";
import { ApplicationError, describeError, type ApplicationErrorCode } from "../../application/errors.js";
import type { Logger, PullRequestSummary, Unsubscribe } from "../../application/ports.js";
import { PROVIDERS, type PullRequestRef } from "../../domain/change/types.js";
import { ENGINES, LANGUAGES } from "../../domain/deliberation/model.js";

export interface HttpServerOptions {
  readonly api: CoderApi;
  readonly autoReview: AutoReview;
  readonly logger: Logger;
  /**
   * When set, every /api route except health and the webhook requires
   * `Authorization: Bearer <token>`. Without it, they only answer requests
   * made on this machine.
   */
  readonly apiToken?: string;
  /** When set, GitHub webhooks are accepted: the receiver verifies and reads them, the route only forwards. */
  readonly githubWebhook?: WebhookReceiver;
  /** Directory with the built web app, served when it exists. */
  readonly webRoot?: string;
}

/** What the webhook route needs to know of a delivery. The source-control adapter that speaks the protocol provides it. */
export type WebhookOutcome =
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "review"; readonly pullRequest: PullRequestSummary };
export type WebhookReceiver = (delivery: { headers: FastifyRequest["headers"]; rawBody: Buffer }) => WebhookOutcome;

const STATUS_BY_CODE: Record<ApplicationErrorCode, number> = {
  not_found: 404,
  invalid_request: 400,
  not_configured: 409,
  conflict: 409,
  upstream_failure: 502,
};

const RefParams = z.object({
  provider: z.enum(PROVIDERS),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
});
const StartReviewBody = z.object({ language: z.enum(LANGUAGES).default("en"), engine: z.enum(ENGINES).optional() });
const DecisionBody = z.object({
  target: z.object({ kind: z.enum(["finding", "patch"]), id: z.string().min(1) }),
  action: z.enum(["accept", "dismiss"]),
  note: z.string().max(2000).optional(),
});
const FileQuery = z.object({ path: z.string().min(1), sha: z.string().min(1).max(100).optional() });
const ImportBody = z.object({ url: z.string().min(1).max(500) });
const SessionParams = z.object({ id: z.string().min(1).max(100) });

const HEARTBEAT_MS = 15_000;

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const { api, logger } = options;
  // Event streams stay open for as long as a browser tab does: shutting down must not wait for them.
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, forceCloseConnections: true });

  // Keep the raw bytes: the webhook signature is computed over them.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try {
      done(null, body.length > 0 ? JSON.parse(body.toString("utf8")) : {});
    } catch {
      done(new ApplicationError("invalid_request", "Request body is not valid JSON"));
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const { status, code, message } = describeFailure(error);
    if (status >= 500) logger.error("Request failed", { error: describeError(error), ...(error instanceof Error ? { stack: error.stack } : {}) });
    void reply.status(status).send({ error: { code, message } });
  });

  const refOf = (request: FastifyRequest): PullRequestRef => {
    const { provider, owner, repo, number } = parse(RefParams, request.params);
    return { provider, owner, repo, number };
  };

  // Outside the guards: liveness, and GitHub, whose credential is the signature.
  app.get("/api/health", async () => ({ ok: true }));
  app.post("/api/webhooks/github", async (request, reply) => {
    if (!options.githubWebhook) throw new HttpError(404, "not_found", "Webhooks are not configured");
    const outcome = options.githubWebhook({ headers: request.headers, rawBody: request.rawBody ?? Buffer.alloc(0) });
    if (outcome.kind === "rejected") throw new HttpError(401, "unauthorized", outcome.message);
    if (outcome.kind === "ignored") return reply.status(202).send({ ignored: outcome.reason });
    const sessionId = await options.autoReview.consider(outcome.pullRequest, "webhook");
    return reply.status(202).send({ sessionId });
  });

  // Every route registered in this plugin is guarded by its hook, whatever the spelling of the URL that reached it.
  await app.register(
    async (guarded) => {
      guarded.addHook("onRequest", async (request) => {
        // With a token, the token is the protection: deployments sit behind arbitrary host names.
        if (options.apiToken) return requireToken(request, options.apiToken);
        requireLocalBrowser(request);
      });

      const pull = "/pulls/:provider/:owner/:repo/:number";
      guarded.get("/config", () => api.config());
      guarded.get("/pulls", () => api.inbox());
      guarded.post("/pulls/import", (request) => api.importPullRequest(parse(ImportBody, request.body).url));
      guarded.get(pull, (request) => api.pullRequest(refOf(request)));
      guarded.get(`${pull}/file`, (request) => {
        const { path, sha } = parse(FileQuery, request.query);
        return api.fileContents(refOf(request), path, sha);
      });
      guarded.post(`${pull}/reviews`, (request) => api.startReview(refOf(request), parse(StartReviewBody, request.body ?? {})));

      guarded.get("/sessions/:id", (request) => api.session(parse(SessionParams, request.params).id));
      guarded.post("/sessions/:id/decisions", (request) => api.decide(parse(SessionParams, request.params).id, parse(DecisionBody, request.body)));
      guarded.get("/sessions/:id/publication", (request) => api.publicationPreview(parse(SessionParams, request.params).id));
      guarded.post("/sessions/:id/publish", (request) => api.publish(parse(SessionParams, request.params).id));
      guarded.get("/sessions/:id/events", (request, reply) => streamEvents(api, request, reply));
    },
    { prefix: "/api" },
  );

  if (options.webRoot && existsSync(join(options.webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    });
  }
  return app;
}

function requireToken(request: FastifyRequest, apiToken: string): void {
  const presented = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(presented, apiToken)) throw new HttpError(401, "unauthorized", "Missing or invalid API token");
}

/**
 * Without a token, being reachable only from this machine is the whole
 * protection, so a request must also come from it: a loopback Host (no DNS
 * rebinding) and no foreign web page as its origin (no cross-site requests).
 */
function requireLocalBrowser(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const foreignOrigin = origin !== undefined && !isLoopback(hostnameOfOrigin(origin));
  const crossSite = request.headers["sec-fetch-site"] === "cross-site";
  if (!isLoopback(hostnameOfHost(request.headers.host ?? "")) || foreignOrigin || crossSite) {
    throw new HttpError(403, "forbidden", "CodeR without CODER_API_TOKEN only answers requests made on this machine.");
  }
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for a name that only reaches this machine (`[::1]` and `::1` alike). */
export function isLoopback(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1"));
}

function hostnameOfHost(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
}

function hostnameOfOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return ""; // "null" or garbage: not this machine
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ApplicationError("invalid_request", `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
}

function describeFailure(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ApplicationError) return { status: STATUS_BY_CODE[error.code], code: error.code, message: error.message };
  const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  if (status >= 400 && status < 500) return { status, code: "invalid_request", message: describeError(error) };
  return { status: 500, code: "internal_error", message: "Internal error" };
}

/** Server-Sent Events: replays the session's events after `Last-Event-ID`, then streams new ones. */
async function streamEvents(api: CoderApi, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = parse(SessionParams, request.params);
  const { after } = parse(z.object({ after: z.coerce.number().int().min(0).optional() }), request.query);
  const afterSeq = Number(request.headers["last-event-id"] ?? after ?? 0) || 0;
  await api.session(id); // answer 404 as JSON before switching to a stream

  reply.hijack();
  const stream = reply.raw;
  let unsubscribe: Unsubscribe = () => {};
  let open = true;
  const heartbeat = setInterval(() => stream.write(": keep-alive\n\n"), HEARTBEAT_MS);
  // Listen before subscribing: a client that leaves during the replay must not leak the subscription.
  stream.on("close", () => {
    open = false;
    clearInterval(heartbeat);
    unsubscribe();
  });
  stream.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Headers are otherwise held back until the first event, which may be minutes away on a resumed stream.
  stream.write(": connected\n\n");
  try {
    const subscription = await api.subscribe(id, afterSeq, (event) => {
      if (open) stream.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    if (open) unsubscribe = subscription;
    else subscription();
  } catch {
    stream.end();
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
