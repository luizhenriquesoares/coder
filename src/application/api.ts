/**
 * The application's API: what any delivery mechanism (HTTP server, or the
 * in-browser standalone build) can ask the application to do.
 */
import type { RiskProfile } from "../domain/change/riskAssessment.js";
import type {
  ChangeStats,
  FileChange,
  FileContents,
  Provider,
  PullRequestRef,
  PullRequestSnapshot,
} from "../domain/change/types.js";
import type { DomainEvent } from "../domain/deliberation/events.js";
import type { Decision, Engine, HumanDecision, Language, MergeRisk } from "../domain/deliberation/model.js";
import type { PublicationPlan } from "../domain/deliberation/publicationPlanner.js";
import type { SessionState, SessionStatus } from "../domain/deliberation/state.js";
import type { PullRequestSummary, Unsubscribe } from "./ports.js";

export interface EngineInfo {
  readonly engine: Engine;
  readonly available: boolean;
  readonly model: string | null;
}

export interface AppConfig {
  /** "standalone" runs entirely in the browser with the scripted demo council. */
  readonly mode: "server" | "standalone";
  readonly engines: readonly EngineInfo[];
  readonly github: {
    readonly configured: boolean;
    readonly canPublish: boolean;
    readonly repositories: readonly string[];
  };
  readonly autoReview: boolean;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly headSha: string;
  readonly engine: Engine;
  readonly status: SessionStatus;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly decision: Decision | null;
  readonly mergeRisk: MergeRisk | null;
  readonly findings: number;
  readonly endorsedFindings: number;
  readonly patches: number;
  readonly published: boolean;
}

export interface InboxItem {
  readonly pullRequest: PullRequestSummary;
  /** Most recent review session of this pull request, if any. */
  readonly latestSession: SessionSummary | null;
  /** True when the latest session reviewed an older commit than the current head. */
  readonly stale: boolean;
}

export interface Inbox {
  readonly items: readonly InboxItem[];
  readonly errors: readonly { readonly provider: Provider; readonly message: string }[];
}

export interface PullRequestDetail {
  readonly pullRequest: Omit<PullRequestSnapshot, "files">;
  readonly files: readonly FileChange[];
  readonly stats: ChangeStats;
  readonly risk: RiskProfile;
  /** Engines able to review this pull request, preferred first. */
  readonly engines: readonly Engine[];
  readonly sessions: readonly SessionSummary[];
}

export interface StartReviewOptions {
  readonly language: Language;
  readonly engine?: Engine;
}

export type DecisionInput = Omit<HumanDecision, "by">;

export interface CoderApi {
  config(): Promise<AppConfig>;
  inbox(): Promise<Inbox>;
  importPullRequest(url: string): Promise<PullRequestRef>;
  pullRequest(ref: PullRequestRef): Promise<PullRequestDetail>;
  /** Both sides of a file. With `headSha`, refuses (conflict) when the pull request has moved past that commit. */
  fileContents(ref: PullRequestRef, path: string, headSha?: string): Promise<FileContents>;
  startReview(ref: PullRequestRef, options: StartReviewOptions): Promise<{ sessionId: string }>;
  session(sessionId: string): Promise<SessionState>;
  /**
   * Replays the events after `afterSeq`, then keeps delivering new ones.
   * `onLost` is called once if the subscription ends for good after it had
   * started (the session is gone, the access was revoked).
   */
  subscribe(
    sessionId: string,
    afterSeq: number,
    listener: (event: DomainEvent) => void,
    onLost?: (error: Error) => void,
  ): Promise<Unsubscribe>;
  decide(sessionId: string, decision: DecisionInput): Promise<SessionState>;
  publicationPreview(sessionId: string): Promise<PublicationPlan>;
  publish(sessionId: string): Promise<SessionState>;
}
