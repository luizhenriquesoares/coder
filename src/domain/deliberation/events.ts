import type { ChangeStats, PullRequestRef } from "../change/types.js";
import type { RiskProfile } from "../change/riskAssessment.js";
import type {
  Consensus,
  DeclinedFinding,
  Decision,
  Engine,
  Finding,
  HumanDecision,
  Language,
  Patch,
  Position,
  ReviewerId,
  Round,
  Usage,
  Verdict,
} from "./model.js";

/** What the session knows about the pull request it reviews. */
export interface ReviewedPullRequest {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly author: string;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
}

interface EventEnvelope<Type extends string, Payload> {
  readonly type: Type;
  readonly sessionId: string;
  /** Position of the event in the session stream, starting at 1. */
  readonly seq: number;
  readonly at: string;
  readonly payload: Payload;
}

export type ReviewSessionConvened = EventEnvelope<
  "ReviewSessionConvened",
  {
    readonly pullRequest: ReviewedPullRequest;
    readonly council: readonly ReviewerId[];
    readonly engine: Engine;
    readonly model: string | null;
    readonly language: Language;
    readonly stats: ChangeStats;
    readonly risk: RiskProfile;
    readonly trigger: "manual" | "webhook" | "poller";
  }
>;
export type RoundStarted = EventEnvelope<"RoundStarted", { readonly round: Round }>;
export type ReviewerStartedThinking = EventEnvelope<
  "ReviewerStartedThinking",
  { readonly reviewer: ReviewerId; readonly round: Round }
>;
export type StatementMade = EventEnvelope<
  "StatementMade",
  {
    readonly reviewer: ReviewerId;
    readonly round: Round;
    readonly text: string;
    readonly durationMs: number;
    readonly usage: Usage | null;
  }
>;
export type ReviewerFailed = EventEnvelope<
  "ReviewerFailed",
  { readonly reviewer: ReviewerId; readonly round: Round; readonly reason: string }
>;
export type FindingRaised = EventEnvelope<"FindingRaised", { readonly finding: Finding }>;
export type PositionTaken = EventEnvelope<"PositionTaken", { readonly position: Position }>;
export type ConsensusComputed = EventEnvelope<"ConsensusComputed", { readonly consensus: readonly Consensus[] }>;
export type PatchProposed = EventEnvelope<"PatchProposed", { readonly patch: Patch }>;
export type FindingDeclined = EventEnvelope<"FindingDeclined", { readonly declined: DeclinedFinding }>;
export type VerdictIssued = EventEnvelope<"VerdictIssued", { readonly verdict: Verdict }>;
export type ReviewSessionConcluded = EventEnvelope<
  "ReviewSessionConcluded",
  { readonly durationMs: number; readonly usage: Usage }
>;
export type ReviewSessionFailed = EventEnvelope<"ReviewSessionFailed", { readonly reason: string }>;
export type HumanDecisionRecorded = EventEnvelope<"HumanDecisionRecorded", { readonly decision: HumanDecision }>;
export type ReviewPublished = EventEnvelope<
  "ReviewPublished",
  {
    readonly url: string;
    readonly inlineComments: number;
    readonly summaryFindings: number;
    /** How the review was actually posted: `comment` when the source control refused the verdict. */
    readonly decision: Decision;
    readonly simulated: boolean;
  }
>;

export type DomainEvent =
  | ReviewSessionConvened
  | RoundStarted
  | ReviewerStartedThinking
  | StatementMade
  | ReviewerFailed
  | FindingRaised
  | PositionTaken
  | ConsensusComputed
  | PatchProposed
  | FindingDeclined
  | VerdictIssued
  | ReviewSessionConcluded
  | ReviewSessionFailed
  | HumanDecisionRecorded
  | ReviewPublished;

export type DomainEventType = DomainEvent["type"];

export type EventPayload<T extends DomainEventType> = Extract<DomainEvent, { type: T }>["payload"];
