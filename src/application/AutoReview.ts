import { refKey, revisionKey } from "../domain/change/types.js";
import type { Language, Trigger } from "../domain/deliberation/model.js";
import type { ConductReview } from "./ConductReview.js";
import { describeError } from "./errors.js";
import type { Logger, PullRequestSummary } from "./ports.js";
import type { PullRequestCatalog } from "./PullRequestCatalog.js";
import type { SessionRepository } from "./SessionRepository.js";

export interface AutoReviewDeps {
  readonly catalog: Pick<PullRequestCatalog, "listOpen">;
  readonly conductReview: Pick<ConductReview, "start">;
  readonly sessions: Pick<SessionRepository, "allStates">;
  readonly logger: Logger;
  readonly language: Language;
}

/** A head whose councils failed this many times is left alone: a broken configuration must not pay on every poll. */
const MAX_FAILED_SESSIONS_PER_HEAD = 2;

/**
 * Policy: every new head commit of an open, non-draft pull request gets
 * reviewed by the council exactly once, without anyone asking.
 *
 * Fed by the GitHub webhook and/or by polling. Pull requests that already
 * existed when the service started form the baseline and are not reviewed
 * (so turning the feature on never triggers a burst of paid reviews), and the
 * baseline is only taken from a complete listing. Whether a head was already
 * reviewed is answered by the stored sessions, so it survives a restart.
 */
export class AutoReview {
  private readonly baseline = new Set<string>();
  private readonly starting = new Set<string>();
  private baselineTaken = false;

  constructor(private readonly deps: AutoReviewDeps) {}

  /** Called for a pull request event that explicitly asks for review (webhook). */
  async consider(pullRequest: PullRequestSummary, trigger: Exclude<Trigger, "manual">): Promise<string | null> {
    const key = revisionKey(pullRequest.ref, pullRequest.headSha);
    if (pullRequest.draft || pullRequest.state !== "open" || this.baseline.has(key) || this.starting.has(key)) return null;
    this.starting.add(key);
    try {
      if (await this.alreadyReviewed(key)) return null;
      const { sessionId } = await this.deps.conductReview.start({ ref: pullRequest.ref, language: this.deps.language, trigger });
      this.deps.logger.info("Council convened automatically", { pullRequest: refKey(pullRequest.ref), sessionId, trigger });
      return sessionId;
    } catch (error) {
      this.deps.logger.warn("Automatic review could not start", { pullRequest: refKey(pullRequest.ref), error: describeError(error) });
      return null;
    } finally {
      this.starting.delete(key);
    }
  }

  /** One polling pass over the open pull requests of the configured sources. */
  async poll(): Promise<void> {
    const { items, errors } = await this.deps.catalog.listOpen();
    const reviewedErrors = errors.filter((error) => error.provider !== "demo");
    if (reviewedErrors.length > 0) {
      // A partial listing would make every pull request it missed look new on the next pass.
      for (const error of reviewedErrors) this.deps.logger.warn("Automatic review is waiting for a complete listing", error);
      return;
    }
    const candidates = items.filter((item) => item.ref.provider !== "demo");
    if (!this.baselineTaken) {
      candidates.forEach((item) => this.baseline.add(revisionKey(item.ref, item.headSha)));
      this.baselineTaken = true;
      return;
    }
    for (const pullRequest of candidates) await this.consider(pullRequest, "poller");
  }

  /** A head is done once it has a session that did not fail, or enough failed ones. */
  private async alreadyReviewed(key: string): Promise<boolean> {
    const sessions = (await this.deps.sessions.allStates()).filter(
      (state) => revisionKey(state.pullRequest.ref, state.pullRequest.headSha) === key,
    );
    const failed = sessions.filter((state) => state.status === "failed").length;
    return failed < sessions.length || failed >= MAX_FAILED_SESSIONS_PER_HEAD;
  }
}
