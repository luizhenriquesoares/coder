/**
 * Change Intelligence — published language.
 *
 * These types describe *what a pull request changes*, independent of the
 * source-control system it came from. Adapters (GitHub, demo fixtures) must
 * translate their own models into these shapes.
 */

export const PROVIDERS = ["github", "demo"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface PullRequestRef {
  readonly provider: Provider;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export function refKey(ref: PullRequestRef): string {
  return `${ref.provider}:${ref.owner}/${ref.repo}#${ref.number}`;
}

/** One commit of one pull request: what a review session reviews. */
export function revisionKey(ref: PullRequestRef, headSha: string): string {
  return `${refKey(ref)}@${headSha}`;
}

export function parseRefKey(key: string): PullRequestRef | null {
  const match = /^(github|demo):([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(key);
  if (!match) return null;
  const [, provider, owner, repo, number] = match;
  return { provider: provider as Provider, owner: owner!, repo: repo!, number: Number(number) };
}

export type PullRequestState = "open" | "closed" | "merged";

export type FileStatus = "added" | "modified" | "removed" | "renamed";

/** A file as reported by the source-control system, before diff parsing. */
export interface RawFileChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** Unified diff (hunks only). Absent for binary or very large files. */
  readonly patch?: string;
}

export interface Author {
  readonly login: string;
  readonly avatarUrl?: string;
}

/** Immutable picture of a pull request at one head commit. */
export interface PullRequestSnapshot {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly description: string;
  readonly author: Author;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  /** Merge base: the commit the diff is computed against. */
  readonly baseSha: string;
  readonly headSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly draft: boolean;
  readonly state: PullRequestState;
  readonly files: readonly RawFileChange[];
}

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface Hunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FileChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly language: string;
  /** True when the provider sent no textual patch (binary or too large). */
  readonly binary: boolean;
  readonly hunks: readonly Hunk[];
}

export interface ChangeStats {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Both sides of one file, used by the workspace diff view and by reviewers. */
export interface FileContents {
  readonly path: string;
  readonly original: string;
  readonly modified: string;
}
