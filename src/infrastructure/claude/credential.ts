import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { ParameterReference } from "../aws/parameterStore.js";
import { SentCredentials } from "./redaction.js";

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

/**
 * What the configuration names: a credential, or where an auth token or a key is kept
 * for CodeR to read when it starts. `variable` is the line that named it.
 */
export type ClaudeCredentialSetting =
  | ClaudeCredential
  | { readonly kind: "stored"; readonly holds: "auth-token" | "api-key"; readonly variable: string; readonly parameter: ParameterReference };

/**
 * A key or a token, as it will travel in a header. A value with anything else
 * in it is refused by the name of where it came from: further on, the error
 * for a header that cannot be sent quotes the whole value.
 */
export const HEADER_SAFE = /^[\x21\x23-\x26\x28-\x5B\x5D-\x7E]+$/;
export const NOT_HEADER_SAFE = "the value has a space, a quote, a backslash, a line break or a character outside ASCII. Paste it alone, on one line";

/** Whether a credential sent to this address is safe from the network: https, or plain http to this machine only. */
export function travelsSafely(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host));
}

/** The words for a credential that failed: what it was, and what the operator can do about it. */
export interface CredentialAdvice {
  readonly name: string;
  /** What to do when the API refuses it. */
  readonly fix: string;
  /** The command that makes it anew, for the one credential a login makes. */
  readonly login?: string;
}

/** Where the Claude API is when nothing says otherwise. */
export const ANTHROPIC_API = "https://api.anthropic.com";

/** The scheme and host of an address, for a log or a message: not its path, and never a password written into it. */
export function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return "an address that is not a URL";
  }
}

/**
 * Whether a bearer token is an OAuth access token, which the API takes only
 * from a request that says so. Anthropic's own are recognizable, and any other
 * `sk-ant-` value is a key of some kind. A token of another shape is OAuth
 * when it goes straight to Anthropic and a gateway's own when it goes anywhere
 * else. Whose token it is, a Console organization's or a Claude plan's, does
 * not show in its shape: the API decides that.
 */
export function isOAuthToken(token: string, baseUrl: string | undefined): boolean {
  if (token.startsWith("sk-ant-")) return token.startsWith("sk-ant-oat");
  return baseUrl === undefined || new URL(baseUrl).origin === ANTHROPIC_API;
}

/** A client for the Claude API, and what cleans a text of the credentials that client has presented. */
export interface ClaudeClient {
  readonly client: Anthropic;
  readonly redact: (text: string) => string;
}

/**
 * A client that authenticates with this credential: the SDK does not read
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_PROFILE for another
 * one. What ANTHROPIC_CUSTOM_HEADERS holds still goes out as written.
 */
export function anthropicClient(credential: ClaudeCredential, baseUrl?: string): ClaudeClient {
  const configured = credential.kind === "auth-token" ? credential.token : credential.kind === "api-key" ? credential.key : undefined;
  const sent = new SentCredentials(configured);
  const client = new Anthropic({ ...credentialOptions(credential), ...(baseUrl ? { baseURL: baseUrl } : {}), fetch: sent.fetch });
  return { client, redact: sent.redact };
}

function credentialOptions(credential: ClaudeCredential): Pick<ClientOptions, "apiKey" | "authToken" | "credentials" | "profile"> {
  switch (credential.kind) {
    case "auth-token":
      // The SDK announces OAuth only for tokens it obtains itself. Handing ours
      // over as a provider with nothing to renew gets it the same treatment,
      // at one price: a token the API refuses is asked for and sent a second
      // time before the refusal comes back, as if it could have been renewed.
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

/**
 * `competingHeaders` are the headers of ANTHROPIC_CUSTOM_HEADERS that carry a
 * credential of their own. With any, what the API refused may not be the
 * credential CodeR chose, and the advice says where to look first.
 */
export function adviceFor(credential: ClaudeCredential, competingHeaders: readonly string[] = []): CredentialAdvice {
  const chosen = adviceForChosen(credential);
  if (competingHeaders.length === 0) return chosen;
  return {
    ...chosen,
    name: "credential",
    fix: `ANTHROPIC_CUSTOM_HEADERS sends one of its own (${competingHeaders.join(", ")}) over or next to the ${chosen.name}: check that variable first.`,
  };
}

function adviceForChosen(credential: ClaudeCredential): CredentialAdvice {
  switch (credential.kind) {
    case "auth-token":
      return { name: "auth token", fix: "Set a fresh ANTHROPIC_AUTH_TOKEN and restart CodeR." };
    case "sign-in": {
      const login = loginCommand(credential.profile);
      return { name: "Console sign-in", fix: `Run \`${login}\` again.`, login };
    }
    case "api-key":
      return { name: "API key", fix: "Check ANTHROPIC_API_KEY." };
  }
}

/** The command that makes a Console sign-in on this machine, or makes it again. */
export function loginCommand(profile: string): string {
  return `ant auth login --profile ${profile}`;
}
