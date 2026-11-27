import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedReview } from "../src/application/ports.js";
import { createStandaloneApplication } from "../src/composition/standalone.js";
import { decisionsOpen, levelOf } from "../src/domain/deliberation/state.js";
import { DemoSourceControl } from "../src/infrastructure/demo/DemoSourceControl.js";
import { instantPace } from "../src/infrastructure/demo/ScriptedCouncil.js";

const storefront = { provider: "demo", owner: "acme", repo: "storefront", number: 131 } as const;

async function concluded() {
  const app = createStandaloneApplication({ pace: instantPace });
  const { sessionId } = await app.application.startReview(storefront, { language: "en" });
  await app.conductReview.whenSettled(sessionId);
  const state = await app.application.session(sessionId);
  return { ...app, sessionId, finding: state.findings[0]!.id };
}

afterEach(() => vi.restoreAllMocks());

describe("publishing records its intent before it acts", () => {
  it("refuses a decision, and a second publication, while the review is in flight", async () => {
    const { application, store, sessionId, finding } = await concluded();
    const held = Promise.withResolvers<PublishedReview>();
    vi.spyOn(DemoSourceControl.prototype, "publishReview").mockReturnValue(held.promise);

    const publishing = application.publish(sessionId);
    await vi.waitFor(async () => expect((await store.load(sessionId)).at(-1)!.type).toBe("PublicationStarted"));
    const inFlight = await application.session(sessionId);
    expect(inFlight).toMatchObject({ publishing: true, publicationFailure: null });
    expect(decisionsOpen(inFlight)).toBe(false);

    await expect(application.decide(sessionId, { target: { kind: "finding", id: finding }, action: "dismiss" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/being published/),
    });
    await expect(application.publish(sessionId)).rejects.toMatchObject({ code: "conflict" });

    held.resolve({ url: "https://example.test/review", decision: "comment", inlineComments: 1, simulated: true });
    const published = await publishing;
    expect(published).toMatchObject({ publishing: false, publication: { decision: "comment" } });
    expect((await store.load(sessionId)).map((event) => event.type).slice(-2)).toEqual(["PublicationStarted", "ReviewPublished"]);
  });

  it("leaves a failed publication publishable again, with the reason in the state", async () => {
    const { application, sessionId, finding } = await concluded();
    vi.spyOn(DemoSourceControl.prototype, "publishReview").mockRejectedValueOnce(new Error("GitHub is down"));

    await expect(application.publish(sessionId)).rejects.toThrow("GitHub is down");
    const failed = await application.session(sessionId);
    expect(failed).toMatchObject({ publishing: false, publicationFailure: "GitHub is down", publication: null });
    expect(decisionsOpen(failed)).toBe(true);
    await application.decide(sessionId, { target: { kind: "finding", id: finding }, action: "dismiss" });

    vi.restoreAllMocks();
    const published = await application.publish(sessionId);
    expect(published).toMatchObject({ publishing: false, publicationFailure: null, publication: { simulated: true } });
  });

  it("shows in the inbox how the review was published, not only what the council asked for", async () => {
    const { application, conductReview } = createStandaloneApplication({ pace: instantPace });
    const { sessionId } = await application.startReview({ ...storefront, number: 128 }, { language: "en" });
    await conductReview.whenSettled(sessionId);
    const latest = async () => (await application.inbox()).items.find((item) => item.latestSession?.sessionId === sessionId)!.latestSession!;
    expect((await latest()).decision).toBe("request_changes");

    const state = await application.session(sessionId);
    const grounds = state.findings.filter((f) => levelOf(state, f) === "endorsed" && (f.severity === "blocker" || f.severity === "major"));
    for (const finding of grounds) await application.decide(sessionId, { target: { kind: "finding", id: finding.id }, action: "dismiss" });
    expect((await latest()).decision).toBe("request_changes"); // still the verdict: nothing was published yet

    await application.publish(sessionId);
    expect(await latest()).toMatchObject({ decision: "comment", published: true });
  });
});
