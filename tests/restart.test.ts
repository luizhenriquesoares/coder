import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/application/ports.js";
import { INTERRUPTED_BY_RESTART, PUBLICATION_INTERRUPTED } from "../src/application/reconcileSessions.js";
import { loadConfig } from "../src/composition/config.js";
import { createServerApplication } from "../src/composition/server.js";
import { createStandaloneApplication } from "../src/composition/standalone.js";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { instantPace } from "../src/infrastructure/demo/ScriptedCouncil.js";

const storefront = { provider: "demo", owner: "acme", repo: "storefront", number: 131 } as const;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** The events of one demo review, as a previous process would have left them. */
async function storedReview(): Promise<{ sessionId: string; events: DomainEvent[] }> {
  const { application, conductReview, store } = createStandaloneApplication({ pace: instantPace });
  const { sessionId } = await application.startReview(storefront, { language: "en" });
  await conductReview.whenSettled(sessionId);
  return { sessionId, events: await store.load(sessionId) };
}

async function bootOver(sessionId: string, events: readonly DomainEvent[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "coder-restart-"));
  directories.push(dataDir);
  await mkdir(join(dataDir, "sessions"));
  await writeFile(join(dataDir, "sessions", `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event) + "\n").join(""));
  return createServerApplication(loadConfig({ CODER_DATA_DIR: dataDir, CODER_DEMO: "true" }), silentLogger);
}

describe("a restart leaves no session in mid-air", () => {
  it("fails a deliberation the previous process did not finish, and lets the council convene again", async () => {
    const { sessionId, events } = await storedReview();
    const halfway = events.slice(0, events.findIndex((event) => event.type === "ConsensusComputed"));
    const { application, conductReview } = await bootOver(sessionId, halfway);

    expect(await application.session(sessionId)).toMatchObject({ status: "failed", failureReason: INTERRUPTED_BY_RESTART });
    const { sessionId: again } = await application.startReview(storefront, { language: "en" });
    expect((await application.session(again)).status).toBe("in_progress");
    await conductReview.interruptRunning("Test over.");
    expect((await application.session(again)).status).toBe("failed");
  });

  it("fails a publication whose outcome the previous process never learned, and leaves it publishable", async () => {
    const { sessionId, events } = await storedReview();
    const last = events.at(-1)!;
    const started = { type: "PublicationStarted", sessionId, seq: last.seq + 1, at: last.at, payload: {} } as DomainEvent;
    const { application } = await bootOver(sessionId, [...events, started]);

    expect(await application.session(sessionId)).toMatchObject({ status: "concluded", publishing: false, publicationFailure: PUBLICATION_INTERRUPTED });
    expect((await application.publish(sessionId)).publication).toMatchObject({ simulated: true });
  });
});
