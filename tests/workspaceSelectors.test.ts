import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/deliberation/model.js";
import { decisionKey, levelOf, type SessionState } from "../src/domain/deliberation/state.js";
import { inboxErrorLines, isSetAside, locationLabel, patchDiffLines, stepThrough, toggleSelection } from "../web/src/state/selectors.js";
import { STRINGS } from "../web/src/state/i18n.js";
import { concludedDemoSession } from "./support/demoSession.js";

const at = (path: string | null, line: number | null): Pick<Finding, "location"> => ({
  location: { path, line, quote: "", anchored: line !== null },
});

function decided(state: SessionState, id: string, action: "accept" | "dismiss"): SessionState {
  const target = { kind: "finding" as const, id };
  return { ...state, decisions: { ...state.decisions, [decisionKey(target)]: { target, action, by: "you" } } };
}

describe("workspace view rules", () => {
  it("steps through a list and wraps around at both ends", () => {
    const items = [{ id: "F1" }, { id: "F2" }, { id: "F3" }];
    expect(stepThrough(items, null, 1)?.id).toBe("F1");
    expect(stepThrough(items, null, -1)?.id).toBe("F3");
    expect(stepThrough(items, "F1", 1)?.id).toBe("F2");
    expect(stepThrough(items, "F3", 1)?.id).toBe("F1");
    expect(stepThrough(items, "F1", -1)?.id).toBe("F3");
    expect(stepThrough(items, "gone", 1)?.id).toBe("F1");
    expect(stepThrough([], "F1", 1)).toBeNull();
  });

  it("lets go of a selection when it is selected again", () => {
    expect(toggleSelection(null, "F1")).toBe("F1");
    expect(toggleSelection("F2", "F1")).toBe("F1");
    expect(toggleSelection("F1", "F1")).toBeNull();
  });

  it("labels a location by file and line, or as the whole change", () => {
    expect(locationLabel(at("src/cart/coupon.ts", 12), "Whole change")).toBe("coupon.ts:12");
    expect(locationLabel(at("src/cart/coupon.ts", null), "Whole change")).toBe("coupon.ts");
    expect(locationLabel(at(null, null), "Whole change")).toBe("Whole change");
  });

  it("sets aside what the human dismissed and what the council rejected, unless the human accepted it", async () => {
    const { state } = await concludedDemoSession();
    const rejected = state.findings.find((finding) => levelOf(state, finding) === "rejected")!;
    const endorsed = state.findings.find((finding) => levelOf(state, finding) === "endorsed")!;
    expect(isSetAside(state, rejected)).toBe(true);
    expect(isSetAside(state, endorsed)).toBe(false);
    expect(isSetAside(decided(state, endorsed.id, "dismiss"), endorsed)).toBe(true);
    expect(isSetAside(decided(state, rejected.id, "accept"), rejected)).toBe(false);
  });
});

describe("the patch card's diff", () => {
  const patch = { original: "  if (x) return 1;\n", replacement: "if (!x) return 1;" };

  it("shows the lines that will be published, not the proposed text", () => {
    expect(patchDiffLines({ ...patch, replacementLines: ["  if (!x) return 1;"] })).toEqual({
      removed: ["  if (x) return 1;"],
      added: ["  if (!x) return 1;"],
    });
  });

  it("shows a deletion as no added line", () => {
    expect(patchDiffLines({ ...patch, replacement: "", replacementLines: [] }).added).toEqual([]);
  });

  it("falls back to the proposed text when the patch could not be placed", () => {
    expect(patchDiffLines({ ...patch, replacementLines: null }).added).toEqual(["if (!x) return 1;"]);
  });
});

describe("the publish bar's wording", () => {
  it("says plainly when the human's decisions changed what will be published", async () => {
    const { application, sessionId, state } = await concludedDemoSession();
    for (const finding of state.findings) {
      if (levelOf(state, finding) === "endorsed" && (finding.severity === "blocker" || finding.severity === "major")) {
        await application.decide(sessionId, { target: { kind: "finding", id: finding.id }, action: "dismiss" });
      }
    }
    const plan = await application.publicationPreview(sessionId);
    expect([plan.councilDecision, plan.decision]).toEqual(["request_changes", "comment"]);
    expect(STRINGS.en.outcomeChanged(plan.councilDecision, plan.decision)).toBe(
      "Your decisions changed the outcome: the council asked for changes, and this review will be published as a comment.",
    );
    expect(STRINGS.pt.outcomeChanged(plan.councilDecision, plan.decision)).toBe(
      "Suas decisões mudaram o resultado: o conselho pediu mudanças, e esta revisão será publicada como um comentário.",
    );
  });
});

describe("the inbox's errors", () => {
  it("shows one line per source and message, in the order they came", () => {
    const errors = [
      { provider: "github" as const, message: "Rate limit exceeded" },
      { provider: "github" as const, message: "Rate limit exceeded" },
      { provider: "demo" as const, message: "Rate limit exceeded" },
      { provider: "github" as const, message: "Not found" },
    ];
    expect(inboxErrorLines(errors)).toEqual([errors[0], errors[2], errors[3]]);
  });
});
