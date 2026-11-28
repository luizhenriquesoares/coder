import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/composition/config.js";
import { createServerApplication, startupSummary } from "../src/composition/server.js";
import { SentCredentials, withoutSecrets } from "../src/infrastructure/claude/redaction.js";
import { betas, claudeApi, CODER_BETA, leftBehind, OAUTH_BETA, recordingLogger, review, reviewOn, startServer, temporaryDirectory, tidyUp } from "./support/claudeServer.js";

/**
 * Which credential the server presents to the Claude API, what it says when
 * the API refuses it, and where the secret must never show up.
 */

// Made up, and as long as the real ones.
const KEY = "sk-ant-api03-key-of-the-test-0123456789abcdef";
const OAUTH_TOKEN = "sk-ant-oat01-token-of-the-test-0123456789abcdef";
const GATEWAY_TOKEN = "team-key-of-the-gateway";

afterEach(tidyUp);

describe("choosing the Claude credential", () => {
  const claudeOf = (env: NodeJS.ProcessEnv) => loadConfig(env).claude;
  const refusalOf = (env: NodeJS.ProcessEnv): string => {
    try {
      loadConfig(env);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("leaves the Claude council off when none is set", () => {
    expect(claudeOf({})).toMatchObject({ credential: null, ignoredCredentials: [] });
    // The lines of .env.example, copied and left empty.
    expect(claudeOf({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_PROFILE: " ", ANTHROPIC_API_KEY: "" })).toMatchObject({ credential: null, ignoredCredentials: [] });
  });

  it("takes whichever one is set", () => {
    expect(claudeOf({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" }).credential).toEqual({ kind: "auth-token", token: "sk-ant-oat01-token", oauth: true });
    expect(claudeOf({ ANTHROPIC_PROFILE: "default" }).credential).toEqual({ kind: "sign-in", profile: "default" });
    expect(claudeOf({ ANTHROPIC_API_KEY: "sk-ant-api03-key" }).credential).toEqual({ kind: "api-key", key: "sk-ant-api03-key" });
  });

  it("prefers an auth token to the sign-in, and both to an API key", () => {
    const all = { ANTHROPIC_API_KEY: "sk-ant-api03-key", ANTHROPIC_PROFILE: "work", ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" };
    expect(claudeOf(all)).toMatchObject({ credential: { kind: "auth-token" }, ignoredCredentials: ["ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY"] });
    expect(claudeOf({ ...all, ANTHROPIC_AUTH_TOKEN: "" })).toMatchObject({ credential: { kind: "sign-in" }, ignoredCredentials: ["ANTHROPIC_API_KEY"] });
    expect(claudeOf({ ...all, ANTHROPIC_PROFILE: "" })).toMatchObject({ credential: { kind: "auth-token" }, ignoredCredentials: ["ANTHROPIC_API_KEY"] });
  });

  it("tells an OAuth access token from a key and from the token of a gateway", () => {
    const credentialOf = (env: NodeJS.ProcessEnv) => claudeOf(env).credential;
    const gateway = "https://llm-gateway.example.com";
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token" })).toMatchObject({ oauth: true });
    // A proxy that forwards the caller's own token: still Anthropic's, still OAuth.
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token", ANTHROPIC_BASE_URL: gateway })).toMatchObject({ oauth: true });
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "team-key-of-the-gateway", ANTHROPIC_BASE_URL: gateway })).toMatchObject({ oauth: false });
    // Straight to Anthropic, a token that is not one of its keys can only be an OAuth one.
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "a-token-of-another-shape" })).toMatchObject({ oauth: true });
    expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: "a-token-of-another-shape", ANTHROPIC_BASE_URL: "https://api.anthropic.com/" })).toMatchObject({ oauth: true });
    // Anthropic's other secrets are not access tokens, whatever line they were pasted on.
    for (const other of ["sk-ant-api03-key", "sk-ant-admin01-key", "sk-ant-ort01-refresh-token"]) {
      expect(credentialOf({ ANTHROPIC_AUTH_TOKEN: other }), other).toMatchObject({ oauth: false });
    }
  });

  it("trims what was pasted", () => {
    expect(claudeOf({ ANTHROPIC_AUTH_TOKEN: " sk-ant-oat01-token\n" }).credential).toMatchObject({ token: "sk-ant-oat01-token" });
    expect(claudeOf({ ANTHROPIC_API_KEY: "\tsk-ant-api03-key\r\n" }).credential).toEqual({ kind: "api-key", key: "sk-ant-api03-key" });
    expect(claudeOf({ ANTHROPIC_PROFILE: " work " }).credential).toEqual({ kind: "sign-in", profile: "work" });
  });

  it("refuses a key or a token that could not travel in a header, without repeating it", () => {
    const broken = [
      "sk-ant-oat01-SECRETPART1\nSECRETPART2", // a quoted value that wrapped onto a second line
      "sk-ant-oat01-SECRETPART1\r\nSECRETPART2",
      "Bearer sk-ant-oat01-SECRETPART1", // copied with its header prefix
      '"sk-ant-oat01-SECRETPART1"',
      "'sk-ant-oat01-SECRETPART1'",
      "sk-ant-oat01-SECRETPART1\\",
      "sk-ant-oat01-SECRETPART1​SECRETPART2", // a zero-width space, as a web page may leave in a copy
      "sk-ant-oat01-SECRETPARTé",
    ];
    for (const variable of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
      for (const value of broken) {
        const refusal = refusalOf({ [variable]: value });
        expect(refusal, `${variable}=${JSON.stringify(value)}`).toContain(`${variable}: the value has a space, a quote, a backslash, a line break or a character outside ASCII.`);
        expect(refusal).not.toContain("SECRETPART");
      }
    }
  });

  it("refuses a profile name that could not be a file name, and a secret on the wrong line", () => {
    for (const name of ["../default", "a/b", "my profile"]) {
      expect(refusalOf({ ANTHROPIC_PROFILE: name }), name).toContain("ANTHROPIC_PROFILE: a profile name has only letters, digits, '_', '-' and '.'");
    }
    for (const name of [".", ".."]) {
      expect(refusalOf({ ANTHROPIC_PROFILE: name }), name).toContain(`ANTHROPIC_PROFILE: "${name}" is not the name of a sign-in`);
    }
    // The name of a sign-in ends up in the log and in the messages. A key or a token pasted on its line must not:
    // one of Anthropic's or of GitHub's by how it begins, and any other by its length.
    for (const secret of ["sk-ant-api03-SECRETPART", "SK-ANT-API03-SECRETPART", "ghp_SECRETPART0123456789", "github_pat_SECRETPART", "SECRETPART-of-33-characters-xxxxx"]) {
      const refusal = refusalOf({ ANTHROPIC_PROFILE: secret });
      expect(refusal, secret).toContain("ANTHROPIC_PROFILE: this looks like a key or a token, not the name of a sign-in.");
      expect(refusal).not.toContain("SECRETPART");
    }
    expect(claudeOf({ ANTHROPIC_PROFILE: "a-name-as-long-as-a-name-may-be." }).credential).toEqual({ kind: "sign-in", profile: "a-name-as-long-as-a-name-may-be." });
  });

  it("holds only the credential it uses to its rule", () => {
    // Placeholders on the lines CodeR sets aside: some set-ups want the variables to exist.
    const gateway = { ANTHROPIC_AUTH_TOKEN: "team-key-of-the-gateway", ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" };
    expect(claudeOf({ ...gateway, ANTHROPIC_PROFILE: "no profile", ANTHROPIC_API_KEY: "not needed" })).toMatchObject({
      credential: { kind: "auth-token", token: "team-key-of-the-gateway" },
      ignoredCredentials: ["ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY"],
    });
    // Used, each of them stops the start.
    expect(refusalOf({ ANTHROPIC_PROFILE: "no profile", ANTHROPIC_API_KEY: "not needed" })).toContain("ANTHROPIC_PROFILE: a profile name has only letters");
    expect(refusalOf({ ANTHROPIC_API_KEY: "not needed" })).toContain("ANTHROPIC_API_KEY: the value has a space");
  });

  it("notices a credential among the headers of ANTHROPIC_CUSTOM_HEADERS", () => {
    expect(claudeOf({ ANTHROPIC_API_KEY: "sk-ant-api03-key", ANTHROPIC_CUSTOM_HEADERS: "X-Team: reviews" }).credentialHeaders).toEqual([]);
    const headers = "X-Team: reviews\nauthorization: Bearer another\n X-Api-Key : another";
    expect(claudeOf({ ANTHROPIC_API_KEY: "sk-ant-api03-key", ANTHROPIC_CUSTOM_HEADERS: headers }).credentialHeaders).toEqual(["authorization", "X-Api-Key"]);
  });
});

