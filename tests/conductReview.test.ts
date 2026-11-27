import { describe, expect, it } from "vitest";
import { ConductReview, MAX_CONCURRENT_REVIEWS } from "../src/application/ConductReview.js";
import { silentLogger, type Logger } from "../src/application/ports.js";
import { PullRequestCatalog } from "../src/application/PullRequestCatalog.js";
import { SessionRepository } from "../src/application/SessionRepository.js";
import { InMemoryEventBus } from "../src/infrastructure/bus/InMemoryEventBus.js";
import { DemoSourceControl } from "../src/infrastructure/demo/DemoSourceControl.js";
import { DEMO_PULL_REQUESTS } from "../src/infrastructure/demo/fixtures/index.js";
import { ScriptedCouncil, type Pace } from "../src/infrastructure/demo/ScriptedCouncil.js";
import type { DemoPullRequest } from "../src/infrastructure/demo/types.js";
import { InMemoryEventStore } from "../src/infrastructure/persistence/InMemoryEventStore.js";

/** Six copies of one demo pull request, under different numbers. */
const pullRequests: DemoPullRequest[] = Array.from({ length: 6 }, (_, index) => ({
  ...DEMO_PULL_REQUESTS[0]!,
  ref: { ...DEMO_PULL_REQUESTS[0]!.ref, number: 1000 + index },
}));
const refOf = (index: number) => pullRequests[index]!.ref;

function conductReview(pace: Pace, reviewerDeadlineMs?: number, options: { source?: DemoSourceControl; logger?: Logger } = {}) {
  const sessions = new SessionRepository(new InMemoryEventStore(), new InMemoryEventBus());
  const catalog = new PullRequestCatalog(new Map([["demo", options.source ?? new DemoSourceControl(pullRequests)]]));
  let id = 0;
  const reviews = new ConductReview({
    catalog,
    councils: [new ScriptedCouncil(pace, pullRequests)],
    sessions,
    logger: options.logger ?? silentLogger,
    newId: () => `S-${++id}`,
    ...(reviewerDeadlineMs ? { reviewerDeadlineMs } : {}),
  });
  return Object.assign(reviews, { sessions });
}

const never: Pace = () => new Promise(() => {});

describe("ConductReview", () => {
  it("caps the deliberations that run at once, and says how many are running", async () => {
    const reviews = conductReview(never);
    const starts = await Promise.allSettled(pullRequests.slice(0, 5).map((pr) => reviews.start({ ref: pr.ref, language: "en", trigger: "manual" })));
    expect(starts.filter((start) => start.status === "fulfilled")).toHaveLength(MAX_CONCURRENT_REVIEWS);
    const refused = starts.find((start) => start.status === "rejected");
    expect(refused?.reason).toMatchObject({ code: "conflict", message: expect.stringContaining(`${MAX_CONCURRENT_REVIEWS} pull requests`) });
  });

  it("refuses a second session on a commit the council is already reviewing", async () => {
    const reviews = conductReview(never);
    await reviews.start({ ref: refOf(0), language: "en", trigger: "manual" });
    await expect(reviews.start({ ref: refOf(0), language: "pt", trigger: "webhook" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("stops waiting for an engine that ignores the deadline", async () => {
    const reviews = conductReview(never, 30);
    const { sessionId } = await reviews.start({ ref: refOf(0), language: "en", trigger: "manual" });
    await reviews.whenSettled(sessionId);
    const state = await reviews.sessions.state(sessionId);
    expect(state).toMatchObject({ status: "failed", failureReason: "No reviewer could complete the opening round" });
    expect(state.statements.map((s) => s.text)).toEqual(Array(4).fill("The reviewer did not answer within 30 ms."));
  });

  it("fails and saves the sessions still deliberating when asked to stop", async () => {
    const reviews = conductReview(never);
    const { sessionId } = await reviews.start({ ref: refOf(0), language: "en", trigger: "manual" });
    await reviews.interruptRunning("The server stopped.");
    expect(await reviews.sessions.state(sessionId)).toMatchObject({ status: "failed", failureReason: "The server stopped." });
  });

  it("logs, with the session, a file reviewers could only see as a diff because it could not be read", async () => {
    const unreadable = pullRequests[0]!.files.find((file) => file.head !== null)!.path;
    const source = new (class extends DemoSourceControl {
      override async getFileContents(snapshot: Parameters<DemoSourceControl["getFileContents"]>[0], path: string) {
        if (path === unreadable) throw new Error("disk on fire");
        return super.getFileContents(snapshot, path);
      }
    })(pullRequests);
    const warnings: Record<string, unknown>[] = [];
    const logger: Logger = { ...silentLogger, warn: (message, data) => void (message.startsWith("Reviewers will see only the diff") && warnings.push(data ?? {})) };
    const reviews = conductReview(never, 30, { source, logger });
    const { sessionId } = await reviews.start({ ref: refOf(0), language: "en", trigger: "manual" });
    await reviews.whenSettled(sessionId);
    expect(warnings).toEqual([{ sessionId, path: unreadable, error: "disk on fire" }]);
  });
});
