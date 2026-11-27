import { ChangeSet } from "../domain/change/ChangeSet.js";
import { assessRisk } from "../domain/change/riskAssessment.js";
import { revisionKey, type PullRequestRef, type PullRequestSnapshot } from "../domain/change/types.js";
import type { ReviewedPullRequest } from "../domain/deliberation/events.js";
import { DomainError, PANELISTS, type Engine, type Language, type ReviewerId } from "../domain/deliberation/model.js";
import { PERSONAS } from "../domain/deliberation/personas.js";
import { MAX_FINDINGS_PER_REVIEWER, ReviewSession, type Clock } from "../domain/deliberation/ReviewSession.js";
import { levelOf } from "../domain/deliberation/state.js";
import { fallbackVerdict } from "../domain/deliberation/verdictPolicy.js";
import { ApplicationError, describeError } from "./errors.js";
import type { Contribution, CouncilAgents, Logger, ReviewContext } from "./ports.js";
import type { PullRequestCatalog } from "./PullRequestCatalog.js";
import type { SessionRepository } from "./SessionRepository.js";

export interface StartReviewCommand {
  readonly ref: PullRequestRef;
  readonly language: Language;
  readonly engine?: Engine;
  readonly trigger: "manual" | "webhook" | "poller";
}

export interface ConductReviewDeps {
  readonly catalog: PullRequestCatalog;
  readonly councils: readonly CouncilAgents[];
  readonly sessions: SessionRepository;
  readonly logger: Logger;
  readonly newId: () => string;
  /** Defaults to the wall clock. The demo replaces it to replay a session in simulated time. */
  readonly clock?: Clock;
  /** How long one reviewer may take to answer. Defaults to 15 minutes. */
  readonly reviewerDeadlineMs?: number;
}

const DEFAULT_REVIEWER_DEADLINE_MS = 15 * 60_000;

/** Each deliberation is up to ten paid model calls: a cap keeps a burst of requests from becoming a bill. */
export const MAX_CONCURRENT_REVIEWS = 4;

/**
 * Use case: convene the council on a pull request and run the deliberation
 * protocol (opening → debate → implementation → verdict). See docs/DOMAIN.md §8.
 */
export class ConductReview {
  private readonly running = new Map<string, { readonly session: ReviewSession; readonly revision: string; readonly done: Promise<void> }>();
  private readonly clock: Clock;
  private readonly deadlineMs: number;

  constructor(private readonly deps: ConductReviewDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.deadlineMs = deps.reviewerDeadlineMs ?? DEFAULT_REVIEWER_DEADLINE_MS;
  }

  /** Convenes the session and returns immediately; the council deliberates in the background. */
  async start(command: StartReviewCommand): Promise<{ sessionId: string }> {
    const { catalog, sessions, newId } = this.deps;
    const snapshot = await catalog.snapshot(command.ref, { fresh: true });
    const revision = revisionKey(snapshot.ref, snapshot.headSha);
    this.assertRoomFor(revision);
    const agents = this.selectCouncil(snapshot, command.engine);
    const changeSet = ChangeSet.fromSnapshot(snapshot);
    const risk = assessRisk(changeSet);

    const session = ReviewSession.convene(
      {
        id: newId(),
        pullRequest: reviewedPullRequest(snapshot),
        engine: agents.engine,
        model: agents.model,
        language: command.language,
        stats: changeSet.stats,
        risk,
        trigger: command.trigger,
      },
      this.clock,
    );
    sessions.add(session);
    // Claim the slot before the first await, so concurrent starts cannot all pass the cap.
    const saved = sessions.save(session);
    const done = saved
      .then(() => this.deliberate(session, agents, { snapshot, changeSet, risk, language: command.language }))
      .catch((error) => this.deps.logger.error("Review session crashed", { sessionId: session.id, error: describeError(error) }))
      .finally(() => this.running.delete(session.id));
    this.running.set(session.id, { session, revision, done });
    await saved;
    return { sessionId: session.id };
  }

  private assertRoomFor(revision: string): void {
    const running = [...this.running.values()];
    if (running.some((run) => run.revision === revision)) {
      throw new ApplicationError("conflict", "The council is already reviewing this commit of the pull request.");
    }
    if (running.length >= MAX_CONCURRENT_REVIEWS) {
      throw new ApplicationError(
        "conflict",
        `The council is already in session on ${running.length} pull requests, the most it runs at once. Try again when one of them has finished.`,
      );
    }
  }