describe("what the server presents to the Claude API", () => {
  it("sends an API key, to the address the configuration names", async () => {
    const api = await claudeApi();
    const { state, claude } = await review(api, { ANTHROPIC_API_KEY: KEY });
    expect(state.status).toBe("concluded");
    expect(claude).toEqual({ model: "claude-opus-5-5", credential: "API key", api: api.baseURL });
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      // The SDK decides which header carries the key; what matters is that it is sent.
      expect(`${request.headers["x-api-key"]} ${request.headers.authorization}`).toContain(KEY);
      expect(betas(request)).toEqual([CODER_BETA]);
    }
  });

  it("sends the auth token as a bearer token, whatever key is also around", async () => {
    // Left alone, the SDK would take a key from the process environment before any token.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-exported-in-the-shell");
    const api = await claudeApi();
    const { state, config, claude } = await review(api, { ANTHROPIC_AUTH_TOKEN: GATEWAY_TOKEN, ANTHROPIC_API_KEY: "sk-ant-api03-in-the-env-file" });
    expect(config.claude.ignoredCredentials).toEqual(["ANTHROPIC_API_KEY"]);
    expect(claude?.credential).toBe("auth token");
    expect(state.status).toBe("concluded");
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
      expect(request.headers["x-api-key"]).toBeUndefined();
      // A gateway gets the token and nothing it did not ask for.
      expect(betas(request)).toEqual([CODER_BETA]);
    }
  });

  it("announces an OAuth access token as OAuth, next to the beta CodeR itself asks for", async () => {
    const api = await claudeApi();
    const { state, claude } = await review(api, { ANTHROPIC_AUTH_TOKEN: OAUTH_TOKEN });
    expect(claude?.credential).toBe("auth token (OAuth)");
    expect(state.status).toBe("concluded");
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(betas(request).sort()).toEqual([OAUTH_BETA, CODER_BETA].sort());
    }
  });

  it("says what it runs on once it listens, and none of its secrets", async () => {
    const secrets = {
      ANTHROPIC_AUTH_TOKEN: OAUTH_TOKEN,
      ANTHROPIC_API_KEY: KEY,
      GITHUB_TOKEN: "ghp_made-up-for-the-test-0123456789",
      GITHUB_WEBHOOK_SECRET: "webhook-secret-of-the-test",
      CODER_API_TOKEN: "api-token-of-the-test",
    };
    const { config, claude } = await startServer({ ...secrets, ANTHROPIC_BASE_URL: "https://user:password-of-the-gateway@llm-gateway.example.com/claude", GITHUB_REPOSITORIES: "acme/storefront" });
    const summary = startupSummary(config, claude);
    expect(summary).toEqual({
      url: "http://127.0.0.1:4317",
      claude: { model: "claude-opus-5-5", credential: "auth token (OAuth)", api: "https://llm-gateway.example.com" },
      github: "token configured",
      repositories: ["acme/storefront"],
      autoReview: false,
    });
    for (const secret of [...Object.values(secrets), "password-of-the-gateway"]) expect(JSON.stringify(summary)).not.toContain(secret);

    const bare = await startServer({});
    expect(startupSummary(bare.config, bare.claude)).toMatchObject({
      claude: "off (set ANTHROPIC_AUTH_TOKEN, ANTHROPIC_PROFILE or ANTHROPIC_API_KEY, or one of the _SSM_PARAMETER variables)",
      github: "read-only, public repositories",
    });
  });

  it("says at start-up which credential it took when more than one is set", async () => {
    const { logger, lines } = recordingLogger();
    await startServer({ ANTHROPIC_AUTH_TOKEN: OAUTH_TOKEN, ANTHROPIC_API_KEY: KEY }, logger);
    expect(lines.filter((line) => line.level === "warn")).toEqual([
      {
        level: "warn",
        message: "More than one Claude credential is set. CodeR prefers an auth token to the Console sign-in, and both to an API key.",
        data: { using: "auth token (OAuth)", ignored: ["ANTHROPIC_API_KEY"] },
      },
    ]);
  });

  it("warns that a credential in ANTHROPIC_CUSTOM_HEADERS is the one that goes out", async () => {
    const headers = "Authorization: Bearer from-the-headers";
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", headers); // the SDK reads this variable from the process, on its own
    const { logger, lines } = recordingLogger();
    const api = await claudeApi();
    await review(api, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_CUSTOM_HEADERS: headers }, logger);

    expect(lines).toContainEqual({
      level: "warn",
      message: "ANTHROPIC_CUSTOM_HEADERS carries a credential of its own. The SDK sends it as written, over or next to the one CodeR chose.",
      data: { using: "API key", headers: ["Authorization"] },
    });
    expect(JSON.stringify(lines)).not.toContain("from-the-headers");
    // Why it is worth a warning: the key CodeR chose never left.
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) expect(request.headers.authorization).toBe("Bearer from-the-headers");
  });
});

