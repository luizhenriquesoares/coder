import type { CoderApi } from "../../../src/application/api.js";
import type { PullRequestRef } from "../../../src/domain/change/types.js";
import type { Language } from "../../../src/domain/deliberation/model.js";
import { readStored, writeStored } from "../state/storage.js";
import { HttpCoderApi } from "./HttpCoderApi.js";

export interface Workspace {
  readonly api: CoderApi;
  /** Standalone only: how fast the scripted council speaks (1 = real time). */
  readonly demoSpeed: { get(): number; set(value: number): void } | null;
  /** Server only: the API token the person typed, when the server asks for one. */
  readonly apiToken: { get(): string | null; set(value: string): void } | null;
}

const TOKEN_KEY = "coder.apiToken";

/** Reviewed "earlier today" in simulated time, so the demo opens on a team's real morning. */
const REVIEWED_EARLIER: readonly { ref: PullRequestRef; minutesAgo: number }[] = [
  { ref: { provider: "demo", owner: "acme", repo: "storefront", number: 133 }, minutesAgo: 123 },
  { ref: { provider: "demo", owner: "acme", repo: "storefront", number: 131 }, minutesAgo: 37 },
];

export async function createWorkspace(language: Language): Promise<Workspace> {
  if (!__STANDALONE__) {
    let token = readStored(TOKEN_KEY);
    const apiToken = {
      get: () => token,
      set: (value: string) => {
        token = value || null;
        writeStored(TOKEN_KEY, token);
      },
    };
    return { api: new HttpCoderApi("", apiToken.get), demoSpeed: null, apiToken };
  }

  // The whole application runs in this tab: the same domain and application code as the server.
  const [{ createStandaloneApplication }, { DemoTime }] = await Promise.all([
    import("../../../src/composition/standalone.js"),
    import("../../../src/infrastructure/demo/DemoTime.js"),
  ]);
  const time = new DemoTime();
  const { application, conductReview } = createStandaloneApplication({ pace: time.pace, clock: time.clock });
  const now = Date.now();
  for (const { ref, minutesAgo } of REVIEWED_EARLIER) {
    await time.replay(now - minutesAgo * 60_000, async () => {
      await conductReview.start({ ref, language, trigger: "webhook" });
      await conductReview.whenSettled();
    });
  }
  return {
    api: application,
    demoSpeed: { get: () => time.speed, set: (value) => (time.speed = value) },
    apiToken: null,
  };
}
