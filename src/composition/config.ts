import { z } from "zod";
import { LANGUAGES } from "../domain/deliberation/model.js";
import { EFFORTS } from "../infrastructure/claude/ClaudeCouncil.js";
import { isArn, regionOfArn } from "../infrastructure/aws/parameterStore.js";
import { HEADER_SAFE, isOAuthToken, NOT_HEADER_SAFE, travelsSafely, type ClaudeCredentialSetting } from "../infrastructure/claude/credential.js";
import type { RepositoryName } from "../infrastructure/github/GitHubSourceControl.js";
import { isLoopback } from "../infrastructure/http/server.js";

const flag = z
  .string()
  .optional()
  .transform((value) => ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase()));

/**
 * The variables that can name the Claude credential, in CodeR's order of
 * preference: a token before the sign-in, and both before a static key. A
 * token kept in AWS Systems Manager comes first: CodeR is the only one to
 * read that variable, so it is never set by accident.
 */
const CLAUDE_CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY"] as const;
/** One of them, as pasted. Only the one that is used is held to its rule: a placeholder on a line CodeR sets aside stops nothing. */
const pasted = z.string().trim().optional();

/** Why a value cannot be the name or the ARN of a parameter of AWS Systems Manager. */
function parameterNameProblem(name: string): string | null {
  // The token itself, pasted on this line. Said without repeating it.
  if (/^(sk-|gh[pousr]_|github_pat_|bearer\s)/i.test(name)) {
    return "this looks like a token, not the name of a parameter. Here goes the name it is kept under in Parameter Store, such as /coder/anthropic-auth-token; a token itself goes in ANTHROPIC_AUTH_TOKEN";
  }
  if (isArn(name) && !regionOfArn(name)) return "this begins like an ARN but is not the ARN of a parameter (arn:aws:ssm:<region>:<account>:parameter/<name>)";
  if (!/^[A-Za-z0-9_.\/:-]+$/.test(name)) return "the name of a parameter has only letters, digits, '_', '.', '-' and '/'";
  return null;
}

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

  ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER: pasted,
  ANTHROPIC_AUTH_TOKEN: pasted,
  ANTHROPIC_PROFILE: pasted,
  ANTHROPIC_API_KEY: pasted,
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  /** Read by the SDK, not by CodeR, which only looks for a credential in it. */
  ANTHROPIC_CUSTOM_HEADERS: z.string().optional(),
  CODER_MODEL: z.string().default("claude-opus-5-5"),
  CODER_EFFORT: z.enum(EFFORTS).default("high"),
  CODER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(4000).max(128000).default(32000),

  /** Read only to find a token kept in AWS Systems Manager, and held to a rule only then. */
  AWS_REGION: pasted,
  AWS_DEFAULT_REGION: pasted,
  AWS_ENDPOINT_URL_SSM: pasted,

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

/** The credential a variable names, or the reason the server cannot start on it. */
function claudeCredentialIn(variable: (typeof CLAUDE_CREDENTIALS)[number], e: z.infer<typeof Environment>): ClaudeCredentialSetting {
  const value = e[variable]!;
  const problem =
    variable === "ANTHROPIC_PROFILE" ? profileNameProblem(value) : variable === "ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER" ? parameterNameProblem(value) : HEADER_SAFE.test(value) ? null : NOT_HEADER_SAFE;
  if (problem) throw new Error(`Invalid configuration:\n  ${variable}: ${problem}`);
  switch (variable) {
    case "ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER":
      return { kind: "stored-auth-token", variable, parameter: parameterIn(value, e) };
    case "ANTHROPIC_AUTH_TOKEN":
      return { kind: "auth-token", token: value, oauth: isOAuthToken(value, e.ANTHROPIC_BASE_URL) };
    case "ANTHROPIC_PROFILE":
      return { kind: "sign-in", profile: value };
    case "ANTHROPIC_API_KEY":
      return { kind: "api-key", key: value };
  }
}

/**
 * Where the parameter is kept. The region of its ARN, where it lives, before
 * AWS_REGION; then AWS_DEFAULT_REGION, which the AWS CLI reads and the AWS SDK
 * does not; without any, the SDK takes the region of the AWS profile.
 */
function parameterIn(name: string, e: z.infer<typeof Environment>) {
  const region = regionOfArn(name) ?? e.AWS_REGION ?? e.AWS_DEFAULT_REGION;
  if (region !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(region)) {
    throw new Error(`Invalid configuration:\n  ${e.AWS_REGION === region ? "AWS_REGION" : "AWS_DEFAULT_REGION"}: "${region}" is not an AWS region, such as eu-west-1`);
  }
  const endpoint = e.AWS_ENDPOINT_URL_SSM;
  if (endpoint !== undefined && !travelsSafely(endpoint)) {
    throw new Error(`Invalid configuration:\n  AWS_ENDPOINT_URL_SSM: the token would travel in the clear, or this is not an address. Use an https address, or http to this machine only`);
  }
  return { name, region, endpoint };
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
