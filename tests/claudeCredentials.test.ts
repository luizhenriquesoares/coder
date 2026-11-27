import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/application/ports.js";
import { loadConfig } from "../src/composition/config.js";
import { createServerApplication } from "../src/composition/server.js";
import type { PullRequestRef } from "../src/domain/change/types.js";
import { startFakeAnthropic, type FakeAnthropic, type RecordedRenewal, type RecordedRequest, type Renewal, type Reply } from "./support/fakeAnthropic.js";

/**
 * Which credential the server presents to the Claude API: the real
 * configuration and composition root and the real SDK, talking to a local
 * stand-in for the API.
 */

const coupon: PullRequestRef = { provider: "demo", owner: "acme", repo: "storefront", number: 128 };
const OAUTH_BETA = "oauth-2025-04-20";
const CODER_BETA = "server-side-fallback-2026-07-01";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A council with nothing to say: these tests look at how each request is authenticated, not at the review. */
function quietCouncil(request: RecordedRequest): Reply {
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

/** Starts the server's application on this environment and lets the Claude council review one pull request. */
async function reviewWith(
  credentials: NodeJS.ProcessEnv,
  reply: (request: RecordedRequest) => Reply = quietCouncil,
  renew?: (renewal: RecordedRenewal) => Renewal,
) {
  const api: FakeAnthropic = await startFakeAnthropic(reply, renew);
  cleanups.push(api.close);
  // As when the server runs: the SDK reads the API's address from the same environment the configuration does.
  // Without this, a sign-in on a machine that exports another address would renew its token there.
  vi.stubEnv("ANTHROPIC_BASE_URL", api.baseURL);
  const config = loadConfig({ CODER_DATA_DIR: await temporaryDirectory("coder-credentials-"), ANTHROPIC_BASE_URL: api.baseURL, ...credentials });
  const { application, conductReview } = await createServerApplication(config, silentLogger);
  const { sessionId } = await application.startReview(coupon, { language: "en", engine: "claude" });
  await conductReview.whenSettled(sessionId);
  return { api, config, state: await application.session(sessionId) };
}

interface StoredTokens {
  readonly accessToken: string;
  /** Seconds from now; negative for a token that has run out. */
  readonly expiresIn: number;
  readonly refreshToken?: string;
}

/**
 * A Claude Console sign-in as `ant auth login` leaves it on a machine:
 * settings under configs/, tokens under credentials/, readable by the user only.
 */
async function signIn(profile: string, tokens: StoredTokens, settings: Record<string, unknown> = {}): Promise<{ tokensFile: string }> {
  const directory = await temporaryDirectory("coder-anthropic-");
  await mkdir(join(directory, "configs"));
  await mkdir(join(directory, "credentials"));
  await writeFile(
    join(directory, "configs", `${profile}.json`),
    JSON.stringify({ version: "1.0", authentication: { type: "user_oauth", client_id: "client-of-the-test" }, ...settings }),
  );
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
  return { tokensFile };
}

function betas(request: RecordedRequest): string[] {
  return String(request.headers["anthropic-beta"] ?? "")
    .split(",")
    .map((beta) => beta.trim());
}

describe("choosing the Claude credential", () => {
  const credentialOf = (env: NodeJS.ProcessEnv) => loadConfig(env).claude;

  it("leaves the Claude council off when none is set", () => {
    expect(credentialOf({})).toMatchObject({ credential: null, ignoredCredentials: [] });
    // The lines of .env.example, copied and left empty.
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_PROFILE: " ", ANTHROPIC_API_KEY: "" })).toMatchObject({ credential: null, ignoredCredentials: [] });
  });

  it("takes whichever one is set", () => {
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" }).credential).toEqual({ kind: "auth-token", token: "sk-ant-oat01-token", oauth: true });
    expect(credentialOf({ ANTHROPIC_PROFILE: "default" }).credential).toEqual({ kind: "sign-in", profile: "default" });
    expect(credentialOf({ ANTHROPIC_API_KEY: "sk-ant-api03-key" }).credential).toEqual({ kind: "api-key", key: "sk-ant-api03-key" });
  });

  it("prefers an auth token to the sign-in, and both to an API key", () => {
    const all = { ANTHROPIC_API_KEY: "sk-ant-api03-key", ANTHROPIC_PROFILE: "work", ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" };
    expect(credentialOf(all)).toMatchObject({ credential: { kind: "auth-token" }, ignoredCredentials: ["ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY"] });
    expect(credentialOf({ ...all, ANTHROPIC_AUTH_TOKEN: "" })).toMatchObject({ credential: { kind: "sign-in" }, ignoredCredentials: ["ANTHROPIC_API_KEY"] });
    expect(credentialOf({ ...all, ANTHROPIC_PROFILE: "" })).toMatchObject({ credential: { kind: "auth-token" }, ignoredCredentials: ["ANTHROPIC_API_KEY"] });
  });

  it("tells an OAuth access token from the token of a gateway", () => {
    const oauth = (env: NodeJS.ProcessEnv) => credentialOf(env).credential;
    const gateway = "https://llm-gateway.example.com";
    expect(oauth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" })).toMatchObject({ oauth: true });
    // A proxy that forwards the caller's own token: still Anthropic's, still OAuth.
    expect(oauth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token", ANTHROPIC_BASE_URL: gateway })).toMatchObject({ oauth: true });
    expect(oauth({ ANTHROPIC_AUTH_TOKEN: "team-key-of-the-gateway", ANTHROPIC_BASE_URL: gateway })).toMatchObject({ oauth: false });
    // Straight to Anthropic, a token that is not an API key can only be an OAuth one.
    expect(oauth({ ANTHROPIC_AUTH_TOKEN: "a-token-of-another-shape" })).toMatchObject({ oauth: true });
    expect(oauth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-key" })).toMatchObject({ oauth: false });
  });

  it("trims what was pasted, and refuses a profile name that could not be a file name", () => {
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: " sk-ant-oat01-token\n" }).credential).toMatchObject({ token: "sk-ant-oat01-token" });
    expect(credentialOf({ ANTHROPIC_PROFILE: " work " }).credential).toEqual({ kind: "sign-in", profile: "work" });
    for (const name of ["../default", "a/b", "..", "my profile"]) {
      expect(() => credentialOf({ ANTHROPIC_PROFILE: name }), name).toThrow(/ANTHROPIC_PROFILE: a profile name has only/);
    }
  });
});

