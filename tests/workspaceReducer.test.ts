import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../src/domain/deliberation/events.js";
import { decisionsOpen } from "../src/domain/deliberation/state.js";
import { INITIAL_MODEL, isConflict, loadFile, reduceWorkspace, type WorkspaceAction, type WorkspaceModel } from "../web/src/state/useWorkspace.js";
import { COUPON, concludedDemoSession } from "./support/demoSession.js";

const replay = (model: WorkspaceModel, events: readonly DomainEvent[]) =>
  events.reduce((current, event) => reduceWorkspace(current, { type: "event", event }), model);

const run = (model: WorkspaceModel, ...actions: WorkspaceAction[]) => actions.reduce(reduceWorkspace, model);

describe("the workspace reducer", () => {
  it("folds a session's events into the same state as the server, and a second replay changes nothing", async () => {
    const { sessionId, events, state } = await concludedDemoSession();
    const opened = run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "sessionOpened", ref: COUPON, sessionId });
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
    const opened = run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "sessionOpened", ref: COUPON, sessionId: mine.sessionId });
    expect(replay(opened, other.events)).toBe(opened);
    const live = replay(opened, mine.events);
    expect(replay(live, other.events)).toBe(live);
  });

  it("keeps the reason a publication preview failed, until a preview arrives", async () => {
    const { application, sessionId } = await concludedDemoSession();
    const plan = await application.publicationPreview(sessionId);
    const opened = run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "sessionOpened", ref: COUPON, sessionId });
    const failed = run(opened, { type: "planFailed", sessionId, message: "The pull request has new commits since this review." });
    expect(failed).toMatchObject({ plan: null, planError: "The pull request has new commits since this review." });
    expect(run(failed, { type: "plan", sessionId, plan })).toMatchObject({ plan, planError: null });
    expect(run(opened, { type: "planFailed", sessionId: "another", message: "no" })).toBe(opened);
  });

  it("shows a publication under way, and why it failed, from the events alone (as after a reload)", async () => {
    const { sessionId, events } = await concludedDemoSession();
    const last = events.at(-1)!;
    const next = (seq: number, type: "PublicationStarted" | "PublicationFailed", payload: object) =>
      ({ sessionId, seq, at: last.at, type, payload }) as DomainEvent;
    const opened = replay(run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "sessionOpened", ref: COUPON, sessionId }), events);
    expect(decisionsOpen(opened.session!)).toBe(true);

    const started = replay(opened, [next(last.seq + 1, "PublicationStarted", {})]);
    expect(started.session).toMatchObject({ publishing: true, publicationFailure: null });
    expect(decisionsOpen(started.session!)).toBe(false);

    const failed = replay(started, [next(last.seq + 2, "PublicationFailed", { reason: "GitHub refused the review" })]);
    expect(failed.session).toMatchObject({ publishing: false, publicationFailure: "GitHub refused the review" });
    expect(decisionsOpen(failed.session!)).toBe(true);
  });

  it("does not open a session convened for a pull request that is no longer on screen", async () => {
    const { sessionId, events } = await concludedDemoSession();
    const other = { ...COUPON, number: 131 };
    const elsewhere = run(INITIAL_MODEL, { type: "selected", ref: COUPON }, { type: "selected", ref: other });
    expect(run(elsewhere, { type: "sessionOpened", ref: COUPON, sessionId })).toBe(elsewhere);

    // Even with the id in hand, a stream that convenes on another pull request is not drawn.
    const wrongId = { ...elsewhere, sessionId };
    expect(replay(wrongId, events)).toBe(wrongId);
  });
});

describe("reading a file", () => {
  it("asks for the commit the pull request was loaded at, and meets a conflict once it moved on", async () => {
    const { application, state } = await concludedDemoSession();
    const path = state.findings[0]!.location.path!;
    const contents = await loadFile(application, COUPON, state.pullRequest.headSha, path);
    expect(contents.modified.length).toBeGreaterThan(0);

    const asked: (string | undefined)[] = [];
    const spy = { ...application, fileContents: (ref, file, headSha) => (asked.push(headSha), application.fileContents(ref, file, headSha)) } as typeof application;
    const error = await loadFile(spy, COUPON, "an-older-commit", path).catch((reason: unknown) => reason);
    expect(asked).toEqual(["an-older-commit"]);
    expect(isConflict(error)).toBe(true);
    expect(isConflict(new Error("boom"))).toBe(false);
  });
});

