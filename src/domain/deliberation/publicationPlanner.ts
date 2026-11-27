import type { ChangeSet } from "../change/ChangeSet.js";
import type { Consensus, Finding, Language, Patch, Severity } from "./model.js";
import { PERSONAS } from "./personas.js";
import { decisionKey, levelOf, type SessionState } from "./state.js";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  /** Present for multi-line comments (GitHub suggestions spanning a range). */
  readonly startLine?: number;
  readonly body: string;
}

export interface PublicationPlan {
  readonly event: ReviewEvent;
  readonly body: string;
  readonly comments: readonly InlineComment[];
  readonly summaryFindings: number;
}

const EVENT_BY_DECISION = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
const SEVERITY_ICON: Record<Severity, string> = { blocker: "🛑", major: "🔶", minor: "🔹", nit: "▫️" };

/**
 * Decides what the council publishes back to the pull request.
 *
 * A finding is published when a human accepted it, or when the council
 * endorsed it and no human dismissed it. Each published finding becomes an
 * inline comment when its line is visible in the diff, otherwise it goes into
 * the summary. Each usable patch becomes a GitHub suggestion: merged into the
 * comment of a finding it fixes when that finding sits inside the patched
 * lines, or as a comment of its own.
 */
export function planPublication(state: SessionState, changeSet: ChangeSet): PublicationPlan {
  if (!state.verdict) throw new Error("Nothing to publish before the verdict");
  const published = state.findings.filter((finding) => isPublished(finding, state));
  const publishedIds = new Set(published.map((finding) => finding.id));
  const patches = state.patches.filter(
    (patch) => patch.applicable && !isDismissed(state, patch.id) && patch.findingIds.some((id) => publishedIds.has(id)),
  );
  const inline = patches.filter((patch) => fitsAsSuggestion(patch, changeSet));
  const offline = patches.filter((patch) => !inline.includes(patch));

  const merged = new Map<string, Patch>(); // finding id → patch shown in the same comment
  for (const patch of inline) {
    const host = published.find((f) => !merged.has(f.id) && patch.findingIds.includes(f.id) && isInside(f, patch));
    if (host) merged.set(host.id, patch);
  }
  const mergedPatches = new Set(merged.values());

  const comments: InlineComment[] = [];
  const inSummary: Finding[] = [];
  for (const finding of published) {
    const body = findingBody(finding, state.consensus[finding.id], state.language);
    const patch = merged.get(finding.id);
    const { path, line } = finding.location;
    if (patch) comments.push(suggestionComment(patch, `${body}\n\n${patchNote(patch, state.language)}`));
    else if (path && line && changeSet.isCommentable(path, line)) comments.push({ path, line, body });
    else inSummary.push(finding);
  }
  for (const patch of inline) {
    if (!mergedPatches.has(patch)) comments.push(suggestionComment(patch, patchBody(patch, state)));
  }

  return {
    event: EVENT_BY_DECISION[state.verdict.decision],
    body: summaryBody(state, inSummary, offline, published.length),
    comments,
    summaryFindings: inSummary.length,
  };
}

function isPublished(finding: Finding, state: SessionState): boolean {
  const decision = state.decisions[decisionKey({ kind: "finding", id: finding.id })];
  if (decision) return decision.action === "accept";
  return levelOf(state, finding) === "endorsed";
}

function isDismissed(state: SessionState, patchId: string): boolean {
  return state.decisions[decisionKey({ kind: "patch", id: patchId })]?.action === "dismiss";
}

function fitsAsSuggestion(patch: Patch, changeSet: ChangeSet): boolean {
  return patch.startLine !== null && patch.endLine !== null && changeSet.isCommentableRange(patch.path, patch.startLine, patch.endLine);
}

function isInside(finding: Finding, patch: Patch): boolean {
  const { path, line } = finding.location;
  return path === patch.path && line !== null && line >= patch.startLine! && line <= patch.endLine!;
}

function suggestionComment(patch: Patch, body: string): InlineComment {
  const multiLine = patch.endLine! > patch.startLine!;
  return {
    path: patch.path,
    line: patch.endLine!,
    ...(multiLine ? { startLine: patch.startLine! } : {}),
    body: `${body}\n\n\`\`\`suggestion\n${patch.replacement.replace(/\n+$/, "")}\n\`\`\``,
  };
}

function findingBody(finding: Finding, consensus: Consensus | undefined, language: Language): string {
  const t = LABELS[language];
  const author = PERSONAS[finding.author].name[language];
  const lines = [
    `${SEVERITY_ICON[finding.severity]} **${finding.id} · ${finding.title}** · _${t.severity[finding.severity]}_ · ${author}`,
    "",
    finding.rationale,
  ];
  if (finding.recommendation) lines.push("", `**${t.recommendation}:** ${finding.recommendation}`);
  if (finding.principle) lines.push("", `_${t.principle}: ${finding.principle}_`);
  if (consensus) {
    lines.push("", `${t.consensus}: **${t.levels[consensus.level]}** (${consensus.support.length} ${t.for}, ${consensus.opposition.length} ${t.against})`);
  }
  return lines.join("\n");
}

