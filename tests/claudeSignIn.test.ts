import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betas, claudeApi, CODER_BETA, OAUTH_BETA, quietCouncil, recordingLogger, review, signIn, startServer, storedIn, tidyUp } from "./support/claudeServer.js";

/**
 * The Claude Console sign-in that `ant auth login` stores on a machine, as
 * the server's credential: what goes out, where it is renewed, what stops the
 * start, and what a reviewer says when it fails.
 */

// Made up, and as long as the real ones.
const ACCESS = "sk-ant-oat01-access-of-the-sign-in-0123456789";
const RENEWED = "sk-ant-oat01-renewed-access-0123456789abcdef";
const REFRESH = "sk-ant-ort01-refresh-of-the-sign-in-0123456789";
const NEXT_REFRESH = "sk-ant-ort01-next-refresh-0123456789abcdef";
const KEY = "sk-ant-api03-key-of-the-test-0123456789abcdef";

const fresh = { accessToken: ACCESS, expiresIn: 3600, refreshToken: REFRESH };
const ranOut = { accessToken: ACCESS, expiresIn: -60, refreshToken: REFRESH };
const renewal = () => ({ accessToken: RENEWED, expiresIn: 3600, refreshToken: NEXT_REFRESH });
const again = "`ant auth login --profile work` again.";

afterEach(tidyUp);

