import { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/application/api.js";
import { CoderApplication } from "../src/application/CoderApplication.js";
import { ConductReview } from "../src/application/ConductReview.js";
import { silentLogger } from "../src/application/ports.js";
import { PullRequestCatalog } from "../src/application/PullRequestCatalog.js";
import { SessionRepository } from "../src/application/SessionRepository.js";
import { InMemoryEventBus } from "../src/infrastructure/bus/InMemoryEventBus.js";
import { GitHubSourceControl } from "../src/infrastructure/github/GitHubSourceControl.js";
import { InMemoryEventStore } from "../src/infrastructure/persistence/InMemoryEventStore.js";
import { InMemoryWatchlist } from "../src/infrastructure/persistence/inMemoryWatchlist.js";
import { startFakeGitHub, type FakeGitHub, type FakePullRequest } from "./support/fakeGitHub.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-27T12:00:00Z");

function pr(number: number, extra: Partial<FakePullRequest> = {}): FakePullRequest {
  return { number, title: `PR ${number}`, body: "", author: "dev", headSha: `head-${number}`, baseTipSha: "tip", mergeBaseSha: "base", files: [], ...extra };
}

let github: FakeGitHub | undefined;
afterEach(async () => {
  await github?.close();
  github = undefined;
});

async function inboxOver(pullRequests: FakePullRequest[], watched: number[]) {
  github = await startFakeGitHub("acme", "shop", pullRequests);
  const octokit = new Octokit({ baseUrl: github.baseUrl, auth: "ghp_test", log: { debug() {}, info() {}, warn() {}, error() {} } });
  const source = new GitHubSourceControl({ octokit, repositories: [{ owner: "acme", repo: "shop" }], authenticated: true });
  const clock = { now: NOW };
  const catalog = new PullRequestCatalog(new Map([["github", source]]), () => clock.now);
  const store = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const sessions = new SessionRepository(store, bus);
  const watchlist = new InMemoryWatchlist();
  for (const number of watched) await watchlist.add({ provider: "github", owner: "acme", repo: "shop", number });
  const conductReview = new ConductReview({ catalog, councils: [], sessions, logger: silentLogger, newId: () => "s" });
  const config = { mode: "server", engines: [], github: { configured: true, canPublish: true, repositories: [] }, autoReview: false } satisfies AppConfig;
  const application = new CoderApplication({ config, catalog, sessions, conductReview, store, bus, watchlist, reviewerName: "me" });
  const requests = (path: string) => github!.calls.filter((call) => call.path === `/repos/acme/shop${path}`).length;
  return { application, watchlist, clock, requests, github };
}

const numbers = (inbox: Awaited<ReturnType<CoderApplication["inbox"]>>) => inbox.items.map((item) => item.pullRequest.ref.number).sort();

describe("the inbox costs GitHub what changed, not who is watching", () => {
  it("reads the listing and each watched pull request once per refresh interval", async () => {
    const { application, clock, requests } = await inboxOver(
      [pr(7), pr(8, { state: "closed", updatedAt: new Date(NOW - DAY).toISOString() }), pr(9)],
      [8],
    );
    const inboxes = await Promise.all(Array.from({ length: 5 }, () => application.inbox()));
    for (let i = 0; i < 5; i++) inboxes.push(await application.inbox());
    expect(inboxes.every((inbox) => numbers(inbox).join() === "7,8,9")).toBe(true);
    expect(requests("/pulls")).toBe(1);
    expect(requests("/pulls/8")).toBe(1);

    clock.now += 61_000;
    await application.inbox();
    expect(requests("/pulls")).toBe(2);
    expect(requests("/pulls/8")).toBe(1); // closed: it will not change again
  });

  it("keeps the rows of a failed refresh and reports the error", async () => {
    const { application, clock, requests, github } = await inboxOver([pr(7), pr(8)], [12]);
    const first = await application.inbox();
    expect(numbers(first)).toEqual([7, 8]);
    expect(first.errors).toEqual([{ provider: "github", message: expect.stringMatching(/could not read acme\/shop#12/) }]);

    clock.now += 61_000;
    github.failNext = { status: 500, message: "Server Error" };
    const second = await application.inbox();
    expect(requests("/pulls")).toBe(2);
    expect(numbers(second)).toEqual([7, 8]);
    expect(second.errors.map((error) => error.message)).toContainEqual(expect.stringMatching(/could not list pull requests of acme\/shop/));
  });

  it("stops following a watched pull request three days after it was merged", async () => {
    const { application, watchlist } = await inboxOver([pr(7), pr(8, { state: "merged", updatedAt: new Date(NOW - 4 * DAY).toISOString() })], [8]);
    expect(numbers(await application.inbox())).toEqual([7]);
    expect(await watchlist.all()).toEqual([]);
  });
});
