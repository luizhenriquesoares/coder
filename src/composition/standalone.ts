import type { AppConfig } from "../application/api.js";
import { CoderApplication } from "../application/CoderApplication.js";
import { ConductReview } from "../application/ConductReview.js";
import { silentLogger, type Logger, type SourceControl } from "../application/ports.js";
import { PullRequestCatalog } from "../application/PullRequestCatalog.js";
import { SessionRepository } from "../application/SessionRepository.js";
import type { Provider } from "../domain/change/types.js";
import { InMemoryEventBus } from "../infrastructure/bus/InMemoryEventBus.js";
import { DemoSourceControl } from "../infrastructure/demo/DemoSourceControl.js";
import type { Clock } from "../domain/deliberation/ReviewSession.js";
import { realTimePace, ScriptedCouncil, type Pace } from "../infrastructure/demo/ScriptedCouncil.js";
import { InMemoryEventStore } from "../infrastructure/persistence/InMemoryEventStore.js";
import { InMemoryWatchlist } from "../infrastructure/persistence/inMemoryWatchlist.js";

export interface StandaloneOptions {
  readonly pace?: Pace;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/**
 * Composition root with no I/O at all: demo pull requests, scripted council,
 * in-memory persistence. Runs in a browser tab (the shareable demo) and in the
 * test suite. The domain and application code is exactly the code the server runs.
 */
export function createStandaloneApplication(options: StandaloneOptions = {}) {
  const logger = options.logger ?? silentLogger;
  const store = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const sessions = new SessionRepository(store, bus);
  const clock = options.clock ?? (() => new Date());
  const sources = new Map<Provider, SourceControl>([["demo", new DemoSourceControl(undefined, () => clock().getTime())]]);
  const catalog = new PullRequestCatalog(sources);
  const conductReview = new ConductReview({
    catalog,
    councils: [new ScriptedCouncil(options.pace ?? realTimePace)],
    sessions,
    logger,
    newId: () => globalThis.crypto.randomUUID(),
    clock,
  });
  const config: AppConfig = {
    mode: "standalone",
    engines: [
      { engine: "claude", available: false, model: null },
      { engine: "scripted", available: true, model: null },
    ],
    github: { configured: false, canPublish: false, repositories: [] },
    autoReview: false,
  };
  const application = new CoderApplication({
    config,
    catalog,
    sessions,
    conductReview,
    store,
    bus,
    watchlist: new InMemoryWatchlist(),
    reviewerName: "you",
  });
  return { application, conductReview, sessions, store, bus };
}
