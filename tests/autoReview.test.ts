import { describe, expect, it } from "vitest";
import { AutoReview } from "../src/application/AutoReview.js";
import type { StartReviewCommand } from "../src/application/ConductReview.js";
import { silentLogger, type Logger, type PullRequestSummary } from "../src/application/ports.js";
import type { CatalogListing } from "../src/application/PullRequestCatalog.js";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import { assessRisk } from "../src/domain/change/riskAssessment.js";
import { ReviewSession } from "../src/domain/deliberation/ReviewSession.js";
import type { SessionState } from "../src/domain/deliberation/state.js";

const summary = (number: number, headSha: string, extra: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  ref: { provider: "github", owner: "acme", repo: "shop", number },
  title: `PR ${number}`,
  author: { login: "dev" },
  url: `https://github.com/acme/shop/pull/${number}`,
  baseBranch: "main",
  headBranch: `feature/${number}`,
  headSha,
  updatedAt: "2026-11-27T10:00:00Z",
  draft: false,
  state: "open",
  ...extra,
});

let sessionCount = 0;

/** A stored session of that head, as the repository would fold it. */
function storedSession(pullRequest: PullRequestSummary, outcome: "in_progress" | "failed"): SessionState {
  const changeSet = ChangeSet.fromSnapshot({ ...pullRequest, description: "", baseSha: "base", createdAt: pullRequest.updatedAt, files: [] });
  const { ref, title, url, baseBranch, headBranch, headSha } = pullRequest;
  const session = ReviewSession.convene({
    id: `stored-${++sessionCount}`,
    pullRequest: { ref, title, author: pullRequest.author.login, url, baseBranch, headBranch, headSha },
    engine: "claude",
    model: "claude-opus-5-5",
    language: "en",
    stats: changeSet.stats,
    risk: assessRisk(changeSet),
    trigger: "poller",
  });
  if (outcome === "failed") session.fail("The model declined this request.");
  return session.state;
}

/** An AutoReview over in-memory collaborators: listings are served in order, the last one repeats. */
function autoReview(listings: CatalogListing[], stored: SessionState[] = [], logger: Logger = silentLogger) {
  const started: StartReviewCommand[] = [];
  let next = 0;
  const review = new AutoReview({
    catalog: { listOpen: async () => listings[Math.min(next++, listings.length - 1)]! },
    conductReview: {
      start: async (command) => {
        started.push(command);
        return { sessionId: `S-${started.length}` };
      },
    },
    sessions: { allStates: async () => stored },
    logger,
    language: "en",
  });
  return { review, started, stored };
}

const listing = (...items: PullRequestSummary[]): CatalogListing => ({ items, errors: [] });
const reviewedNumbers = (started: readonly StartReviewCommand[]) => started.map((command) => command.ref.number);

describe("AutoReview", () => {
  it("reviews nothing on the first poll: what exists at start is the baseline", async () => {
    const { review, started } = autoReview([listing(summary(1, "a"), summary(2, "b"))]);
    await review.poll();
    await review.poll();
    expect(started).toEqual([]);
  });

  it("reviews a new head on a later poll exactly once, and skips a draft", async () => {
    const { review, started, stored } = autoReview([
      listing(summary(1, "a")),
      listing(summary(1, "a2"), summary(2, "b", { draft: true })),
    ]);
    await review.poll();
    await review.poll();
    expect(reviewedNumbers(started)).toEqual([1]);
    expect(started[0]).toMatchObject({ trigger: "poller", language: "en" });
    stored.push(storedSession(summary(1, "a2"), "in_progress"));
    await review.poll();
    expect(reviewedNumbers(started)).toEqual([1]);
  });

  it("takes no baseline from a failed listing, and so starts no review when the next one succeeds", async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const failed: CatalogListing = { items: [], errors: [{ provider: "github", message: "GitHub rate limit reached." }] };
    const { review, started } = autoReview([failed, failed, listing(summary(1, "a"), summary(2, "b")), listing(summary(1, "a"), summary(2, "b"))], [], logger);
    await review.poll();
    await review.poll();
    expect(warnings).toEqual(["Automatic review is waiting for a complete listing", "Automatic review is waiting for a complete listing"]);
    await review.poll();
    await review.poll();
    expect(started).toEqual([]);
  });

  it("retries a head whose session failed once, then leaves it alone", async () => {
    const head = summary(3, "c");
    const { review, started, stored } = autoReview([listing(), listing(head)], [storedSession(head, "failed")]);
    await review.poll();
    await review.poll();
    expect(reviewedNumbers(started)).toEqual([3]);
    stored.push(storedSession(head, "failed"));
    await review.poll();
    expect(reviewedNumbers(started)).toEqual([3]);
  });

  it("does not review again a head that has a session from before a restart", async () => {
    const head = summary(4, "d");
    const { review, started } = autoReview([listing(), listing(head)], [storedSession(head, "in_progress")]);
    await review.poll();
    await review.poll();
    expect(await review.consider(head, "webhook")).toBeNull();
    expect(started).toEqual([]);
  });
});
