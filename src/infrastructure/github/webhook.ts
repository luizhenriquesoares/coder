import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PullRequestSummary } from "../../application/ports.js";
import { toSummary } from "./GitHubSourceControl.js";

/** What a webhook delivery asks of CodeR, in the domain's words. */
export type GitHubWebhookOutcome =
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "review"; readonly pullRequest: PullRequestSummary };

export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The bytes as received: the signature is computed over them, not over a re-serialised body. */
  readonly rawBody: Buffer;
}

const REVIEWABLE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

const WebhookPayload = z.object({
  action: z.string(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    draft: z.boolean().optional(),
    state: z.string(),
    merged_at: z.string().nullable().optional(),
    updated_at: z.string(),
    user: z.object({ login: z.string(), avatar_url: z.string().optional() }).nullable(),
    base: z.object({ ref: z.string() }),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
});

/** GitHub's webhook protocol: verify the signature over the raw bytes first, then read the event. */
export function githubWebhookReceiver(secret: string): (delivery: WebhookDelivery) => GitHubWebhookOutcome {
  return ({ headers, rawBody }) => {
    if (!verifySignature(secret, rawBody, String(headers["x-hub-signature-256"] ?? ""))) {
      return { kind: "rejected", message: "Invalid webhook signature" };
    }
    if (headers["x-github-event"] !== "pull_request") return { kind: "ignored", reason: "not a pull_request event" };
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { kind: "ignored", reason: "not a reviewable action" };
    }
    const payload = WebhookPayload.safeParse(body);
    if (!payload.success || !REVIEWABLE_ACTIONS.has(payload.data.action)) return { kind: "ignored", reason: "not a reviewable action" };
    const { repository, pull_request: pr } = payload.data;
    const ref = { provider: "github", owner: repository.owner.login, repo: repository.name, number: pr.number } as const;
    return { kind: "review", pullRequest: toSummary(ref, pr) };
  };
}

function verifySignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const presented = Buffer.from(signature);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
