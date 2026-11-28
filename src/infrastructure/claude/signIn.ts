import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCredentialsPath, loadConfig as loadProfile } from "@anthropic-ai/sdk/core/credentials";
import { checkCredentialsFileSafety, type WorkloadIdentityError } from "@anthropic-ai/sdk/lib/credentials/types";
// The SDK renews a sign-in over https, or over http to this machine only. API calls with its tokens are held to the same rule.
import { ANTHROPIC_API, loginCommand, originOf, travelsSafely } from "./credential.js";

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

/**
 * What the SDK says when a sign-in gives it no token to send, what CodeR says
 * instead, and what to do when a new login is not what repairs it. The SDK
 * names the file, by a path that holds the home directory, and what a failure
 * says is kept with the review.
 */
const NO_TOKEN: readonly (readonly [said: RegExp, means: string, instead: string | null])[] = [
  [/^Credentials file not found/, "its stored tokens are missing or cannot be read", null],
  [/^Credentials file at .* is not valid JSON/s, "its stored tokens are damaged", null],
  [/^Credentials file at .* must include/s, "its stored tokens hold no access token", null],
  [/^Access token at .* has expired/s, "its token ran out and nothing can renew it", null],
  [/^Credentials file at .* is group\/world-/s, "its stored tokens are open to other users of this machine", "Restart CodeR to read which file, and the command that closes it."],
  [/^User OAuth refresh failed to reach/, "the address that renews it could not be reached", "Try again in a moment."],
];
/** The JavaScript error the SDK appends to some of its sentences. A parser's can quote the file it choked on. */
const APPENDED_ERROR = /: \w*Error\b.*$/s;

/**
 * Why the sign-in gave no token, in words that are safe to keep. Of what the
 * token endpoint answered, only the status and the error code are repeated:
 * the rest of an answer may echo the token it was sent. `login` is the
 * command that makes the sign-in again.
 */
export function describeSignInFailure(error: WorkloadIdentityError, login?: string): string {
  const again = login ? `run \`${login}\` again` : "sign in again";
  const status = error.statusCode;
  if (status === null) {
    // Nothing came back: the stored tokens could not be used from here, or the endpoint was out of reach.
    const known = NO_TOKEN.find(([said]) => said.test(error.message));
    // A state this does not know keeps the SDK's sentence.
    if (!known) return `The Console sign-in could not be used: ${error.message.replace(APPENDED_ERROR, "").trim().replace(/\.$/, "")}.`;
    const [, means, instead] = known;
    return `The Console sign-in could not be used: ${means}. ${instead ?? `${capitalized(again)}.`}`;
  }
  const code = errorCodeOf(error.body);
  const answer = `HTTP ${status}${code ? `, ${code}` : ""}`;
  if (status === 400 || status === 401) {
    // Usually a sign-in that ran out. Sometimes two renewals that crossed, and then the second try finds the token the first one saved.
    return `The Console sign-in could not be renewed (${answer}). Try once more; if it fails the same way, ${again}.`;
  }
  if (status === 408 || status === 429 || status >= 500) {
    return `The Console sign-in could not be renewed (${answer}). Try again in a moment.`;
  }
  return `The Console sign-in could not be renewed (${answer}).`;
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
