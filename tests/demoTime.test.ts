import { describe, expect, it } from "vitest";
import { createStandaloneApplication } from "../src/composition/standalone.js";
import { DemoTime } from "../src/infrastructure/demo/DemoTime.js";

describe("DemoTime", () => {
  it("wakes simulated waits in time order and moves the clock with them", async () => {
    const time = new DemoTime();
    const start = Date.UTC(2026, 10, 27, 9, 0, 0);
    const woke: [string, number][] = [];

    const realStart = Date.now();
    await time.replay(start, async () => {
      const wait = async (name: string, ms: number) => {
        await time.pace(ms);
        woke.push([name, time.now() - start]);
      };
      await Promise.all([wait("slow", 5000), wait("fast", 1000), wait("then", 1000).then(() => wait("chained", 2500))]);
    });

    expect(woke).toEqual([
      ["fast", 1000],
      ["then", 1000],
      ["chained", 3500],
      ["slow", 5000],
    ]);
    expect(Date.now() - realStart).toBeLessThan(1000);
    expect(Math.abs(time.now() - Date.now())).toBeLessThan(1000); // back to real time
  });

  it("replays a whole council session in an instant, with real-looking timestamps", async () => {
    const time = new DemoTime();
    const { application, conductReview } = createStandaloneApplication({ pace: time.pace, clock: time.clock });
    const anHourAgo = Date.now() - 3_600_000;

    const realStart = Date.now();
    let sessionId = "";
    await time.replay(anHourAgo, async () => {
      ({ sessionId } = await application.startReview({ provider: "demo", owner: "acme", repo: "storefront", number: 131 }, { language: "en" }));
      await conductReview.whenSettled();
    });
    expect(Date.now() - realStart).toBeLessThan(2000);

    const state = await application.session(sessionId);
    expect(state.status).toBe("concluded");
    expect(Date.parse(state.startedAt)).toBe(anHourAgo);
    // Opening and debate run in parallel (slowest reviewer: 6.4 s and 5.8 s), then implementer and moderator.
    expect(state.durationMs).toBe(6400 + 5800 + 4200 + 2600);
    const staff = state.statements.find((s) => s.reviewer === "staff" && s.round === "opening")!;
    expect(staff.durationMs).toBe(3800);
  });
});
