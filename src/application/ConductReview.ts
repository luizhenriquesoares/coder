import { ChangeSet } from "../domain/change/ChangeSet.js";
import { assessRisk } from "../domain/change/riskAssessment.js";
import type { PullRequestRef, PullRequestSnapshot } from "../domain/change/types.js";
import type { ReviewedPullRequest } from "../domain/deliberation/events.js";
import { DomainError, PANELISTS, type Engine, type Language, type ReviewerId } from "../domain/deliberation/model.js";
import { PERSONAS } from "../domain/deliberation/personas.js";
import { MAX_FINDINGS_PER_REVIEWER, ReviewSession, type Clock } from "../domain/deliberation/ReviewSession.js";
import { ApplicationError, describeError } from "./errors.js";
import { fallbackVerdict } from "./fallbackVerdict.js";
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
}

/**
 * Use case: convene the council on a pull request and run the deliberation
 * protocol (opening → debate → implementation → verdict). See docs/DOMAIN.md §8.
 */
export class ConductReview {
  private readonly running = new Map<string, Promise<void>>();
  private readonly clock: Clock;

  constructor(private readonly deps: ConductReviewDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Convenes the session and returns immediately; the council deliberates in the background. */
  async start(command: StartReviewCommand): Promise<{ sessionId: string }> {
    const { catalog, sessions, newId } = this.deps;
    const snapshot = await catalog.snapshot(command.ref, { fresh: true });
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
    await sessions.save(session);

    const run = this.deliberate(session, agents, { snapshot, changeSet, risk, language: command.language })
      .catch((error) => this.deps.logger.error("Review session crashed", { sessionId: session.id, error: describeError(error) }))
      .finally(() => this.running.delete(session.id));
    this.running.set(session.id, run);
    return { sessionId: session.id };
  }

  /** Resolves when the given session (or every running session) has finished. */
  async whenSettled(sessionId?: string): Promise<void> {
    if (sessionId) return this.running.get(sessionId) ?? Promise.resolve();
    await Promise.all(this.running.values());
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
      const context: ReviewContext = { ...partial, headContents: contents, diffOnly };
      const protocol = new Protocol(session, agents, context, save, this.deps.logger, this.clock);
      await protocol.opening();
      await protocol.debate();
      await protocol.implementation();
      await protocol.verdict();
      session.conclude();
    } catch (error) {
      this.deps.logger.error("Review session failed", { sessionId: session.id, error: describeError(error) });
      if (session.state.status === "in_progress") session.fail(describeError(error));
    }
    await save();
  }
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
  ) {}

  async opening(): Promise<void> {
    this.session.startRound("opening");
    const spoke = await this.speak(
      PANELISTS,
      (reviewer) => this.agents.open({ persona: PERSONAS[reviewer], context: this.context }),
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
        (reviewer) => this.agents.debate({ persona: PERSONAS[reviewer], context: this.context, findings, openingStatements }),
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
    const { findings, positions, consensus } = this.session.state;
    const worthFixing = findings.filter((f) => consensus[f.id]?.level !== "rejected");
    if (worthFixing.length === 0) return this.save();

    await this.speak(
      ["implementer"],
      (reviewer) => this.agents.implement({ persona: PERSONAS[reviewer], context: this.context, findings, positions, consensus }),
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
      (reviewer) =>
        this.agents.moderate({
          persona: PERSONAS[reviewer],
          context: this.context,
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
   * aggregate. A reviewer that fails is recorded and the round goes on.
   * Returns the contributions of those who spoke.
   */
  private async speak<C extends Contribution>(
    reviewers: readonly ReviewerId[],
    ask: (reviewer: ReviewerId) => Promise<C>,
    record: (reviewer: ReviewerId, contribution: C) => void,
  ): Promise<Map<ReviewerId, C>> {
    reviewers.forEach((reviewer) => this.session.startThinking(reviewer));
    await this.save();

    const spoke = new Map<ReviewerId, C>();
    await Promise.all(
      reviewers.map(async (reviewer) => {
        const startedAt = this.clock().getTime();
        try {
          const contribution = await ask(reviewer);
          // Recording is synchronous, so each reviewer's events stay contiguous.
          this.session.makeStatement(reviewer, contribution.statement, {
            durationMs: this.clock().getTime() - startedAt,
            usage: contribution.usage,
          });
          record(reviewer, contribution);
          spoke.set(reviewer, contribution);
        } catch (error) {
          this.logger.warn("Reviewer failed", { reviewer, error: describeError(error) });
          this.failReviewer(reviewer, describeError(error));
        }
        await this.save();
      }),
    );
    return spoke;
  }

  private failReviewer(reviewer: ReviewerId, reason: string): void {
    const alreadySpoke = this.session.state.statements.some(
      (s) => s.reviewer === reviewer && s.round === this.session.state.currentRound,
    );
    if (!alreadySpoke) this.session.reportFailure(reviewer, reason);
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
