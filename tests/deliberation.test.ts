import { describe, expect, it } from "vitest";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import { assessRisk } from "../src/domain/change/riskAssessment.js";
import type { PullRequestSnapshot } from "../src/domain/change/types.js";
import { anchorLocation } from "../src/domain/deliberation/codeAnchoring.js";
import { computeConsensus } from "../src/domain/deliberation/consensusPolicy.js";
import {
  DomainError,
  type ConsensusLevel,
  type Decision,
  type Finding,
  type Language,
  type Position,
  type ReviewerId,
  type Severity,
  type Stance,
} from "../src/domain/deliberation/model.js";
import { applyPatches, applySnippetPatch, locateSnippet } from "../src/domain/deliberation/patching.js";
import { planPublication } from "../src/domain/deliberation/publicationPlanner.js";
import { MAX_FINDINGS_PER_REVIEWER, ReviewSession, type FindingDraft } from "../src/domain/deliberation/ReviewSession.js";
import { foldEvents } from "../src/domain/deliberation/state.js";
import { applyVerdictPolicy, boundDecision, fallbackVerdict, riskFloor } from "../src/domain/deliberation/verdictPolicy.js";

const HEAD = ["export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}"].join("\n");

const snapshot: PullRequestSnapshot = {
  ref: { provider: "github", owner: "acme", repo: "shop", number: 1 },
  title: "Totals",
  description: "",
  author: { login: "dev" },
  url: "https://github.com/acme/shop/pull/1",
  baseBranch: "main",
  headBranch: "totals",
  baseSha: "b",
  headSha: "h",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  draft: false,
  state: "open",
  files: [
    {
      path: "src/total.ts",
      status: "added",
      additions: 5,
      deletions: 0,
      patch: "@@ -0,0 +1,5 @@\n" + HEAD.split("\n").map((l) => "+" + l).join("\n"),
    },
  ],
};
const changeSet = ChangeSet.fromSnapshot(snapshot);
const contents = new Map([["src/total.ts", HEAD]]);

function convene(): ReviewSession {
  let tick = 0;
  return ReviewSession.convene(
    {
      id: "s1",
      pullRequest: { ref: snapshot.ref, title: snapshot.title, author: "dev", url: snapshot.url, baseBranch: "main", headBranch: "totals", headSha: "h" },
      engine: "scripted",
      model: null,
      language: "en",
      stats: changeSet.stats,
      risk: assessRisk(changeSet),
      trigger: "manual",
    },
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  );
}

const draft = (overrides: Partial<FindingDraft> = {}): FindingDraft => ({
  severity: "major",
  category: "correctness",
  title: "Sum ignores quantity",
  rationale: "Each item is counted once.",
  recommendation: "Multiply by quantity.",
  principle: "",
  path: "src/total.ts",
  line: 1,
  quote: "for (const i of items) sum += i.price;",
  ...overrides,
});

const say = (session: ReviewSession, reviewer: ReviewerId) => session.makeStatement(reviewer, "ok", { durationMs: 1, usage: null });

/** Drives a session to the verdict round with one finding and the given positions. */
function debated(severity: "blocker" | "major" | "nit", stances: Partial<Record<ReviewerId, Stance>>): ReviewSession {
  const session = convene();
  session.startRound("opening");
  session.raiseFinding("staff", draft({ severity }), changeSet, contents);
  session.startRound("debate");
  for (const [reviewer, stance] of Object.entries(stances)) {
    session.takePosition(reviewer as ReviewerId, { findingId: "F-1", stance: stance!, argument: "because" });
  }
  session.settleConsensus();
  session.startRound("implementation");
  session.startRound("verdict");
  return session;
}