function patchNote(patch: Patch, language: Language): string {
  const author = PERSONAS[patch.author].name[language];
  return `🔧 **${LABELS[language].patch} ${patch.id}** · ${author}${patch.explanation ? `\n\n${patch.explanation}` : ""}`;
}

function patchBody(patch: Patch, state: SessionState): string {
  const t = LABELS[state.language];
  const fixes = patch.findingIds
    .map((id) => state.findings.find((f) => f.id === id))
    .filter((f): f is Finding => f !== undefined)
    .map((f) => `${f.id} (${f.title})`)
    .join(", ");
  return `${patchNote(patch, state.language)}\n\n_${t.fixes}: ${fixes}_`;
}

function summaryBody(state: SessionState, inSummary: readonly Finding[], offline: readonly Patch[], publishedCount: number): string {
  const t = LABELS[state.language];
  const verdict = state.verdict!;
  const lines = [
    `## 🧠 CodeR Council — ${t.decisions[verdict.decision]} · ${t.mergeRisk} ${t.risk[verdict.mergeRisk]}`,
    "",
    verdict.summary,
  ];
  if (verdict.overriddenByPolicy && verdict.decision !== verdict.proposedDecision) lines.push("", `> ${t.policyOverride}`);
  if (verdict.humanAttention.length > 0) {
    lines.push("", `### ${t.humanAttention}`, ...verdict.humanAttention.map((item) => `- ${item}`));
  }
  if (inSummary.length > 0) {
    lines.push("", `### ${t.generalFindings}`, "", `| | ${t.finding} | ${t.where} |`, "|---|---|---|");
    for (const f of inSummary) {
      const where = f.location.path ? `\`${f.location.path}${f.location.line ? `:${f.location.line}` : ""}\`` : "—";
      lines.push(`| ${SEVERITY_ICON[f.severity]} | **${f.id} · ${escapeCell(f.title)}** — ${escapeCell(f.recommendation || f.rationale)} | ${where} |`);
    }
  }
  for (const patch of offline) {
    lines.push("", `#### ${patchNote(patch, state.language).split("\n")[0]} · \`${patch.path}:${patch.startLine}\``, "", patch.explanation, "", "```", patch.replacement, "```");
  }
  const members = state.council.map((id) => PERSONAS[id].name[state.language]).join(" · ");
  lines.push("", `<sub>${t.stats(state.findings.length, publishedCount, state.patches.length)} · ${members}</sub>`);
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

interface Labels {
  readonly severity: Record<Severity, string>;
  readonly levels: Record<Consensus["level"], string>;
  readonly decisions: Record<"approve" | "request_changes" | "comment", string>;
  readonly risk: Record<"low" | "medium" | "high", string>;
  readonly recommendation: string;
  readonly principle: string;
  readonly consensus: string;
  readonly for: string;
  readonly against: string;
  readonly patch: string;
  readonly fixes: string;
  readonly mergeRisk: string;
  readonly humanAttention: string;
  readonly generalFindings: string;
  readonly finding: string;
  readonly where: string;
  readonly policyOverride: string;
  readonly stats: (raised: number, published: number, patches: number) => string;
}

const LABELS: Record<Language, Labels> = {
  en: {
    severity: { blocker: "blocker", major: "major", minor: "minor", nit: "nit" },
    levels: { endorsed: "endorsed", contested: "contested", rejected: "rejected", unreviewed: "unreviewed" },
    decisions: { approve: "Approve", request_changes: "Request changes", comment: "Comment" },
    risk: { low: "low", medium: "medium", high: "high" },
    recommendation: "Recommendation",
    principle: "Principle",
    consensus: "Council consensus",
    for: "for",
    against: "against",
    patch: "Patch",
    fixes: "Fixes",
    mergeRisk: "merge risk",
    humanAttention: "Where a human should look",
    generalFindings: "Other findings",
    finding: "Finding",
    where: "Where",
    policyOverride: "The moderator proposed approval, but policy blocks approval while the council endorses a blocker.",
    stats: (raised, published, patches) => `${raised} findings raised · ${published} published · ${patches} patches proposed`,
  },
  pt: {
    severity: { blocker: "bloqueante", major: "grave", minor: "menor", nit: "detalhe" },
    levels: { endorsed: "endossado", contested: "em disputa", rejected: "rejeitado", unreviewed: "sem revisão" },
    decisions: { approve: "Aprovar", request_changes: "Pedir mudanças", comment: "Comentar" },
    risk: { low: "baixo", medium: "médio", high: "alto" },
    recommendation: "Recomendação",
    principle: "Princípio",
    consensus: "Consenso do conselho",
    for: "a favor",
    against: "contra",
    patch: "Patch",
    fixes: "Corrige",
    mergeRisk: "risco de merge",
    humanAttention: "Onde um humano deve olhar",
    generalFindings: "Outros achados",
    finding: "Achado",
    where: "Onde",
    policyOverride: "O moderador propôs aprovar, mas a política bloqueia a aprovação enquanto o conselho endossa um bloqueante.",
    stats: (raised, published, patches) => `${raised} achados levantados · ${published} publicados · ${patches} patches propostos`,
  },
};
