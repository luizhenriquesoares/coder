import { ApplicationError } from "../../application/errors.js";
import type { PublishedReview, PullRequestSummary, SourceControl } from "../../application/ports.js";
import { summarize } from "../../application/ports.js";
import { refKey, type FileContents, type PullRequestRef, type PullRequestSnapshot, type RawFileChange } from "../../domain/change/types.js";
import type { PublicationPlan } from "../../domain/deliberation/publicationPlanner.js";
import { DEMO_PULL_REQUESTS } from "./fixtures/index.js";
import { unifiedDiff } from "./lineDiff.js";
import type { DemoFile, DemoPullRequest } from "./types.js";

/**
 * Source-control adapter backed by built-in fixtures. It lets the whole
 * product run with no network and no credentials. Publishing is simulated:
 * the review is returned as it would be sent, and nothing leaves the process.
 */
export class DemoSourceControl implements SourceControl {
  readonly provider = "demo" as const;
  readonly refreshIntervalMs = 0; // nothing to save: the fixtures are in memory
  private readonly startedAt: number;

  constructor(
    private readonly pullRequests: readonly DemoPullRequest[] = DEMO_PULL_REQUESTS,
    now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  async listOpenPullRequests(): Promise<PullRequestSummary[]> {
    return this.pullRequests.map((pr) => summarize(this.toSnapshot(pr)));
  }

  async getSummary(ref: PullRequestRef): Promise<PullRequestSummary> {
    return summarize(this.toSnapshot(this.find(ref)));
  }

  async getSnapshot(ref: PullRequestRef): Promise<PullRequestSnapshot> {
    return this.toSnapshot(this.find(ref));
  }

  async getFileContents(snapshot: PullRequestSnapshot, path: string): Promise<FileContents> {
    const file = this.find(snapshot.ref).files.find((candidate) => candidate.path === path);
    if (!file) throw new ApplicationError("not_found", `${path} is not part of ${refKey(snapshot.ref)}`);
    return { path, original: file.base ?? "", modified: file.head ?? "" };
  }

  async publishReview(snapshot: PullRequestSnapshot, plan: PublicationPlan): Promise<PublishedReview> {
    return { url: snapshot.url, decision: plan.decision, inlineComments: plan.comments.length, simulated: true };
  }

  private find(ref: PullRequestRef): DemoPullRequest {
    const found = this.pullRequests.find((pr) => refKey(pr.ref) === refKey(ref));
    if (!found) throw new ApplicationError("not_found", `There is no demo pull request ${refKey(ref)}`);
    return found;
  }

  private toSnapshot(pr: DemoPullRequest): PullRequestSnapshot {
    const updatedAt = new Date(this.startedAt - pr.updatedMinutesAgo * 60_000).toISOString();
    return {
      ref: pr.ref,
      title: pr.title,
      description: pr.description,
      author: { login: pr.author },
      url: `https://github.com/${pr.ref.owner}/${pr.ref.repo}/pull/${pr.ref.number}`,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      createdAt: updatedAt,
      updatedAt,
      draft: false,
      state: "open",
      files: pr.files.map(toRawFileChange),
    };
  }
}

function toRawFileChange(file: DemoFile): RawFileChange {
  const diff = unifiedDiff(file.base ?? "", file.head ?? "");
  const status = file.base === null ? "added" : file.head === null ? "removed" : "modified";
  return { path: file.path, status, additions: diff.additions, deletions: diff.deletions, patch: diff.patch };
}