describe("ReviewSession protocol", () => {
  it("runs rounds strictly in order", () => {
    const session = convene();
    expect(() => session.startRound("debate")).toThrow(DomainError);
    session.startRound("opening");
    expect(() => session.startRound("opening")).toThrow(/expected "debate"/);
  });

  it("lets a reviewer speak once per round and only in their rounds", () => {
    const session = convene();
    session.startRound("opening");
    say(session, "architect");
    expect(() => say(session, "architect")).toThrow(/already spoke/);
    expect(() => say(session, "implementer")).toThrow(/does not speak in the opening round/);
    expect(() => say(session, "moderator")).toThrow(DomainError);
  });

  it("re-anchors a finding to the quoted line", () => {
    const session = convene();
    session.startRound("opening");
    const finding = session.raiseFinding("staff", draft({ line: 40 }), changeSet, contents);
    expect(finding).toMatchObject({ id: "F-1", location: { path: "src/total.ts", line: 3, anchored: true } });
  });

  it("keeps findings about unknown files as general findings", () => {
    const session = convene();
    session.startRound("opening");
    const finding = session.raiseFinding("staff", draft({ path: "src/elsewhere.ts" }), changeSet, contents);
    expect(finding.location).toMatchObject({ path: null, line: null, anchored: false });
  });

  it("caps findings per reviewer", () => {
    const session = convene();
    session.startRound("opening");
    for (let i = 0; i < MAX_FINDINGS_PER_REVIEWER; i++) session.raiseFinding("staff", draft(), changeSet, contents);
    expect(() => session.raiseFinding("staff", draft(), changeSet, contents)).toThrow(/already raised/);
    expect(() => session.raiseFinding("architect", draft(), changeSet, contents)).not.toThrow();
  });

  it("forbids positions on one's own finding, duplicates and unknown findings", () => {
    const session = convene();
    session.startRound("opening");
    session.raiseFinding("staff", draft(), changeSet, contents);
    expect(() => session.takePosition("architect", { findingId: "F-1", stance: "agree", argument: "" })).toThrow(/"debate" round/);
    session.startRound("debate");
    expect(() => session.takePosition("staff", { findingId: "F-1", stance: "agree", argument: "" })).toThrow(/own finding/);
    session.takePosition("architect", { findingId: "F-1", stance: "agree", argument: "yes" });
    expect(() => session.takePosition("architect", { findingId: "F-1", stance: "disagree", argument: "no" })).toThrow(/already took/);
    expect(() => session.takePosition("cleancode", { findingId: "F-9", stance: "agree", argument: "" })).toThrow(/Unknown finding/);
  });

  it("marks a patch applicable only when its original exists in the head file", () => {
    const session = debatedUntilImplementation();
    const good = session.proposePatch(
      "implementer",
      { findingIds: ["F-1"], path: "total.ts", original: "  for (const i of items) sum += i.price;", replacement: "  for (const i of items) sum += i.price * i.quantity;", explanation: "x" },
      changeSet,
      contents,
    );
    expect(good).toMatchObject({ id: "P-1", path: "src/total.ts", applicable: true, startLine: 3, endLine: 3 });
    const bad = session.proposePatch(
      "implementer",
      { findingIds: ["F-1"], path: "src/total.ts", original: "not in the file", replacement: "x", explanation: "x" },
      changeSet,
      contents,
    );
    expect(bad).toMatchObject({ applicable: false, startLine: null });
    expect(() =>
      session.proposePatch("implementer", { findingIds: [], path: "src/total.ts", original: "a", replacement: "b", explanation: "" }, changeSet, contents),
    ).toThrow(/at least one finding/);
    expect(() =>
      session.proposePatch("implementer", { findingIds: ["F-1"], path: "nope.ts", original: "a", replacement: "b", explanation: "" }, changeSet, contents),
    ).toThrow(/outside the change set/);
  });

  it("does not let the council approve over an endorsed blocker", () => {
    const session = debated("blocker", { architect: "agree", cleancode: "agree" });
    const verdict = session.issueVerdict("moderator", { decision: "approve", mergeRisk: "low", summary: "fine", humanAttention: [] });
    expect(verdict).toMatchObject({ decision: "request_changes", proposedDecision: "approve", overriddenByPolicy: true, mergeRisk: "high" });
    expect(() => session.issueVerdict("moderator", { decision: "approve", mergeRisk: "low", summary: "", humanAttention: [] })).toThrow(/already issued/);
  });

  it("lets the moderator approve when the blocker was rejected by the panel", () => {
    const session = debated("blocker", { architect: "disagree", cleancode: "disagree" });
    const verdict = session.issueVerdict("moderator", { decision: "approve", mergeRisk: "low", summary: "fine", humanAttention: [] });
    expect(verdict).toMatchObject({ decision: "approve", overriddenByPolicy: false, mergeRisk: "low" });
  });

  it("concludes only after a verdict and rebuilds the same state from its events", () => {
    const session = debated("major", { architect: "agree" });
    expect(() => session.conclude()).toThrow(/after the verdict/);
    session.issueVerdict("moderator", { decision: "comment", mergeRisk: "low", summary: "s", humanAttention: ["look here"] });
    session.conclude();
    const events = session.pullPendingEvents();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(foldEvents(events)).toEqual(session.state);
    expect(ReviewSession.rehydrate(events).state).toEqual(session.state);
    expect(session.state).toMatchObject({ status: "concluded", verdict: { mergeRisk: "medium" } });
    expect(() => session.startRound("opening")).toThrow(/concluded/);
  });

  it("records human decisions idempotently and rejects unknown targets", () => {
    const session = debated("major", { architect: "agree" });
    session.pullPendingEvents();
    const decision = { target: { kind: "finding", id: "F-1" }, action: "dismiss", by: "luiz" } as const;
    session.recordHumanDecision(decision);
    session.recordHumanDecision(decision);
    expect(session.pullPendingEvents()).toHaveLength(1);
    session.recordHumanDecision({ ...decision, action: "accept" });
    expect(session.state.decisions["finding:F-1"]!.action).toBe("accept");
    expect(() => session.recordHumanDecision({ ...decision, target: { kind: "patch", id: "P-9" } })).toThrow(/Unknown patch/);
  });
});

