import type { FileChange, PullRequestRef } from "../../../src/domain/change/types.js";
import type { ConsensusLevel, Finding, Patch, Severity } from "../../../src/domain/deliberation/model.js";
import { decisionKey, type SessionState } from "../../../src/domain/deliberation/state.js";

/** Pure views over the session state, shared by several panels. */

export const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
export const LEVEL_ORDER: readonly ConsensusLevel[] = ["endorsed", "contested", "unreviewed", "rejected"];

export function sameRef(a: PullRequestRef | null, b: PullRequestRef | null): boolean {
  return a !== null && b !== null && a.provider === b.provider && a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

export function levelOf(state: SessionState, finding: Finding): ConsensusLevel | null {
  return state.consensus[finding.id]?.level ?? null;
}

export type HumanChoice = "accept" | "dismiss" | null;

export function choiceFor(state: SessionState, kind: "finding" | "patch", id: string): HumanChoice {
  return state.decisions[decisionKey({ kind, id })]?.action ?? null;
}

/** Mirrors the publication rule: accepted by a human, or endorsed and not dismissed. */
export function willPublish(state: SessionState, finding: Finding): boolean {
  const choice = choiceFor(state, "finding", finding.id);
  if (choice) return choice === "accept";
  return levelOf(state, finding) === "endorsed";
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
