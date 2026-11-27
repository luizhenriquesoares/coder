import type { ChangeSet } from "../change/ChangeSet.js";
import type { ChangeStats } from "../change/types.js";
import type { RiskProfile } from "../change/riskAssessment.js";
import { anchorLocation, type HeadContents } from "./codeAnchoring.js";
import { computeAllConsensus } from "./consensusPolicy.js";
import type { DomainEvent, DomainEventType, EventPayload, ReviewedPullRequest } from "./events.js";
import {
  DomainError,
  ROUNDS,
  type Category,
  type Consensus,
  type Decision,
  type Engine,
  type Finding,
  type HumanDecision,
  type Language,
  type Patch,
  type Position,
  type ReviewerId,
  type Round,
  type Severity,
  type Stance,
  type Trigger,
  type Usage,
  type Verdict,
} from "./model.js";
import { locateSnippet, replacementLinesAt } from "./patching.js";
import { PERSONAS, COUNCIL_ORDER } from "./personas.js";
import { decisionKey, decisionsOpen, evolve, foldEvents, type SessionState } from "./state.js";
import { applyVerdictPolicy, type VerdictDraft } from "./verdictPolicy.js";

export interface ConveneCommand {
  readonly id: string;
  readonly pullRequest: ReviewedPullRequest;
  readonly engine: Engine;
  readonly model: string | null;
  readonly language: Language;
  readonly stats: ChangeStats;
  readonly risk: RiskProfile;
  readonly trigger: Trigger;
}

export interface FindingDraft {
  readonly key?: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly title: string;
  readonly rationale: string;
  readonly recommendation: string;
  readonly principle: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly quote: string;
}

export interface PositionDraft {
  readonly findingId: string;
  readonly stance: Stance;
  readonly argument: string;
}

export interface PatchDraft {
  readonly findingIds: readonly string[];
  readonly path: string;
  readonly original: string;
  readonly replacement: string;
  readonly explanation: string;
}

export interface PublicationRecord {
  readonly url: string;
  readonly inlineComments: number;
  readonly summaryFindings: number;
  /** How the review was actually posted: `comment` when the source control refused the verdict. */
  readonly decision: Decision;
  readonly simulated: boolean;
}

/** Signal-over-noise rule: a reviewer may raise at most this many findings per session. */
export const MAX_FINDINGS_PER_REVIEWER = 8;

export type Clock = () => Date;

/**
 * ReviewSession — aggregate root of the core domain (event-sourced).
 *
 * Every command validates the invariants listed in docs/DOMAIN.md §6 and
 * records events. Callers persist `pullPendingEvents()`.
 */
export class ReviewSession {
  private pending: DomainEvent[] = [];

  private constructor(
    private current: SessionState,
    private readonly clock: Clock,
  ) {}

  static convene(command: ConveneCommand, clock: Clock = () => new Date()): ReviewSession {
    const { id, ...payload } = command;
    const convened: DomainEvent = {
      type: "ReviewSessionConvened",
      sessionId: id,
      seq: 1,
      at: clock().toISOString(),
      payload: { ...payload, council: COUNCIL_ORDER },
    };
    const session = new ReviewSession(foldEvents([convened]), clock);
    session.pending.push(convened);
    return session;
  }

  static rehydrate(events: readonly DomainEvent[], clock: Clock = () => new Date()): ReviewSession {
    return new ReviewSession(foldEvents(events), clock);
  }

  get id(): string {
    return this.current.id;
  }

  get state(): SessionState {
    return this.current;
  }

  pullPendingEvents(): DomainEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  // ── Protocol ────────────────────────────────────────────────────────────

  startRound(round: Round): void {
    this.assertInProgress();
    const expected = ROUNDS[this.current.rounds.length];
    if (round !== expected) throw new DomainError(`Round "${round}" cannot start now; expected "${expected ?? "none"}"`);
    this.record("RoundStarted", { round });
  }

  startThinking(reviewer: ReviewerId): void {
    const round = this.assertSpeakingTurn(reviewer);
    this.record("ReviewerStartedThinking", { reviewer, round });
  }

  makeStatement(reviewer: ReviewerId, text: string, meta: { durationMs: number; usage: Usage | null }): void {
    const round = this.assertSpeakingTurn(reviewer);
    if (text.trim().length === 0) throw new DomainError("A statement cannot be empty");
    this.record("StatementMade", { reviewer, round, text: text.trim(), durationMs: meta.durationMs, usage: meta.usage });
  }

