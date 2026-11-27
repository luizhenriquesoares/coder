import type { ChangeSet } from "../change/ChangeSet.js";
import { DomainError, type Consensus, type Decision, type Finding, type Language, type Patch, type Severity } from "./model.js";
import { PERSONAS } from "./personas.js";
import { decisionKey, isPublished, type SessionState } from "./state.js";

export interface PlannedComment {
  readonly path: string;
  readonly line: number;
  /** Present for multi-line comments (suggestions spanning a range). */
  readonly startLine?: number;
  readonly body: string;
  /** The finding this comment publishes. */
  readonly findingId?: string;
  /** Set when the comment carries a suggestion. */
  readonly patchId?: string;
}

export interface PublicationPlan {
  /** What the review is published as, after the human's decisions. */
  readonly decision: Decision;
  /** The council's verdict, before the human's decisions. */
  readonly councilDecision: Decision;
  readonly body: string;
  readonly comments: readonly PlannedComment[];
  readonly summaryFindings: number;
}

/** A published finding, and where it goes. `patch` is the suggestion shown in its own comment. */
export interface SelectedFinding {
  readonly finding: Finding;
  readonly placement: "inline" | "summary";
  readonly patch: Patch | null;
}

/** What will be published, as data: the decision about the review before any of it is rendered. */
export interface PublicationSelection {
  readonly findings: readonly SelectedFinding[];
  /** Suggestions that fit in the diff but sit on no published finding's line: a comment of their own. */
  readonly suggestions: readonly Patch[];
  /** Patches that cannot be suggested on the diff: shown in the summary. */
  readonly summaryPatches: readonly Patch[];
}

const SEVERITY_ICON: Record<Severity, string> = { blocker: "🛑", major: "🔶", minor: "🔹", nit: "▫️" };

/**
 * Decides what the council publishes back to the pull request.
 *
 * A finding is published when `isPublished` says so. Each published finding
 * becomes an inline comment when its line was confirmed against the file and
 * is visible in the diff, otherwise it goes into the summary. Each usable
 * patch becomes a suggestion: merged into the comment of a finding it fixes
 * when that finding sits inside the patched lines, or as a comment of its own.
 */
export function selectPublication(state: SessionState, changeSet: ChangeSet): PublicationSelection {
  const published = state.findings.filter((finding) => isPublished(state, finding));
  const publishedIds = new Set(published.map((finding) => finding.id));
  const patches = state.patches.filter(
    (patch) => patch.applicable && !isDismissed(state, patch.id) && patch.findingIds.some((id) => publishedIds.has(id)),
  );
  const suggestible = patches.filter((patch) => fitsAsSuggestion(patch, changeSet));

  const merged = new Map<string, Patch>(); // finding id → patch shown in the same comment
  for (const patch of suggestible) {
    const host = published.find((f) => !merged.has(f.id) && patch.findingIds.includes(f.id) && isInside(f, patch));
    if (host) merged.set(host.id, patch);
  }
  const mergedPatches = new Set(merged.values());

  const findings = published.map((finding): SelectedFinding => {
    const patch = merged.get(finding.id) ?? null;
    const { path, line, anchored } = finding.location;
    const inline = patch !== null || (anchored && path !== null && line !== null && changeSet.isCommentable(path, line));
    return { finding, placement: inline ? "inline" : "summary", patch };
  });
  return {
    findings,
    suggestions: suggestible.filter((patch) => !mergedPatches.has(patch)),
    summaryPatches: patches.filter((patch) => !suggestible.includes(patch)),
  };
}

