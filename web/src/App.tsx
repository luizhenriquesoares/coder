import { useEffect, useMemo, useState } from "react";
import { refKey } from "../../src/domain/change/types.js";
import type { Engine, Finding, Language, Patch } from "../../src/domain/deliberation/model.js";
import type { Workspace } from "./api/createApi.js";
import { ActivityBar, Dock, type Pane, type SideView } from "./components/ActivityBar.js";
import { BottomPanel, type BottomTab } from "./components/BottomPanel.js";
import type { CardContext } from "./components/cards.js";
import { CouncilPanel, type CouncilTab } from "./components/CouncilPanel.js";
import { Notice, ShortcutsDialog, TokenDialog } from "./components/dialogs.js";
import { EditorTabs } from "./components/EditorTabs.js";
import { FileView, type DiffMode } from "./components/FileView.js";
import { Overview } from "./components/Overview.js";
import { EmptyState } from "./components/primitives.js";
import { SidePanel } from "./components/SidePanel.js";
import { StatusBar } from "./components/StatusBar.js";
import { TitleBar } from "./components/TitleBar.js";
import type { EditorTheme } from "./editor/monaco.js";
import { STRINGS } from "./state/i18n.js";
import { decisionsOpen } from "../../src/domain/deliberation/state.js";
import { choiceFor, findingsInReadingOrder, stepThrough, toggleSelection } from "./state/selectors.js";
import { useMediaQuery, useStoredFlag } from "./state/useUi.js";
import { useWorkspace } from "./state/useWorkspace.js";

export interface AppProps {
  readonly workspace: Workspace;
  readonly language: Language;
  onLanguageChange(language: Language): void;
  readonly theme: EditorTheme;
  onToggleTheme(): void;
}

/** Below this width the workbench shows one pane at a time. Mirrors the breakpoint in app.css. */
const SINGLE_PANE = "(max-width: 980px)";

