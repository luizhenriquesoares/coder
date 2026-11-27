import type { Octokit } from "@octokit/rest";
import type { PublishedReview, PullRequestSummary, SourceControl } from "../../application/ports.js";
import type {
  FileContents,
  FileStatus,
  PullRequestRef,
  PullRequestSnapshot,
  PullRequestState,
  RawFileChange,
} from "../../domain/change/types.js";
import { isBinaryPath } from "../../domain/change/language.js";
import type { Decision } from "../../domain/deliberation/model.js";
import type { PlannedComment, PublicationPlan } from "../../domain/deliberation/publicationPlanner.js";

export interface RepositoryName {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubSourceControlOptions {
  readonly octokit: Octokit;
  /** Repositories whose open pull requests appear in the inbox. */
  readonly repositories: readonly RepositoryName[];
  /** False when no token is configured: reading public repositories still works. */
  readonly authenticated: boolean;
}

/** Raised with a message that is safe and useful to show in the workspace. */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

const STATUS: Record<string, FileStatus> = {
  added: "added",
  copied: "added",
  removed: "removed",
  renamed: "renamed",
  modified: "modified",
  changed: "modified",
  unchanged: "modified",
};

/**
 * Anticorruption layer for GitHub: translates pull requests, files and
 * reviews between GitHub's REST API and the domain's published language.
 * Works with github.com and GitHub Enterprise Server (via the Octokit base URL).
 */
export class GitHubSourceControl implements SourceControl {
  readonly provider = "github" as const;

  constructor(private readonly options: GitHubSourceControlOptions) {}

  async listOpenPullRequests(): Promise<PullRequestSummary[]> {
    const perRepository = await Promise.all(
      this.options.repositories.map(({ owner, repo }) =>
        this.call(`list pull requests of ${owner}/${repo}`, async () => {
          const { data } = await this.options.octokit.rest.pulls.list({
            owner,
            repo,
            state: "open",
            sort: "updated",
            direction: "desc",
            per_page: 30,
          });
          return data.map((pr) => toSummary({ provider: "github", owner, repo, number: pr.number }, pr));
        }),
      ),
    );
    return perRepository.flat();
  }

  async getSnapshot(ref: PullRequestRef): Promise<PullRequestSnapshot> {
    const { octokit } = this.options;
    const { owner, repo } = ref;
    return this.call(`read ${owner}/${repo}#${ref.number}`, async () => {
      const [{ data: pr }, files] = await Promise.all([
        octokit.rest.pulls.get({ owner, repo, pull_number: ref.number }),
        octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: ref.number, per_page: 100 }),
      ]);
      return {
        ...toSummary(ref, pr),
        description: pr.body ?? "",
        baseSha: await this.mergeBase(ref, pr.base.sha, pr.head.sha),
        createdAt: pr.created_at,
        files: files.map(
          (file): RawFileChange => ({
            path: file.filename,
            ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
            status: STATUS[file.status] ?? "modified",
            additions: file.additions,
            deletions: file.deletions,
            ...(file.patch === undefined ? {} : { patch: file.patch }),
          }),
        ),
      };
    });
  }

  async getFileContents(snapshot: PullRequestSnapshot, path: string): Promise<FileContents> {
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file) throw new GitHubError(`${path} is not part of this pull request`);
    const tooLargeToDiff = file.patch === undefined && file.additions + file.deletions > 0;
    if (isBinaryPath(path) || tooLargeToDiff) return { path, original: "", modified: "" };

    const [original, modified] = await Promise.all([
      file.status === "added" ? "" : this.contentAt(snapshot.ref, file.previousPath ?? path, snapshot.baseSha),
      file.status === "removed" ? "" : this.contentAt(snapshot.ref, path, snapshot.headSha),
    ]);
    return { path, original, modified };
  }

  async publishReview(snapshot: PullRequestSnapshot, plan: PublicationPlan): Promise<PublishedReview> {
    if (!this.options.authenticated) {
      throw new GitHubError("Publishing needs a GitHub token with pull request write access. Set GITHUB_TOKEN.");
    }
    const attempts = publicationAttempts(plan);
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const { data } = await this.options.octokit.rest.pulls.createReview({
          owner: snapshot.ref.owner,
          repo: snapshot.ref.repo,
          pull_number: snapshot.ref.number,
          commit_id: snapshot.headSha,
          event: REVIEW_EVENT[attempt.decision],
          body: attempt.body,
          comments: attempt.comments.map(toReviewComment),
        });
        return { url: data.html_url, decision: attempt.decision, inlineComments: attempt.comments.length, simulated: false };
      } catch (error) {
        // 422: GitHub refused this shape (own pull request, or a line outside the diff). Try the next, safer shape.
        if (statusOf(error) !== 422) throw toGitHubError("publish the review", error);
        lastError = error;
      }
    }
    throw toGitHubError("publish the review", lastError);
  }

  /** The diff of a pull request is computed against the merge base, not the tip of the base branch. */
  private async mergeBase(ref: PullRequestRef, baseSha: string, headSha: string): Promise<string> {
    try {
      const { data } = await this.options.octokit.rest.repos.compareCommitsWithBasehead({
        owner: ref.owner,
        repo: ref.repo,
        basehead: `${baseSha}...${headSha}`,
        per_page: 1,
      });
      return data.merge_base_commit.sha;
    } catch {
      return baseSha;
    }
  }

  private async contentAt(ref: PullRequestRef, path: string, sha: string): Promise<string> {
    try {
      const { data } = await this.options.octokit.rest.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ref: sha,
        mediaType: { format: "raw" },
      });
      // With the raw media type the API answers with the file body itself.
      const body: unknown = data;
      const text = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : "";
      return text.includes("\u0000") ? "" : text; // binary content has nothing to show a reviewer
    } catch (error) {
      if (statusOf(error) === 404) return ""; // e.g. a submodule pointer
      throw toGitHubError(`read ${path}`, error);
    }
  }

  private async call<T>(action: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw toGitHubError(action, error);
    }
  }
}