function debatedUntilImplementation(): ReviewSession {
  const session = convene();
  session.startRound("opening");
  session.raiseFinding("staff", draft(), changeSet, contents);
  session.startRound("debate");
  session.settleConsensus();
  session.startRound("implementation");
  return session;
}

describe("ConsensusPolicy", () => {
  const finding = { id: "F-1", author: "staff" } as Finding;
  const position = (reviewer: ReviewerId, stance: Stance): Position => ({ reviewer, findingId: "F-1", stance, argument: "" });
  const level = (...positions: Position[]) => computeConsensus(finding, positions).level;

  it("classifies findings from the panel's positions", () => {
    expect(level()).toBe("unreviewed");
    expect(level(position("architect", "agree"))).toBe("endorsed");
    expect(level(position("architect", "refine"))).toBe("endorsed");
    expect(level(position("architect", "disagree"))).toBe("contested");
    expect(level(position("architect", "agree"), position("cleancode", "disagree"))).toBe("contested");
    expect(level(position("architect", "disagree"), position("cleancode", "disagree"))).toBe("rejected");
    expect(level(position("architect", "agree"), position("cleancode", "agree"), position("refactoring", "disagree"))).toBe("endorsed");
  });

  it("ignores the author's own vote and positions on other findings", () => {
    const consensus = computeConsensus(finding, [position("staff", "disagree"), { ...position("architect", "disagree"), findingId: "F-2" }]);
    expect(consensus).toMatchObject({ level: "unreviewed", support: ["staff"], opposition: [] });
  });
});

describe("VerdictPolicy", () => {
  const finding = (id: string, severity: Finding["severity"]) => ({ id, severity }) as Finding;
  const endorsed = (id: string) => ({ [id]: { findingId: id, level: "endorsed", support: [], opposition: [], refinements: [] } }) as const;

  it("raises the merge risk to what endorsed findings imply", () => {
    const verdict = applyVerdictPolicy({ decision: "comment", mergeRisk: "low", summary: "", humanAttention: [] }, [finding("F-1", "major")], endorsed("F-1"));
    expect(verdict).toMatchObject({ decision: "comment", mergeRisk: "medium", overriddenByPolicy: true });
  });

  it("leaves a compliant verdict untouched", () => {
    const verdict = applyVerdictPolicy({ decision: "approve", mergeRisk: "medium", summary: "", humanAttention: [] }, [finding("F-1", "minor")], endorsed("F-1"));
    expect(verdict).toMatchObject({ decision: "approve", mergeRisk: "medium", overriddenByPolicy: false });
  });
});

