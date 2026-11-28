import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { silentLogger, type Logger } from "../../src/application/ports.js";
import { loadConfig } from "../../src/composition/config.js";
import { createServerApplication } from "../../src/composition/server.js";
import type { PullRequestRef } from "../../src/domain/change/types.js";
import { startFakeAnthropic, type FakeAnthropic, type RecordedRenewal, type RecordedRequest, type Renewal, type Reply } from "./fakeAnthropic.js";

/**
 * The server as it runs on a Claude credential: the real configuration, the
 * real composition root and the real SDK, talking to a local stand-in for the
 * API. Shared by the tests of the credentials and of the Console sign-in.
 */

const coupon: PullRequestRef = { provider: "demo", owner: "acme", repo: "storefront", number: 128 };
export const OAUTH_BETA = "oauth-2025-04-20";
export const CODER_BETA = "server-side-fallback-2026-07-01";

const cleanups: (() => Promise<unknown>)[] = [];

/** For afterEach: closes and removes what the helpers below opened, and undoes every stubbed variable. */
export async function tidyUp(): Promise<void> {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A council with nothing to say: these tests look at how each request is authenticated, not at the review. */
export function quietCouncil(request: RecordedRequest): Reply {
  switch (request.round) {
    case "opening":
      return { json: { statement: `Opening from ${request.seat}.`, findings: [] } };
    case "debate":
      return { json: { statement: "Nothing to debate.", positions: [] } };
    case "implementation":
      return { json: { statement: "Nothing to patch.", patches: [], declined: [] } };
    case "verdict":
      return { json: { statement: "Nothing stands in the way.", decision: "approve", mergeRisk: "low", summary: "No findings.", humanAttention: [] } };
  }
}

/** A stand-in for the Claude API that lasts until the test ends. It refuses every renewal unless `renew` says otherwise. */
export async function claudeApi(reply: (request: RecordedRequest) => Reply = quietCouncil, renew?: (renewal: RecordedRenewal) => Renewal): Promise<FakeAnthropic> {
  const api = await startFakeAnthropic(reply, renew);
  cleanups.push(api.close);
  return api;
}

export interface Logged {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Record<string, unknown> | undefined;
}

export function recordingLogger(): { logger: Logger; lines: Logged[] } {
  const lines: Logged[] = [];
  return {
    lines,
    logger: {
      info: (message, data) => void lines.push({ level: "info", message, data }),
      warn: (message, data) => void lines.push({ level: "warn", message, data }),
      error: (message, data) => void lines.push({ level: "error", message, data }),
    },
  };
}

/** Starts the server's application on these variables, as the lines of a .env file. */
export async function startServer(variables: NodeJS.ProcessEnv, logger: Logger = silentLogger) {
  const dataDir = await temporaryDirectory("coder-credentials-");
  const config = loadConfig({ CODER_DATA_DIR: dataDir, ...variables });
  return { config, dataDir, ...(await createServerApplication(config, logger)) };
}

/**
 * Starts the server and lets the Claude council review one pull request.
 * The API's address reaches the SDK through the configuration alone: the one
 * in the process environment is an address nothing listens on (hermetic.ts),
 * so a request arrives at the stand-in only if CodeR handed the address over.
 */
export async function review(api: FakeAnthropic, credentials: NodeJS.ProcessEnv, logger: Logger = silentLogger) {
  const server = await startServer({ ANTHROPIC_BASE_URL: api.baseURL, ...credentials }, logger);
  return { ...server, ...(await reviewOn(server)) };
}

/** Lets the Claude council of a started server review one pull request, to the end. */
export async function reviewOn(server: Pick<Awaited<ReturnType<typeof createServerApplication>>, "application" | "conductReview">) {
  const { sessionId } = await server.application.startReview(coupon, { language: "en", engine: "claude" });
  await server.conductReview.whenSettled(sessionId);
  const state = await server.application.session(sessionId);
  return { state, failure: state.statements.find((statement) => statement.failed)?.text };
}

/** Everything a review left in the data directory, as one text to search. */
export async function storedIn(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

export interface StoredTokens {
  readonly accessToken: string;
  /** Seconds from now; negative for a token that has run out. */
  readonly expiresIn: number;
  readonly refreshToken?: string;
}

export interface SignInFiles {
  readonly directory: string;
  readonly settingsFile: string;
  readonly tokensFile: string;
}

/**
 * A Claude Console sign-in as `ant auth login` leaves it on a machine:
 * settings under configs/, tokens under credentials/, readable by the user
 * only. `settings` adds to the settings file or replaces what is in it.
 */
export async function signIn(profile: string, tokens: StoredTokens, settings: Record<string, unknown> = {}): Promise<SignInFiles> {
  const directory = await temporaryDirectory("coder-anthropic-");
  await mkdir(join(directory, "configs"));
  await mkdir(join(directory, "credentials"));
  const settingsFile = join(directory, "configs", `${profile}.json`);
  await writeFile(settingsFile, JSON.stringify({ version: "1.0", authentication: { type: "user_oauth", client_id: "client-of-the-test" }, ...settings }));
  const tokensFile = join(directory, "credentials", `${profile}.json`);
  await writeFile(
    tokensFile,
    JSON.stringify({
      version: "1.0",
      type: "oauth_token",
      access_token: tokens.accessToken,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expiresIn,
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    }),
    { mode: 0o600 },
  );
  vi.stubEnv("ANTHROPIC_CONFIG_DIR", directory);
  return { directory, settingsFile, tokensFile };
}

export function betas(request: RecordedRequest): string[] {
  return String(request.headers["anthropic-beta"] ?? "")
    .split(",")
    .map((beta) => beta.trim());
}
