import { z } from "zod";
import { LANGUAGES } from "../domain/deliberation/model.js";
import { EFFORTS } from "../infrastructure/claude/ClaudeCouncil.js";
import type { RepositoryName } from "../infrastructure/github/GitHubSourceControl.js";
import { isLoopback } from "../infrastructure/http/server.js";

const flag = z
  .string()
  .optional()
  .transform((value) => ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase()));

const Environment = z.object({
  PORT: z.coerce.number().int().positive().default(4317),
  HOST: z.string().default("127.0.0.1"),
  CODER_API_TOKEN: z.string().min(16, "CODER_API_TOKEN must have at least 16 characters").optional(),
  CODER_DATA_DIR: z.string().default(".data"),
  CODER_DEMO: z.string().default("true"),
  CODER_LANGUAGE: z.enum(LANGUAGES).default("en"),
  CODER_REVIEWER: z.string().default("human"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  CODER_MODEL: z.string().default("claude-opus-5-5"),
  CODER_EFFORT: z.enum(EFFORTS).default("high"),
  CODER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(4000).max(128000).default(32000),

  GITHUB_TOKEN: z.string().optional(),
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
  return {
    port: e.PORT,
    host: e.HOST,
    apiToken: e.CODER_API_TOKEN,
    dataDir: e.CODER_DATA_DIR,
    demo: e.CODER_DEMO.toLowerCase() !== "false",
    language: e.CODER_LANGUAGE,
    reviewerName: e.CODER_REVIEWER,
    claude: {
      enabled: Boolean(e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN),
      apiKey: e.ANTHROPIC_API_KEY,
      authToken: e.ANTHROPIC_AUTH_TOKEN,
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
