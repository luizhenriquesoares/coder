import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake Messages API received. */
export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  // The wire format of the Messages API: checked field by field in the tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
  /** Reviewer seat, read from the persona block of the user message. */
  readonly seat: string;
  /** Which structured answer the request asks for. */
  readonly round: "opening" | "debate" | "implementation" | "verdict";
}

export type Reply =
  | {
      readonly json: unknown;
      readonly stopReason?: string;
      readonly model?: string;
      readonly usage?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
      readonly delayMs?: number;
    }
  | { readonly status: number; readonly errorType: string; readonly message: string }
  /** An answer that is not shaped like the API's: what a gateway in front of it may send. */
  | { readonly status: number; readonly rawBody: string; readonly contentType?: string };

/** A request the fake token endpoint received: a sign-in renewing its access token. */
export interface RecordedRenewal {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: { grant_type?: string; refresh_token?: string; client_id?: string };
}

export type Renewal =
  | { readonly accessToken: string; readonly expiresIn: number; readonly refreshToken?: string }
  | { readonly status: number; readonly error: string; readonly description?: string };

export interface FakeAnthropic {
  readonly baseURL: string;
  readonly requests: RecordedRequest[];
  /** What arrived at POST /v1/oauth/token. */
  readonly renewals: RecordedRenewal[];
  /** For each request, how many responses had already started streaming when it arrived. */
  readonly startedBefore: number[];
  close(): Promise<void>;
}

/**
 * A local stand-in for POST /v1/messages that speaks the real streaming wire
 * format (server-sent events), so the official SDK is exercised end to end.
 * It also answers POST /v1/oauth/token, where a sign-in renews its access
 * token: every renewal is refused unless `renew` says otherwise.
 */
export async function startFakeAnthropic(
  reply: (request: RecordedRequest) => Reply,
  renew: (renewal: RecordedRenewal) => Renewal = () => ({ status: 400, error: "invalid_grant" }),
): Promise<FakeAnthropic> {
  const requests: RecordedRequest[] = [];
  const renewals: RecordedRenewal[] = [];
  const startedBefore: number[] = [];
  let responsesStarted = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (req.url?.split("?")[0] === "/v1/oauth/token") {
        const renewal: RecordedRenewal = { headers: req.headers, body };
        renewals.push(renewal);
        const answer = renew(renewal);
        const failed = "status" in answer;
        res.writeHead(failed ? answer.status : 200, { "content-type": "application/json", "request-id": "req_fake_token" });
        res.end(
          JSON.stringify(
            failed
              ? { error: answer.error, ...(answer.description ? { error_description: answer.description } : {}) }
              : { token_type: "Bearer", access_token: answer.accessToken, expires_in: answer.expiresIn, ...(answer.refreshToken ? { refresh_token: answer.refreshToken } : {}) },
          ),
        );
        return;
      }
      const persona: string = body.messages?.[0]?.content?.[1]?.text ?? "";
      const properties = body.output_config?.format?.schema?.properties ?? {};
      const request: RecordedRequest = {
        url: req.url ?? "",
        headers: req.headers,
        body,
        seat: /Your seat: ([^.,]+)/.exec(persona)?.[1] ?? "unknown",
        round: "findings" in properties ? "opening" : "positions" in properties ? "debate" : "patches" in properties ? "implementation" : "verdict",
      };
      requests.push(request);
      startedBefore.push(responsesStarted);
      const answer = reply(request);

      if ("rawBody" in answer) {
        res.writeHead(answer.status, { "content-type": answer.contentType ?? "application/json", "request-id": "req_fake" });
        res.end(answer.rawBody);
        return;
      }
      if ("status" in answer) {
        res.writeHead(answer.status, { "content-type": "application/json", "request-id": "req_fake" });
        res.end(JSON.stringify({ type: "error", error: { type: answer.errorType, message: answer.message } }));
        return;
      }

      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const usage = answer.usage ?? {};
      const stream = () => {
        responsesStarted += 1;
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_fake" });
        send("message_start", {
          type: "message_start",
          message: {
            id: `msg_${requests.length}`,
            type: "message",
            role: "assistant",
            model: answer.model ?? body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: usage.input ?? 100,
              output_tokens: 1,
              cache_creation_input_tokens: usage.cacheWrite ?? 0,
              cache_read_input_tokens: usage.cacheRead ?? 0,
            },
          },
        });
        const text = JSON.stringify(answer.json);
        const middle = Math.floor(text.length / 2);
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        // Two deltas: the SDK has to accumulate partial JSON before parsing it.
        for (const part of [text.slice(0, middle), text.slice(middle)]) {
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
        }
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: answer.stopReason ?? "end_turn", stop_sequence: null },
          usage: { output_tokens: usage.output ?? 50 },
        });
        send("message_stop", { type: "message_stop" });
        res.end();
      };
      if (answer.delayMs) setTimeout(stream, answer.delayMs);
      else stream();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    renewals,
    startedBefore,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // do not wait for keep-alive sockets
      }),
  };
}
