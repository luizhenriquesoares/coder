import type { CoderApi } from "../../src/application/api.js";
import type { DomainEvent } from "../../src/domain/deliberation/events.js";

const ENDS = new Set<DomainEvent["type"]>(["ReviewSessionConcluded", "ReviewSessionFailed"]);

/** Follows a session through any delivery of `CoderApi` until the council concludes or fails. */
export async function followUntilConcluded(api: CoderApi, sessionId: string, afterSeq = 0): Promise<DomainEvent[]> {
  const events: DomainEvent[] = [];
  const { promise: ended, resolve, reject } = Promise.withResolvers<void>();
  const listener = (event: DomainEvent) => {
    events.push(event);
    if (ENDS.has(event.type)) resolve();
  };
  const unsubscribe = await api.subscribe(sessionId, afterSeq, listener, reject);
  try {
    await ended;
  } finally {
    unsubscribe();
  }
  return events;
}