describe("what the server presents to the Claude API", () => {
  it("sends an API key", async () => {
    const { api, state } = await reviewWith({ ANTHROPIC_API_KEY: "sk-ant-api03-key" });
    expect(state.status).toBe("concluded");
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      // The SDK decides which header carries the key; what matters is that it is sent.
      expect(`${request.headers["x-api-key"]} ${request.headers.authorization}`).toContain("sk-ant-api03-key");
      expect(betas(request)).toEqual([CODER_BETA]);
    }
  });

  it("sends the auth token as a bearer token, whatever key is also around", async () => {
    // Left alone, the SDK would take a key from the process environment before any token.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-exported-in-the-shell");
    const { api, state, config } = await reviewWith({ ANTHROPIC_AUTH_TOKEN: "team-key-of-the-gateway", ANTHROPIC_API_KEY: "sk-ant-api03-in-the-env-file" });
    expect(config.claude.ignoredCredentials).toEqual(["ANTHROPIC_API_KEY"]);
    expect(state.status).toBe("concluded");
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe("Bearer team-key-of-the-gateway");
      expect(request.headers["x-api-key"]).toBeUndefined();
      // A gateway gets the token and nothing it did not ask for.
      expect(betas(request)).toEqual([CODER_BETA]);
    }
  });

  it("announces an OAuth access token as OAuth, next to the beta CodeR itself asks for", async () => {
    const { api, state } = await reviewWith({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" });
    expect(state.status).toBe("concluded");
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe("Bearer sk-ant-oat01-token");
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(betas(request).sort()).toEqual([OAUTH_BETA, CODER_BETA].sort());
    }
  });

  it("uses the Console sign-in stored on this machine, in the workspace it was made for", async () => {
    await signIn("work", { accessToken: "sk-ant-oat01-signed-in", expiresIn: 3600, refreshToken: "sk-ant-ort01-renew" }, { workspace_id: "wrkspc_01test" });
    const { api, state } = await reviewWith({ ANTHROPIC_PROFILE: "work" });
    expect(state.status).toBe("concluded");
    expect(api.renewals).toHaveLength(0);
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe("Bearer sk-ant-oat01-signed-in");
      expect(request.headers["anthropic-workspace-id"]).toBe("wrkspc_01test");
      expect(betas(request).sort()).toEqual([OAUTH_BETA, CODER_BETA].sort());
    }
  });

  it("renews a sign-in whose token ran out, once, and keeps the new one for the next start", async () => {
    const { tokensFile } = await signIn("default", { accessToken: "sk-ant-oat01-ran-out", expiresIn: -60, refreshToken: "sk-ant-ort01-first" });
    const { api, state } = await reviewWith({ ANTHROPIC_PROFILE: "default" }, quietCouncil, () => ({
      accessToken: "sk-ant-oat01-renewed",
      expiresIn: 3600,
      refreshToken: "sk-ant-ort01-second",
    }));
    expect(state.status).toBe("concluded");

    expect(api.renewals).toHaveLength(1); // the reviewers of a round ask at the same moment and share one renewal
    expect(api.renewals[0]!.body).toEqual({ grant_type: "refresh_token", refresh_token: "sk-ant-ort01-first", client_id: "client-of-the-test" });
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) expect(request.headers.authorization).toBe("Bearer sk-ant-oat01-renewed");

    const stored = JSON.parse(await readFile(tokensFile, "utf8"));
    expect(stored).toMatchObject({ access_token: "sk-ant-oat01-renewed", refresh_token: "sk-ant-ort01-second" });
    expect(stored.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("does not start on a sign-in this machine does not have", async () => {
    await signIn("default", { accessToken: "sk-ant-oat01-signed-in", expiresIn: 3600 });
    const config = loadConfig({ CODER_DATA_DIR: await temporaryDirectory("coder-credentials-"), ANTHROPIC_PROFILE: "work" });
    await expect(createServerApplication(config, silentLogger)).rejects.toThrow(
      'ANTHROPIC_PROFILE: this machine has no Claude Console sign-in named "work". Run `ant auth login --profile work` in a terminal, or remove ANTHROPIC_PROFILE.',
    );
  });
});

