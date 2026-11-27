import { describe, expect, it } from "vitest";
import { ConductReview, MAX_CONCURRENT_REVIEWS } from "../src/application/ConductReview.js";
import { silentLogger } from "../src/application/ports.js";
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

function conductReview(pace: Pace) {
  const sessions = new SessionRepository(new InMemoryEventStore(), new InMemoryEventBus());
  const catalog = new PullRequestCatalog(new Map([["demo", new DemoSourceControl(pullRequests)]]));
  let id = 0;
  return new ConductReview({ catalog, councils: [new ScriptedCouncil(pace, pullRequests)], sessions, logger: silentLogger, newId: () => `S-${++id}` });
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
});
