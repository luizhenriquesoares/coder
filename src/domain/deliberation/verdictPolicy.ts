import type { Consensus, Decision, Finding, MergeRisk, Verdict } from "./model.js";

export interface VerdictDraft {
  readonly decision: Decision;
  readonly mergeRisk: MergeRisk;
  readonly summary: string;
  readonly humanAttention: readonly string[];
}

const RISK_RANK: Record<MergeRisk, number> = { low: 0, medium: 1, high: 2 };

/**
 * VerdictPolicy — the moderator's opinion is constrained by consensus.
 * The council cannot approve while an endorsed blocker exists, and the merge
 * risk can never be lower than what the endorsed findings imply.
 */
export function applyVerdictPolicy(
  draft: VerdictDraft,
  findings: readonly Finding[],
  consensus: Readonly<Record<string, Consensus>>,
): Verdict {
  const endorsed = findings.filter((f) => consensus[f.id]?.level === "endorsed");
  const endorsedBlockers = endorsed.filter((f) => f.severity === "blocker");
  const endorsedMajors = endorsed.filter((f) => f.severity === "major");

  const mustRequestChanges = endorsedBlockers.length > 0 && draft.decision === "approve";
  const decision: Decision = mustRequestChanges ? "request_changes" : draft.decision;

  const floor: MergeRisk = endorsedBlockers.length > 0 ? "high" : endorsedMajors.length > 0 ? "medium" : "low";
  const mergeRisk = RISK_RANK[draft.mergeRisk] >= RISK_RANK[floor] ? draft.mergeRisk : floor;

  return {
    decision,
    proposedDecision: draft.decision,
    overriddenByPolicy: mustRequestChanges || mergeRisk !== draft.mergeRisk,
    mergeRisk,
    summary: draft.summary,
    humanAttention: draft.humanAttention,
  };
}