  /** Resolves when the given session (or every running session) has finished. */
  async whenSettled(sessionId?: string): Promise<void> {
    if (sessionId) return this.running.get(sessionId)?.done ?? Promise.resolve();
    await Promise.all([...this.running.values()].map((run) => run.done));
  }

  /** Fails and saves every session still deliberating, e.g. when the server shuts down. */
  async interruptRunning(reason: string): Promise<void> {
    await Promise.allSettled(
      [...this.running.values()].map(({ session }) => {
        if (session.state.status === "in_progress") session.fail(reason);
        return this.deps.sessions.save(session);
      }),
    );
  }

  availableEngines(snapshot: PullRequestSnapshot): Engine[] {
    return this.deps.councils.filter((council) => council.supports(snapshot)).map((council) => council.engine);
  }

  private selectCouncil(snapshot: PullRequestSnapshot, preferred?: Engine): CouncilAgents {
    const candidates = this.deps.councils.filter((council) => council.supports(snapshot));
    const chosen = candidates.find((council) => council.engine === preferred) ?? candidates[0];
    if (!chosen) {
      throw new ApplicationError(
        "not_configured",
        "No review engine can review this pull request. Set ANTHROPIC_API_KEY to enable the Claude council.",
      );
    }
    return chosen;
  }

  private async deliberate(
    session: ReviewSession,
    agents: CouncilAgents,
    partial: Omit<ReviewContext, "headContents" | "diffOnly">,
  ): Promise<void> {
    const save = () => this.deps.sessions.save(session);
    try {
      const { contents, diffOnly } = await this.deps.catalog.headContents(
        partial.snapshot,
        partial.changeSet,
        partial.risk.reviewOrder,
      );
      for (const file of diffOnly.filter((candidate) => candidate.reason === "unreadable")) {
        this.deps.logger.warn("Reviewers will see only the diff of a file that could not be read", { sessionId: session.id, path: file.path, error: file.error });
      }
      const context: ReviewContext = { ...partial, headContents: contents, diffOnly };
      const protocol = new Protocol(session, agents, context, save, this.deps.logger, this.clock, this.deadlineMs);
      await protocol.opening();
      await protocol.debate();
      await protocol.implementation();
      await protocol.verdict();
      session.conclude();
    } catch (error) {
      this.deps.logger.error("Review session failed", {
        sessionId: session.id,
        error: describeError(error),
        ...(error instanceof Error && !(error instanceof DomainError) ? { stack: error.stack } : {}),
      });
      if (session.state.status === "in_progress") session.fail(describeError(error));
    }
    await save();
  }
}

function describeDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} minute${milliseconds === 60_000 ? "" : "s"}`;
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000} seconds`;
  return `${milliseconds} ms`;
}

function reviewedPullRequest(snapshot: PullRequestSnapshot): ReviewedPullRequest {
  const { ref, title, author, url, baseBranch, headBranch, headSha } = snapshot;
  return { ref, title, author: author.login, url, baseBranch, headBranch, headSha };
}

/** One run of the deliberation protocol over one session. */
class Protocol {
  constructor(
    private readonly session: ReviewSession,
    private readonly agents: CouncilAgents,
    private readonly context: ReviewContext,
    private readonly save: () => Promise<void>,
    private readonly logger: Logger,
    private readonly clock: Clock,
    private readonly deadlineMs: number,
  ) {}

  async opening(): Promise<void> {
    this.session.startRound("opening");
    const spoke = await this.speak(
      PANELISTS,
      (reviewer, signal) => this.agents.open({ persona: PERSONAS[reviewer], context: this.context, signal }),
      (reviewer, contribution) => {
        for (const draft of contribution.findings.slice(0, MAX_FINDINGS_PER_REVIEWER)) {
          this.tolerating(reviewer, () =>
            this.session.raiseFinding(reviewer, draft, this.context.changeSet, this.context.headContents),
          );
        }
      },
    );
    if (spoke.size === 0) throw new Error("No reviewer could complete the opening round");
  }

  async debate(): Promise<void> {
    this.session.startRound("debate");
    const { findings, statements } = this.session.state;
    const openingStatements = statements.filter((s) => s.round === "opening" && !s.failed);
    const panel = PANELISTS.filter((reviewer) => openingStatements.some((s) => s.reviewer === reviewer));
    if (findings.length > 0 && panel.length >= 2) {
      await this.speak(
        panel,
        (reviewer, signal) => this.agents.debate({ persona: PERSONAS[reviewer], context: this.context, signal, findings, openingStatements }),
        (reviewer, contribution) => {
          for (const draft of contribution.positions) {
            this.tolerating(reviewer, () => this.session.takePosition(reviewer, draft));
          }
        },
      );
    }
    this.session.settleConsensus();
    await this.save();
  }

