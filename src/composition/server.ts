import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../application/api.js";
import { AutoReview } from "../application/AutoReview.js";
import { CoderApplication } from "../application/CoderApplication.js";
import { ConductReview } from "../application/ConductReview.js";
import type { CouncilAgents, Logger, SourceControl } from "../application/ports.js";
import { PullRequestCatalog } from "../application/PullRequestCatalog.js";
import { reconcileInterruptedSessions } from "../application/reconcileSessions.js";
import { SessionRepository } from "../application/SessionRepository.js";
import type { Provider } from "../domain/change/types.js";
import { InMemoryEventBus } from "../infrastructure/bus/InMemoryEventBus.js";
import { ClaudeCouncil } from "../infrastructure/claude/ClaudeCouncil.js";
import { adviceFor, anthropicClient, requireSignIn } from "../infrastructure/claude/credential.js";
import { DemoSourceControl } from "../infrastructure/demo/DemoSourceControl.js";
import { ScriptedCouncil } from "../infrastructure/demo/ScriptedCouncil.js";
import { GitHubSourceControl } from "../infrastructure/github/GitHubSourceControl.js";
import { FileEventStore } from "../infrastructure/persistence/FileEventStore.js";
import { FileWatchlist } from "../infrastructure/persistence/FileWatchlist.js";
import type { ServerConfig } from "./config.js";

const quietOctokitLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Composition root of the server: wires adapters to the application. */
export async function createServerApplication(config: ServerConfig, logger: Logger) {
  const store = await FileEventStore.open(join(config.dataDir, "sessions"), logger);
  const watchlist = await FileWatchlist.open(join(config.dataDir, "watchlist.json"));
  const bus = new InMemoryEventBus();
  const sessions = new SessionRepository(store, bus);

  const sources = new Map<Provider, SourceControl>();
  sources.set(
    "github",
    new GitHubSourceControl({
      octokit: new Octokit({
        ...(config.github.token ? { auth: config.github.token } : {}),
        ...(config.github.apiUrl ? { baseUrl: config.github.apiUrl } : {}),
        userAgent: "coder-review-council",
        log: quietOctokitLog, // failures are reported once, by the adapter
      }),
      repositories: config.github.repositories,
      authenticated: Boolean(config.github.token),
    }),
  );
  if (config.demo) sources.set("demo", new DemoSourceControl());

  // Order is preference: Claude reviews anything; the scripted council only knows the demo fixtures.
  const councils: CouncilAgents[] = [];
  const { credential } = config.claude;
  if (credential) {
    if (credential.kind === "sign-in") await requireSignIn(credential.profile);
    councils.push(
      new ClaudeCouncil({
        client: anthropicClient(credential, config.claude.baseUrl),
        credentialAdvice: adviceFor(credential),
        model: config.claude.model,
        effort: config.claude.effort,
        maxOutputTokens: config.claude.maxOutputTokens,
        logger,
      }),
    );
  }
  if (config.demo) councils.push(new ScriptedCouncil());

  const catalog = new PullRequestCatalog(sources);
  const conductReview = new ConductReview({ catalog, councils, sessions, logger, newId: randomUUID });
  const autoReview = new AutoReview({ catalog, conductReview, sessions, logger, language: config.language });

  const appConfig: AppConfig = {
    mode: "server",
    engines: [
      { engine: "claude", available: credential !== null, model: credential ? config.claude.model : null },
      { engine: "scripted", available: config.demo, model: null },
    ],
    github: {
      configured: Boolean(config.github.token) || config.github.repositories.length > 0,
      canPublish: Boolean(config.github.token),
      repositories: config.github.repositories.map(({ owner, repo }) => `${owner}/${repo}`),
    },
    autoReview: config.autoReview.enabled,
  };
  const application = new CoderApplication({
    config: appConfig,
    catalog,
    sessions,
    conductReview,
    store,
    bus,
    watchlist,
    reviewerName: config.reviewerName,
  });
  await reconcileInterruptedSessions(sessions, logger);
  return { application, autoReview, conductReview };
}