describe("a credential the API refuses", () => {
  const refuse = (message: string) => (): Reply => ({ status: 401, errorType: "authentication_error", message });
  const firstFailure = (state: { statements: readonly { text: string; failed: boolean }[] }) => state.statements.find((statement) => statement.failed)?.text;

  it("says which credential it was and what to do about it", async () => {
    const key = await reviewWith({ ANTHROPIC_API_KEY: "sk-ant-api03-key" }, refuse("invalid x-api-key"));
    expect(key.state.status).toBe("failed");
    expect(firstFailure(key.state)).toBe("The Claude API refused the API key (invalid x-api-key). Check ANTHROPIC_API_KEY.");

    const token = await reviewWith({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" }, refuse("OAuth token has expired."));
    expect(token.state.status).toBe("failed");
    expect(firstFailure(token.state)).toBe("The Claude API refused the auth token (OAuth token has expired). Set a fresh ANTHROPIC_AUTH_TOKEN and restart CodeR.");
  });

  it("sends back to the login a sign-in that can no longer be renewed", async () => {
    await signIn("work", { accessToken: "sk-ant-oat01-ran-out", expiresIn: -60, refreshToken: "sk-ant-ort01-dead" });
    const { api, state } = await reviewWith({ ANTHROPIC_PROFILE: "work" }); // the stand-in refuses every renewal
    expect(state.status).toBe("failed");
    expect(api.requests).toHaveLength(0); // no review was sent with a token known to be dead
    const failure = firstFailure(state)!;
    expect(failure).toMatch(/^The Console sign-in could not be used: User OAuth refresh failed \(HTTP 400\)/);
    expect(failure).toMatch(/Run `ant auth login --profile work` again\.$/);
    expect(failure).not.toContain("sk-ant-ort01-dead");
  });

  it("passes on the API's own reason when the organization has no credits", async () => {
    const noCredits = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    await signIn("default", { accessToken: "sk-ant-oat01-signed-in", expiresIn: 3600 });
    const { state } = await reviewWith({ ANTHROPIC_PROFILE: "default" }, () => ({ status: 400, errorType: "invalid_request_error", message: noCredits }));
    expect(state.status).toBe("failed");
    expect(firstFailure(state)).toBe(`The Claude API rejected the request: ${noCredits}`);
  });
});