describe("the rules over the findings that stand", () => {
  const standing = (...severities: Severity[]) => severities.map((severity, index) => ({ id: `F-${index + 1}`, severity }) as Finding);

  it.each([
    [[], "low"],
    [["nit", "minor"], "low"],
    [["minor", "major"], "medium"],
    [["major", "blocker"], "high"],
  ] as [Severity[], string][])("riskFloor(%j) is %s", (severities, floor) => {
    expect(riskFloor(standing(...severities))).toBe(floor);
  });

  it.each([
    ["approve", ["blocker"], "request_changes"],
    ["approve", ["major"], "approve"],
    ["approve", [], "approve"],
    ["request_changes", ["blocker"], "request_changes"],
    ["request_changes", ["major"], "request_changes"],
    ["request_changes", ["minor", "nit"], "comment"],
    ["request_changes", [], "comment"],
    ["comment", ["blocker"], "comment"],
    ["comment", [], "comment"],
  ] as [Decision, Severity[], Decision][])("boundDecision(%s, %j) is %s", (proposed, severities, bound) => {
    expect(boundDecision(proposed, standing(...severities))).toBe(bound);
  });

  it("turns a request for changes the endorsed findings do not ground into a comment", () => {
    const consensus = { "F-1": { findingId: "F-1", level: "endorsed", support: [], opposition: [], refinements: [] } } as const;
    const verdict = applyVerdictPolicy({ decision: "request_changes", mergeRisk: "low", summary: "", humanAttention: [] }, standing("minor"), consensus);
    expect(verdict).toMatchObject({ decision: "comment", proposedDecision: "request_changes", overriddenByPolicy: true, mergeRisk: "low" });
  });
});

describe("the fallback verdict, when the moderator cannot answer", () => {
  const settled = (language: Language, ...findings: [Severity, ConsensusLevel][]) => ({
    language,
    findings: findings.map(([severity], index) => ({ id: `F-${index + 1}`, severity, title: `Finding ${index + 1}` }) as Finding),
    consensus: Object.fromEntries(
      findings.map(([, level], index) => [`F-${index + 1}`, { findingId: `F-${index + 1}`, level, support: [], opposition: [], refinements: [] }]),
    ),
  });

  it("requests changes over an endorsed blocker or major", () => {
    expect(fallbackVerdict(settled("en", ["blocker", "endorsed"]))).toMatchObject({ decision: "request_changes", mergeRisk: "high" });
    expect(fallbackVerdict(settled("en", ["major", "endorsed"], ["nit", "rejected"]))).toMatchObject({ decision: "request_changes", mergeRisk: "medium" });
  });

  it("never approves a blocker nobody reviewed (a single panelist survived the opening)", () => {
    const verdict = fallbackVerdict(settled("en", ["blocker", "unreviewed"], ["minor", "unreviewed"]));
    expect(verdict).toMatchObject({ decision: "comment", mergeRisk: "medium", humanAttention: ["Unreviewed: Finding 1 (F-1)"] });
    expect(verdict.summary).toBe(
      "The moderator did not answer; this verdict was derived from the council's consensus: 0 endorsed findings (0 blockers, 0 major), 0 contested and 2 unreviewed.",
    );
  });

  it("comments on findings that stand or are disputed, and lists the disputed ones for the human", () => {
    expect(fallbackVerdict(settled("en", ["minor", "endorsed"]))).toMatchObject({ decision: "comment", mergeRisk: "low", humanAttention: [] });
    expect(fallbackVerdict(settled("pt", ["major", "contested"]))).toMatchObject({
      decision: "comment",
      mergeRisk: "medium",
      humanAttention: ["Em disputa: Finding 1 (F-1)"],
    });
  });

  it("approves when nothing stands", () => {
    expect(fallbackVerdict(settled("en"))).toMatchObject({ decision: "approve", mergeRisk: "low", humanAttention: [] });
    expect(fallbackVerdict(settled("pt", ["blocker", "rejected"]))).toMatchObject({ decision: "approve", mergeRisk: "low" });
    expect(fallbackVerdict(settled("pt")).summary).toMatch(/^O moderador não respondeu/);
  });
});

