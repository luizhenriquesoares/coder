import type { ReactNode } from "react";
import type { RiskLevel } from "../../../src/domain/change/riskAssessment.js";
import type { ConsensusLevel, ReviewerId, Severity } from "../../../src/domain/deliberation/model.js";
import { PERSONAS } from "../../../src/domain/deliberation/personas.js";
import type { Strings } from "../state/i18n.js";

/** Stroke icons drawn on a 24-unit grid. Each entry is the inside of an <svg>. */
const ICONS = {
  pulls: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-3m0 0 2.5-2.5M12 7l2.5 2.5" />
    </>
  ),
  files: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  findings: (
    <>
      <path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6z" />
      <path d="M12 8.5v4.5M12 16.5v.01" />
    </>
  ),
  council: (
    <>
      <circle cx="12" cy="7" r="3" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="4.5" cy="10" r="2" />
      <circle cx="19.5" cy="10" r="2" />
    </>
  ),
  code: <path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4M13.5 5l-3 14" />,
  play: <path d="M7 4.5v15l12-7.5z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  arrowUp: <path d="M12 19V5m0 0-6 6m6-6 6 6" />,
  arrowDown: <path d="M12 5v14m0 0 6-6m-6 6-6-6" />,
  external: <path d="M9 6h9v9M18 6 7 17" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  send: <path d="M4 12 20 4l-5 16-3.5-6.5zM11.5 13.5 20 4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 14.5H17" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: <path d="M12 4 2.5 20h19zM12 10v4.5M12 17.5v.01" />,
  columns: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M12 4.5v15" />
    </>
  ),
  rows: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 12h18" />
    </>
  ),
  fold: <path d="M4 12h16M8 5l4 4 4-4M8 19l4-4 4 4" />,
  patch: <path d="M14.5 5.5a4 4 0 0 0-5.3 5.3L4 16l4 4 5.2-5.2a4 4 0 0 0 5.3-5.3L16 12l-4-4z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 16.5v.01" />
    </>
  ),
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

/** A council member's seat marker: initials on the persona's colour. */
export function Avatar({ reviewer, size = "md", active = false }: { reviewer: ReviewerId; size?: "sm" | "md" | "lg"; active?: boolean }) {
  const persona = PERSONAS[reviewer];
  return (
    <span className={`avatar avatar--${size}${active ? " avatar--active" : ""}`} style={{ "--seat": persona.color } as React.CSSProperties} aria-hidden="true">
      {persona.initials}
    </span>
  );
}

export function SeverityMark({ severity, t, compact = false }: { severity: Severity; t: Strings; compact?: boolean }) {
  return (
    <span className={`sev sev--${severity}`} title={t.severity[severity]}>
      <span className="sev__bar" aria-hidden="true" />
      {compact ? <span className="visually-hidden">{t.severity[severity]}</span> : t.severity[severity]}
    </span>
  );
}

export function LevelChip({ level, t, tally }: { level: ConsensusLevel; t: Strings; tally?: string }) {
  return (
    <span className={`chip chip--level chip--${level}`}>
      <span className="chip__dot" aria-hidden="true" />
      {t.level[level]}
      {tally ? <span className="chip__extra">{tally}</span> : null}
    </span>
  );
}

export function RiskChip({ level, t, score }: { level: RiskLevel; t: Strings; score?: number }) {
  return (
    <span className={`chip chip--risk chip--risk-${level}`}>
      {t.risk[level]}
      {score === undefined ? null : <span className="chip__extra">{score}</span>}
    </span>
  );
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diffstat">
      <span className="diffstat__add">+{additions}</span>
      <span className="diffstat__del">−{deletions}</span>
    </span>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={28} /> : null}
      <p className="empty__title">{title}</p>
      {children ? <div className="empty__body">{children}</div> : null}
    </div>
  );
}
