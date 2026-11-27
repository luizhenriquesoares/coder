import type { Strings } from "../state/i18n.js";
import { Icon, type IconName } from "./primitives.js";

export type SideView = "pulls" | "files" | "findings";
/** On a narrow screen the workbench shows one of its three panes at a time. */
export type Pane = "side" | "main" | "council";

const VIEWS: readonly { id: SideView; icon: IconName; label: keyof Pick<Strings, "viewPulls" | "viewFiles" | "viewFindings"> }[] = [
  { id: "pulls", icon: "pulls", label: "viewPulls" },
  { id: "files", icon: "files", label: "viewFiles" },
  { id: "findings", icon: "findings", label: "viewFindings" },
];

export interface ActivityBarProps {
  readonly t: Strings;
  readonly view: SideView;
  onView(view: SideView): void;
  readonly findingCount: number;
  readonly logOpen: boolean;
  onToggleLog(): void;
  onShowShortcuts(): void;
}

/** The rail on the far left: picks what the explorer shows. */
export function ActivityBar({ t, view, onView, findingCount, logOpen, onToggleLog, onShowShortcuts }: ActivityBarProps) {
  return (
    <nav className="activity" aria-label={t.viewFiles}>
      {VIEWS.map(({ id, icon, label }) => (
        <button
          key={id}
          type="button"
          className={`activity__item${view === id ? " is-active" : ""}`}
          aria-pressed={view === id}
          aria-label={t[label]}
          title={t[label]}
          onClick={() => onView(id)}
        >
          <Icon name={icon} size={22} />
          {id === "findings" && findingCount > 0 ? <span className="activity__badge">{findingCount}</span> : null}
        </button>
      ))}
      <span className="activity__spacer" />
      <button
        type="button"
        className={`activity__item${logOpen ? " is-active" : ""}`}
        aria-pressed={logOpen}
        aria-label={t.sessionLog}
        title={t.sessionLog}
        onClick={onToggleLog}
      >
        <Icon name="terminal" size={22} />
      </button>
      <button type="button" className="activity__item" aria-label={t.shortcuts} title={t.shortcuts} onClick={onShowShortcuts}>
        <Icon name="help" size={22} />
      </button>
    </nav>
  );
}

export interface DockProps {
  readonly t: Strings;
  readonly pane: Pane;
  readonly view: SideView;
  readonly findingCount: number;
  readonly inSession: boolean;
  onPane(pane: Pane): void;
  onView(view: SideView): void;
}

/** Narrow screens: the same destinations as the rail and the panes, along the bottom edge. */
export function Dock({ t, pane, view, findingCount, inSession, onPane, onView }: DockProps) {
  const go = (nextPane: Pane, nextView?: SideView) => () => {
    if (nextView) onView(nextView);
    onPane(nextPane);
  };
  const onSide = (id: SideView) => pane === "side" && (id === "pulls" ? view === "pulls" : view !== "pulls");
  return (
    <nav className="dock" aria-label={t.product}>
      <button type="button" className={onSide("pulls") ? "is-active" : ""} aria-pressed={onSide("pulls")} onClick={go("side", "pulls")}>
        <Icon name="pulls" size={20} />
        <span>{t.viewPulls}</span>
      </button>
      <button type="button" className={onSide("files") ? "is-active" : ""} aria-pressed={onSide("files")} onClick={go("side", "files")}>
        <Icon name="files" size={20} />
        <span>{t.viewFiles}</span>
      </button>
      <button type="button" className={pane === "main" ? "is-active" : ""} aria-pressed={pane === "main"} onClick={go("main")}>
        <Icon name="code" size={20} />
        <span>{t.viewCode}</span>
      </button>
      <button type="button" className={pane === "council" ? "is-active" : ""} aria-pressed={pane === "council"} onClick={go("council")}>
        <Icon name="council" size={20} />
        <span>{t.viewCouncil}</span>
        {inSession ? <span className="dock__live" aria-hidden="true" /> : findingCount > 0 ? <span className="dock__badge">{findingCount}</span> : null}
      </button>
    </nav>
  );
}
