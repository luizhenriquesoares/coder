import type { Clock } from "../../domain/deliberation/ReviewSession.js";
import type { Pace } from "./ScriptedCouncil.js";

interface Sleeper {
  readonly wakeAt: number;
  readonly wake: () => void;
}

/**
 * Time as the demo sees it. Normally it is real time, optionally sped up.
 * Inside `replay`, time is simulated: every wait completes immediately, in the
 * order it would have in real life, and the clock jumps forward accordingly.
 * That is how the demo opens with sessions that "happened earlier today",
 * with believable timestamps and durations, without making anyone wait.
 */
export class DemoTime {
  /** Real-time speed-up factor for the scripted council (1 = real time). */
  speed = 1;
  private simulatedNow: number | null = null;
  private sleepers: Sleeper[] = [];
  private stepScheduled = false;

  readonly clock: Clock = () => new Date(this.now());

  readonly pace: Pace = (ms) => {
    if (this.simulatedNow === null) return new Promise((resolve) => setTimeout(resolve, ms / this.speed));
    return new Promise((wake) => {
      this.sleepers.push({ wakeAt: this.simulatedNow! + ms, wake });
      this.scheduleStep();
    });
  };

  now(): number {
    return this.simulatedNow ?? Date.now();
  }

  /** Runs `work` in simulated time starting at `startAt` (epoch milliseconds). */
  async replay(startAt: number, work: () => Promise<void>): Promise<void> {
    if (this.simulatedNow !== null) throw new Error("A replay is already running");
    this.simulatedNow = startAt;
    try {
      await work();
    } finally {
      this.simulatedNow = null;
      this.sleepers.splice(0).forEach((sleeper) => sleeper.wake());
    }
  }

  /**
   * Wakes the earliest sleeper on the next macrotask. By then everything that
   * was runnable has run and registered its own waits, so wake-ups happen in
   * simulated-time order.
   */
  private scheduleStep(): void {
    if (this.stepScheduled) return;
    this.stepScheduled = true;
    setTimeout(() => {
      this.stepScheduled = false;
      if (this.simulatedNow === null || this.sleepers.length === 0) return;
      const next = this.sleepers.reduce((earliest, sleeper) => (sleeper.wakeAt < earliest.wakeAt ? sleeper : earliest));
      this.sleepers = this.sleepers.filter((sleeper) => sleeper !== next);
      this.simulatedNow = Math.max(this.simulatedNow, next.wakeAt);
      next.wake();
      if (this.sleepers.length > 0) this.scheduleStep();
    }, 0);
  }
}
