/**
 * Keeping credentials out of what CodeR logs and stores. A failure's text may
 * repeat what was sent: an API or a gateway that quotes the token it refused,
 * an error raised on the way out.
 */

const REMOVED = "[credential removed]";
/** A key or token of Anthropic's, whoever holds it. */
const ANTHROPIC_SECRET = /sk-ant-[A-Za-z0-9_-]{20,}/g;
/** A value shorter than this is not looked for: taking it out would garble ordinary words. */
const SHORTEST_SECRET = 8;
/** A sign-in adds two at every renewal, about once an hour. Past this many, the ones sent longest ago are let go. */
const MOST_REMEMBERED = 32;
/**
 * A header that authenticates, by a word of its name: Authorization and
 * X-Api-Key, and the ones a gateway asks for on top, such as X-Gateway-Token.
 */
const CREDENTIAL_HEADER = /(^|[^a-z])(auth|authorization|key|apikey|token|secret|password)([^a-z]|$)/i;
/** The scheme in front of a credential, as in "Bearer …". It is no part of the secret. */
const SCHEME = /^[A-Za-z][\w.~+-]*\s+(?=\S)/;
/** Where a sign-in is renewed. That request carries the refresh token, in its body. */
const TOKEN_ENDPOINT = /\/v1\/oauth\/token(\?|$)/;

/** Takes anything shaped like a key or token of Anthropic's out of a text that is about to be logged or stored. */
export function withoutSecrets(text: string): string {
  return text.replace(ANTHROPIC_SECRET, REMOVED);
}

/**
 * What a client has presented as a credential, learnt from its own requests
 * as they leave. Where a credential came from makes no difference to a text
 * that repeats it, and CodeR does not hold them all: the tokens of a sign-in
 * are the SDK's to read and renew, and the headers of ANTHROPIC_CUSTOM_HEADERS
 * are the SDK's to add. All of them pass here on their way out.
 */
export class SentCredentials {
  private readonly values = new Set<string>();

  /** `configured` is the secret the client was built with: an error raised before any request can already quote it. */
  constructor(configured?: string) {
    this.remember(configured);
  }

  /** The runtime's fetch, noting what each request presents as a credential. Given to the SDK client as its `fetch`. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    for (const [name, value] of new Headers(init?.headers ?? request?.headers)) {
      if (CREDENTIAL_HEADER.test(name)) this.remember(value.replace(SCHEME, ""));
    }
    if (TOKEN_ENDPOINT.test(request?.url ?? String(input)) && typeof init?.body === "string") this.remember(refreshTokenIn(init.body));
    return fetch(input, init);
  };

  /** Takes out of a text every credential seen so far, and whatever is shaped like a key or token of Anthropic's. */
  readonly redact = (text: string): string => {
    // Longest first: where one credential begins like another, the longer is not left half standing.
    const longestFirst = [...this.values].sort((a, b) => b.length - a.length);
    return withoutSecrets(longestFirst.reduce((cleaned, secret) => cleaned.replaceAll(secret, REMOVED), text));
  };

  private remember(value: unknown): void {
    if (typeof value !== "string" || value.length < SHORTEST_SECRET) return;
    this.values.delete(value); // sent again: the most recent once more
    this.values.add(value);
    if (this.values.size > MOST_REMEMBERED) this.values.delete(this.values.values().next().value!);
  }
}

function refreshTokenIn(body: string): unknown {
  try {
    return (JSON.parse(body) as { refresh_token?: unknown } | null)?.refresh_token;
  } catch {
    return undefined; // not JSON: no renewal this knows how to read
  }
}
