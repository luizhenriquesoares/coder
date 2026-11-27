import { refKey } from "../domain/change/types.js";
import type { Language } from "../domain/deliberation/model.js";
import type { ConductReview } from "./ConductReview.js";
import { describeError } from "./errors.js";
import type { Logger, PullRequestSummary } from "./ports.js";
import type { PullRequestCatalog } from "./PullRequestCatalog.js";

export interface AutoReviewDeps {
  readonly catalog: PullRequestCatalog;
  readonly conductReview: ConductReview;
  readonly logger: Logger;
  readonly language: Language;
}

/**
 * Policy: every new head commit of an open, non-draft pull request gets
 * reviewed by the council exactly once, without anyone asking.
 *
 * Fed by the GitHub webhook and/or by polling. Pull requests that already
 * existed when the service started form the baseline and are not reviewed
 * (so turning the feature on never triggers a burst of paid reviews).
 */
export class AutoReview {
  private readonly reviewed = new Set<string>();
  private baselineTaken = false;

  constructor(private readonly deps: AutoReviewDeps) {}

  /** Called for a pull request event that explicitly asks for review (webhook). */
  async consider(pullRequest: PullRequestSummary, trigger: "webhook" | "poller"): Promise<string | null> {
    const key = `${refKey(pullRequest.ref)}@${pullRequest.headSha}`;
    if (pullRequest.draft || pullRequest.state !== "open" || this.reviewed.has(key)) return null;
    this.reviewed.add(key);
    try {
      const { sessionId } = await this.deps.conductReview.start({
        ref: pullRequest.ref,
        language: this.deps.language,
        trigger,
      });
      this.deps.logger.info("Council convened automatically", { pullRequest: refKey(pullRequest.ref), sessionId, trigger });
      return sessionId;
    } catch (error) {
      this.reviewed.delete(key);
      this.deps.logger.warn("Automatic review could not start", { pullRequest: refKey(pullRequest.ref), error: describeError(error) });
      return null;
    }
  }

  /** One polling pass over the open pull requests of the configured sources. */
  async poll(): Promise<void> {
    const { items, errors } = await this.deps.catalog.listOpen();
    errors.forEach((error) => this.deps.logger.warn("Could not list pull requests", error));
    const candidates = items.filter((item) => item.ref.provider !== "demo");
    if (!this.baselineTaken) {
      candidates.forEach((item) => this.reviewed.add(`${refKey(item.ref)}@${item.headSha}`));
      this.baselineTaken = true;
      return;
    }
    for (const pullRequest of candidates) await this.consider(pullRequest, "poller");
  }
}
