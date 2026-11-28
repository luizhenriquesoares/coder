import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCredentialsPath, loadConfig as loadProfile } from "@anthropic-ai/sdk/core/credentials";
import { checkCredentialsFileSafety, type WorkloadIdentityError } from "@anthropic-ai/sdk/lib/credentials/types";
import { ANTHROPIC_API, loginCommand, originOf, type CredentialAdvice } from "./credential.js";

/**
 * The Claude Console sign-in that `ant auth login` leaves on a machine: its
 * settings in configs/<profile>.json, its tokens in credentials/<profile>.json.
 * The SDK reads, renews and rewrites the tokens. CodeR checks at start-up that
 * it will be able to, and puts into words what went wrong when it was not.
 */

export interface SignInCheck {
  /** ANTHROPIC_BASE_URL, when the configuration sets it. */
  readonly baseUrl?: string | undefined;
  /** Variables that hold another credential, set but not used. */
  readonly otherCredentials: readonly string[];
  /** Receives what deserves the operator's attention without being a reason to stop. */
  readonly warn: (message: string) => void;
}

export interface SignInAddresses {
  /** Where the reviews are sent. */
  readonly api: string;
  /** Where the tokens are renewed: the sign-in's own address when its settings name one. */
  readonly renewsAt: string;
}

/**
 * Stops the server on a sign-in that could not work: none under that name,
 * a profile of another kind, tokens that are missing, that the SDK would
 * refuse or that could not be saved after a renewal, or an address that would
 * carry them in the clear. Only the settings are read. Of the file that holds
 * the tokens it looks at the permissions: whether the tokens still work is
 * the API's to say, at the first review.
 */
export async function requireSignIn(profile: string, check: SignInCheck): Promise<SignInAddresses> {
  const login = loginCommand(profile);
  const usualTokensFile = await getCredentialsPath(null, profile);
  if (usualTokensFile === null) throw refusal("there is no home directory to look for a sign-in in. Set HOME, or ANTHROPIC_CONFIG_DIR.");
  const settingsFile = join(dirname(dirname(usualTokensFile)), "configs", `${profile}.json`);

  const settings = await loadProfile(profile).catch((error: unknown) => {
    throw refusal(`the settings of the sign-in "${profile}" cannot be read (${messageOf(error)}). Run \`${login}\` again.`);
  });
  if (!settings) {
    // Often a profile exported for Claude Code in the shell, next to a key in .env that was meant to be used.
    const fallBack = check.otherCredentials.length > 0 ? ` to fall back on ${check.otherCredentials.join(", ")}` : "";
    throw refusal(
      `this machine has no Claude Console sign-in named "${profile}": ${settingsFile} does not exist. ` +
        `Run \`${login}\` in a terminal, or take ANTHROPIC_PROFILE out of .env and of the shell${fallBack}.`,
    );
  }
  if (settings.authentication.type !== "user_oauth") {
    throw refusal(
      `the profile "${profile}" is not a Console sign-in but a workload identity federation, which CodeR does not take yet. Use a sign-in made with \`ant auth login\`, an auth token or an API key.`,
    );
  }

  const tokensFile = (await getCredentialsPath(settings, profile)) ?? usualTokensFile;
  if (!(await allows(tokensFile, constants.R_OK))) {
    throw refusal(`the sign-in "${profile}" has no tokens this user can read (${tokensFile}). Run \`${login}\` again.`);
  }
  try {
    await checkCredentialsFileSafety(tokensFile, (message) => check.warn(`Console sign-in: ${message}`));
  } catch (error) {
    throw refusal(`the tokens of the sign-in "${profile}" cannot be used as they are. ${messageOf(error)}`);
  }
  // With a client id the SDK renews the tokens, and writes the new ones next to the old.
  const tokensDirectory = dirname(tokensFile);
  if (settings.authentication.client_id && !(await allows(tokensDirectory, constants.W_OK | constants.X_OK))) {
    throw refusal(`the tokens of the sign-in "${profile}" are renewed in place, and this user cannot write to ${tokensDirectory}: a renewed token could not be saved.`);
  }

  // As the SDK resolves them: for API calls ANTHROPIC_BASE_URL wins, for a renewal the sign-in's own address does.
  const api = check.baseUrl || settings.base_url || ANTHROPIC_API;
  const renewsAt = settings.base_url || check.baseUrl || ANTHROPIC_API;
  for (const address of new Set([api, renewsAt])) {
    if (!travelsSafely(address)) {
      throw refusal(
        `the sign-in "${profile}" would travel in the clear to ${originOf(address)}. Use an https address, in ANTHROPIC_BASE_URL or in base_url of ${settingsFile}, or another credential.`,
      );
    }
  }
  return { api, renewsAt };
}

/** The SDK renews a sign-in over https, or over http to this machine only. API calls with its tokens are held to the same rule. */
function travelsSafely(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host));
}

async function allows(path: string, mode: number): Promise<boolean> {
  return access(path, mode).then(
    () => true,
    () => false,
  );
}

function refusal(problem: string): Error {
  return new Error(`Invalid configuration:\n  ANTHROPIC_PROFILE: ${problem}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The states of the stored tokens that a new login repairs, as the SDK words them. */
const LOGIN_REPAIRS = /^Credentials file not found|^Credentials file at .* (is not valid JSON|must include)|^Access token at .* has expired/s;
/** The JavaScript error the SDK appends to some of its sentences. A parser's can quote the file it choked on. */
const APPENDED_ERROR = /: \w*Error\b.*$/s;

/**
 * Why the sign-in gave no token, in words that are safe to store. Of what the
 * token endpoint answered, only the status and the error code are repeated:
 * the rest of an answer may echo the token it was sent.
 */
export function describeSignInFailure(error: WorkloadIdentityError, advice: CredentialAdvice): string {
  const again = advice.login ? `run \`${advice.login}\` again` : "sign in again";
  const status = error.statusCode;
  if (status === null) {
    // Nothing came back: the stored tokens could not be read or renewed from here, or the endpoint was out of reach.
    const repaired = LOGIN_REPAIRS.test(error.message) ? ` ${capitalized(again)}.` : "";
    const reason = error.message.replace(APPENDED_ERROR, "").trim().replace(/\.$/, "");
    return `The ${advice.name} could not be used: ${reason}.${repaired}`;
  }
  const code = errorCodeOf(error.body);
  const answer = `HTTP ${status}${code ? `, ${code}` : ""}`;
  if (status === 400 || status === 401) {
    // Usually a sign-in that ran out. Sometimes two renewals that crossed, and then the second try finds the token the first one saved.
    return `The ${advice.name} could not be renewed (${answer}). Try once more; if it fails the same way, ${again}.`;
  }
  if (status === 408 || status === 429 || status >= 500) {
    return `The ${advice.name} could not be renewed (${answer}). Try again in a moment.`;
  }
  return `The ${advice.name} could not be renewed (${answer}).`;
}

/** The `error` of an OAuth error answer, or the `error.type` of one shaped like the API's, when it is a plain code. */
function errorCodeOf(body: unknown): string | null {
  const answer = typeof body === "string" ? parsed(body) : body;
  if (typeof answer !== "object" || answer === null) return null;
  const error: unknown = (answer as { error?: unknown }).error;
  const code: unknown = typeof error === "object" && error !== null ? (error as { type?: unknown }).type : error;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : null;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
