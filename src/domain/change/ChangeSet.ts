import { parseUnifiedPatch } from "./diffParser.js";
import { isBinaryPath, languageFromPath } from "./language.js";
import type {
  ChangeStats,
  FileChange,
  PullRequestRef,
  PullRequestSnapshot,
  RawFileChange,
} from "./types.js";

/**
 * ChangeSet — aggregate root of Change Intelligence.
 *
 * An immutable snapshot of everything a pull request changes at one head
 * commit. A new push produces a new ChangeSet; this one never mutates.
 */
export class ChangeSet {
  private readonly byPath: ReadonlyMap<string, FileChange>;

  private constructor(
    readonly ref: PullRequestRef,
    readonly headSha: string,
    readonly files: readonly FileChange[],
  ) {
    this.byPath = new Map(files.map((file) => [file.path, file]));
  }

  static fromSnapshot(snapshot: PullRequestSnapshot): ChangeSet {
    const files = snapshot.files.map(toFileChange);
    assertUniquePaths(files);
    return new ChangeSet(snapshot.ref, snapshot.headSha, files);
  }

  get stats(): ChangeStats {
    return {
      files: this.files.length,
      additions: sum(this.files.map((f) => f.additions)),
      deletions: sum(this.files.map((f) => f.deletions)),
    };
  }

  file(path: string): FileChange | undefined {
    return this.byPath.get(path);
  }

  /** Finds a file by exact path, or by a unique suffix match ("CouponService.ts"). */
  resolvePath(path: string): string | null {
    if (this.byPath.has(path)) return path;
    const normalized = path.replace(/^\.?\//, "");
    if (this.byPath.has(normalized)) return normalized;
    const candidates = this.files.filter((f) => f.path.endsWith(`/${normalized}`));
    return candidates.length === 1 ? candidates[0]!.path : null;
  }

  /**
   * A line can carry an inline review comment only when it is visible in the
   * diff on the new side (an added or context line inside a hunk).
   */
  isCommentable(path: string, line: number): boolean {
    return this.hunkContaining(path, line) !== null;
  }

  /** True when every line in [start, end] sits inside the same hunk. */
  isCommentableRange(path: string, start: number, end: number): boolean {
    const hunk = this.hunkContaining(path, start);
    return hunk !== null && end <= hunk.newStart + hunk.newLines - 1;
  }

  private hunkContaining(path: string, line: number) {
    const file = this.byPath.get(path);
    if (!file || file.status === "removed") return null;
    return (
      file.hunks.find(
        (hunk) =>
          line >= hunk.newStart &&
          line < hunk.newStart + hunk.newLines &&
          hunk.lines.some((l) => l.newLine === line),
      ) ?? null
    );
  }
}

function toFileChange(raw: RawFileChange): FileChange {
  return {
    path: raw.path,
    ...(raw.previousPath ? { previousPath: raw.previousPath } : {}),
    status: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    language: languageFromPath(raw.path),
    // No patch despite changed lines means the diff was too large for the provider to render.
    binary: isBinaryPath(raw.path) || (raw.patch === undefined && raw.additions + raw.deletions > 0),
    hunks: parseUnifiedPatch(raw.patch),
  };
}

function assertUniquePaths(files: readonly FileChange[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Duplicate file in change set: ${file.path}`);
    seen.add(file.path);
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