describe("a credential the API refuses", () => {
  const answering = (status: number, errorType: string, message: string) => claudeApi(() => ({ status, errorType, message }));

  it("says which credential it was and what to do about it", async () => {
    const key = await review(await answering(401, "authentication_error", "invalid x-api-key"), { ANTHROPIC_API_KEY: KEY });
    expect(key.state.status).toBe("failed");
    expect(key.failure).toBe("The Claude API refused the API key (invalid x-api-key). Check ANTHROPIC_API_KEY.");

    const token = await review(await answering(401, "authentication_error", "OAuth token has expired."), { ANTHROPIC_AUTH_TOKEN: OAUTH_TOKEN });
    expect(token.state.status).toBe("failed");
    expect(token.failure).toBe("The Claude API refused the auth token (OAuth token has expired). Set a fresh ANTHROPIC_AUTH_TOKEN and restart CodeR.");
  });

  it("passes on the API's own reason for what it denied, did not find or would not take", async () => {
    const denied = await review(await answering(403, "permission_error", "OAuth authentication is currently not allowed for this organization."), { ANTHROPIC_AUTH_TOKEN: OAUTH_TOKEN });
    expect(denied.failure).toBe("The Claude API denied the request: OAuth authentication is currently not allowed for this organization.");

    const missing = await review(await answering(404, "not_found_error", "model: claude-of-no-catalog"), { ANTHROPIC_API_KEY: KEY });
    expect(missing.failure).toBe("The configured model was not found (model: claude-of-no-catalog). Check CODER_MODEL.");

    const noCredits = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    const broke = await review(await answering(400, "invalid_request_error", noCredits), { ANTHROPIC_API_KEY: KEY });
    expect(broke.failure).toBe(`The Claude API rejected the request: ${noCredits}`);
  });

  it("looks at ANTHROPIC_CUSTOM_HEADERS first when that variable sent a credential of its own", async () => {
    const headers = "Authorization: Bearer token-of-the-headers";
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", headers); // the SDK reads this variable from the process, on its own
    const { logger, lines } = recordingLogger();
    // A gateway that quotes the header it would not take.
    const api = await claudeApi((request) => ({ status: 401, errorType: "authentication_error", message: `Invalid proxy token. Received: ${request.headers.authorization}` }));
    const run = await review(api, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_CUSTOM_HEADERS: headers }, logger);

    // The key CodeR chose never left: it is not what was refused, and not what the gateway quoted.
    expect(run.failure).toBe(
      "The Claude API refused the credential (Invalid proxy token. Received: Bearer [credential removed]). " +
        "ANTHROPIC_CUSTOM_HEADERS sends one of its own (Authorization) over or next to the API key: check that variable first.",
    );
    expect(await leftBehind(run, lines)).not.toContain("token-of-the-headers");
  });

  it("makes do without a reason when the answer is not shaped like the API's", async () => {
    // A gateway of its own mind: `message` holds an object here, and the whole body is a web page there.
    const object = await claudeApi(() => ({ status: 401, rawBody: JSON.stringify({ error: { message: { detail: "no" } } }) }));
    expect((await review(object, { ANTHROPIC_API_KEY: KEY })).failure).toBe("The Claude API refused the API key. Check ANTHROPIC_API_KEY.");

    const page = await claudeApi(() => ({ status: 403, rawBody: "<html>Forbidden</html>", contentType: "text/html" }));
    expect((await review(page, { ANTHROPIC_AUTH_TOKEN: GATEWAY_TOKEN })).failure).toBe("This auth token is not allowed to use the configured model.");
  });
});

