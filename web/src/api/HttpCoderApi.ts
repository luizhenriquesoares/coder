import type {
  AppConfig,
  CoderApi,
  DecisionInput,
  Inbox,
  PullRequestDetail,
  StartReviewOptions,
} from "../../../src/application/api.js";
import type { Unsubscribe } from "../../../src/application/ports.js";
import type { FileContents, PullRequestRef } from "../../../src/domain/change/types.js";
import type { DomainEvent } from "../../../src/domain/deliberation/events.js";
import type { PublicationPlan } from "../../../src/domain/deliberation/publicationPlanner.js";
import type { SessionState } from "../../../src/domain/deliberation/state.js";

/** An error answered by the server, with the message it meant for the person at the screen. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** The application's API over HTTP: the same interface the server implements in process. */
export class HttpCoderApi implements CoderApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => string | null,
  ) {}

  config(): Promise<AppConfig> {
    return this.request("/api/config");
  }

  inbox(): Promise<Inbox> {
    return this.request("/api/pulls");
  }

  importPullRequest(url: string): Promise<PullRequestRef> {
    return this.request("/api/pulls/import", { method: "POST", body: { url } });
  }

  pullRequest(ref: PullRequestRef): Promise<PullRequestDetail> {
    return this.request(pullPath(ref));
  }

  fileContents(ref: PullRequestRef, path: string, headSha?: string): Promise<FileContents> {
    const sha = headSha === undefined ? "" : `&sha=${encodeURIComponent(headSha)}`;
    return this.request(`${pullPath(ref)}/file?path=${encodeURIComponent(path)}${sha}`);
  }

  startReview(ref: PullRequestRef, options: StartReviewOptions): Promise<{ sessionId: string }> {
    return this.request(`${pullPath(ref)}/reviews`, { method: "POST", body: options });
  }

  session(sessionId: string): Promise<SessionState> {
    return this.request(sessionPath(sessionId));
  }

  decide(sessionId: string, decision: DecisionInput): Promise<SessionState> {
    return this.request(`${sessionPath(sessionId)}/decisions`, { method: "POST", body: decision });
  }

  publicationPreview(sessionId: string): Promise<PublicationPlan> {
    return this.request(`${sessionPath(sessionId)}/publication`);
  }

  publish(sessionId: string): Promise<SessionState> {
    return this.request(`${sessionPath(sessionId)}/publish`, { method: "POST" });
  }

  /**
   * Follows the session's event stream. The browser's EventSource cannot send
   * an Authorization header, so the stream is read with fetch; a dropped
   * connection resumes after the last event received.
   */
  async subscribe(
    sessionId: string,
    afterSeq: number,
    listener: (event: DomainEvent) => void,
    onLost?: (error: Error) => void,
  ): Promise<Unsubscribe> {
    const abort = new AbortController();
    let lastSeq = afterSeq;

    const readOnce = async (): Promise<void> => {
      const response = await fetch(`${this.baseUrl}${sessionPath(sessionId)}/events?after=${lastSeq}`, {
        headers: this.headers(),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw await toApiError(response);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue; // comments and heartbeats
          const event = JSON.parse(data.slice(6)) as DomainEvent;
          if (event.seq <= lastSeq) continue;
          lastSeq = event.seq;
          listener(event);
        }
      }
    };

    await this.session(sessionId); // fail now, not in the background, if the session cannot be read
    void (async () => {
      let delay = RECONNECT_MIN_MS;
      while (!abort.signal.aborted) {
        const before = lastSeq;
        try {
          await readOnce();
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof ApiError && error.status < 500) {
            onLost?.(error); // gone or forbidden: retrying will not help, so say so instead of going quiet
            return;
          }
        }
        delay = lastSeq > before ? RECONNECT_MIN_MS : Math.min(delay * 2, RECONNECT_MAX_MS);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
    return () => abort.abort();
  }

  private headers(): Record<string, string> {
    const token = this.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { ...this.headers(), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new ApiError(0, "unreachable", "Cannot reach the CodeR server. Is it running?");
    }
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }
}

function pullPath(ref: PullRequestRef): string {
  return `/api/pulls/${ref.provider}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}`;
}

function sessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const { error } = (await response.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(response.status, error?.code ?? "error", error?.message ?? `Request failed (${response.status})`);
  } catch {
    return new ApiError(response.status, "error", `Request failed (${response.status})`);
  }
}
