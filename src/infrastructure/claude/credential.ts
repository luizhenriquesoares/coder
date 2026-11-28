import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";

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

/**
 * A client that authenticates with this credential: the SDK does not read
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_PROFILE for another
 * one. What ANTHROPIC_CUSTOM_HEADERS holds still goes out as written.
 */
export function anthropicClient(credential: ClaudeCredential, baseUrl?: string): Anthropic {
  return new Anthropic({ ...credentialOptions(credential), ...(baseUrl ? { baseURL: baseUrl } : {}) });
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

export function adviceFor(credential: ClaudeCredential): CredentialAdvice {
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

const REMOVED = "[credential removed]";
/** A key or token of Anthropic's, whoever holds it: a sign-in's tokens never pass through CodeR's hands. */
const ANTHROPIC_SECRET = /sk-ant-[A-Za-z0-9_-]{20,}/g;
/** A configured value shorter than this is not looked for: taking it out would garble ordinary words. */
const SHORTEST_SECRET = 8;

/** Takes anything shaped like a key or token of Anthropic's out of a text that is about to be logged or stored. */
export function withoutSecrets(text: string): string {
  return text.replace(ANTHROPIC_SECRET, REMOVED);
}

/**
 * The same, and the configured secret too, whatever its shape. The other side
 * may repeat what it was sent, and so may an error raised on the way out.
 */
export function redactorFor(credential: ClaudeCredential): (text: string) => string {
  const secret = credential.kind === "auth-token" ? credential.token : credential.kind === "api-key" ? credential.key : "";
  if (secret.length < SHORTEST_SECRET) return withoutSecrets;
  return (text) => withoutSecrets(text.replaceAll(secret, REMOVED));
}
