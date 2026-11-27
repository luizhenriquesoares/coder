/**
 * Review Deliberation (core domain) — value objects and entities.
 * See docs/DOMAIN.md for the ubiquitous language.
 */

export const LANGUAGES = ["en", "pt"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Localized {
  readonly en: string;
  readonly pt: string;
}

export type ReviewerId = "architect" | "staff" | "refactoring" | "cleancode" | "implementer" | "moderator";

/** The four reviewers who speak in the opening and debate rounds. */
export const PANELISTS = ["architect", "staff", "refactoring", "cleancode"] as const satisfies readonly ReviewerId[];
export type PanelistId = (typeof PANELISTS)[number];

export const ROUNDS = ["opening", "debate", "implementation", "verdict"] as const;
export type Round = (typeof ROUNDS)[number];

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "architecture",
  "design",
  "correctness",
  "security",
  "concurrency",
  "performance",
  "error_handling",
  "testing",
  "readability",
  "naming",
  "maintainability",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STANCES = ["agree", "disagree", "refine"] as const;
export type Stance = (typeof STANCES)[number];

export type ConsensusLevel = "endorsed" | "contested" | "rejected" | "unreviewed";

export const ENGINES = ["claude", "scripted"] as const;
export type Engine = (typeof ENGINES)[number];

/** What started a review session. */
export const TRIGGERS = ["manual", "webhook", "poller"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Where a finding points. `path: null` means a general, change-wide finding. */
export interface CodeLocation {
  readonly path: string | null;
  readonly line: number | null;
  readonly quote: string;
  /** True when the line was confirmed by finding the quoted code in the file. */
  readonly anchored: boolean;
}

export interface Finding {
  readonly id: string;
  /** Stable key supplied by scripted reviewers; lets a script refer to its own findings. */
  readonly key?: string;
  readonly author: ReviewerId;
  readonly severity: Severity;
  readonly category: Category;
  readonly title: string;
  readonly rationale: string;
  readonly recommendation: string;
  /** Named refactoring or principle, e.g. "Extract Function", "Dependency Inversion". */
  readonly principle: string;
  readonly location: CodeLocation;
}

export interface Position {
  readonly reviewer: ReviewerId;
  readonly findingId: string;
  readonly stance: Stance;
  readonly argument: string;
}

export interface Consensus {
  readonly findingId: string;
  readonly level: ConsensusLevel;
  readonly support: readonly ReviewerId[];
  readonly opposition: readonly ReviewerId[];
  readonly refinements: readonly ReviewerId[];
}

export interface Patch {
  readonly id: string;
  readonly author: ReviewerId;
  readonly findingIds: readonly string[];
  readonly path: string;
  readonly original: string;
  readonly replacement: string;
  readonly explanation: string;
  /** False when `original` could not be located in the head version of the file, or occurs there ambiguously. */
  readonly applicable: boolean;
  /** 1-based line range of `original` in the head file, when applicable. */
  readonly startLine: number | null;
  readonly endLine: number | null;
  /**
   * The lines that replace `startLine..endLine`, exactly as they will be
   * written (re-indented when the snippet matched loosely, empty for a
   * deletion); null when the patch is not applicable.
   */
  readonly replacementLines: readonly string[] | null;
}

export interface DeclinedFinding {
  readonly findingId: string;
  readonly by: ReviewerId;
  readonly reason: string;
}

export const DECISIONS = ["approve", "request_changes", "comment"] as const;
export type Decision = (typeof DECISIONS)[number];
export const MERGE_RISKS = ["low", "medium", "high"] as const;
export type MergeRisk = (typeof MERGE_RISKS)[number];

export interface Verdict {
  readonly decision: Decision;
  /** What the moderator proposed before policy was applied. */
  readonly proposedDecision: Decision;
  readonly overriddenByPolicy: boolean;
  readonly mergeRisk: MergeRisk;
  readonly summary: string;
  readonly humanAttention: readonly string[];
}

export interface HumanDecision {
  readonly target: { readonly kind: "finding" | "patch"; readonly id: string };
  readonly action: "accept" | "dismiss";
  readonly note?: string;
  readonly by: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
