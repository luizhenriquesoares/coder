import { createStandaloneApplication } from "../../src/composition/standalone.js";
import type { PullRequestRef } from "../../src/domain/change/types.js";
import type { DomainEvent } from "../../src/domain/deliberation/events.js";
import { instantPace } from "../../src/infrastructure/demo/ScriptedCouncil.js";

export const COUPON: PullRequestRef = { provider: "demo", owner: "acme", repo: "storefront", number: 128 };

/** A concluded demo session on the coupon pull request, and every event it recorded. */
export async function concludedDemoSession(ref: PullRequestRef = COUPON) {
  const app = createStandaloneApplication({ pace: instantPace });
  const { sessionId } = await app.application.startReview(ref, { language: "en" });
  await app.conductReview.whenSettled(sessionId);
  const events: DomainEvent[] = [];
  const stop = await app.application.subscribe(sessionId, 0, (event) => events.push(event));
  stop();
  return { ...app, sessionId, events, state: await app.application.session(sessionId) };
}
