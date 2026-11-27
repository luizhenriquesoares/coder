import type { SessionState } from "../../../src/domain/deliberation/state.js";
import type { Strings } from "../state/i18n.js";
import { fileName, findingsOfFile, worstSeverity } from "../state/selectors.js";
import { Icon } from "./primitives.js";

export interface EditorTabsProps {
  readonly t: Strings;
  readonly tabs: readonly string[];
  /** `null` is the overview of the pull request. */
  readonly activePath: string | null;
  readonly session: SessionState | null;
  onOpen(path: string | null): void;
  onClose(path: string): void;
}

export function EditorTabs({ t, tabs, activePath, session, onOpen, onClose }: EditorTabsProps) {
  return (
    <div className="tabs" role="tablist">
      <div className={`tab${activePath === null ? " is-active" : ""}`}>
        <button type="button" role="tab" aria-selected={activePath === null} className="tab__open" onClick={() => onOpen(null)}>
          <Icon name="council" size={15} />
          {t.overview}
        </button>
      </div>
      {tabs.map((path) => {
        const findings = findingsOfFile(session, path);
        const worst = worstSeverity(findings);
        const active = path === activePath;
        return (
          <div key={path} className={`tab${active ? " is-active" : ""}`}>
            <button type="button" role="tab" aria-selected={active} className="tab__open" title={path} onClick={() => onOpen(path)}>
              <Icon name="code" size={15} />
              {fileName(path)}
              {worst ? <span className={`count count--${worst}`}>{findings.length}</span> : null}
            </button>
            <button type="button" className="tab__close" aria-label={`${t.close}: ${fileName(path)}`} title={t.close} onClick={() => onClose(path)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