  reportFailure(reviewer: ReviewerId, reason: string): void {
    const round = this.assertSpeakingTurn(reviewer);
    this.record("ReviewerFailed", { reviewer, round, reason });
  }

  raiseFinding(reviewer: ReviewerId, draft: FindingDraft, changeSet: ChangeSet, contents: HeadContents): Finding {
    this.assertRound("opening");
    this.assertParticipates(reviewer, "opening");
    const authored = this.current.findings.filter((f) => f.author === reviewer).length;
    if (authored >= MAX_FINDINGS_PER_REVIEWER) {
      throw new DomainError(`${reviewer} already raised ${MAX_FINDINGS_PER_REVIEWER} findings`);
    }
    if (draft.title.trim().length === 0) throw new DomainError("A finding needs a title");

    const finding: Finding = {
      id: `F-${this.current.findings.length + 1}`,
      ...(draft.key ? { key: draft.key } : {}),
      author: reviewer,
      severity: draft.severity,
      category: draft.category,
      title: draft.title.trim(),
      rationale: draft.rationale.trim(),
      recommendation: draft.recommendation.trim(),
      principle: draft.principle.trim(),
      location: anchorLocation({ path: draft.path, line: draft.line, quote: draft.quote }, changeSet, contents),
    };
    this.record("FindingRaised", { finding });
    return finding;
  }

  takePosition(reviewer: ReviewerId, draft: PositionDraft): Position {
    this.assertRound("debate");
    this.assertParticipates(reviewer, "debate");
    const finding = this.findingOrThrow(draft.findingId);
    if (finding.author === reviewer) throw new DomainError("A reviewer cannot take a position on their own finding");
    const duplicate = this.current.positions.some((p) => p.reviewer === reviewer && p.findingId === finding.id);
    if (duplicate) throw new DomainError(`${reviewer} already took a position on ${finding.id}`);

    const position: Position = { reviewer, findingId: finding.id, stance: draft.stance, argument: draft.argument.trim() };
    this.record("PositionTaken", { position });
    return position;
  }

  settleConsensus(): readonly Consensus[] {
    this.assertRound("debate");
    const consensus = computeAllConsensus(this.current.findings, this.current.positions);
    this.record("ConsensusComputed", { consensus });
    return consensus;
  }

  proposePatch(reviewer: ReviewerId, draft: PatchDraft, changeSet: ChangeSet, contents: HeadContents): Patch {
    this.assertRound("implementation");
    this.assertParticipates(reviewer, "implementation");
    if (draft.findingIds.length === 0) throw new DomainError("A patch must address at least one finding");
    const fixes = draft.findingIds.map((id) => this.findingOrThrow(id));
    const path = changeSet.resolvePath(draft.path);
    if (!path) throw new DomainError(`Patch targets a file outside the change set: ${draft.path}`);

    // A snippet that occurs more than once belongs to the occurrence its findings point at.
    const near = fixes.flatMap(({ location }) => (location.path === path && location.line !== null ? [location.line] : []));
    const head = contents.get(path);
    const location = head === undefined ? null : locateSnippet(head, draft.original, near);
    const patch: Patch = {
      id: `P-${this.current.patches.length + 1}`,
      author: reviewer,
      findingIds: [...new Set(draft.findingIds)],
      path,
      original: draft.original,
      replacement: draft.replacement,
      explanation: draft.explanation.trim(),
      applicable: location !== null,
      startLine: location?.startLine ?? null,
      endLine: location?.endLine ?? null,
      replacementLines: location && head !== undefined ? replacementLinesAt(head, location, draft.replacement) : null,
    };
    this.record("PatchProposed", { patch });
    return patch;
  }

  declineFinding(reviewer: ReviewerId, findingId: string, reason: string): void {
    this.assertRound("implementation");
    this.assertParticipates(reviewer, "implementation");
    this.findingOrThrow(findingId);
    this.record("FindingDeclined", { declined: { findingId, by: reviewer, reason: reason.trim() } });
  }

