import { z } from "zod";
import { LANGUAGES } from "../domain/deliberation/model.js";
import { EFFORTS } from "../infrastructure/claude/ClaudeCouncil.js";
import { isOAuthToken, type ClaudeCredential } from "../infrastructure/claude/credential.js";
import type { RepositoryName } from "../infrastructure/github/GitHubSourceControl.js";
import { isLoopback } from "../infrastructure/http/server.js";

const flag = z
  .string()
  .optional()
  .transform((value) => ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase()));

/**
 * A key or a token, as it will travel in a header. A value with anything else
 * in it is refused here, by the name of its variable: further on, the error
 * for a header that cannot be sent quotes the whole value.
 */
const HEADER_SAFE = /^[\x21\x23-\x26\x28-\x5B\x5D-\x7E]+$/;
const NOT_HEADER_SAFE = "the value has a space, a quote, a backslash, a line break or a character outside ASCII. Paste it alone, on one line";

/** The variables that can hold the Claude credential, in CodeR's order of preference: a token before the sign-in, and both before a static key. */
const CLAUDE_CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY"] as const;
/** One of them, as pasted. Only the one that is used is held to its rule: a placeholder on a line CodeR sets aside stops nothing. */
const pasted = z.string().trim().optional();

/** Why a value cannot be the name `ant auth login` stored a sign-in under. That name becomes a file name, a command to copy and a line in the log. */
function profileNameProblem(name: string): string | null {
  // Too long for a name, or begun like a secret of Anthropic's or of GitHub's. Said without repeating the value.
  if (name.length > 32 || /^(sk-|gh[pousr]_|github_pat_)/i.test(name)) {
    return "this looks like a key or a token, not the name of a sign-in. A key goes in ANTHROPIC_API_KEY, a token in ANTHROPIC_AUTH_TOKEN";
  }
  if (name === "." || name === "..") return `"${name}" is not the name of a sign-in`;
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return "a profile name has only letters, digits, '_', '-' and '.'";
  return null;
}

const Environment = z.object({
  PORT: z.coerce.number().int().positive().default(4317),
  HOST: z.string().default("127.0.0.1"),
  CODER_API_TOKEN: z.string().min(16, "CODER_API_TOKEN must have at least 16 characters").optional(),
  CODER_DATA_DIR: z.string().default(".data"),
  CODER_DEMO: z.string().default("true"),
  CODER_LANGUAGE: z.enum(LANGUAGES).default("en"),
  CODER_REVIEWER: z.string().default("human"),

  ANTHROPIC_AUTH_TOKEN: pasted,
  ANTHROPIC_PROFILE: pasted,
  ANTHROPIC_API_KEY: pasted,
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  /** Read by the SDK, not by CodeR, which only looks for a credential in it. */
  ANTHROPIC_CUSTOM_HEADERS: z.string().optional(),
  CODER_MODEL: z.string().default("claude-opus-5-5"),
  CODER_EFFORT: z.enum(EFFORTS).default("high"),
  CODER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(4000).max(128000).default(32000),

  GITHUB_TOKEN: z.string().trim().regex(HEADER_SAFE, NOT_HEADER_SAFE).optional(),
  GITHUB_API_URL: z.string().url().optional(),
  GITHUB_REPOSITORIES: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  AUTO_REVIEW: flag,
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(30),
});

export type ServerConfig = ReturnType<typeof loadConfig>;

/** Reads and validates configuration from the environment. Fails fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Environment.safeParse(blankAsUndefined(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  if (!isLoopback(e.HOST) && !e.CODER_API_TOKEN) {
    throw new Error(
      `Invalid configuration:\n  HOST: listening on ${e.HOST} needs CODER_API_TOKEN, or anyone who can reach this port could start reviews and publish them.`,
    );
  }
  const [chosen, ...ignored] = CLAUDE_CREDENTIALS.filter((variable) => e[variable]);
  const credential = chosen ? claudeCredentialIn(chosen, e) : null;
  return {
    port: e.PORT,
    host: e.HOST,
    apiToken: e.CODER_API_TOKEN,
    dataDir: e.CODER_DATA_DIR,
    demo: e.CODER_DEMO.toLowerCase() !== "false",
    language: e.CODER_LANGUAGE,
    reviewerName: e.CODER_REVIEWER,
    claude: {
      /** Null leaves the Claude council off. */
      credential,
      /** Variables that hold another credential, set but not used. */
      ignoredCredentials: ignored,
      /** Headers of ANTHROPIC_CUSTOM_HEADERS that carry a credential of their own. */
      credentialHeaders: credentialHeaders(e.ANTHROPIC_CUSTOM_HEADERS),
      baseUrl: e.ANTHROPIC_BASE_URL,
      model: e.CODER_MODEL,
      effort: e.CODER_EFFORT,
      maxOutputTokens: e.CODER_MAX_OUTPUT_TOKENS,
    },
    github: {
      token: e.GITHUB_TOKEN,
      apiUrl: e.GITHUB_API_URL,
      repositories: parseRepositories(e.GITHUB_REPOSITORIES),
      webhookSecret: e.GITHUB_WEBHOOK_SECRET,
    },
    autoReview: { enabled: e.AUTO_REVIEW, pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000 },
  };
}

/** The credential a variable holds, or the reason the server cannot start on it. */
function claudeCredentialIn(variable: (typeof CLAUDE_CREDENTIALS)[number], e: z.infer<typeof Environment>): ClaudeCredential {
  const value = e[variable]!;
  const problem = variable === "ANTHROPIC_PROFILE" ? profileNameProblem(value) : HEADER_SAFE.test(value) ? null : NOT_HEADER_SAFE;
  if (problem) throw new Error(`Invalid configuration:\n  ${variable}: ${problem}`);
  switch (variable) {
    case "ANTHROPIC_AUTH_TOKEN":
      return { kind: "auth-token", token: value, oauth: isOAuthToken(value, e.ANTHROPIC_BASE_URL) };
    case "ANTHROPIC_PROFILE":
      return { kind: "sign-in", profile: value };
    case "ANTHROPIC_API_KEY":
      return { kind: "api-key", key: value };
  }
}

/**
 * The names of the headers in ANTHROPIC_CUSTOM_HEADERS that authenticate a
 * request. The SDK sends every header of that variable as written, so these
 * go out over, or next to, the credential CodeR chose.
 */
function credentialHeaders(customHeaders: string | undefined): string[] {
  return (customHeaders ?? "").split("\n").flatMap((line) => {
    const name = line.includes(":") ? line.slice(0, line.indexOf(":")).trim() : "";
    return ["authorization", "x-api-key"].includes(name.toLowerCase()) ? [name] : [];
  });
}

function blankAsUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value?.trim() === "" ? undefined : value]));
}

export function parseRepositories(value: string): RepositoryName[] {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(entry);
      if (!match) throw new Error(`Invalid configuration:\n  GITHUB_REPOSITORIES: "${entry}" is not owner/repo`);
      return { owner: match[1]!, repo: match[2]! };
    });
}