/** Renders the selection: what the workspace previews is exactly what the source control receives. */
export function planPublication(state: SessionState, changeSet: ChangeSet): PublicationPlan {
  if (!state.verdict) throw new DomainError("Nothing to publish before the verdict");
  const selection = selectPublication(state, changeSet);

  const comments: PlannedComment[] = [];
  for (const { finding, placement, patch } of selection.findings) {
    if (placement === "summary") continue;
    const body = findingBody(finding, state.consensus[finding.id], state.language);
    if (patch) comments.push(suggestionComment(patch, `${body}\n\n${patchNote(patch, state.language)}`, finding.id));
    else comments.push({ path: finding.location.path!, line: finding.location.line!, body, findingId: finding.id });
  }
  for (const patch of selection.suggestions) comments.push(suggestionComment(patch, patchBody(patch, state)));

  const inSummary = selection.findings.filter((selected) => selected.placement === "summary").map((selected) => selected.finding);
  return {
    decision: state.verdict.decision,
    councilDecision: state.verdict.decision,
    body: summaryBody(state, inSummary, selection.summaryPatches, selection.findings.length),
    comments,
    summaryFindings: inSummary.length,
  };
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

function suggestionComment(patch: Patch, body: string, findingId?: string): PlannedComment {
  const multiLine = patch.endLine! > patch.startLine!;
  return {
    path: patch.path,
    line: patch.endLine!,
    ...(multiLine ? { startLine: patch.startLine! } : {}),
    // The suggestion is the patch exactly as previewed; no lines at all is a deletion.
    body: `${body}\n\n${fenced("suggestion", patch.replacementLines ?? [])}`,
    ...(findingId ? { findingId } : {}),
    patchId: patch.id,
  };
}

function findingBody(finding: Finding, consensus: Consensus | undefined, language: Language): string {
  const t = LABELS[language];
  const author = PERSONAS[finding.author].name[language];
  const lines = [
    `${SEVERITY_ICON[finding.severity]} **${finding.id} · ${prose(finding.title)}** · _${t.severity[finding.severity]}_ · ${author}`,
    "",
    prose(finding.rationale),
  ];
  if (finding.recommendation) lines.push("", `**${t.recommendation}:** ${prose(finding.recommendation)}`);
  if (finding.principle) lines.push("", `_${t.principle}: ${prose(finding.principle)}_`);
  if (consensus) {
    lines.push("", `${t.consensus}: **${t.levels[consensus.level]}** (${consensus.support.length} ${t.for}, ${consensus.opposition.length} ${t.against})`);
  }
  return lines.join("\n");
}

function patchNote(patch: Patch, language: Language): string {
  const author = PERSONAS[patch.author].name[language];
  return `🔧 **${LABELS[language].patch} ${patch.id}** · ${author}${patch.explanation ? `\n\n${prose(patch.explanation)}` : ""}`;
}

function patchBody(patch: Patch, state: SessionState): string {
  const t = LABELS[state.language];
  const fixes = patch.findingIds
    .map((id) => state.findings.find((f) => f.id === id))
    .filter((f): f is Finding => f !== undefined)
    .map((f) => `${f.id} (${prose(f.title)})`)
    .join(", ");
  return `${patchNote(patch, state.language)}\n\n_${t.fixes}: ${fixes}_`;
}

function summaryBody(state: SessionState, inSummary: readonly Finding[], offline: readonly Patch[], publishedCount: number): string {
  const t = LABELS[state.language];
  const verdict = state.verdict!;
  const lines = [
    `## 🧠 CodeR Council — ${t.decisions[verdict.decision]} · ${t.mergeRisk} ${t.risk[verdict.mergeRisk]}`,
    "",
    prose(verdict.summary),
  ];
  if (verdict.overriddenByPolicy && verdict.decision !== verdict.proposedDecision) lines.push("", `> ${t.policyOverride}`);
  if (verdict.humanAttention.length > 0) {
    lines.push("", `### ${t.humanAttention}`, ...verdict.humanAttention.map((item) => `- ${prose(item)}`));
  }
  if (inSummary.length > 0) {
    lines.push("", `### ${t.generalFindings}`, "", `| | ${t.finding} | ${t.where} |`, "|---|---|---|");
    for (const f of inSummary) {
      const where = f.location.path ? `\`${f.location.path}${f.location.line ? `:${f.location.line}` : ""}\`` : "—";
      lines.push(`| ${SEVERITY_ICON[f.severity]} | **${f.id} · ${escapeCell(prose(f.title))}** — ${escapeCell(prose(f.recommendation || f.rationale))} | ${where} |`);
    }
  }
  for (const patch of offline) {
    lines.push("", `#### ${patchNote(patch, state.language).split("\n")[0]} · \`${patch.path}:${patch.startLine}\``, "", prose(patch.explanation), "", fenced("", patch.replacementLines ?? []));
  }
  const members = state.council.map((id) => PERSONAS[id].name[state.language]).join(" · ");
  lines.push("", `<sub>${t.stats(state.findings.length, publishedCount, state.patches.length)} · ${members}</sub>`);
  return lines.join("\n");
}

/** A code block fenced with one backtick more than the longest run inside it, so its content cannot close it. */
function fenced(info: string, lines: readonly string[]): string {
  const longestRun = Math.max(0, ...(lines.join("\n").match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${info}`, ...lines, fence].join("\n");
}

const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const MENTION_OR_ISSUE = /(^|[^\w`])(@[a-z\d](?:[a-z\d-]*)(?:\/[\w.-]+)?|#\d+)\b/gi;

/**
 * Model-authored prose goes out under the reviewer's identity: a `@name`,
 * `@org/team` or `#123` in it must not notify anyone or link an issue, so
 * outside code spans each one is wrapped in a code span.
 */
function prose(text: string): string {
  let result = "";
  let last = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    result += neutralize(text.slice(last, span.index)) + span[0];
    last = span.index + span[0].length;
  }
  return result + neutralize(text.slice(last));
}

function neutralize(text: string): string {
  return text.replace(MENTION_OR_ISSUE, (_match, before: string, reference: string) => `${before}\`${reference}\``);
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