describe("code anchoring and patching", () => {
  it("picks the occurrence closest to the claimed line", () => {
    const text = ["x = 1", "return x", "y = 2", "return x"].join("\n");
    const cs = ChangeSet.fromSnapshot({ ...snapshot, files: [{ path: "a.py", status: "added", additions: 4, deletions: 0 }] });
    const where = (line: number | null) => anchorLocation({ path: "a.py", line, quote: "return x" }, cs, new Map([["a.py", text]])).line;
    expect(where(4)).toBe(4);
    expect(where(1)).toBe(2);
    expect(where(null)).toBe(2);
    expect(anchorLocation({ path: "a.py", line: 3, quote: "missing" }, cs, new Map([["a.py", text]]))).toMatchObject({ line: 3, anchored: false });
    expect(anchorLocation({ path: "a.py", line: 99, quote: "missing" }, cs, new Map([["a.py", text]])).line).toBeNull();
  });

  it("locates snippets exactly or ignoring indentation", () => {
    expect(locateSnippet(HEAD, "  let sum = 0;\n  for (const i of items) sum += i.price;")).toEqual({ startLine: 2, endLine: 3, exact: true });
    expect(locateSnippet(HEAD, "let sum = 0;\n      for (const i of items) sum += i.price;")).toEqual({ startLine: 2, endLine: 3, exact: false });
    expect(locateSnippet(HEAD, "nothing")).toBeNull();
    expect(locateSnippet(HEAD, "  \n")).toBeNull();
  });

  it("applies replacements, deletions and re-indents loose matches", () => {
    expect(applySnippetPatch(HEAD, "  let sum = 0;", "  let sum = 0n;")!.split("\n")[1]).toBe("  let sum = 0n;");
    expect(applySnippetPatch(HEAD, "  let sum = 0;", "")!.split("\n")).toHaveLength(4);
    expect(applySnippetPatch(HEAD, "return sum;", "if (sum < 0) {\n  return 0;\n}\nreturn sum;")!.split("\n").slice(3, 7)).toEqual([
      "  if (sum < 0) {",
      "    return 0;",
      "  }",
      "  return sum;",
    ]);
    expect(applySnippetPatch(HEAD, "absent", "x")).toBeNull();
    expect(applyPatches(HEAD, [{ original: "absent", replacement: "x" }, { original: "  return sum;", replacement: "  return sum | 0;" }])).toContain("return sum | 0;");
  });
});

describe("planPublication", () => {
  function concluded(decide?: (session: ReviewSession) => void): ReviewSession {
    const session = convene();
    session.startRound("opening");
    session.raiseFinding("staff", draft(), changeSet, contents); // F-1 inline, will get a patch
    session.raiseFinding("architect", draft({ path: null, quote: "", title: "No ADR for totals" }), changeSet, contents); // F-2 general
    session.raiseFinding("cleancode", draft({ severity: "nit", title: "Rename i", quote: "let sum = 0;" }), changeSet, contents); // F-3 unreviewed
    session.startRound("debate");
    session.takePosition("architect", { findingId: "F-1", stance: "agree", argument: "yes" });
    session.takePosition("staff", { findingId: "F-2", stance: "agree", argument: "yes" });
    session.settleConsensus();
    session.startRound("implementation");
    session.proposePatch(
      "implementer",
      { findingIds: ["F-1"], path: "src/total.ts", original: "  for (const i of items) sum += i.price;", replacement: "  for (const i of items) sum += i.price * i.quantity;", explanation: "Counts quantity." },
      changeSet,
      contents,
    );
    session.startRound("verdict");
    session.issueVerdict("moderator", { decision: "request_changes", mergeRisk: "medium", summary: "Fix the sum.", humanAttention: ["Check rounding"] });
    session.conclude();
    decide?.(session);
    return session;
  }

  it("publishes endorsed findings: inline with a suggestion, or in the summary", () => {
    const plan = planPublication(concluded().state, changeSet);
    expect(plan.event).toBe("REQUEST_CHANGES");
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]).toMatchObject({ path: "src/total.ts", line: 3 });
    expect(plan.comments[0]!.body).toContain("```suggestion\n  for (const i of items) sum += i.price * i.quantity;\n```");
    expect(plan.summaryFindings).toBe(1);
    expect(plan.body).toContain("No ADR for totals");
    expect(plan.body).toContain("Check rounding");
    expect(plan.body).not.toContain("Rename i");
  });

  it("lets the human overrule the council in both directions", () => {
    const plan = planPublication(
      concluded((session) => {
        session.recordHumanDecision({ target: { kind: "finding", id: "F-2" }, action: "dismiss", by: "luiz" });
        session.recordHumanDecision({ target: { kind: "finding", id: "F-3" }, action: "accept", by: "luiz" });
        session.recordHumanDecision({ target: { kind: "patch", id: "P-1" }, action: "dismiss", by: "luiz" });
      }).state,
      changeSet,
    );
    expect(plan.summaryFindings).toBe(0);
    expect(plan.comments.map((c) => c.line)).toEqual([3, 2]);
    expect(plan.comments[0]!.body).not.toContain("```suggestion");
    expect(plan.comments[1]!.body).toContain("Rename i");
  });

  it("writes the review in the session language", () => {
    const session = concluded();
    const plan = planPublication({ ...session.state, language: "pt" }, changeSet);
    expect(plan.body).toContain("Pedir mudanças");
    expect(plan.comments[0]!.body).toContain("Recomendação");
  });
});
