import type { EventBus, Unsubscribe } from "../../application/ports.js";
import type { DomainEvent } from "../../domain/deliberation/events.js";

type Listener = (event: DomainEvent) => void;

/** In-process publish/subscribe. A listener that throws never affects the others. */
export class InMemoryEventBus implements EventBus {
  private readonly bySession = new Map<string, Set<Listener>>();

  publish(events: readonly DomainEvent[]): void {
    for (const event of events) {
      const listeners = [...(this.bySession.get(event.sessionId) ?? [])];
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A broken subscriber (e.g. a closed connection) must not stop delivery.
        }
      }
    }
  }

  subscribe(sessionId: string, listener: Listener): Unsubscribe {
    const listeners = this.bySession.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.bySession.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.bySession.delete(sessionId);
    };
  }
}
