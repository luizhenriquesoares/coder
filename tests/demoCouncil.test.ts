import { describe, expect, it } from "vitest";
import type { CoderApi } from "../src/application/api.js";
import { createStandaloneApplication } from "../src/composition/standalone.js";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import type { PullRequestRef } from "../src/domain/change/types.js";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { PANELISTS, type Language } from "../src/domain/deliberation/model.js";
import { applyPatches } from "../src/domain/deliberation/patching.js";
import type { SessionState } from "../src/domain/deliberation/state.js";
import { DemoSourceControl } from "../src/infrastructure/demo/DemoSourceControl.js";
import { DEMO_PULL_REQUESTS } from "../src/infrastructure/demo/fixtures/index.js";
import { instantPace } from "../src/infrastructure/demo/ScriptedCouncil.js";

const coupon: PullRequestRef = { provider: "demo", owner: "acme", repo: "storefront", number: 128 };
const cache: PullRequestRef = { ...coupon, number: 131 };
const bump: PullRequestRef = { ...coupon, number: 133 };

async function review(ref: PullRequestRef, language: Language = "en") {
  const app = createStandaloneApplication({ pace: instantPace });
  const { sessionId } = await app.application.startReview(ref, { language });
  await app.conductReview.whenSettled(sessionId);
  return { ...app, sessionId, state: await app.application.session(sessionId) };
}

const levels = (state: SessionState) => Object.groupBy(state.findings, (f) => state.consensus[f.id]!.level);
const byKey = (state: SessionState, key: string) => state.findings.find((f) => f.key === key)!;

