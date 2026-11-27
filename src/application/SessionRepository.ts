import type { DomainEvent } from "../domain/deliberation/events.js";
import { ReviewSession } from "../domain/deliberation/ReviewSession.js";
import { foldEvents, type SessionState } from "../domain/deliberation/state.js";
import { ApplicationError } from "./errors.js";
import type { EventBus, EventStore } from "./ports.js";

const MAX_LIVE_SESSIONS = 200;

/**
 * Repository for the ReviewSession aggregate.
 *
 * Keeps exactly one in-memory instance per session so the council (writing
 * while it deliberates) and the human (deciding at the same time) never
 * produce conflicting event sequences. Saves are serialized per session.
 */
export class SessionRepository {
  private readonly live = new Map<string, ReviewSession>();
  private readonly saving = new Map<string, Promise<void>>();
  /** Events whose append failed, kept to be written again, first, by the next save. */
  private readonly unsaved = new Map<string, readonly DomainEvent[]>();

  constructor(
    private readonly store: EventStore,
    private readonly bus: EventBus,
  ) {}

  add(session: ReviewSession): void {
    this.live.set(session.id, session);
    this.evictFinishedSessions();
  }

  async get(sessionId: string): Promise<ReviewSession> {
    const live = this.live.get(sessionId);
    if (live) return live;
    const events = await this.store.load(sessionId);
    if (events.length === 0) throw new ApplicationError("not_found", `Review session ${sessionId} not found`);
    const session = ReviewSession.rehydrate(events);
    this.add(session);
    return session;
  }

  /**
   * Persists and publishes the session's pending events, in order. When the
   * append fails the events are kept and written again by the next save; the
   * failure still reaches the caller.
   */
  save(session: ReviewSession): Promise<void> {
    const fresh = session.pullPendingEvents();
    const previous = this.saving.get(session.id) ?? Promise.resolve();
    if (fresh.length === 0 && !this.unsaved.has(session.id)) return previous;
    const next = previous
      .catch(() => {})
      .then(async () => {
        const events = [...(this.unsaved.get(session.id) ?? []), ...fresh];
        if (events.length === 0) return;
        try {
          await this.store.append(events);
        } catch (error) {
          this.unsaved.set(session.id, events);
          throw error;
        }
        this.unsaved.delete(session.id);
        this.bus.publish(events);
      });
    this.saving.set(session.id, next);
    return next;
  }

  async state(sessionId: string): Promise<SessionState> {
    return (await this.get(sessionId)).state;
  }

  async allStates(): Promise<SessionState[]> {
    const ids = await this.store.sessionIds();
    const states = await Promise.all(
      ids.map(async (id) => {
        const live = this.live.get(id);
        if (live) return live.state;
        const events = await this.store.load(id);
        return events.length > 0 ? foldEvents(events) : null;
      }),
    );
    return states.filter((state): state is SessionState => state !== null);
  }

  private evictFinishedSessions(): void {
    if (this.live.size <= MAX_LIVE_SESSIONS) return;
    for (const [id, session] of this.live) {
      if (session.state.status !== "in_progress" && !this.unsaved.has(id)) {
        this.live.delete(id);
        this.saving.delete(id);
      }
      if (this.live.size <= MAX_LIVE_SESSIONS) return;
    }
  }
}
