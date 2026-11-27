import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { loadConfig as loadProfile } from "@anthropic-ai/sdk/core/credentials";

/**
 * What CodeR presents to the Claude API. Each of the three belongs to a Claude
 * Console organization, or to a gateway in front of one. The login of a Claude
 * plan, the one Claude Code uses, is not among them: it is meant for Claude
 * Code and Anthropic's own apps.
 */
export type ClaudeCredential =
  /** A bearer token: a gateway's own, or an OAuth access token of the Claude Console. */
  | { readonly kind: "auth-token"; readonly token: string; readonly oauth: boolean }
  /** The Console sign-in that `ant auth login` stored on this machine under a profile name. */
  | { readonly kind: "sign-in"; readonly profile: string }
  /** A static API key. */
  | { readonly kind: "api-key"; readonly key: string };

/** The words for a refused credential: what it was, and what the operator can do about it. */
export interface CredentialAdvice {
  readonly name: string;
  readonly fix: string;
}

/**
 * Whether an auth token is one of Anthropic's OAuth access tokens, which the
 * API accepts only when the request announces OAuth. Those start with
 * `sk-ant-oat`; and with no gateway in between, a token that is not an API key
 * can be nothing else.
 */
export function isOAuthToken(token: string, baseUrl: string | undefined): boolean {
  return token.startsWith("sk-ant-oat") || (baseUrl === undefined && !token.startsWith("sk-ant-api"));
}

/** A client that authenticates with this credential and no other: the SDK does not look in the environment for one. */
export function anthropicClient(credential: ClaudeCredential, baseUrl?: string): Anthropic {
  return new Anthropic({ ...credentialOptions(credential), ...(baseUrl ? { baseURL: baseUrl } : {}) });
}

function credentialOptions(credential: ClaudeCredential): Pick<ClientOptions, "apiKey" | "authToken" | "credentials" | "profile"> {
  switch (credential.kind) {
    case "auth-token":
      // The SDK announces OAuth only for tokens it obtains itself. Handing ours
      // over as a provider with nothing to renew gets it the same treatment.
      return credential.oauth ? { credentials: async () => ({ token: credential.token, expiresAt: null }) } : { authToken: credential.token };
    case "sign-in":
      return { profile: credential.profile };
    case "api-key":
      return { apiKey: credential.key };
  }
}

/** How logs name the credential in use. Never the secret itself. */
export function describeCredential(credential: ClaudeCredential): string {
  switch (credential.kind) {
    case "auth-token":
      return credential.oauth ? "auth token (OAuth)" : "auth token";
    case "sign-in":
      return `Console sign-in (profile ${credential.profile})`;
    case "api-key":
      return "API key";
  }
}

export function adviceFor(credential: ClaudeCredential): CredentialAdvice {
  switch (credential.kind) {
    case "auth-token":
      return { name: "auth token", fix: "Set a fresh ANTHROPIC_AUTH_TOKEN and restart CodeR." };
    case "sign-in":
      return { name: "Console sign-in", fix: `Run \`${loginCommand(credential.profile)}\` again.` };
    case "api-key":
      return { name: "API key", fix: "Check ANTHROPIC_API_KEY." };
  }
}

/**
 * Fails, with the command that fixes it, when this machine has no sign-in
 * under that profile name: better once at startup than in every review.
 * Reads the profile's settings only, never its tokens.
 */
export async function requireSignIn(profile: string): Promise<void> {
  if (await loadProfile(profile)) return;
  throw new Error(
    `Invalid configuration:\n  ANTHROPIC_PROFILE: this machine has no Claude Console sign-in named "${profile}". Run \`${loginCommand(profile)}\` in a terminal, or remove ANTHROPIC_PROFILE.`,
  );
}

function loginCommand(profile: string): string {
  return `ant auth login --profile ${profile}`;
}
