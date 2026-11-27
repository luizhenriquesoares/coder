import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { CoderApi } from "../../application/api.js";
import type { AutoReview } from "../../application/AutoReview.js";
import { ApplicationError, describeError, type ApplicationErrorCode } from "../../application/errors.js";
import type { Logger, PullRequestSummary, Unsubscribe } from "../../application/ports.js";
import type { Provider, PullRequestRef } from "../../domain/change/types.js";
import { CouncilAgentError } from "../claude/ClaudeCouncil.js";
import { GitHubError } from "../github/GitHubSourceControl.js";

export interface HttpServerOptions {
  readonly api: CoderApi;
  readonly autoReview: AutoReview;
  readonly logger: Logger;
  /** When set, every /api route except the webhook requires `Authorization: Bearer <token>`. */
  readonly apiToken?: string;
  /** When set, GitHub webhooks are accepted and their signature is verified with it. */
  readonly webhookSecret?: string;
  /** Directory with the built web app, served when it exists. */
  readonly webRoot?: string;
}

const STATUS_BY_CODE: Record<ApplicationErrorCode, number> = {
  not_found: 404,
  invalid_request: 400,
  not_configured: 409,
  conflict: 409,
  upstream_failure: 502,
};

const RefParams = z.object({
  provider: z.enum(["github", "demo"]),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
});
const StartReviewBody = z.object({ language: z.enum(["en", "pt"]).default("en"), engine: z.enum(["claude", "scripted"]).optional() });
const DecisionBody = z.object({
  target: z.object({ kind: z.enum(["finding", "patch"]), id: z.string().min(1) }),
  action: z.enum(["accept", "dismiss"]),
  note: z.string().max(2000).optional(),
});
const ImportBody = z.object({ url: z.string().min(1).max(500) });
const SessionParams = z.object({ id: z.string().min(1).max(100) });

const REVIEWABLE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
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
    if (status >= 500) logger.error("Request failed", { error: describeError(error) });
    void reply.status(status).send({ error: { code, message } });
  });

  const refOf = (request: FastifyRequest): PullRequestRef => {
    const { provider, owner, repo, number } = parse(RefParams, request.params);
    return { provider: provider as Provider, owner, repo, number };
  };

  // Outside the guards: liveness, and GitHub, whose credential is the signature.
  app.get("/api/health", async () => ({ ok: true }));
  app.post("/api/webhooks/github", async (request, reply) => {
    if (!options.webhookSecret) throw new HttpError(404, "not_found", "Webhooks are not configured");
    const signature = String(request.headers["x-hub-signature-256"] ?? "");
    if (!verifySignature(options.webhookSecret, request.rawBody ?? Buffer.alloc(0), signature)) {
      throw new HttpError(401, "unauthorized", "Invalid webhook signature");
    }
    if (request.headers["x-github-event"] !== "pull_request") return reply.status(202).send({ ignored: "not a pull_request event" });
    const pullRequest = summaryFromWebhook(request.body);
    if (!pullRequest) return reply.status(202).send({ ignored: "not a reviewable action" });
    const sessionId = await options.autoReview.consider(pullRequest, "webhook");
    return reply.status(202).send({ sessionId });
  });

  // Every route registered in this plugin is guarded by its hook, whatever the spelling of the URL that reached it.
  await app.register(
    async (guarded) => {
      guarded.addHook("onRequest", async (request) => {
        if (options.apiToken) requireToken(request, options.apiToken);
      });

      const pull = "/pulls/:provider/:owner/:repo/:number";
      guarded.get("/config", () => api.config());
      guarded.get("/pulls", () => api.inbox());
      guarded.post("/pulls/import", (request) => api.importPullRequest(parse(ImportBody, request.body).url));
      guarded.get(pull, (request) => api.pullRequest(refOf(request)));
      guarded.get(`${pull}/file`, (request) => api.fileContents(refOf(request), parse(z.object({ path: z.string().min(1) }), request.query).path));
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
  if (error instanceof GitHubError || error instanceof CouncilAgentError) return { status: 502, code: "upstream_failure", message: error.message };
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

function verifySignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return safeEqual(signature, expected);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const WebhookPayload = z.object({
  action: z.string(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    draft: z.boolean().optional(),
    state: z.string(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
    base: z.object({ ref: z.string() }),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
});

function summaryFromWebhook(body: unknown): PullRequestSummary | null {
  const payload = WebhookPayload.safeParse(body);
  if (!payload.success || !REVIEWABLE_ACTIONS.has(payload.data.action)) return null;
  const { repository, pull_request: pr } = payload.data;
  return {
    ref: { provider: "github", owner: repository.owner.login, repo: repository.name, number: pr.number },
    title: pr.title,
    author: { login: pr.user?.login ?? "ghost" },
    url: pr.html_url,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    state: pr.state === "open" ? "open" : "closed",
  };
}