interface PullRequestFields {
  readonly title: string;
  readonly html_url: string;
  readonly draft?: boolean;
  readonly state: string;
  readonly merged_at?: string | null;
  readonly updated_at: string;
  readonly user: { readonly login: string; readonly avatar_url?: string } | null;
  readonly base: { readonly ref: string };
  readonly head: { readonly ref: string; readonly sha: string };
}

function toSummary(ref: PullRequestRef, pr: PullRequestFields): PullRequestSummary {
  const state: PullRequestState = pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed";
  return {
    ref,
    title: pr.title,
    author: { login: pr.user?.login ?? "ghost", ...(pr.user?.avatar_url ? { avatarUrl: pr.user.avatar_url } : {}) },
    url: pr.html_url,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    state,
  };
}

/** GitHub's words for the council's decisions. */
type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
const REVIEW_EVENT: Record<Decision, ReviewEvent> = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" };

interface Attempt {
  readonly decision: Decision;
  readonly body: string;
  readonly comments: readonly PlannedComment[];
}

/**
 * GitHub rejects some reviews outright: approving or requesting changes on
 * your own pull request, or a comment on a line it does not consider part of
 * the diff. Each attempt gives up a little structure but keeps all the content.
 */
export function publicationAttempts(plan: PublicationPlan): Attempt[] {
  // The body's headline already states the decision, in the session's language.
  const planned: Attempt = { decision: plan.decision, body: plan.body, comments: plan.comments };
  const asComment: Attempt = { ...planned, decision: "comment" };
  const flattened = (attempt: Attempt): Attempt => ({
    ...attempt,
    comments: [],
    body: [attempt.body, ...attempt.comments.map((c) => `---\n\`${c.path}:${c.startLine ? `${c.startLine}-` : ""}${c.line}\`\n\n${c.body}`)].join("\n\n"),
  });
  const attempts: Attempt[] = [planned];
  if (plan.decision !== "comment") attempts.push(asComment);
  if (plan.comments.length > 0) attempts.push(flattened(asComment));
  return attempts;
}

function toReviewComment(comment: PlannedComment) {
  return {
    path: comment.path,
    line: comment.line,
    side: "RIGHT",
    ...(comment.startLine ? { start_line: comment.startLine, start_side: "RIGHT" } : {}),
    body: comment.body,
  };
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : undefined;
}

function toGitHubError(action: string, error: unknown): GitHubError {
  if (error instanceof GitHubError) return error;
  const status = statusOf(error);
  const detail = error instanceof Error ? error.message : String(error);
  if (status === 401) return new GitHubError("GitHub rejected the token. Check GITHUB_TOKEN.");
  if (status === 403 && /rate limit/i.test(detail)) return new GitHubError("GitHub rate limit reached. Configure GITHUB_TOKEN or wait a few minutes.");
  if (status === 403) return new GitHubError(`GitHub denied access while trying to ${action}. The token may lack permission for this repository.`);
  if (status === 404) return new GitHubError(`GitHub could not ${action}: not found, or the token cannot see it.`);
  return new GitHubError(`GitHub could not ${action}: ${detail}`);
}
