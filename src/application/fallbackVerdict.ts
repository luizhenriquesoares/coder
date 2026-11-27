import type { SessionState } from "../domain/deliberation/state.js";
import type { VerdictDraft } from "../domain/deliberation/verdictPolicy.js";

/**
 * When the moderator cannot answer, the session still ends with a verdict:
 * one derived deterministically from what the council agreed on.
 */
export function fallbackVerdict(state: SessionState): VerdictDraft {
  const endorsed = state.findings.filter((f) => state.consensus[f.id]?.level === "endorsed");
  const contested = state.findings.filter((f) => state.consensus[f.id]?.level === "contested");
  const blockers = endorsed.filter((f) => f.severity === "blocker").length;
  const majors = endorsed.filter((f) => f.severity === "major").length;

  const decision = blockers + majors > 0 ? "request_changes" : endorsed.length + contested.length > 0 ? "comment" : "approve";
  const mergeRisk = blockers > 0 ? "high" : majors > 0 ? "medium" : "low";
  const pt = state.language === "pt";

  return {
    decision,
    mergeRisk,
    summary: pt
      ? `O moderador não respondeu; este veredito foi derivado do consenso do conselho: ${endorsed.length} achados endossados (${blockers} bloqueantes, ${majors} graves) e ${contested.length} em disputa.`
      : `The moderator did not answer; this verdict was derived from the council's consensus: ${endorsed.length} endorsed findings (${blockers} blockers, ${majors} major) and ${contested.length} contested.`,
    humanAttention: contested.map((f) =>
      pt ? `Em disputa: ${f.title} (${f.id})` : `Contested: ${f.title} (${f.id})`,
    ),
  };
}
