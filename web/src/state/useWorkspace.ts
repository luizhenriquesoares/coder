import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AppConfig, CoderApi, DecisionInput, Inbox, PullRequestDetail } from "../../../src/application/api.js";
import type { FileContents, PullRequestRef } from "../../../src/domain/change/types.js";
import { refKey, revisionKey } from "../../../src/domain/change/types.js";
import type { DomainEvent } from "../../../src/domain/deliberation/events.js";
import type { Engine, Language } from "../../../src/domain/deliberation/model.js";
import type { PublicationPlan } from "../../../src/domain/deliberation/publicationPlanner.js";
import { evolve, foldEvents, type SessionState } from "../../../src/domain/deliberation/state.js";
import { ApiError } from "../api/HttpCoderApi.js";
import { STRINGS } from "./i18n.js";
import { sameRef } from "./selectors.js";

const INBOX_REFRESH_MS = 15_000;

export interface WorkspaceModel {
  readonly config: AppConfig | null;
  readonly inbox: Inbox | null;
  /** The workspace could not load at all (server down, or it wants a token). */
  readonly loadError: string | null;
  readonly needsToken: boolean;
  readonly selected: PullRequestRef | null;
  readonly detail: PullRequestDetail | null;
  readonly detailError: string | null;
  readonly sessionId: string | null;
  /** Counts the times the open session was (re)opened: each one follows its stream again from the start. */
  readonly subscription: number;
  readonly session: SessionState | null;
  /** The live stream of the open session ended for good, and why. */
  readonly streamLost: string | null;
  readonly events: readonly DomainEvent[];
  readonly plan: PublicationPlan | null;
  /** Why the publication preview could not be prepared. */
  readonly planError: string | null;
  readonly busy: "convening" | "publishing" | "importing" | null;
  /** The last action that failed, shown until dismissed. */
  readonly notice: string | null;
}

export type WorkspaceAction =
  | { type: "loaded"; config: AppConfig; inbox: Inbox }
  | { type: "loadFailed"; message: string; needsToken: boolean }
  | { type: "inbox"; inbox: Inbox }
  | { type: "selected"; ref: PullRequestRef }
  | { type: "detail"; ref: PullRequestRef; detail: PullRequestDetail; followLatest: boolean }
  | { type: "detailFailed"; ref: PullRequestRef; message: string }
  | { type: "sessionOpened"; ref: PullRequestRef; sessionId: string }
  | { type: "event"; event: DomainEvent }
  | { type: "streamLost"; sessionId: string; message: string }
  | { type: "plan"; sessionId: string; plan: PublicationPlan }
  | { type: "planFailed"; sessionId: string; message: string }
  | { type: "busy"; busy: WorkspaceModel["busy"] }
  | { type: "notice"; notice: string | null };

export const INITIAL_MODEL: WorkspaceModel = {
  config: null,
  inbox: null,
  loadError: null,
  needsToken: false,
  selected: null,
  detail: null,
  detailError: null,
  sessionId: null,
  subscription: 0,
  session: null,
  streamLost: null,
  events: [],
  plan: null,
  planError: null,
  busy: null,
  notice: null,
};

