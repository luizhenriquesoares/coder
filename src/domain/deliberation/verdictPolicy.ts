import type { Consensus, Decision, Finding, MergeRisk, Verdict } from "./model.js";
import { levelOf, type SessionState } from "./state.js";

export interface VerdictDraft {
  readonly decision: Decision;
  readonly mergeRisk: MergeRisk;
  readonly summary: string;
  readonly humanAttention: readonly string[];
}

const RISK_RANK: Record<MergeRisk, number> = { low: 0, medium: 1, high: 2 };

const higherRisk = (a: MergeRisk, b: MergeRisk): MergeRisk => (RISK_RANK[a] >= RISK_RANK[b] ? a : b);
const hasSeverity = (findings: readonly Finding[], ...severities: Finding["severity"][]) =>
  findings.some((f) => severities.includes(f.severity));

/**
 * The lowest merge risk the findings that stand allow: the endorsed ones when
 * the verdict is issued, the published ones when the review is published.
 */
export function riskFloor(standing: readonly Finding[]): MergeRisk {
  if (hasSeverity(standing, "blocker")) return "high";
  if (hasSeverity(standing, "major")) return "medium";
  return "low";
}

/**
 * The decision the findings that stand allow: no approval while a blocker
 * stands, and no request for changes without a blocker or a major to ground it.
 */
export function boundDecision(proposed: Decision, standing: readonly Finding[]): Decision {
  if (proposed === "approve" && hasSeverity(standing, "blocker")) return "request_changes";
  if (proposed === "request_changes" && !hasSeverity(standing, "blocker", "major")) return "comment";
  return proposed;
}

/**
 * VerdictPolicy — the moderator's opinion is constrained by consensus: the
 * decision is bounded by the endorsed findings, and the merge risk can never
 * be lower than what they imply.
 */
export function applyVerdictPolicy(
  draft: VerdictDraft,
  findings: readonly Finding[],
  consensus: Readonly<Record<string, Consensus>>,
): Verdict {
  const endorsed = findings.filter((f) => levelOf({ consensus }, f) === "endorsed");
  const decision = boundDecision(draft.decision, endorsed);
  const mergeRisk = higherRisk(draft.mergeRisk, riskFloor(endorsed));
  return {
    decision,
    proposedDecision: draft.decision,
    overriddenByPolicy: decision !== draft.decision || mergeRisk !== draft.mergeRisk,
    mergeRisk,
    summary: draft.summary,
    humanAttention: draft.humanAttention,
  };
}

/**
 * When the moderator cannot answer, the session still ends with a verdict:
 * one derived deterministically from the findings and what the council made
 * of them. A serious finding nobody reviewed is never waved through.
 */
export function fallbackVerdict(state: Pick<SessionState, "findings" | "consensus" | "language">): VerdictDraft {
  const withLevel = (level: string) => state.findings.filter((f) => levelOf(state, f) === level);
  const endorsed = withLevel("endorsed");
  const contested = withLevel("contested");
  const unreviewed = withLevel("unreviewed");
  const unsettledSerious = [...contested, ...unreviewed].filter((f) => f.severity === "blocker" || f.severity === "major");
  const blockers = endorsed.filter((f) => f.severity === "blocker").length;
  const majors = endorsed.filter((f) => f.severity === "major").length;

  const decision: Decision =
    blockers + majors > 0 ? "request_changes" : endorsed.length + contested.length + unreviewed.length > 0 ? "comment" : "approve";
  const mergeRisk = higherRisk(riskFloor(endorsed), unsettledSerious.length > 0 ? "medium" : "low");
  const pt = state.language === "pt";

  return {
    decision,
    mergeRisk,
    summary: pt
      ? `O moderador não respondeu; este veredito foi derivado do consenso do conselho: ${endorsed.length} achados endossados (${blockers} bloqueantes, ${majors} graves), ${contested.length} em disputa e ${unreviewed.length} sem revisão.`
      : `The moderator did not answer; this verdict was derived from the council's consensus: ${endorsed.length} endorsed findings (${blockers} blockers, ${majors} major), ${contested.length} contested and ${unreviewed.length} unreviewed.`,
    humanAttention: [
      ...contested.map((f) => (pt ? `Em disputa: ${f.title} (${f.id})` : `Contested: ${f.title} (${f.id})`)),
      ...unreviewed
        .filter((f) => unsettledSerious.includes(f))
        .map((f) => (pt ? `Sem revisão: ${f.title} (${f.id})` : `Unreviewed: ${f.title} (${f.id})`)),
    ],
  };
}
