import { appendFile, mkdir, readdir, readFile, rename, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "../../application/errors.js";
import type { Logger } from "../../application/ports.js";
import type { DomainEvent } from "../../domain/deliberation/events.js";
import { InMemoryEventStore } from "./InMemoryEventStore.js";

/**
 * Append-only event store: one JSON-lines file per review session.
 * Good enough for a single node; swap for Postgres or EventStoreDB to scale out.
 *
 * The file is the truth: an event is in memory only once it is on disk, so a
 * failed write can be retried and never leaves a hole in the stream.
 */
export class FileEventStore extends InMemoryEventStore {
  private constructor(private readonly directory: string) {
    super();
  }

  static async open(directory: string, logger: Logger): Promise<FileEventStore> {
    await mkdir(directory, { recursive: true });
    const store = new FileEventStore(directory);
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".jsonl")) continue;
      const events = await store.recover(file, logger);
      if (events && events.length > 0) store.streams.set(events[0]!.sessionId, events);
    }
    return store;
  }

  override async append(events: readonly DomainEvent[]): Promise<void> {
    this.check(events);
    for (const [sessionId, sessionEvents] of Map.groupBy(events, (event) => event.sessionId)) {
      await this.write(sessionId, sessionEvents);
      this.commit(sessionEvents);
    }
  }

  private async write(sessionId: string, events: readonly DomainEvent[]): Promise<void> {
    const path = this.pathOf(sessionId);
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    try {
      await appendFile(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    } catch (error) {
      // Leave no fragment behind for the retry to be glued onto.
      await truncate(path, size).catch(() => {});
      throw error;
    }
  }

  /**
   * Reads one stream file. A torn last line (a crash mid-write) is cut off the
   * file so later appends start on a clean line. A stream that is not one
   * session's events numbered 1..n is set aside as `<file>.corrupt`.
   */
  private async recover(file: string, logger: Logger): Promise<DomainEvent[] | null> {
    const path = join(this.directory, file);
    const text = await readFile(path, "utf8");
    const { events, validLength } = parseStream(text);
    const problem = events ? streamProblem(events, file) : "a complete line is not a valid event";
    if (problem || !events) {
      await rename(path, `${path}.corrupt`);
      logger.error("Set aside a corrupt session stream", { file, problem, renamedTo: `${file}.corrupt` });
      return null;
    }
    if (validLength < Buffer.byteLength(text, "utf8")) {
      await truncate(path, validLength).catch((error) => logger.warn("Could not cut a torn line", { file, error: describeError(error) }));
      logger.warn("Cut a torn last line off a session stream", { file, events: events.length });
    }
    return events;
  }

  private pathOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }
}

/**
 * Parses a stream file. Every event is written with its newline, so text
 * after the last newline is a torn write; `validLength` is the byte length
 * of the complete lines. `events` is null when a complete line is not an event.
 */
function parseStream(text: string): { events: DomainEvent[] | null; validLength: number } {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const validLength = Buffer.byteLength(complete, "utf8");
  const events: DomainEvent[] = [];
  for (const line of complete.split("\n").slice(0, -1)) {
    try {
      events.push(JSON.parse(line) as DomainEvent);
    } catch {
      return { events: null, validLength };
    }
  }
  return { events, validLength };
}

function streamProblem(events: readonly DomainEvent[], file: string): string | null {
  const sessionId = file.slice(0, -".jsonl".length);
  for (const [index, event] of events.entries()) {
    if (event.sessionId !== sessionId) return `event ${index + 1} belongs to session ${event.sessionId}`;
    if (event.seq !== index + 1) return `expected seq ${index + 1}, found ${event.seq}`;
  }
  return null;
}
