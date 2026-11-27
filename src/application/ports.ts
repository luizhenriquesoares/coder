/**
 * Ports of the application layer (hexagonal architecture).
 * The domain and the application never import an adapter; adapters implement these.
 */
import type { ChangeSet } from "../domain/change/ChangeSet.js";
import type { RiskProfile } from "../domain/change/riskAssessment.js";
import type {
  Author,
  FileContents,
  Provider,
  PullRequestRef,
  PullRequestSnapshot,
  PullRequestState,
} from "../domain/change/types.js";
import type { HeadContents } from "../domain/deliberation/codeAnchoring.js";
import type { DomainEvent } from "../domain/deliberation/events.js";
import type {
  Consensus,
  DeclinedFinding,
  Decision,
  Engine,
  Finding,
  Language,
  Patch,
  Position,
  Usage,
} from "../domain/deliberation/model.js";
import type { Persona } from "../domain/deliberation/personas.js";
import type { PublicationPlan } from "../domain/deliberation/publicationPlanner.js";
import type { FindingDraft, PatchDraft, PositionDraft } from "../domain/deliberation/ReviewSession.js";
import type { Statement } from "../domain/deliberation/state.js";
import type { VerdictDraft } from "../domain/deliberation/verdictPolicy.js";

// ── Source Control (ACL) ──────────────────────────────────────────────────

export interface PullRequestSummary {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly author: Author;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly draft: boolean;
  readonly state: PullRequestState;
}

export function summarize(snapshot: PullRequestSnapshot): PullRequestSummary {
  const { ref, title, author, url, baseBranch, headBranch, headSha, updatedAt, draft, state } = snapshot;
  return { ref, title, author, url, baseBranch, headBranch, headSha, updatedAt, draft, state };
}

export interface PublishedReview {
  readonly url: string;
  /** How the review was actually posted, which may be `comment` when the source refused the verdict. */
  readonly decision: Decision;
  readonly inlineComments: number;
  readonly simulated: boolean;
}

export interface SourceControl {
  readonly provider: Provider;
  listOpenPullRequests(): Promise<PullRequestSummary[]>;
  getSnapshot(ref: PullRequestRef): Promise<PullRequestSnapshot>;
  getFileContents(snapshot: PullRequestSnapshot, path: string): Promise<FileContents>;
  publishReview(snapshot: PullRequestSnapshot, plan: PublicationPlan): Promise<PublishedReview>;
}

// ── Model Gateway: the council's reviewer agents ──────────────────────────

/** Everything a reviewer may look at. */
export interface ReviewContext {
  readonly snapshot: PullRequestSnapshot;
  readonly changeSet: ChangeSet;
  readonly risk: RiskProfile;
  readonly headContents: HeadContents;
  /** Files reviewers can only see as a diff (binary, removed or over the content budget). */
  readonly diffOnly: readonly string[];
  readonly language: Language;
}

export interface Contribution {
  readonly statement: string;
  readonly usage: Usage | null;
}

export interface OpeningBrief {
  readonly persona: Persona;
  readonly context: ReviewContext;
}
export interface OpeningContribution extends Contribution {
  readonly findings: readonly FindingDraft[];
}

export interface DebateBrief {
  readonly persona: Persona;
  readonly context: ReviewContext;
  readonly findings: readonly Finding[];
  readonly openingStatements: readonly Statement[];
}
export interface DebateContribution extends Contribution {
  readonly positions: readonly PositionDraft[];
}

export interface ImplementationBrief {
  readonly persona: Persona;
  readonly context: ReviewContext;
  readonly findings: readonly Finding[];
  readonly positions: readonly Position[];
  readonly consensus: Readonly<Record<string, Consensus>>;
}
export interface ImplementationContribution extends Contribution {
  readonly patches: readonly PatchDraft[];
  readonly declined: readonly { readonly findingId: string; readonly reason: string }[];
}

export interface VerdictBrief {
  readonly persona: Persona;
  readonly context: ReviewContext;
  readonly findings: readonly Finding[];
  readonly positions: readonly Position[];
  readonly consensus: Readonly<Record<string, Consensus>>;
  readonly patches: readonly Patch[];
  readonly declined: readonly DeclinedFinding[];
  readonly statements: readonly Statement[];
}
export interface VerdictContribution extends Contribution {
  readonly verdict: VerdictDraft;
}

export interface CouncilAgents {
  readonly engine: Engine;
  readonly model: string | null;
  /** Scripted agents only know the demo fixtures. */
  supports(snapshot: PullRequestSnapshot): boolean;
  open(brief: OpeningBrief): Promise<OpeningContribution>;
  debate(brief: DebateBrief): Promise<DebateContribution>;
  implement(brief: ImplementationBrief): Promise<ImplementationContribution>;
  moderate(brief: VerdictBrief): Promise<VerdictContribution>;
}

// ── Persistence & messaging ───────────────────────────────────────────────

export interface EventStore {
  append(events: readonly DomainEvent[]): Promise<void>;
  load(sessionId: string): Promise<DomainEvent[]>;
  sessionIds(): Promise<string[]>;
}

/** Pull requests the user asked to follow individually (imported by URL). */
export interface Watchlist {
  all(): Promise<PullRequestRef[]>;
  add(ref: PullRequestRef): Promise<void>;
}

export type Unsubscribe = () => void;

export interface EventBus {
  publish(events: readonly DomainEvent[]): void;
  subscribe(sessionId: string, listener: (event: DomainEvent) => void): Unsubscribe;
  /** Every event of every session (used by background projections). */
  subscribeAll(listener: (event: DomainEvent) => void): Unsubscribe;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