describe("the Console sign-in as the server's credential", () => {
  it("is used as stored on this machine, in the workspace it was made for", async () => {
    const api = await claudeApi();
    await signIn("work", fresh, { base_url: api.baseURL, workspace_id: "wrkspc_01test" });
    const { state, claude } = await review(api, { ANTHROPIC_PROFILE: "work" });
    expect(state.status).toBe("concluded");
    expect(claude).toEqual({ model: "claude-opus-5-5", credential: "Console sign-in (profile work)", api: api.baseURL });
    expect(api.renewals).toHaveLength(0);
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${ACCESS}`);
      expect(request.headers["anthropic-workspace-id"]).toBe("wrkspc_01test");
      expect(betas(request).sort()).toEqual([OAUTH_BETA, CODER_BETA].sort());
    }
  });

  it("is renewed when its token ran out, and the new tokens are kept for the next start", async () => {
    const api = await claudeApi(quietCouncil, renewal);
    const { tokensFile } = await signIn("default", ranOut, { base_url: api.baseURL });
    const { state } = await review(api, { ANTHROPIC_PROFILE: "default" });
    expect(state.status).toBe("concluded");

    expect(api.renewals).toHaveLength(1); // one renewal serves the whole review
    expect(api.renewals[0]!.body).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: "client-of-the-test" });
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) expect(request.headers.authorization).toBe(`Bearer ${RENEWED}`);

    const stored = JSON.parse(await readFile(tokensFile, "utf8"));
    expect(stored).toMatchObject({ access_token: RENEWED, refresh_token: NEXT_REFRESH });
    expect(stored.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("is renewed, and the request sent again, when the API refuses a token that still looked good", async () => {
    const revoked = { status: 401, errorType: "authentication_error", message: "OAuth token has been revoked." };
    const api = await claudeApi((request) => (request.headers.authorization === `Bearer ${ACCESS}` ? revoked : quietCouncil(request)), renewal);
    await signIn("work", fresh, { base_url: api.baseURL });
    const { state } = await review(api, { ANTHROPIC_PROFILE: "work" });
    expect(state.status).toBe("concluded");
    expect(api.renewals).toHaveLength(1);
    expect(api.requests.filter((request) => request.headers.authorization === `Bearer ${ACCESS}`)).toHaveLength(1);
  });

  it("is renewed at its own address when its settings name one, while the reviews go where ANTHROPIC_BASE_URL says", async () => {
    const gateway = await claudeApi();
    const anthropic = await claudeApi(quietCouncil, renewal);
    await signIn("work", ranOut, { base_url: anthropic.baseURL });
    const { state, claude } = await review(gateway, { ANTHROPIC_PROFILE: "work" });
    expect(state.status).toBe("concluded");
    expect(claude).toMatchObject({ api: gateway.baseURL, renewsAt: anthropic.baseURL });
    expect({ gateway: gateway.renewals.length, anthropic: anthropic.renewals.length }).toEqual({ gateway: 0, anthropic: 1 });
    expect(anthropic.requests).toHaveLength(0);
    expect(gateway.requests.length).toBeGreaterThan(0);
    for (const request of gateway.requests) expect(request.headers.authorization).toBe(`Bearer ${RENEWED}`);
  });

  it("is renewed where ANTHROPIC_BASE_URL says when its settings name no address", async () => {
    const api = await claudeApi(quietCouncil, renewal);
    await signIn("work", ranOut);
    // What the settings leave out, the SDK takes from the process's own variables: the ones main loads from .env.
    vi.stubEnv("ANTHROPIC_BASE_URL", api.baseURL);
    const { state, claude } = await review(api, { ANTHROPIC_PROFILE: "work" });
    expect(state.status).toBe("concluded");
    expect(claude).toEqual({ model: "claude-opus-5-5", credential: "Console sign-in (profile work)", api: api.baseURL });
    expect(api.renewals).toHaveLength(1);
  });
});

describe("a sign-in that could not work stops the start", () => {
  const refusal = (problem: string) => `Invalid configuration:\n  ANTHROPIC_PROFILE: ${problem}`;

  it("when this machine has none under that name", async () => {
    const { directory } = await signIn("default", fresh);
    await expect(startServer({ ANTHROPIC_PROFILE: "work" })).rejects.toThrow(
      refusal(
        `this machine has no Claude Console sign-in named "work": ${join(directory, "configs", "work.json")} does not exist. ` +
          "Run `ant auth login --profile work` in a terminal, or take ANTHROPIC_PROFILE out of .env and of the shell.",
      ),
    );
  });

  it("and says which credential it was preferred to, before it stops", async () => {
    await signIn("default", fresh);
    const { logger, lines } = recordingLogger();
    await expect(startServer({ ANTHROPIC_PROFILE: "work", ANTHROPIC_API_KEY: KEY }, logger)).rejects.toThrow(
      "or take ANTHROPIC_PROFILE out of .env and of the shell to fall back on ANTHROPIC_API_KEY.",
    );
    expect(lines).toContainEqual({
      level: "warn",
      message: "More than one Claude credential is set. CodeR prefers an auth token to the Console sign-in, and both to an API key.",
      data: { using: "Console sign-in (profile work)", ignored: ["ANTHROPIC_API_KEY"] },
    });
  });

  it("when its settings cannot be read", async () => {
    const { settingsFile } = await signIn("work", fresh);
    await writeFile(settingsFile, "{ not json");
    await expect(startServer({ ANTHROPIC_PROFILE: "work" })).rejects.toThrow(
      /ANTHROPIC_PROFILE: the settings of the sign-in "work" cannot be read \(failed to parse config file .*\)\. Run `ant auth login --profile work` again\./,
    );
  });

  it("when the profile is a workload identity federation, which is not a sign-in", async () => {
    await signIn("ci", fresh, { organization_id: "org_01test", authentication: { type: "oidc_federation", federation_rule_id: "fdrl_01test" } });
    await expect(startServer({ ANTHROPIC_PROFILE: "ci" })).rejects.toThrow(
      refusal(
        'the profile "ci" is not a Console sign-in but a workload identity federation, which CodeR does not take yet. Use a sign-in made with `ant auth login`, an auth token or an API key.',
      ),
    );
  });

  it("when its tokens are missing", async () => {
    const { tokensFile } = await signIn("work", fresh);
    await rm(tokensFile);
    await expect(startServer({ ANTHROPIC_PROFILE: "work" })).rejects.toThrow(refusal(`the sign-in "work" has no tokens this user can read (${tokensFile}). Run ${again}`));
  });

  it.skipIf(process.platform === "win32")("when other users of the machine could read its tokens", async () => {
    const { tokensFile } = await signIn("work", fresh);
    await chmod(tokensFile, 0o644);
    await expect(startServer({ ANTHROPIC_PROFILE: "work" })).rejects.toThrow(
      /ANTHROPIC_PROFILE: the tokens of the sign-in "work" cannot be used as they are\. Credentials file at .* is group\/world-readable \(mode 0o644\); run `chmod 600 .*` before retrying\./,
    );
  });

  // Root writes wherever it likes, so for root there is nothing to refuse.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("when a renewed token could not be saved", async () => {
    const { tokensFile } = await signIn("work", fresh);
    const directory = dirname(tokensFile);
    await chmod(directory, 0o500);
    try {
      await expect(startServer({ ANTHROPIC_PROFILE: "work" })).rejects.toThrow(
        refusal(`the tokens of the sign-in "work" are renewed in place, and this user cannot write to ${directory}: a renewed token could not be saved.`),
      );
    } finally {
      await chmod(directory, 0o700); // or the directory could not be removed after the test
    }
  });

  it("when it would travel in the clear to another machine", async () => {
    const { settingsFile } = await signIn("work", fresh);
    await expect(startServer({ ANTHROPIC_PROFILE: "work", ANTHROPIC_BASE_URL: "http://gateway.example.com/claude" })).rejects.toThrow(
      refusal(
        `the sign-in "work" would travel in the clear to http://gateway.example.com. Use an https address, in ANTHROPIC_BASE_URL or in base_url of ${settingsFile}, or another credential.`,
      ),
    );
    // Its own address is held to the same rule: that is where the refresh token goes.
    await signIn("work", fresh, { base_url: "http://console.example.com" });
    await expect(startServer({ ANTHROPIC_PROFILE: "work", ANTHROPIC_BASE_URL: "https://gateway.example.com" })).rejects.toThrow(
      'the sign-in "work" would travel in the clear to http://console.example.com.',
    );
  });
});