  issueVerdict(reviewer: ReviewerId, draft: VerdictDraft): Verdict {
    this.assertRound("verdict");
    this.assertParticipates(reviewer, "verdict");
    if (this.current.verdict) throw new DomainError("The verdict was already issued");
    const verdict = applyVerdictPolicy(draft, this.current.findings, this.current.consensus);
    this.record("VerdictIssued", { verdict });
    return verdict;
  }

  conclude(): void {
    this.assertInProgress();
    if (!this.current.verdict) throw new DomainError("A session concludes only after the verdict");
    const durationMs = Date.parse(this.now()) - Date.parse(this.current.startedAt);
    this.record("ReviewSessionConcluded", { durationMs: Math.max(0, durationMs), usage: this.current.usage });
  }

  fail(reason: string): void {
    this.assertInProgress();
    this.record("ReviewSessionFailed", { reason });
  }

  // ── Human in the loop ───────────────────────────────────────────────────

  recordHumanDecision(decision: HumanDecision): void {
    const { kind, id } = decision.target;
    const exists =
      kind === "finding" ? this.current.findings.some((f) => f.id === id) : this.current.patches.some((p) => p.id === id);
    if (!exists) throw new DomainError(`Unknown ${kind} ${id}`);
    if (this.current.decisions[decisionKey(decision.target)]?.action === decision.action) return; // idempotent
    if (!decisionsOpen(this.current)) {
      if (this.current.publication) throw new DomainError("This review was already published; its decisions are closed");
      if (this.current.publishing) throw new DomainError("This review is being published; its decisions are closed");
      throw new DomainError("Decisions open once the council has concluded");
    }
    this.record("HumanDecisionRecorded", { decision });
  }

  /**
   * Publishing talks to the outside world, so its intent is recorded first:
   * from here until it is published or failed, decisions are closed and no
   * second publication can start.
   */
  startPublication(): void {
    this.assertPublishable();
    this.record("PublicationStarted", {});
  }

  failPublication(reason: string): void {
    if (!this.current.publishing) throw new DomainError("No publication is in progress");
    this.record("PublicationFailed", { reason });
  }

  /** A review is published once: what the pull request author reads must not change under them. */
  recordPublication(publication: PublicationRecord): void {
    if (!this.current.publishing) throw new DomainError("A publication is recorded only after it was started");
    this.record("ReviewPublished", publication);
  }

  assertPublishable(): void {
    if (this.current.status !== "concluded") throw new DomainError("Only a concluded review can be published");
    if (this.current.publication) throw new DomainError("This review was already published");
    if (this.current.publishing) throw new DomainError("This review is already being published");
  }

  // ── Invariants ──────────────────────────────────────────────────────────

  private assertInProgress(): void {
    if (this.current.status !== "in_progress") throw new DomainError(`Session is ${this.current.status}`);
  }

  private assertRound(round: Round): void {
    this.assertInProgress();
    if (this.current.currentRound !== round) {
      throw new DomainError(`This happens in the "${round}" round; current round is "${this.current.currentRound ?? "none"}"`);
    }
  }

  private assertParticipates(reviewer: ReviewerId, round: Round): void {
    if (!this.current.council.includes(reviewer)) throw new DomainError(`${reviewer} is not seated in this council`);
    if (!PERSONAS[reviewer].rounds.includes(round)) throw new DomainError(`${reviewer} does not speak in the ${round} round`);
  }

  /** Returns the current round after checking the reviewer may still speak in it. */
  private assertSpeakingTurn(reviewer: ReviewerId): Round {
    this.assertInProgress();
    const round = this.current.currentRound;
    if (!round) throw new DomainError("No round is open");
    this.assertParticipates(reviewer, round);
    const spoke = this.current.statements.some((s) => s.reviewer === reviewer && s.round === round);
    if (spoke) throw new DomainError(`${reviewer} already spoke in the ${round} round`);
    return round;
  }

  private findingOrThrow(id: string): Finding {
    const finding = this.current.findings.find((f) => f.id === id);
    if (!finding) throw new DomainError(`Unknown finding ${id}`);
    return finding;
  }

  private record<T extends DomainEventType>(type: T, payload: EventPayload<T>): void {
    const event = {
      type,
      payload,
      sessionId: this.current.id,
      seq: this.current.lastSeq + 1,
      at: this.now(),
    } as Extract<DomainEvent, { type: T }>;
    this.current = evolve(this.current, event);
    this.pending.push(event);
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
