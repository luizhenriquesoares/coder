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
const secret = z
  .string()
  .trim()
  .regex(/^[\x21\x23-\x26\x28-\x5B\x5D-\x7E]+$/, "the value has a space, a quote, a backslash, a line break or a character outside ASCII. Paste it alone, on one line")
  .optional();

/** The name `ant auth login` stored a sign-in under. It becomes a file name, a command to copy and a line in the log. */
const profileName = z
  .string()
  .trim()
  .superRefine((name, context) => {
    const problem = profileNameProblem(name);
    if (problem) context.addIssue({ code: "custom", message: problem });
  })
  .optional();

function profileNameProblem(name: string): string | null {
  // Said without repeating the value: what looks like a secret is not printed.
  if (name.length > 64 || /^sk-/i.test(name)) {
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

  ANTHROPIC_AUTH_TOKEN: secret,
  ANTHROPIC_PROFILE: profileName,
  ANTHROPIC_API_KEY: secret,
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  /** Read by the SDK, not by CodeR, which only looks for a credential in it. */
  ANTHROPIC_CUSTOM_HEADERS: z.string().optional(),
  CODER_MODEL: z.string().default("claude-opus-5-5"),
  CODER_EFFORT: z.enum(EFFORTS).default("high"),
  CODER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(4000).max(128000).default(32000),

  GITHUB_TOKEN: secret,
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
  const [chosen, ...others] = claudeCredentials(e);
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
      credential: chosen?.credential ?? null,
      /** Variables that hold another credential, set but not used. */
      ignoredCredentials: others.map((other) => other.variable),
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

/**
 * The Claude credentials this environment holds, in CodeR's order of
 * preference: a token before the sign-in, and both before a static key.
 * Only the first is used.
 */
function claudeCredentials(e: z.infer<typeof Environment>): { variable: string; credential: ClaudeCredential }[] {
  const configured: { variable: string; credential: ClaudeCredential }[] = [];
  if (e.ANTHROPIC_AUTH_TOKEN) {
    const oauth = isOAuthToken(e.ANTHROPIC_AUTH_TOKEN, e.ANTHROPIC_BASE_URL);
    configured.push({ variable: "ANTHROPIC_AUTH_TOKEN", credential: { kind: "auth-token", token: e.ANTHROPIC_AUTH_TOKEN, oauth } });
  }
  if (e.ANTHROPIC_PROFILE) configured.push({ variable: "ANTHROPIC_PROFILE", credential: { kind: "sign-in", profile: e.ANTHROPIC_PROFILE } });
  if (e.ANTHROPIC_API_KEY) configured.push({ variable: "ANTHROPIC_API_KEY", credential: { kind: "api-key", key: e.ANTHROPIC_API_KEY } });
  return configured;
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
