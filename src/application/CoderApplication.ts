import { ChangeSet } from "../domain/change/ChangeSet.js";
import { assessRisk } from "../domain/change/riskAssessment.js";
import { refKey, type FileContents, type PullRequestRef, type PullRequestSnapshot } from "../domain/change/types.js";
import type { DomainEvent } from "../domain/deliberation/events.js";
import { DomainError } from "../domain/deliberation/model.js";
import { planPublication, type PublicationPlan } from "../domain/deliberation/publicationPlanner.js";
import type { SessionState } from "../domain/deliberation/state.js";
import type {
  AppConfig,
  CoderApi,
  DecisionInput,
  Inbox,
  InboxItem,
  PullRequestDetail,
  SessionSummary,
  StartReviewOptions,
} from "./api.js";
import type { ConductReview } from "./ConductReview.js";
import { ApplicationError } from "./errors.js";
import { summarize, type EventBus, type EventStore, type PullRequestSummary, type Unsubscribe, type Watchlist } from "./ports.js";
import type { PullRequestCatalog } from "./PullRequestCatalog.js";
import type { SessionRepository } from "./SessionRepository.js";

export interface CoderApplicationDeps {
  readonly config: AppConfig;
  readonly catalog: PullRequestCatalog;
  readonly sessions: SessionRepository;
  readonly conductReview: ConductReview;
  readonly store: EventStore;
  readonly bus: EventBus;
  readonly watchlist: Watchlist;
  /** Name recorded on human decisions. */
  readonly reviewerName: string;
}

const GITHUB_PR_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;
const SHORT_PR_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Application service implementing the API for every delivery mechanism. */
export class CoderApplication implements CoderApi {
  private readonly publishing = new Set<string>();

  constructor(private readonly deps: CoderApplicationDeps) {}

  async config(): Promise<AppConfig> {
    return this.deps.config;
  }

  async inbox(): Promise<Inbox> {
    const { catalog, watchlist, sessions } = this.deps;
    const [listing, watched, states] = await Promise.all([catalog.listOpen(), watchlist.all(), sessions.allStates()]);

    const known = new Set(listing.items.map((item) => refKey(item.ref)));
    const extra = await Promise.all(
      watched
        .filter((ref) => !known.has(refKey(ref)))
        .map((ref) => catalog.snapshot(ref).then(summarize, () => null)),
    );
    const pullRequests = [...listing.items, ...extra.filter((s): s is PullRequestSummary => s !== null)];

    const items = pullRequests
      .map((pullRequest): InboxItem => {
        const latest = latestSession(states, pullRequest.ref);
        return {
          pullRequest,
          latestSession: latest ? summarizeSession(latest) : null,
          stale: latest !== null && latest.pullRequest.headSha !== pullRequest.headSha,
        };
      })
      .sort((a, b) => b.pullRequest.updatedAt.localeCompare(a.pullRequest.updatedAt));
    return { items, errors: listing.errors };
  }

