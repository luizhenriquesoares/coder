import type { EventStore } from "../../application/ports.js";
import type { DomainEvent } from "../../domain/deliberation/events.js";

export class InMemoryEventStore implements EventStore {
  protected readonly streams = new Map<string, DomainEvent[]>();

  async append(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const stream = this.streams.get(event.sessionId) ?? [];
      const expected = stream.length + 1;
      if (event.seq !== expected) {
        throw new Error(`Out-of-order event for ${event.sessionId}: expected seq ${expected}, got ${event.seq}`);
      }
      stream.push(event);
      this.streams.set(event.sessionId, stream);
    }
  }

  async load(sessionId: string): Promise<DomainEvent[]> {
    return [...(this.streams.get(sessionId) ?? [])];
  }

  async sessionIds(): Promise<string[]> {
    return [...this.streams.keys()];
  }
}
