import type { Localized, MergeRisk, Decision, PanelistId, Severity, Category, Stance } from "../../domain/deliberation/model.js";
import type { PullRequestRef } from "../../domain/change/types.js";

export interface DemoFile {
  readonly path: string;
  /** Null when the file is added by the pull request. */
  readonly base: string | null;
  /** Null when the file is removed by the pull request. */
  readonly head: string | null;
}

export interface ScriptedFinding {
  readonly key: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly path: string | null;
  /** A line of the head file, copied verbatim, that anchors the finding. */
  readonly quote: string;
  readonly title: Localized;
  readonly rationale: Localized;
  readonly recommendation: Localized;
  readonly principle: Localized;
}

export interface ScriptedPosition {
  readonly on: string;
  readonly stance: Stance;
  readonly argument: Localized;
}

export interface ScriptedPatch {
  readonly fixes: readonly string[];
  readonly path: string;
  readonly original: string;
  readonly replacement: string;
  readonly explanation: Localized;
}

export interface CouncilScript {
  readonly opening: Readonly<Record<PanelistId, { readonly statement: Localized; readonly findings: readonly ScriptedFinding[] }>>;
  readonly debate: Readonly<Record<PanelistId, { readonly statement: Localized; readonly positions: readonly ScriptedPosition[] }>>;
  readonly implementation: {
    readonly statement: Localized;
    readonly patches: readonly ScriptedPatch[];
    readonly declined: readonly { readonly on: string; readonly reason: Localized }[];
  };
  readonly verdict: {
    readonly statement: Localized;
    readonly decision: Decision;
    readonly mergeRisk: MergeRisk;
    readonly summary: Localized;
    readonly humanAttention: readonly Localized[];
  };
}

export interface DemoPullRequest {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly description: string;
  readonly author: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Minutes before "now" the pull request was last updated (keeps the demo inbox fresh). */
  readonly updatedMinutesAgo: number;
  readonly files: readonly DemoFile[];
  readonly script: CouncilScript;
}

export const L = (en: string, pt: string): Localized => ({ en, pt });
