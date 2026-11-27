import type { EventStore } from "../../application/ports.js";
import type { DomainEvent } from "../../domain/deliberation/events.js";

export class InMemoryEventStore implements EventStore {
  protected readonly streams = new Map<string, DomainEvent[]>();

  async append(events: readonly DomainEvent[]): Promise<void> {
    this.check(events);
    this.commit(events);
  }

  async load(sessionId: string): Promise<DomainEvent[]> {
    return [...(this.streams.get(sessionId) ?? [])];
  }

  async sessionIds(): Promise<string[]> {
    return [...this.streams.keys()];
  }

  /** Throws unless every event continues its session's stream, in order. Changes nothing. */
  protected check(events: readonly DomainEvent[]): void {
    const lengths = new Map<string, number>();
    for (const event of events) {
      const length = lengths.get(event.sessionId) ?? this.streams.get(event.sessionId)?.length ?? 0;
      const expected = length + 1;
      if (event.seq !== expected) {
        throw new Error(`Out-of-order event for ${event.sessionId}: expected seq ${expected}, got ${event.seq}`);
      }
      lengths.set(event.sessionId, expected);
    }
  }

  /** Adds checked events to memory. */
  protected commit(events: readonly DomainEvent[]): void {
    for (const event of events) {
      const stream = this.streams.get(event.sessionId) ?? [];
      stream.push(event);
      this.streams.set(event.sessionId, stream);
    }
  }
}