describe("the secret itself", () => {
  const credentials = [
    ["ANTHROPIC_API_KEY", KEY],
    ["ANTHROPIC_AUTH_TOKEN", GATEWAY_TOKEN],
    ["ANTHROPIC_AUTH_TOKEN", OAUTH_TOKEN],
  ] as const;
  const unsendable = (source: string, fix: string) =>
    `A header of the request could not be sent: it holds a line break or a character that cannot travel in one. It comes from the ${source} or from ANTHROPIC_CUSTOM_HEADERS. ${fix}`;

  it("is in nothing a review leaves behind", async () => {
    for (const [variable, secret] of credentials) {
      const { logger, lines } = recordingLogger();
      const run = await review(await claudeApi(), { [variable]: secret }, logger);
      expect(run.state.status).toBe("concluded");
      expect(lines.length).toBeGreaterThan(0);
      expect(`${JSON.stringify(run.claude)}\n${await leftBehind(run, lines)}`, variable).not.toContain(secret);
    }
  });

  it("is taken out of what the other side says, when the other side repeats it", async () => {
    for (const [variable, secret] of credentials) {
      const { logger, lines } = recordingLogger();
      // What a gateway may answer: the token it was handed, back in the message.
      const api = await claudeApi(() => ({ status: 401, errorType: "authentication_error", message: `no such token: ${secret}` }));
      const run = await review(api, { [variable]: secret }, logger);
      expect(run.failure, variable).toContain("(no such token: [credential removed])");
      expect(JSON.stringify(lines)).toContain("no such token"); // the log did record the refusal
      expect(await leftBehind(run, lines), variable).not.toContain(secret);
    }
  });

  it("is taken out when a header of ANTHROPIC_CUSTOM_HEADERS carried it, whatever the header is called", async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Team: code-reviews\nX-Gateway-Token: token-of-the-headers");
    const { logger, lines } = recordingLogger();
    const api = await claudeApi((request) => ({
      status: 403,
      errorType: "permission_error",
      message: `the token ${String(request.headers["x-gateway-token"])} of the team ${String(request.headers["x-team"])} has no budget left`,
    }));
    const run = await review(api, { ANTHROPIC_API_KEY: KEY }, logger);
    // What names a team is no credential, and stays.
    expect(run.failure).toBe("The Claude API denied the request: the token [credential removed] of the team code-reviews has no budget left.");
    expect(await leftBehind(run, lines)).not.toContain("token-of-the-headers");
  });

  it("is not in what is said of a header that could not be sent", async () => {
    // The runtime's own error for such a header quotes it whole. The configuration refuses a key like this one;
    // this is the adapter on its own, should one ever reach it.
    const wrapped = "sk-ant-api03-key-of-the-test\nSECRETPART";
    const { logger, lines } = recordingLogger();
    const api = await claudeApi();
    const dataDir = await temporaryDirectory("coder-credentials-");
    const config = loadConfig({ CODER_DATA_DIR: dataDir, ANTHROPIC_BASE_URL: api.baseURL, ANTHROPIC_API_KEY: KEY });
    const server = await createServerApplication({ ...config, claude: { ...config.claude, credential: { kind: "api-key", key: wrapped } } }, logger);
    const run = { dataDir, ...(await reviewOn(server)) };
    expect(run.failure).toBe(unsendable("API key", "Check ANTHROPIC_API_KEY."));
    expect(await leftBehind(run, lines)).not.toContain("SECRETPART");

    // The headers of ANTHROPIC_CUSTOM_HEADERS pass no check of CodeR's:
    // a stray carriage return, a character no header can hold, a line that lost the colon after its name.
    for (const headers of ["X-Gateway-Token: token\rSECRETPART", "X-Gateway-Token: token\u2014SECRETPART", "Authorization Bearer SECRETPART:x"]) {
      vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", headers);
      const recorded = recordingLogger();
      const refused = await review(api, { ANTHROPIC_API_KEY: KEY }, recorded.logger);
      expect(refused.failure, JSON.stringify(headers)).toBe(unsendable("API key", "Check ANTHROPIC_API_KEY."));
      expect(await leftBehind(refused, recorded.lines)).not.toContain("SECRETPART");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("is recognized by its shape when it is one of Anthropic's, wherever it came from", () => {
    expect(withoutSecrets(`access ${OAUTH_TOKEN}, refresh sk-ant-ort01-refresh-of-the-test-0123456789`)).toBe("access [credential removed], refresh [credential removed]");
    // A prefix is not a secret.
    expect(withoutSecrets("An OAuth access token starts with sk-ant-oat01-.")).toBe("An OAuth access token starts with sk-ant-oat01-.");
  });

  it("is remembered once a request carried it, whatever its shape and whichever header or body it left in", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}"));
    const sent = new SentCredentials("key-the-client-was-built-with");
    await sent.fetch("https://llm-gateway.example.com/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer opaque-access-token", "X-Api-Key": "key-of-the-gateway", "Ocp-Apim-Subscription-Key": "key-of-the-subscription", "X-Team": "code-reviews", "X-Monkey": "capuchin-monkey" },
    });
    await sent.fetch("https://console.example.com/v1/oauth/token", { method: "POST", body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "opaque-refresh-token" }) });

    expect(sent.redact("key-the-client-was-built-with was not sent, Bearer opaque-access-token was")).toBe("[credential removed] was not sent, Bearer [credential removed] was");
    expect(sent.redact("key-of-the-gateway, key-of-the-subscription, opaque-refresh-token")).toBe("[credential removed], [credential removed], [credential removed]");
    // Not everything in a header is a credential, and neither is a body sent anywhere else.
    expect(sent.redact("the team code-reviews, a capuchin-monkey, a POST")).toBe("the team code-reviews, a capuchin-monkey, a POST");
    await sent.fetch("https://llm-gateway.example.com/v1/messages", { method: "POST", body: JSON.stringify({ refresh_token: "a-field-of-a-message" }) });
    expect(sent.redact("a-field-of-a-message")).toBe("a-field-of-a-message");
  });

  it("is not looked for when it is too short to be one, and is taken out whole when another begins like it", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}"));
    expect(new SentCredentials("test").redact("the test token was refused")).toBe("the test token was refused");

    const sent = new SentCredentials();
    for (const token of ["opaque-token", "opaque-token-renewed"]) await sent.fetch("https://api.example.com/v1/messages", { headers: { Authorization: `Bearer ${token}` } });
    expect(sent.redact("opaque-token-renewed after opaque-token")).toBe("[credential removed] after [credential removed]");
  });

  it("is still known after many others when it is still being sent, while the oldest of the others are let go", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}"));
    const sent = new SentCredentials();
    // A gateway's key that stays, next to an access token that is renewed forty times.
    for (let renewal = 1; renewal <= 40; renewal += 1) {
      await sent.fetch("https://api.example.com/v1/messages", { headers: { "Api-Key": "key-of-the-gateway", Authorization: `Bearer access-token-number-${renewal}!` } });
      expect(sent.redact("key-of-the-gateway"), `after ${renewal} access tokens`).toBe("[credential removed]");
    }
    expect(sent.redact("access-token-number-40!")).toBe("[credential removed]");
    expect(sent.redact("access-token-number-1!")).toBe("access-token-number-1!");
  });
});