describe("a sign-in that fails during a review", () => {
  it("is sent back to the login when it can no longer be renewed, with nothing of what the endpoint echoed", async () => {
    const { logger, lines } = recordingLogger();
    // An endpoint that repeats the refresh token it was sent.
    const api = await claudeApi(quietCouncil, (asked) => ({ status: 400, error: "invalid_grant", description: `refresh token ${asked.body.refresh_token} has expired` }));
    await signIn("work", ranOut, { base_url: api.baseURL });
    const { state, failure, dataDir } = await review(api, { ANTHROPIC_PROFILE: "work" }, logger);

    expect(state.status).toBe("failed");
    expect(api.renewals.length).toBeGreaterThan(0);
    expect(api.requests).toHaveLength(0); // no review was sent with a token known to be dead
    expect(failure).toBe(`The Console sign-in could not be renewed (HTTP 400, invalid_grant). Try once more; if it fails the same way, run ${again}`);
    for (const text of [JSON.stringify(lines), JSON.stringify(state), await storedIn(dataDir)]) {
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(ACCESS);
    }
  });

  it("is told to wait when the token endpoint is what fails, and no more than the status when the address renews nothing", async () => {
    const overloaded = await claudeApi(quietCouncil, () => ({ status: 503, error: "overloaded" }));
    await signIn("work", ranOut, { base_url: overloaded.baseURL });
    expect((await review(overloaded, { ANTHROPIC_PROFILE: "work" })).failure).toBe("The Console sign-in could not be renewed (HTTP 503, overloaded). Try again in a moment.");

    // A gateway that passes the Messages API on and nothing else.
    const gateway = await claudeApi(quietCouncil, () => ({ status: 404, error: "Not Found" }));
    await signIn("work", ranOut, { base_url: gateway.baseURL });
    expect((await review(gateway, { ANTHROPIC_PROFILE: "work" })).failure).toBe("The Console sign-in could not be renewed (HTTP 404).");
  });

  it("is sent back to the login when its token ran out and nothing can renew it", async () => {
    const api = await claudeApi();
    const { tokensFile } = await signIn("work", { accessToken: ACCESS, expiresIn: -60 }, { base_url: api.baseURL });
    const { failure } = await review(api, { ANTHROPIC_PROFILE: "work" });
    expect(failure).toBe(
      `The Console sign-in could not be used: Access token at ${tokensFile} has expired and no refresh is available (client_id set, refresh_token empty). Run ${again}`,
    );
  });

  it("does not quote stored tokens it could not parse", async () => {
    const api = await claudeApi();
    const { tokensFile } = await signIn("work", fresh, { base_url: api.baseURL });
    await writeFile(tokensFile, `${ACCESS} was cut short`);
    const { failure } = await review(api, { ANTHROPIC_PROFILE: "work" });
    expect(failure).toBe(`The Console sign-in could not be used: Credentials file at ${tokensFile} is not valid JSON. Run ${again}`);
  });

  it("is sent back to the login when the API refuses it even after a renewal", async () => {
    const api = await claudeApi(() => ({ status: 401, errorType: "authentication_error", message: "OAuth token has been revoked." }), renewal);
    await signIn("work", fresh, { base_url: api.baseURL });
    const { failure } = await review(api, { ANTHROPIC_PROFILE: "work" });
    expect(failure).toBe(`The Claude API refused the Console sign-in (OAuth token has been revoked). Run ${again}`);
  });
});
