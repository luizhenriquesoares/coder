import type { Logger } from "./ports.js";
import type { SessionRepository } from "./SessionRepository.js";

export const INTERRUPTED_BY_RESTART = "The server restarted while the council was in session. Convene the council again.";
export const PUBLICATION_INTERRUPTED =
  "The server stopped while this review was being published. Check the pull request before publishing again.";

/**
 * At boot, nothing is deliberating or publishing yet: a stored session that
 * still says so was interrupted by a stop or a crash. Each one gets an outcome,
 * so it can be convened or published again instead of hanging in mid-air.
 */
export async function reconcileInterruptedSessions(sessions: SessionRepository, logger: Logger): Promise<void> {
  for (const state of await sessions.allStates()) {
    if (state.status !== "in_progress" && !state.publishing) continue;
    const session = await sessions.get(state.id);
    if (state.status === "in_progress") session.fail(INTERRUPTED_BY_RESTART);
    else session.failPublication(PUBLICATION_INTERRUPTED);
    await sessions.save(session);
    logger.warn(state.status === "in_progress" ? "Failed a session interrupted by a restart" : "Failed a publication interrupted by a restart", {
      sessionId: state.id,
    });
  }
}
