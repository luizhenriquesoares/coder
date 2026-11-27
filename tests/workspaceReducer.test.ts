import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { INITIAL_MODEL, reduceWorkspace, type WorkspaceAction, type WorkspaceModel } from "../web/src/state/useWorkspace.js";
import { COUPON, concludedDemoSession } from "./support/demoSession.js";

const replay = (model: WorkspaceModel, events: readonly DomainEvent[]) =>
  events.reduce((current, event) => reduceWorkspace(current, { type: "event", event }), model);

const run = (model: WorkspaceModel, ...actions: WorkspaceAction[]) => actions.reduce(reduceWorkspace, model);

describe("the workspace reducer", () => {
  it("folds a session's events into the same state as the server, and a second replay changes nothing", async () => {
    const { sessionId, events, state } = await concludedDemoSession();
    const opened = run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "sessionOpened", sessionId });
    const once = replay(opened, events);
    expect(once.session).toEqual(state);
    expect(once.events).toHaveLength(events.length);

    const twice = replay(once, events);
    expect(twice).toBe(once);
  });

  it("ignores the events of another session", async () => {
    const mine = await concludedDemoSession();
    const other = await concludedDemoSession();
    expect(other.sessionId).not.toBe(mine.sessionId);
    const opened = run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "sessionOpened", sessionId: mine.sessionId });
    expect(replay(opened, other.events)).toBe(opened);
    const live = replay(opened, mine.events);
    expect(replay(live, other.events)).toBe(live);
  });
});
