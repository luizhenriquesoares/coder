import type { ChangeStats } from "../change/types.js";
import type { RiskProfile } from "../change/riskAssessment.js";
import type { DomainEvent, ReviewedPullRequest } from "./events.js";
import {
  addUsage,
  ZERO_USAGE,
  type Consensus,
  type DeclinedFinding,
  type Engine,
  type Finding,
  type HumanDecision,
  type Language,
  type Patch,
  type Position,
  type ReviewerId,
  type Round,
  type Usage,
  type Verdict,
} from "./model.js";

export type SessionStatus = "in_progress" | "concluded" | "failed";

export interface Statement {
  readonly reviewer: ReviewerId;
  readonly round: Round;
  readonly text: string;
  readonly at: string;
  readonly durationMs: number;
  readonly failed: boolean;
}

export interface Publication {
  readonly url: string;
  readonly inlineComments: number;
  readonly summaryFindings: number;
  readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  readonly simulated: boolean;
  readonly at: string;
}

/**
 * The state of a review session, rebuilt by folding its events.
 * The same fold powers the aggregate (write side) and the workspace (read side).
 */
export interface SessionState {
  readonly id: string;
  readonly status: SessionStatus;
  readonly pullRequest: ReviewedPullRequest;
  readonly council: readonly ReviewerId[];
  readonly engine: Engine;
  readonly model: string | null;
  readonly language: Language;
  readonly trigger: "manual" | "webhook" | "poller";
  readonly stats: ChangeStats;
  readonly risk: RiskProfile;
  readonly rounds: readonly Round[];
  readonly currentRound: Round | null;
  /** Reviewers working right now. */
  readonly thinking: readonly ReviewerId[];
  readonly statements: readonly Statement[];
  readonly findings: readonly Finding[];
  readonly positions: readonly Position[];
  readonly consensus: Readonly<Record<string, Consensus>>;
  readonly patches: readonly Patch[];
  readonly declined: readonly DeclinedFinding[];
  readonly verdict: Verdict | null;
  readonly decisions: Readonly<Record<string, HumanDecision>>;
  readonly publication: Publication | null;
  readonly usage: Usage;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly failureReason: string | null;
  readonly lastSeq: number;
}

export function decisionKey(target: HumanDecision["target"]): string {
  return `${target.kind}:${target.id}`;
}

/** Builds a session state from its full event stream. */
export function foldEvents(events: readonly DomainEvent[]): SessionState {
  const [first, ...rest] = events;
  if (!first || first.type !== "ReviewSessionConvened") {
    throw new Error("A session stream must start with ReviewSessionConvened");
  }
  return rest.reduce(evolve, initialState(first));
}

function initialState(event: Extract<DomainEvent, { type: "ReviewSessionConvened" }>): SessionState {
  const { pullRequest, council, engine, model, language, stats, risk, trigger } = event.payload;
  return {
    id: event.sessionId,
    status: "in_progress",
    pullRequest,
    council,
    engine,
    model,
    language,
    trigger,
    stats,
    risk,
    rounds: [],
    currentRound: null,
    thinking: [],
    statements: [],
    findings: [],
    positions: [],
    consensus: {},
    patches: [],
    declined: [],
    verdict: null,
    decisions: {},
    publication: null,
    usage: ZERO_USAGE,
    startedAt: event.at,
    endedAt: null,
    durationMs: null,
    failureReason: null,
    lastSeq: event.seq,
  };
}

/** Pure state transition. Never throws for well-formed streams. */
export function evolve(state: SessionState, event: DomainEvent): SessionState {
  const next = transition(state, event);
  return { ...next, lastSeq: event.seq };
}

function transition(state: SessionState, event: DomainEvent): SessionState {
  switch (event.type) {
    case "ReviewSessionConvened":
      return initialState(event);
    case "RoundStarted":
      return { ...state, rounds: [...state.rounds, event.payload.round], currentRound: event.payload.round };
    case "ReviewerStartedThinking":
      return { ...state, thinking: [...without(state.thinking, event.payload.reviewer), event.payload.reviewer] };
    case "StatementMade": {
      const { reviewer, round, text, durationMs, usage } = event.payload;
      return {
        ...state,
        thinking: without(state.thinking, reviewer),
        statements: [...state.statements, { reviewer, round, text, at: event.at, durationMs, failed: false }],
        usage: usage ? addUsage(state.usage, usage) : state.usage,
      };
    }
    case "ReviewerFailed": {
      const { reviewer, round, reason } = event.payload;
      return {
        ...state,
        thinking: without(state.thinking, reviewer),
        statements: [...state.statements, { reviewer, round, text: reason, at: event.at, durationMs: 0, failed: true }],
      };
    }
    case "FindingRaised":
      return { ...state, findings: [...state.findings, event.payload.finding] };
    case "PositionTaken":
      return { ...state, positions: [...state.positions, event.payload.position] };
    case "ConsensusComputed":
      return {
        ...state,
        consensus: Object.fromEntries(event.payload.consensus.map((c) => [c.findingId, c])),
      };
    case "PatchProposed":
      return { ...state, patches: [...state.patches, event.payload.patch] };
    case "FindingDeclined":
      return { ...state, declined: [...state.declined, event.payload.declined] };
    case "VerdictIssued":
      return { ...state, verdict: event.payload.verdict };
    case "ReviewSessionConcluded":
      return {
        ...state,
        status: "concluded",
        currentRound: null,
        thinking: [],
        endedAt: event.at,
        durationMs: event.payload.durationMs,
      };
    case "ReviewSessionFailed":
      return {
        ...state,
        status: "failed",
        currentRound: null,
        thinking: [],
        endedAt: event.at,
        failureReason: event.payload.reason,
      };
    case "HumanDecisionRecorded": {
      const { decision } = event.payload;
      return { ...state, decisions: { ...state.decisions, [decisionKey(decision.target)]: decision } };
    }
    case "ReviewPublished":
      return { ...state, publication: { ...event.payload, at: event.at } };
  }
}

function without<T>(items: readonly T[], item: T): T[] {
  return items.filter((candidate) => candidate !== item);
}
