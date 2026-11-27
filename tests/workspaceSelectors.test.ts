import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/deliberation/model.js";
import { decisionKey, levelOf, type SessionState } from "../src/domain/deliberation/state.js";
import { isSetAside, locationLabel, stepThrough, toggleSelection } from "../web/src/state/selectors.js";
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
