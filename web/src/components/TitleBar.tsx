import type { AppConfig, PullRequestDetail } from "../../../src/application/api.js";
import { LANGUAGES, type Language } from "../../../src/domain/deliberation/model.js";
import type { EditorTheme } from "../editor/monaco.js";
import type { Strings } from "../state/i18n.js";
import { Icon } from "./primitives.js";

/** A round table: the four panelists' seats around the change they are reviewing. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="brand__mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      <circle cx="12" cy="4.75" r="2.4" fill="#4FC1FF" />
      <circle cx="19.25" cy="12" r="2.4" fill="#F2A65A" />
      <circle cx="12" cy="19.25" r="2.4" fill="#B48EF5" />
      <circle cx="4.75" cy="12" r="2.4" fill="#4EC9B0" />
      <path d="m9.9 12.2 1.5 1.5 2.8-3.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SPEEDS = [1, 2, 4, 8] as const;

export interface TitleBarProps {
  readonly t: Strings;
  readonly language: Language;
  onLanguageChange(language: Language): void;
  readonly theme: EditorTheme;
  onToggleTheme(): void;
  readonly config: AppConfig;
  readonly pullRequest: PullRequestDetail["pullRequest"] | null;
  /** Standalone demo only. */
  readonly demoSpeed: number | null;
  onDemoSpeed(value: number): void;
  onShowShortcuts(): void;
}

export function TitleBar(props: TitleBarProps) {
  const { t, language, theme, config, pullRequest, demoSpeed } = props;
  return (
    <header className="titlebar">
      <div className="brand">
        <BrandMark />
        <span className="brand__name">CodeR</span>
        <span className="brand__tag">{t.product}</span>
      </div>

      <div className="crumbs">
        {pullRequest ? (
          <>
            <span className="crumbs__repo">
              {pullRequest.ref.owner}/{pullRequest.ref.repo}
            </span>
            <Icon name="chevronRight" size={14} />
            <span className="crumbs__pr">
              <span className="crumbs__number">#{pullRequest.ref.number}</span> {pullRequest.title}
            </span>
          </>
        ) : null}
      </div>

      <div className="titlebar__tools">
        <span className={`mode mode--${config.mode}`}>
          <span className="mode__dot" aria-hidden="true" />
          <span className="mode__text">{config.mode === "standalone" ? t.demoMode : t.serverMode}</span>
        </span>
        {demoSpeed === null ? null : (
          <label className="speed" title={t.demoSpeed}>
            <Icon name="bolt" size={14} />
            <span className="visually-hidden">{t.demoSpeed}</span>
            <select value={demoSpeed} onChange={(event) => props.onDemoSpeed(Number(event.target.value))}>
              {SPEEDS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="segmented" role="group" aria-label={t.language}>
          {LANGUAGES.map((code) => (
            <button key={code} type="button" aria-pressed={language === code} onClick={() => props.onLanguageChange(code)}>
              {code.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="iconbtn"
          title={theme === "dark" ? t.lightTheme : t.darkTheme}
          aria-label={theme === "dark" ? t.lightTheme : t.darkTheme}
          onClick={props.onToggleTheme}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
        <button type="button" className="iconbtn titlebar__help" title={t.shortcuts} aria-label={t.shortcuts} onClick={props.onShowShortcuts}>
          <Icon name="help" />
        </button>
      </div>
    </header>
  );
}
