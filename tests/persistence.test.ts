import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger, type EventStore, type Logger } from "../src/application/ports.js";
import { SessionRepository } from "../src/application/SessionRepository.js";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import { assessRisk } from "../src/domain/change/riskAssessment.js";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { ReviewSession } from "../src/domain/deliberation/ReviewSession.js";
import { InMemoryEventBus } from "../src/infrastructure/bus/InMemoryEventBus.js";
import { DemoSourceControl } from "../src/infrastructure/demo/DemoSourceControl.js";
import { FileEventStore } from "../src/infrastructure/persistence/FileEventStore.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coder-store-"));
  directories.push(path);
  return path;
}

async function convene(id: string): Promise<ReviewSession> {
  const snapshot = await new DemoSourceControl().getSnapshot({ provider: "demo", owner: "acme", repo: "storefront", number: 131 });
  const changeSet = ChangeSet.fromSnapshot(snapshot);
  const { ref, title, url, baseBranch, headBranch, headSha } = snapshot;
  return ReviewSession.convene({
    id,
    pullRequest: { ref, title, author: snapshot.author.login, url, baseBranch, headBranch, headSha },
    engine: "scripted",
    model: null,
    language: "en",
    stats: changeSet.stats,
    risk: assessRisk(changeSet),
    trigger: "manual",
  });
}

/** Three events: convened, opening round, the architect thinking. */
async function sessionEvents(id: string): Promise<DomainEvent[]> {
  const session = await convene(id);
  session.startRound("opening");
  session.startThinking("architect");
  return session.pullPendingEvents();
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: () => {}, warn: (message) => lines.push(`warn ${message}`), error: (message) => lines.push(`error ${message}`) };
}

const seqs = (events: readonly DomainEvent[]) => events.map((event) => event.seq);

describe("FileEventStore", () => {
  it("believes an event only once it is on disk", async () => {
    const dir = await directory();
    const store = await FileEventStore.open(dir, silentLogger);
    const events = await sessionEvents("s1");
    await mkdir(join(dir, "s1.jsonl")); // the write will fail
    await expect(store.append(events)).rejects.toThrow();
    expect(await store.load("s1")).toEqual([]);

    await rmdir(join(dir, "s1.jsonl"));
    await store.append(events); // the same events, again: no hole, no "out of order"
    expect(seqs(await (await FileEventStore.open(dir, silentLogger)).load("s1"))).toEqual([1, 2, 3]);
  });

  it("cuts a torn last line off the file, so the next append starts on a clean line", async () => {
    const dir = await directory();
    const [first, second, third] = await sessionEvents("s1");
    await writeFile(join(dir, "s1.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n{"type":"Revie`);
    const logger = recordingLogger();
    const store = await FileEventStore.open(dir, logger);
    expect(seqs(await store.load("s1"))).toEqual([1, 2]);
    expect(logger.lines).toEqual(["warn Cut a torn last line off a session stream"]);

    await store.append([third!]);
    expect(seqs(await (await FileEventStore.open(dir, silentLogger)).load("s1"))).toEqual([1, 2, 3]);
  });

  it("sets aside a stream with a hole or a foreign event, and loads the rest", async () => {
    const dir = await directory();
    const [a1, , a3] = await sessionEvents("holey");
    const [b1, b2] = await sessionEvents("good");
    const [c1] = await sessionEvents("other");
    await writeFile(join(dir, "holey.jsonl"), `${JSON.stringify(a1)}\n${JSON.stringify(a3)}\n`);
    await writeFile(join(dir, "good.jsonl"), `${JSON.stringify(b1)}\n${JSON.stringify(b2)}\n`);
    await writeFile(join(dir, "mixed.jsonl"), `${JSON.stringify(c1)}\n`);
    const logger = recordingLogger();
    const store = await FileEventStore.open(dir, logger);

    expect(await store.sessionIds()).toEqual(["good"]);
    expect((await readdir(dir)).sort()).toEqual(["good.jsonl", "holey.jsonl.corrupt", "mixed.jsonl.corrupt"]);
    expect(logger.lines).toEqual(["error Set aside a corrupt session stream", "error Set aside a corrupt session stream"]);
  });
});

describe("SessionRepository", () => {
  it("writes events whose append failed again with the next save, in order", async () => {
    const dir = await directory();
    const file = await FileEventStore.open(dir, silentLogger);
    let failNext = false;
    const flaky: EventStore = {
      append: (events) => (failNext ? ((failNext = false), Promise.reject(new Error("disk full"))) : file.append(events)),
      load: (id) => file.load(id),
      sessionIds: () => file.sessionIds(),
    };
    const sessions = new SessionRepository(flaky, new InMemoryEventBus());
    const session = await convene("s1");
    sessions.add(session);
    await sessions.save(session);

    session.startRound("opening");
    failNext = true;
    await expect(sessions.save(session)).rejects.toThrow("disk full");
    session.startThinking("architect");
    await sessions.save(session);

    const reopened = await FileEventStore.open(dir, silentLogger);
    const events = await reopened.load("s1");
    expect(seqs(events)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual(["ReviewSessionConvened", "RoundStarted", "ReviewerStartedThinking"]);
    expect(await readFile(join(dir, "s1.jsonl"), "utf8")).toMatch(/\n$/);
  });
});