/** The pure state transition of the workspace. Exported for its tests. */
export function reduceWorkspace(model: WorkspaceModel, action: WorkspaceAction): WorkspaceModel {
  switch (action.type) {
    case "loaded":
      return { ...model, config: action.config, inbox: action.inbox, loadError: null, needsToken: false };
    case "loadFailed":
      return { ...model, loadError: action.message, needsToken: action.needsToken };
    case "inbox":
      return { ...model, inbox: action.inbox };
    case "selected":
      if (sameRef(model.selected, action.ref)) return model;
      return { ...model, selected: action.ref, detail: null, detailError: null, sessionId: null, session: null, streamLost: null, events: [], plan: null, planError: null };
    case "detail": {
      if (!sameRef(model.selected, action.ref)) return model;
      const latest = action.detail.sessions[0]?.sessionId ?? null;
      const sessionId = action.followLatest ? latest : model.sessionId;
      return sessionId === model.sessionId
        ? { ...model, detail: action.detail, detailError: null }
        : { ...model, detail: action.detail, detailError: null, sessionId, session: null, streamLost: null, events: [], plan: null, planError: null };
    }
    case "detailFailed":
      return sameRef(model.selected, action.ref) ? { ...model, detailError: action.message } : model;
    case "sessionOpened":
      // The person may have moved to another pull request while the council was being convened.
      if (!sameRef(model.selected, action.ref)) return model;
      return {
        ...model,
        sessionId: action.sessionId,
        subscription: model.subscription + 1,
        session: null,
        streamLost: null,
        events: [],
        plan: null,
        planError: null,
      };
    case "streamLost":
      return action.sessionId === model.sessionId ? { ...model, streamLost: action.message } : model;
    case "event": {
      const { event } = action;
      if (event.sessionId !== model.sessionId) return model;
      if (event.type === "ReviewSessionConvened" && !sameRef(model.selected, event.payload.pullRequest.ref)) return model;
      if (model.session && event.seq <= model.session.lastSeq) return model; // replayed after a reconnect
      const session = model.session ? evolve(model.session, event) : event.type === "ReviewSessionConvened" ? foldEvents([event]) : null;
      return session ? { ...model, session, events: [...model.events, event] } : model;
    }
    case "plan":
      return action.sessionId === model.sessionId ? { ...model, plan: action.plan, planError: null } : model;
    case "planFailed":
      return action.sessionId === model.sessionId ? { ...model, plan: null, planError: action.message } : model;
    case "busy":
      return { ...model, busy: action.busy };
    case "notice":
      return { ...model, notice: action.notice };
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface WorkspaceActions {
  reload(): void;
  select(ref: PullRequestRef): void;
  convene(engine?: Engine): Promise<void>;
  decide(decision: DecisionInput): Promise<void>;
  publish(): Promise<void>;
  importPullRequest(url: string): Promise<boolean>;
  /** Follow the open session again from its first event, after its live stream was lost. */
  reloadSession(): void;
  /** A file read found the pull request on a newer commit: reload it, and say so. */
  pullRequestMoved(): void;
  dismissNotice(): void;
}

/**
 * The workspace's connection to the application: what is loaded, which pull
 * request and session are open, and the live session state, rebuilt in the
 * browser by folding the same events the server folds.
 */
export function useWorkspace(api: CoderApi, language: Language): [WorkspaceModel, WorkspaceActions] {
  const [model, dispatch] = useReducer(reduceWorkspace, INITIAL_MODEL);
  const latest = useRef(model);
  latest.current = model;

  const load = useCallback(async () => {
    try {
      const [config, inbox] = await Promise.all([api.config(), api.inbox()]);
      dispatch({ type: "loaded", config, inbox });
    } catch (error) {
      dispatch({ type: "loadFailed", message: messageOf(error), needsToken: error instanceof ApiError && error.status === 401 });
    }
  }, [api]);

  const refreshInbox = useCallback(async () => {
    try {
      dispatch({ type: "inbox", inbox: await api.inbox() });
    } catch {
      // The next refresh will try again; a stale inbox is better than an error banner every few seconds.
    }
  }, [api]);

  useEffect(() => void load(), [load]);

  // New pull requests and automatic reviews show up without a reload.
  const serverMode = model.config?.mode === "server";
  useEffect(() => {
    if (!serverMode) return;
    const timer = setInterval(() => void refreshInbox(), INBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [serverMode, refreshInbox]);

  // Open the first pull request once the inbox arrives.
  const firstRef = model.inbox?.items[0]?.pullRequest.ref ?? null;
  useEffect(() => {
    if (!latest.current.selected && firstRef) dispatch({ type: "selected", ref: firstRef });
  }, [firstRef]);

  const loadDetail = useCallback(
    async (ref: PullRequestRef, followLatest: boolean) => {
      try {
        dispatch({ type: "detail", ref, detail: await api.pullRequest(ref), followLatest });
      } catch (error) {
        dispatch({ type: "detailFailed", ref, message: messageOf(error) });
      }
    },
    [api],
  );

  const selectedKey = model.selected ? refKey(model.selected) : null;
  useEffect(() => {
    const ref = latest.current.selected;
    if (ref) void loadDetail(ref, true);
  }, [selectedKey, loadDetail]);

  // Follow the open session's event stream from its first event.
  const { sessionId, subscription } = model;
  useEffect(() => {
    if (!sessionId) return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    api
      .subscribe(
        sessionId,
        0,
        (event) => {
          dispatch({ type: "event", event });
          if (event.type === "ReviewSessionConcluded" || event.type === "ReviewSessionFailed" || event.type === "ReviewPublished") {
            void refreshInbox();
          }
        },
        (error) => !cancelled && dispatch({ type: "streamLost", sessionId, message: messageOf(error) }),
      )
      .then(
        (stop) => (cancelled ? stop() : (unsubscribe = stop)),
        (error) => !cancelled && dispatch({ type: "notice", notice: messageOf(error) }),
      );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, sessionId, subscription]);

  // Keep the publication preview in step with the verdict and the human's decisions.
  const concluded = model.session?.status === "concluded";
  const decisions = model.session?.decisions;
  useEffect(() => {
    if (!sessionId || !concluded) return;
    let cancelled = false;
    api.publicationPreview(sessionId).then(
      (plan) => !cancelled && dispatch({ type: "plan", sessionId, plan }),
      (error) => !cancelled && dispatch({ type: "planFailed", sessionId, message: messageOf(error) }), // e.g. the pull request moved on
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, concluded, decisions]);

  const attempt = useCallback(async (busy: WorkspaceModel["busy"], action: () => Promise<void>): Promise<boolean> => {
    if (busy) dispatch({ type: "busy", busy });
    try {
      await action();
      return true;
    } catch (error) {
      dispatch({ type: "notice", notice: messageOf(error) });
      return false;
    } finally {
      if (busy) dispatch({ type: "busy", busy: null });
    }
  }, []);

  const actions: WorkspaceActions = {
    reload: () => void load(),
    select: (ref) => dispatch({ type: "selected", ref }),
    convene: async (engine) => {
      const ref = latest.current.selected;
      if (!ref) return;
      await attempt("convening", async () => {
        const started = await api.startReview(ref, { language, ...(engine ? { engine } : {}) });
        dispatch({ type: "sessionOpened", ref, sessionId: started.sessionId });
        void refreshInbox();
        void loadDetail(ref, false);
      });
    },
    decide: async (decision) => {
      const id = latest.current.sessionId;
      if (id) await attempt(null, async () => void (await api.decide(id, decision)));
    },
    publish: async () => {
      const id = latest.current.sessionId;
      if (id) await attempt("publishing", async () => void (await api.publish(id)));
    },
    importPullRequest: (url) =>
      attempt("importing", async () => {
        const ref = await api.importPullRequest(url);
        await refreshInbox();
        dispatch({ type: "selected", ref });
      }),
    reloadSession: () => {
      const { selected, sessionId: id } = latest.current;
      if (selected && id) dispatch({ type: "sessionOpened", ref: selected, sessionId: id });
    },
    pullRequestMoved: () => {
      const ref = latest.current.selected;
      if (!ref) return;
      dispatch({ type: "notice", notice: STRINGS[language].pullRequestReloaded });
      void loadDetail(ref, false);
    },
    dismissNotice: () => dispatch({ type: "notice", notice: null }),
  };
  return [model, actions];
}

/** True for an error that says the request met a newer state than the one it was made for. */
export function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "conflict";
}

/**
 * Both sides of a file at `headSha`, the commit the pull request was loaded at. Cached: a blob at a
 * commit never changes. Rejects with a conflict (`isConflict`) when the pull request has moved on.
 */
const fileCache = new Map<string, Promise<FileContents>>();

export function loadFile(api: CoderApi, ref: PullRequestRef, headSha: string, path: string): Promise<FileContents> {
  const key = `${revisionKey(ref, headSha)}:${path}`;
  let cached = fileCache.get(key);
  if (!cached) {
    cached = api.fileContents(ref, path, headSha);
    fileCache.set(key, cached);
    cached.catch(() => fileCache.delete(key));
  }
  return cached;
}