  async implementation(): Promise<void> {
    this.session.startRound("implementation");
    const state = this.session.state;
    const { findings, positions, consensus } = state;
    const worthFixing = findings.filter((f) => levelOf(state, f) !== "rejected");
    if (worthFixing.length === 0) return this.save();

    await this.speak(
      ["implementer"],
      (reviewer, signal) => this.agents.implement({ persona: PERSONAS[reviewer], context: this.context, signal, findings, positions, consensus }),
      (reviewer, contribution) => {
        for (const draft of contribution.patches) {
          this.tolerating(reviewer, () =>
            this.session.proposePatch(reviewer, draft, this.context.changeSet, this.context.headContents),
          );
        }
        for (const { findingId, reason } of contribution.declined) {
          this.tolerating(reviewer, () => this.session.declineFinding(reviewer, findingId, reason));
        }
      },
    );
  }

  async verdict(): Promise<void> {
    this.session.startRound("verdict");
    const state = this.session.state;
    const spoke = await this.speak(
      ["moderator"],
      (reviewer, signal) =>
        this.agents.moderate({
          persona: PERSONAS[reviewer],
          context: this.context,
          signal,
          findings: state.findings,
          positions: state.positions,
          consensus: state.consensus,
          patches: state.patches,
          declined: state.declined,
          statements: state.statements.filter((s) => !s.failed),
        }),
      () => {},
    );
    // If the moderator could not answer, the verdict is derived from consensus alone.
    const draft = spoke.get("moderator")?.verdict ?? fallbackVerdict(this.session.state);
    this.session.issueVerdict("moderator", draft);
    await this.save();
  }

  /**
   * Lets the given reviewers speak concurrently in the current round.
   * `ask` is the (slow) call to the agent; `record` applies its output to the
   * aggregate. A reviewer whose call fails is recorded as failed and the round
   * goes on. An error while recording is a defect of ours, not the reviewer's:
   * the others finish and are recorded, then it fails the session.
   * Returns the contributions of those who spoke.
   */
  private async speak<C extends Contribution>(
    reviewers: readonly ReviewerId[],
    ask: (reviewer: ReviewerId, signal: AbortSignal) => Promise<C>,
    record: (reviewer: ReviewerId, contribution: C) => void,
  ): Promise<Map<ReviewerId, C>> {
    reviewers.forEach((reviewer) => this.session.startThinking(reviewer));
    await this.save();

    const spoke = new Map<ReviewerId, C>();
    const outcomes = await Promise.allSettled(
      reviewers.map(async (reviewer) => {
        const startedAt = this.clock().getTime();
        let contribution: C;
        try {
          contribution = await this.within(this.deadlineMs, (signal) => ask(reviewer, signal));
        } catch (error) {
          this.logger.warn("Reviewer failed", { reviewer, error: describeError(error) });
          this.session.reportFailure(reviewer, describeError(error));
          return this.save();
        }
        // Recording is synchronous, so each reviewer's events stay contiguous. A blank statement must not cost the findings.
        this.session.makeStatement(reviewer, contribution.statement.trim() || "—", {
          durationMs: this.clock().getTime() - startedAt,
          usage: contribution.usage,
        });
        record(reviewer, contribution);
        spoke.set(reviewer, contribution);
        return this.save();
      }),
    );
    const defect = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (defect) throw defect.reason;
    return spoke;
  }

  /**
   * The deadline is a rule of the protocol, not of an engine: the agent is
   * told through the signal, and the round stops waiting even if it ignores it.
   */
  private async within<C>(milliseconds: number, ask: (signal: AbortSignal) => Promise<C>): Promise<C> {
    const signal = AbortSignal.timeout(milliseconds);
    let onAbort = () => {};
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(`The reviewer did not answer within ${describeDuration(milliseconds)}.`));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([ask(signal), deadline]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** A single malformed item from a reviewer must not sink the whole contribution. */
  private tolerating(reviewer: ReviewerId, record: () => unknown): void {
    try {
      record();
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn("Discarded an invalid contribution", { reviewer, reason: error.message });
    }
  }
}
