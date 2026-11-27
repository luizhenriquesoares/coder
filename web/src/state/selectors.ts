import type { FileChange, PullRequestRef } from "../../../src/domain/change/types.js";
import type { ConsensusLevel, Finding, Patch, Severity } from "../../../src/domain/deliberation/model.js";
import { decisionKey, levelOf, type SessionState } from "../../../src/domain/deliberation/state.js";

/** Pure views over the session state, shared by several panels. The rules themselves live in the domain. */

export const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
export const LEVEL_ORDER: readonly ConsensusLevel[] = ["endorsed", "contested", "unreviewed", "rejected"];

/** One line per source and message: several watched pull requests failing the same way read as one problem. */
export function inboxErrorLines<E extends { readonly provider: string; readonly message: string }>(errors: readonly E[]): E[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.provider}\n${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sameRef(a: PullRequestRef | null, b: PullRequestRef | null): boolean {
  return a !== null && b !== null && a.provider === b.provider && a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

/** The session reviewed another commit than the one on screen: none of it may be drawn over this code. */
export function reviewedAnotherCommit(session: SessionState | null, headSha: string | null): boolean {
  return session !== null && headSha !== null && session.pullRequest.headSha !== headSha;
}

export type HumanChoice = "accept" | "dismiss" | null;

export function choiceFor(state: SessionState, kind: "finding" | "patch", id: string): HumanChoice {
  return state.decisions[decisionKey({ kind, id })]?.action ?? null;
}

/** Set aside: dismissed by the human, or rejected by the council with no human decision. Drawn dimmed. */
export function isSetAside(state: SessionState, finding: Pick<Finding, "id">): boolean {
  const choice = choiceFor(state, "finding", finding.id);
  return choice === "dismiss" || (choice === null && levelOf(state, finding) === "rejected");
}

/** The next item after `currentId` in `direction`, wrapping around at both ends; from no current item, the first or the last. */
export function stepThrough<T extends { readonly id: string }>(items: readonly T[], currentId: string | null, direction: 1 | -1): T | null {
  if (items.length === 0) return null;
  const index = items.findIndex((item) => item.id === currentId);
  if (index < 0) return items[direction === 1 ? 0 : items.length - 1] ?? null;
  return items[(index + direction + items.length) % items.length] ?? null;
}

/** Selecting what is already selected lets go of it. */
export function toggleSelection(currentId: string | null, id: string): string | null {
  return id === currentId ? null : id;
}

/** Where a finding is, as a person reads it: `file.ts:12`, `file.ts`, or the given words for the whole change. */
export function locationLabel(finding: Pick<Finding, "location">, wholeChange: string): string {
  const { path, line } = finding.location;
  if (!path) return wholeChange;
  return line ? `${fileName(path)}:${line}` : fileName(path);
}

/** Findings in the order a person should read them: what the council stands behind first, worst first. */
export function findingsInReadingOrder(state: SessionState): Finding[] {
  const levelRank = (finding: Finding) => {
    const level = levelOf(state, finding);
    return level === null ? LEVEL_ORDER.length : LEVEL_ORDER.indexOf(level);
  };
  return [...state.findings].sort(
    (a, b) =>
      levelRank(a) - levelRank(b) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

export function findingsOfFile(state: SessionState | null, path: string): Finding[] {
  return state ? state.findings.filter((finding) => finding.location.path === path) : [];
}

export function worstSeverity(findings: readonly Finding[]): Severity | null {
  return findings.reduce<Severity | null>(
    (worst, finding) => (worst === null || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[worst] ? finding.severity : worst),
    null,
  );
}

export function patchesFixing(state: SessionState, findingId: string): Patch[] {
  return state.patches.filter((patch) => patch.findingIds.includes(findingId));
}

/**
 * The lines a patch card shows. Added lines are the patch's `replacementLines`, exactly what will be
 * published (re-indented, empty for a deletion); the proposed text only when the patch could not be placed.
 */
export function patchDiffLines(patch: Pick<Patch, "original" | "replacement" | "replacementLines">): { removed: string[]; added: string[] } {
  const lines = (text: string) => text.replace(/^\n+|\n+$/g, "").split("\n");
  return {
    removed: lines(patch.original),
    added: patch.replacementLines ? [...patch.replacementLines] : patch.replacement.trim() === "" ? [] : lines(patch.replacement),
  };
}

/** Patches the editor can preview on a file: located in it and not dismissed by the human. */
export function previewablePatches(state: SessionState | null, path: string): Patch[] {
  if (!state) return [];
  return state.patches.filter((patch) => patch.path === path && patch.applicable && choiceFor(state, "patch", patch.id) !== "dismiss");
}

export function consensusCounts(state: SessionState): Record<ConsensusLevel, number> {
  const counts: Record<ConsensusLevel, number> = { endorsed: 0, contested: 0, rejected: 0, unreviewed: 0 };
  for (const finding of state.findings) {
    const level = levelOf(state, finding);
    if (level) counts[level] += 1;
  }
  return counts;
}

export function severityCounts(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** True when the line is visible in the pull request's diff, i.e. not inside a collapsed unchanged region. */
export function isInsideHunk(file: FileChange, line: number): boolean {
  return file.hunks.some((hunk) => line >= hunk.newStart && line < hunk.newStart + hunk.newLines);
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function directory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index + 1);
}