  async importPullRequest(url: string): Promise<PullRequestRef> {
    const match = GITHUB_PR_URL.exec(url.trim()) ?? SHORT_PR_REF.exec(url.trim());
    if (!match) {
      throw new ApplicationError("invalid_request", "Expected a GitHub pull request URL (https://github.com/owner/repo/pull/123)");
    }
    const ref: PullRequestRef = { provider: "github", owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
    await this.deps.catalog.snapshot(ref, { fresh: true }); // fails early if it cannot be read
    await this.deps.watchlist.add(ref);
    return ref;
  }

  async pullRequest(ref: PullRequestRef): Promise<PullRequestDetail> {
    const snapshot = await this.deps.catalog.snapshot(ref);
    const changeSet = ChangeSet.fromSnapshot(snapshot);
    const { files: _raw, ...pullRequest } = snapshot;
    const states = await this.deps.sessions.allStates();
    return {
      pullRequest,
      files: changeSet.files,
      stats: changeSet.stats,
      risk: assessRisk(changeSet),
      engines: this.deps.conductReview.availableEngines(snapshot),
      sessions: sessionsOf(states, ref).map(summarizeSession),
    };
  }

  async fileContents(ref: PullRequestRef, path: string): Promise<FileContents> {
    const snapshot = await this.deps.catalog.snapshot(ref);
    if (!snapshot.files.some((file) => file.path === path)) {
      throw new ApplicationError("not_found", `${path} is not part of this pull request`);
    }
    return this.deps.catalog.fileContents(snapshot, path);
  }

  startReview(ref: PullRequestRef, options: StartReviewOptions): Promise<{ sessionId: string }> {
    return this.deps.conductReview.start({ ref, ...options, trigger: "manual" });
  }

  session(sessionId: string): Promise<SessionState> {
    return this.deps.sessions.state(sessionId);
  }

  async subscribe(sessionId: string, afterSeq: number, listener: (event: DomainEvent) => void): Promise<Unsubscribe> {
    await this.deps.sessions.get(sessionId); // 404 for unknown sessions
    let delivered = afterSeq;
    const deliver = (event: DomainEvent) => {
      if (event.seq <= delivered) return;
      delivered = event.seq;
      listener(event);
    };
    // Subscribe first and buffer, so no event falls between the replay and the live stream.
    const buffered: DomainEvent[] = [];
    let replaying = true;
    const unsubscribe = this.deps.bus.subscribe(sessionId, (event) => (replaying ? buffered.push(event) : deliver(event)));
    (await this.deps.store.load(sessionId)).forEach(deliver);
    buffered.forEach(deliver);
    replaying = false;
    return unsubscribe;
  }

  async decide(sessionId: string, decision: DecisionInput): Promise<SessionState> {
    const session = await this.deps.sessions.get(sessionId);
    asInvalidRequest(() => session.recordHumanDecision({ ...decision, by: this.deps.reviewerName }));
    await this.deps.sessions.save(session);
    return session.state;
  }

  async publicationPreview(sessionId: string): Promise<PublicationPlan> {
    const state = await this.deps.sessions.state(sessionId);
    const snapshot = await this.reviewedSnapshot(state);
    return asInvalidRequest(() => planPublication(state, ChangeSet.fromSnapshot(snapshot)));
  }

  async publish(sessionId: string): Promise<SessionState> {
    const session = await this.deps.sessions.get(sessionId);
    asConflict(() => session.assertPublishable());
    // Publishing talks to the outside world: a second click must not post a second review.
    if (this.publishing.has(sessionId)) throw new ApplicationError("conflict", "This review is already being published");
    this.publishing.add(sessionId);
    try {
      const snapshot = await this.reviewedSnapshot(session.state);
      const plan = planPublication(session.state, ChangeSet.fromSnapshot(snapshot));
      const published = await this.deps.catalog.source(snapshot.ref.provider).publishReview(snapshot, plan);
      session.recordPublication({
        url: published.url,
        event: published.event,
        inlineComments: published.inlineComments,
        summaryFindings: plan.summaryFindings,
        simulated: published.simulated,
      });
      await this.deps.sessions.save(session);
      return session.state;
    } finally {
      this.publishing.delete(sessionId);
    }
  }

  /** A review is published against the commit it reviewed, never a newer one. */
  private async reviewedSnapshot(state: SessionState): Promise<PullRequestSnapshot> {
    const snapshot = await this.deps.catalog.snapshot(state.pullRequest.ref, { fresh: true });
    if (snapshot.headSha !== state.pullRequest.headSha) {
      throw new ApplicationError("conflict", "The pull request has new commits since this review. Run the council again.");
    }
    return snapshot;
  }
}

function asInvalidRequest<T>(action: () => T): T {
  return translatingDomainErrors("invalid_request", action);
}

function asConflict<T>(action: () => T): T {
  return translatingDomainErrors("conflict", action);
}

function translatingDomainErrors<T>(code: "invalid_request" | "conflict", action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DomainError) throw new ApplicationError(code, error.message);
    throw error;
  }
}

function sessionsOf(states: readonly SessionState[], ref: PullRequestRef): SessionState[] {
  const key = refKey(ref);
  return states
    .filter((state) => refKey(state.pullRequest.ref) === key)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function latestSession(states: readonly SessionState[], ref: PullRequestRef): SessionState | null {
  return sessionsOf(states, ref)[0] ?? null;
}

export function summarizeSession(state: SessionState): SessionSummary {
  return {
    sessionId: state.id,
    headSha: state.pullRequest.headSha,
    engine: state.engine,
    status: state.status,
    startedAt: state.startedAt,
    durationMs: state.durationMs,
    decision: state.verdict?.decision ?? null,
    mergeRisk: state.verdict?.mergeRisk ?? null,
    findings: state.findings.length,
    endorsedFindings: state.findings.filter((f) => state.consensus[f.id]?.level === "endorsed").length,
    patches: state.patches.length,
    published: state.publication !== null,
  };
}
