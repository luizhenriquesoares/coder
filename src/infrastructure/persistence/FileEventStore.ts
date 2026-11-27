import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent } from "../../domain/deliberation/events.js";
import { InMemoryEventStore } from "./InMemoryEventStore.js";

/**
 * Append-only event store: one JSON-lines file per review session.
 * Good enough for a single node; swap for Postgres or EventStoreDB to scale out.
 */
export class FileEventStore extends InMemoryEventStore {
  private constructor(private readonly directory: string) {
    super();
  }

  static async open(directory: string): Promise<FileEventStore> {
    await mkdir(directory, { recursive: true });
    const store = new FileEventStore(directory);
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".jsonl")) continue;
      const events = parseStream(await readFile(join(directory, file), "utf8"));
      if (events.length > 0) store.streams.set(events[0]!.sessionId, events);
    }
    return store;
  }

  override async append(events: readonly DomainEvent[]): Promise<void> {
    await super.append(events);
    const bySession = Map.groupBy(events, (event) => event.sessionId);
    for (const [sessionId, sessionEvents] of bySession) {
      const lines = sessionEvents.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await appendFile(join(this.directory, `${sessionId}.jsonl`), lines, "utf8");
    }
  }
}

/** Parses a stream file, ignoring a torn last line left by a crash mid-write. */
function parseStream(text: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as DomainEvent);
    } catch {
      break;
    }
  }
  return events;
}