export function App({ workspace, language, onLanguageChange, theme, onToggleTheme }: AppProps) {
  const t = STRINGS[language];
  const [model, actions] = useWorkspace(workspace.api, language);
  const { detail, session } = model;
  const singlePane = useMediaQuery(SINGLE_PANE);

  const [sideView, setSideView] = useState<SideView>("pulls");
  const [pane, setPane] = useState<Pane>("main");
  const [tabs, setTabs] = useState<readonly string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("pr");
  const [sideBySide, setSideBySide] = useStoredFlag("coder.sideBySide", true);
  const [collapseUnchanged, setCollapseUnchanged] = useStoredFlag("coder.collapseUnchanged", true);
  const [councilTab, setCouncilTab] = useState<CouncilTab>("session");
  const [bottom, setBottom] = useState<BottomTab | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [demoSpeed, setDemoSpeed] = useState(() => workspace.demoSpeed?.get() ?? 1);

  // A different pull request is a different desk: its own tabs, nothing selected.
  const selectedKey = model.selected ? refKey(model.selected) : null;
  useEffect(() => {
    setTabs([]);
    setActivePath(null);
  }, [selectedKey]);
  useEffect(() => {
    setSelectedFindingId(null);
    setDiffMode("pr");
  }, [selectedKey, model.sessionId]);

  // The debate about a finding is in the chamber: bring it forward with the selection.
  useEffect(() => {
    if (selectedFindingId) setCouncilTab("findings");
  }, [selectedFindingId]);

  const openFile = (path: string) => {
    setTabs((open) => (open.includes(path) ? open : [...open, path]));
    setActivePath(path);
  };
  const closeTab = (path: string) => {
    const remaining = tabs.filter((open) => open !== path);
    setTabs(remaining);
    if (activePath === path) setActivePath(remaining[Math.max(0, tabs.indexOf(path) - 1)] ?? null);
  };
  const showOverview = () => {
    setActivePath(null);
    setPane("main");
  };

  /** Selecting a finding takes the editor to it; selecting it again lets go of it. */
  const selectFinding = (id: string) => {
    const next = toggleSelection(selectedFindingId, id);
    setSelectedFindingId(next);
    if (!next) return;
    const path = session?.findings.find((finding) => finding.id === id)?.location.path;
    if (path) {
      setDiffMode("pr");
      openFile(path);
    }
  };
  const showInCode = (finding: Finding) => {
    setSelectedFindingId(finding.id);
    if (!finding.location.path) return;
    setDiffMode("pr");
    openFile(finding.location.path);
    setPane("main");
  };
  const previewPatch = (patch: Patch) => {
    setDiffMode("patched");
    openFile(patch.path);
    setPane("main");
  };
  const decide = (kind: "finding" | "patch", id: string, action: "accept" | "dismiss") =>
    void actions.decide({ target: { kind, id }, action });
  const convene = (engine?: Engine) => {
    setCouncilTab("session");
    setPane("council");
    void actions.convene(engine);
  };
  const changeDemoSpeed = (value: number) => {
    workspace.demoSpeed?.set(value);
    setDemoSpeed(value);
  };

  const canDecide = session !== null && decisionsOpen(session);
  const cards: CardContext | null = session
    ? {
        state: session,
        t,
        language,
        readOnly: !canDecide,
        onDecide: decide,
        onSelectFinding: selectFinding,
        onShowInCode: showInCode,
        onPreviewPatch: previewPatch,
      }
    : null;

  const reading = useMemo(() => (session ? findingsInReadingOrder(session) : []), [session]);
  const stepFinding = (step: 1 | -1) => {
    const next = stepThrough(reading, selectedFindingId, step);
    if (next) showInCode(next);
  };

  // Keyboard first, like an editor. Keys are ignored while the person types in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const inEditor = target?.closest?.(".monaco-editor") != null;
      if (!inEditor && target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      const handlers: Record<string, () => void> = {
        n: () => stepFinding(1),
        p: () => stepFinding(-1),
        a: () => canDecide && selectedFindingId && decide("finding", selectedFindingId, "accept"),
        d: () => canDecide && selectedFindingId && decide("finding", selectedFindingId, "dismiss"),
        o: showOverview,
        l: () => setBottom((open) => (open === "log" ? null : "log")),
        "?": () => setShowShortcuts((open) => !open),
        Escape: () => (showShortcuts ? setShowShortcuts(false) : setSelectedFindingId(null)),
      };
      const handler = handlers[event.key];
      if (!handler) return;
      // The read-only editor would otherwise answer a letter with "cannot edit".
      if (event.key !== "Escape") event.preventDefault();
      if (inEditor) event.stopPropagation();
      handler();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (model.needsToken && workspace.apiToken) {
    const { apiToken } = workspace;
    return (
      <div className="coder shell shell--blank" data-theme={theme} lang={language}>
        <TokenDialog
          t={t}
          onSubmit={(token) => {
            apiToken.set(token);
            actions.reload();
          }}
        />
      </div>
    );
  }
  if (!model.config) {
    return (
      <div className="coder shell shell--blank" data-theme={theme} lang={language}>
        {model.loadError ? (
          <EmptyState title={model.loadError} icon="alert">
            <button type="button" className="btn" onClick={actions.reload}>
              {t.retry}
            </button>
          </EmptyState>
        ) : (
          <EmptyState title={t.loading} />
        )}
      </div>
    );
  }

  const activeFile = activePath ? (detail?.files.find((file) => file.path === activePath) ?? null) : null;
  const stale = Boolean(session && detail && session.pullRequest.headSha !== detail.pullRequest.headSha);
  const canPublish = model.selected?.provider === "demo" || model.config.github.canPublish;
  const selectedFinding = session?.findings.find((finding) => finding.id === selectedFindingId) ?? null;
  const pendingDecision = selectedFinding && session ? choiceFor(session, "finding", selectedFinding.id) : null;

  return (
    <div className="coder shell" data-theme={theme} data-pane={pane} data-side={sideView} lang={language}>
      <TitleBar
        t={t}
        language={language}
        onLanguageChange={onLanguageChange}
        theme={theme}
        onToggleTheme={onToggleTheme}
        config={model.config}
        pullRequest={detail?.pullRequest ?? null}
        demoSpeed={workspace.demoSpeed ? demoSpeed : null}
        onDemoSpeed={changeDemoSpeed}
        onShowShortcuts={() => setShowShortcuts(true)}
      />

      <div className="workbench">
        <ActivityBar
          t={t}
          view={sideView}
          onView={setSideView}
          findingCount={session?.findings.length ?? 0}
          logOpen={bottom !== null}
          onToggleLog={() => setBottom((open) => (open ? null : "log"))}
          onShowShortcuts={() => setShowShortcuts(true)}
        />

        <aside className="side" aria-label={t[sideView === "pulls" ? "viewPulls" : sideView === "files" ? "viewFiles" : "viewFindings"]}>
          <SidePanel
            t={t}
            language={language}
            view={sideView}
            config={model.config}
            inbox={model.inbox}
            selected={model.selected}
            onSelectPullRequest={(ref) => {
              actions.select(ref);
              showOverview();
            }}
            importing={model.busy === "importing"}
            onImport={actions.importPullRequest}
            detail={detail}
            session={session}
            activePath={activePath}
            onOpenFile={(path) => {
              openFile(path);
              setPane("main");
            }}
            selectedFindingId={selectedFindingId}
            onSelectFinding={(finding) => (singlePane ? showInCode(finding) : selectFinding(finding.id))}
          />
        </aside>

        <main className="stage">
          <EditorTabs t={t} tabs={tabs} activePath={activePath} session={session} onOpen={setActivePath} onClose={closeTab} />
          <div className="stage__body">
            {model.detailError ? (
              <EmptyState title={model.detailError} icon="alert" />
            ) : !detail ? (
              <EmptyState title={model.selected ? t.loading : t.noPulls} />
            ) : activeFile ? (
              <FileView
                key={activeFile.path}
                api={workspace.api}
                t={t}
                theme={theme}
                detail={detail}
                file={activeFile}
                session={session}
                cards={cards}
                sideBySide={sideBySide}
                onSideBySide={setSideBySide}
                collapseUnchanged={collapseUnchanged}
                onCollapseUnchanged={setCollapseUnchanged}
                diffMode={diffMode}
                onDiffMode={setDiffMode}
                selectedFindingId={selectedFindingId}
                onSelectFinding={setSelectedFindingId}
                compact={singlePane}
              />
            ) : (
              <Overview
                t={t}
                language={language}
                config={model.config}
                detail={detail}
                session={session}
                stale={stale}
                convening={model.busy === "convening"}
                onConvene={convene}
                onOpenFile={openFile}
              />
            )}
          </div>
          {bottom ? (
            <BottomPanel t={t} language={language} tab={bottom} onTab={setBottom} onClose={() => setBottom(null)} events={model.events} plan={model.plan} />
          ) : null}
        </main>

        <aside className="chamber" aria-label={t.viewCouncil}>
          <CouncilPanel
            t={t}
            language={language}
            config={model.config}
            detail={detail}
            session={session}
            cards={cards}
            tab={councilTab}
            onTab={setCouncilTab}
            selectedFindingId={selectedFindingId}
            convening={model.busy === "convening"}
            onConvene={convene}
            plan={model.plan}
            stale={stale}
            canPublish={canPublish}
            publishing={model.busy === "publishing"}
            onPublish={() => void actions.publish()}
            onPreviewPublication={() => setBottom("publication")}
          />
        </aside>
      </div>

      <StatusBar
        t={t}
        language={language}
        session={session}
        selectedFinding={selectedFinding}
        selectedChoice={pendingDecision}
        logOpen={bottom !== null}
        onToggleLog={() => setBottom((open) => (open ? null : "log"))}
      />
      <Dock t={t} pane={pane} view={sideView} findingCount={session?.findings.length ?? 0} inSession={session?.status === "in_progress"} onPane={setPane} onView={setSideView} />

      {showShortcuts ? <ShortcutsDialog t={t} onClose={() => setShowShortcuts(false)} /> : null}
      {model.notice ? <Notice t={t} message={model.notice} onDismiss={actions.dismissNotice} /> : null}
    </div>
  );
}