describe("demo council on the coupon pull request", () => {
  it("runs the whole protocol and reaches the scripted verdict", async () => {
    const { state } = await review(coupon);
    expect(state.status).toBe("concluded");
    expect(state.rounds).toEqual(["opening", "debate", "implementation", "verdict"]);
    expect(state.statements.filter((s) => s.round === "opening").map((s) => s.reviewer).sort()).toEqual([...PANELISTS].sort());
    expect(state.statements.every((s) => !s.failed)).toBe(true);
    expect(state.findings).toHaveLength(17);
    expect(state.verdict).toMatchObject({ decision: "request_changes", mergeRisk: "high", overriddenByPolicy: false });
    expect(state.thinking).toEqual([]);
  });

  it("anchors every finding to the quoted line of the head file", async () => {
    const { state, application } = await review(coupon);
    for (const finding of state.findings) {
      expect(finding.location.anchored, finding.key).toBe(true);
      const { modified } = await application.fileContents(coupon, finding.location.path!);
      expect(modified.split("\n")[finding.location.line! - 1], finding.key).toContain(finding.location.quote.trim());
    }
  });

  it("reaches the consensus the moderator's summary claims", async () => {
    const { state } = await review(coupon);
    const grouped = levels(state);
    expect(grouped.endorsed).toHaveLength(14);
    expect(grouped.contested!.map((f) => f.key).sort()).toEqual(["mysterious-names", "ocp-coupon-types"]);
    expect(grouped.rejected!.map((f) => f.key)).toEqual(["event-driven-redemption"]);
    expect(grouped.unreviewed).toBeUndefined();

    const blockers = state.findings.filter((f) => f.severity === "blocker");
    expect(blockers.map((f) => f.key).sort()).toEqual(["free-shipping-bug", "sql-injection"]);
    for (const blocker of blockers) expect(state.consensus[blocker.id]!.support).toHaveLength(4);

    const endorsed = new Set(grouped.endorsed!.map((f) => f.id));
    const patched = new Set(state.patches.flatMap((p) => p.findingIds).filter((id) => endorsed.has(id)));
    expect(state.patches).toHaveLength(10);
    expect(patched.size).toBe(12);
    expect(state.declined.map((d) => state.findings.find((f) => f.id === d.findingId)!.key).sort()).toEqual([
      "ocp-coupon-types",
      "srp-place-order",
      "thin-tests",
    ]);
  });

  it("produces patches that all apply and yield the intended code", async () => {
    const { state, application } = await review(coupon);
    expect(state.patches.every((p) => p.applicable)).toBe(true);

    const patchedFile = async (path: string) => {
      const { modified } = await application.fileContents(coupon, path);
      return applyPatches(modified, state.patches.filter((p) => p.path === path));
    };
    const service = await patchedFile("src/checkout/CheckoutService.ts");
    expect(service).not.toMatch(/PostgresCouponRepository|\bdb\b|catch \(e\)|\bd\b/);
    expect(service).toContain("private readonly coupons: CouponRepository,");
    expect(service).toContain('const freeShipping = subtotal >= 200 || coupon?.type === "free_shipping";');
    expect(service).toContain("      discount,\n");

    const repository = await patchedFile("src/checkout/coupons/CouponRepository.ts");
    expect(repository).not.toContain("' +");
    expect(repository).toContain("implements CouponRepository");
    expect(repository).toContain("used_count < max_uses RETURNING id");

    expect(await patchedFile("src/api/checkoutController.ts")).not.toContain("console.log");
    expect(await patchedFile("migrations/20260112_add_coupons.sql")).toContain("NOT NULL UNIQUE,");
    expect(await patchedFile("src/checkout/coupons/Coupon.ts")).toContain("export function discountFor");
  });

  it("speaks Portuguese when asked", async () => {
    const { state } = await review(coupon, "pt");
    expect(state.language).toBe("pt");
    expect(byKey(state, "sql-injection").title).toBe("SQL injection pelo código do cupom");
    expect(state.verdict!.summary).toMatch(/^Não faça o merge ainda/);
  });

  it("plans a publication with suggestions on commentable lines only", async () => {
    const { application, sessionId, state } = await review(coupon);
    const plan = await application.publicationPreview(sessionId);
    const snapshot = await new DemoSourceControl().getSnapshot(coupon);
    const changeSet = ChangeSet.fromSnapshot(snapshot);
    expect(plan).toMatchObject({ decision: "request_changes", councilDecision: "request_changes" });
    // 14 published findings (4 of them carrying the patch that fixes them) + 5 patches as comments of their own.
    expect(plan.summaryFindings).toBe(0);
    expect(plan.comments).toHaveLength(19);
    for (const comment of plan.comments) {
      expect(changeSet.isCommentableRange(comment.path, comment.startLine ?? comment.line, comment.line), comment.body.slice(0, 60)).toBe(true);
    }
    // P-6 touches unchanged lines outside every hunk, so it cannot be a GitHub suggestion: it goes into the summary.
    expect(plan.comments.filter((c) => c.body.includes("```suggestion"))).toHaveLength(state.patches.length - 1);
    expect(plan.body).toContain("Patch P-6");
    expect(plan.body).toContain("private readonly coupons: CouponRepository,");
    const blocker = plan.comments.find((c) => c.body.includes("SQL injection through the coupon code"))!;
    expect(blocker).toMatchObject({ path: "src/checkout/coupons/CouponRepository.ts", startLine: 8, line: 10 });
    expect(blocker.body).toContain('```suggestion\n    const rows = await this.db.query("SELECT * FROM coupons WHERE code = $1 LIMIT 1", [code]);\n```');
    expect(plan.body).toContain("Where a human should look");

    const published = await application.publish(sessionId);
    expect(published.publication).toMatchObject({ simulated: true, decision: "request_changes", inlineComments: plan.comments.length });
    expect(state.publication).toBeNull();
  });

  it("applies human decisions to what gets published", async () => {
    const { application, sessionId, state } = await review(coupon);
    const before = await application.publicationPreview(sessionId);
    await application.decide(sessionId, { target: { kind: "finding", id: byKey(state, "ocp-coupon-types").id }, action: "accept" });
    await application.decide(sessionId, { target: { kind: "finding", id: byKey(state, "sql-injection").id }, action: "dismiss" });
    const after = await application.publicationPreview(sessionId);
    const titles = (plan: typeof after) => plan.comments.map((c) => c.body).join("\n") + plan.body;
    expect(titles(before)).toContain("SQL injection through the coupon code");
    expect(titles(after)).not.toContain("SQL injection through the coupon code");
    expect(titles(after)).toContain("Type switch violates the Open/Closed Principle");
    await expect(application.decide(sessionId, { target: { kind: "finding", id: "F-99" }, action: "accept" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("streams events in order, replays from any point and keeps one stream per session", async () => {
    const app = createStandaloneApplication({ pace: instantPace });
    const { sessionId } = await app.application.startReview(coupon, { language: "en" });
    const live: DomainEvent[] = [];
    const unsubscribe = await app.application.subscribe(sessionId, 0, (event) => live.push(event));
    await app.conductReview.whenSettled(sessionId);
    unsubscribe();

    expect(live.map((e) => e.seq)).toEqual(live.map((_, i) => i + 1));
    expect(live[0]!.type).toBe("ReviewSessionConvened");
    expect(live.at(-1)!.type).toBe("ReviewSessionConcluded");

    const replayed: DomainEvent[] = [];
    (await app.application.subscribe(sessionId, 10, (event) => replayed.push(event)))();
    expect(replayed).toEqual(live.slice(10));
    expect(await app.store.load(sessionId)).toEqual(live);
    await expect(app.application.subscribe("missing", 0, () => {})).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the other demo pull requests", () => {
  it("approves the clean cache change with three endorsed low-severity findings", async () => {
    const { state, application } = await review(cache);
    expect(state.verdict).toMatchObject({ decision: "approve", mergeRisk: "low", overriddenByPolicy: false });
    expect(levels(state).endorsed).toHaveLength(3);
    expect(state.patches.every((p) => p.applicable)).toBe(true);
    const { modified } = await application.fileContents(cache, "src/shared/TtlCache.ts");
    const patched = applyPatches(modified, state.patches.filter((p) => p.path === "src/shared/TtlCache.ts"));
    expect(patched).toContain("private readonly maxEntries = 10_000,");
    expect(patched).toContain("this.entries.size >= this.maxEntries");
  });

  it("requests changes on the dependency bump without inventing a patch", async () => {
    const { state } = await review(bump);
    expect(state.verdict).toMatchObject({ decision: "request_changes", mergeRisk: "medium" });
    expect(state.patches).toEqual([]);
    expect(state.declined).toHaveLength(1);
    expect(state.risk.files[0]!.reasons).toContain("dependency_change");
  });

  it("keeps every scripted quote, patch and reference consistent with its fixture", () => {
    for (const pr of DEMO_PULL_REQUESTS) {
      const head = new Map(pr.files.map((f) => [f.path, f.head ?? ""]));
      const keys = new Set(PANELISTS.flatMap((p) => pr.script.opening[p].findings.map((f) => f.key)));
      for (const panelist of PANELISTS) {
        for (const finding of pr.script.opening[panelist].findings) {
          expect(head.get(finding.path!), `${finding.key} path`).toBeDefined();
          expect(head.get(finding.path!)!.includes(finding.quote), `${finding.key} quote`).toBe(true);
        }
        for (const position of pr.script.debate[panelist].positions) {
          expect(keys.has(position.on), `${panelist} → ${position.on}`).toBe(true);
          const own = pr.script.opening[panelist].findings.some((f) => f.key === position.on);
          expect(own, `${panelist} votes on own finding ${position.on}`).toBe(false);
        }
      }
      for (const patch of pr.script.implementation.patches) {
        expect(patch.fixes.every((key) => keys.has(key)), patch.path).toBe(true);
        expect(head.get(patch.path)!.includes(patch.original), `patch original in ${patch.path}`).toBe(true);
      }
      expect(pr.script.implementation.declined.every((d) => keys.has(d.on))).toBe(true);
    }
  });
});

describe("inbox and pull request detail", () => {
  it("lists demo pull requests with their latest session", async () => {
    const { application } = await review(coupon);
    const inbox = await (application as CoderApi).inbox();
    expect(inbox.items.map((i) => i.pullRequest.ref.number)).toEqual([128, 131, 133]);
    expect(inbox.items[0]).toMatchObject({ stale: false, latestSession: { status: "concluded", decision: "request_changes", findings: 17, endorsedFindings: 14, patches: 10 } });
    expect(inbox.items[1]!.latestSession).toBeNull();
  });

  it("describes a pull request for the workspace", async () => {
    const { application } = createStandaloneApplication({ pace: instantPace });
    const detail = await application.pullRequest(coupon);
    expect(detail.stats).toEqual({ files: 6, additions: 109, deletions: 5 });
    expect(detail.engines).toEqual(["scripted"]);
    expect(detail.risk.level).toBe("high");
    expect(detail.risk.reviewOrder[0]).toBe("src/checkout/CheckoutService.ts");
    expect(detail.files.find((f) => f.path.endsWith("Coupon.ts"))).toMatchObject({ status: "added", language: "typescript" });
    await expect(application.fileContents(coupon, "nope.ts")).rejects.toMatchObject({ code: "not_found" });
    await expect(application.importPullRequest("not a url")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
