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
import { adviceFor, ANTHROPIC_API, anthropicClient, describeCredential, originOf, redactorFor } from "../infrastructure/claude/credential.js";
import { requireSignIn } from "../infrastructure/claude/signIn.js";
import { DemoSourceControl } from "../infrastructure/demo/DemoSourceControl.js";
import { ScriptedCouncil } from "../infrastructure/demo/ScriptedCouncil.js";
import { GitHubSourceControl } from "../infrastructure/github/GitHubSourceControl.js";
import { FileEventStore } from "../infrastructure/persistence/FileEventStore.js";
import { FileWatchlist } from "../infrastructure/persistence/FileWatchlist.js";
import type { ServerConfig } from "./config.js";

const quietOctokitLog = { debug() {}, info() {}, warn() {}, error() {} };

/** What the Claude council runs on, in words fit for a log: the kind of credential, never the credential. */
export interface ClaudeWiring {
  readonly model: string;
  readonly credential: string;
  /** Scheme and host the reviews are sent to. */
  readonly api: string;
  /** Scheme and host a sign-in is renewed at, when that is somewhere else. */
  readonly renewsAt?: string;
}

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
  const claude = await wireClaude(config.claude, logger);
  if (claude) councils.push(claude.council);
  if (config.demo) councils.push(new ScriptedCouncil());

  const catalog = new PullRequestCatalog(sources);
  const conductReview = new ConductReview({ catalog, councils, sessions, logger, newId: randomUUID });
  const autoReview = new AutoReview({ catalog, conductReview, sessions, logger, language: config.language });

  const appConfig: AppConfig = {
    mode: "server",
    engines: [
      { engine: "claude", available: claude !== null, model: claude ? config.claude.model : null },
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
  return { application, autoReview, conductReview, claude: claude?.wiring ?? null };
}

/** The Claude council on the one credential the configuration chose, or null when it holds none. */
async function wireClaude(claude: ServerConfig["claude"], logger: Logger): Promise<{ council: ClaudeCouncil; wiring: ClaudeWiring } | null> {
  const { credential, ignoredCredentials, credentialHeaders, baseUrl } = claude;
  if (!credential) return null;
  const using = describeCredential(credential);

  // Said before the sign-in is checked: if that stops the start, the operator has
  // already read which credential was taken and which were left aside.
  if (ignoredCredentials.length > 0) {
    logger.warn("More than one Claude credential is set. CodeR prefers an auth token to the Console sign-in, and both to an API key.", {
      using,
      ignored: ignoredCredentials,
    });
  }
  if (credentialHeaders.length > 0) {
    logger.warn("ANTHROPIC_CUSTOM_HEADERS carries a credential of its own. The SDK sends it as written, over or next to the one CodeR chose.", {
      using,
      headers: credentialHeaders,
    });
  }

  const signIn =
    credential.kind === "sign-in"
      ? await requireSignIn(credential.profile, { baseUrl, otherCredentials: ignoredCredentials, warn: (message) => logger.warn(message) })
      : null;
  const council = new ClaudeCouncil({
    client: anthropicClient(credential, baseUrl),
    credentialAdvice: adviceFor(credential),
    redact: redactorFor(credential),
    model: claude.model,
    effort: claude.effort,
    maxOutputTokens: claude.maxOutputTokens,
    logger,
  });
  const api = originOf(signIn?.api ?? baseUrl ?? ANTHROPIC_API);
  const renewsAt = signIn ? originOf(signIn.renewsAt) : api;
  return { council, wiring: { model: claude.model, credential: using, api, ...(renewsAt === api ? {} : { renewsAt }) } };
}
