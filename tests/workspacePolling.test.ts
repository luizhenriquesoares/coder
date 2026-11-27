import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { everyWhileVisible, type PageVisibility } from "../web/src/state/polling.js";

class FakePage implements PageVisibility {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.delete(listener);
  }
  set(hidden: boolean) {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
  get listening() {
    return this.listeners.size;
  }
}

describe("the inbox refresh timer", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("refreshes on its interval while the page is visible", () => {
    const tick = vi.fn();
    const stop = everyWhileVisible(new FakePage(), 15_000, tick);
    vi.advanceTimersByTime(45_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("pauses while the page is hidden, and refreshes at once when it is visible again", () => {
    const page = new FakePage();
    const tick = vi.fn();
    const stop = everyWhileVisible(page, 15_000, tick);
    vi.advanceTimersByTime(10_000);
    page.set(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(tick).not.toHaveBeenCalled();

    page.set(false);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not start while hidden, and stops for good", () => {
    const page = new FakePage();
    page.hidden = true;
    const tick = vi.fn();
    const stop = everyWhileVisible(page, 15_000, tick);
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
    stop();
    expect(page.listening).toBe(0);
    page.set(false);
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
