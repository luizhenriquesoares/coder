import { useEffect, useState } from "react";
import type { Finding, Language } from "../../../src/domain/deliberation/model.js";
import { decisionsOpen, type SessionState } from "../../../src/domain/deliberation/state.js";
import { formatCost, formatDuration, formatTokens } from "../state/format.js";
import type { Strings } from "../state/i18n.js";
import { consensusCounts, LEVEL_ORDER, type HumanChoice } from "../state/selectors.js";
import { personaName } from "./cards.js";
import { engineLabel } from "./ConveneControl.js";
import { Icon } from "./primitives.js";

export interface StatusBarProps {
  readonly t: Strings;
  readonly language: Language;
  readonly session: SessionState | null;
  readonly selectedFinding: Finding | null;
  readonly selectedChoice: HumanChoice;
  readonly logOpen: boolean;
  onToggleLog(): void;
}

/** Time since the session started, ticking while it runs. */
function useElapsed(session: SessionState | null): number | null {
  const running = session?.status === "in_progress";
  const startedAt = session ? Date.parse(session.startedAt) : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (!session) return null;
  return session.durationMs ?? (running ? Math.max(0, now - startedAt) : null);
}

export function StatusBar({ t, language, session, selectedFinding, selectedChoice, logOpen, onToggleLog }: StatusBarProps) {
  const elapsed = useElapsed(session);
  const status = !session ? "idle" : session.status;
  const label = { idle: t.statusIdle, in_progress: t.statusInSession, concluded: t.statusConcluded, failed: t.statusFailed }[status];
  const counts = session ? consensusCounts(session) : null;
  const tokens = session ? session.usage.inputTokens + session.usage.outputTokens : 0;
  const canDecide = session !== null && decisionsOpen(session);

  return (
    <footer className="statusbar">
      <span className={`statusbar__state statusbar__state--${status}`}>
        <span className={status === "in_progress" ? "live-dot" : "statusbar__dot"} aria-hidden="true" />
        {label}
      </span>
      {session?.currentRound ? (
        <span className="statusbar__item">
          {t.round[session.currentRound]}
          {session.thinking.length > 0
            ? ` · ${session.thinking.map((reviewer) => personaName(reviewer, language)).join(", ")} ${t.working[session.currentRound]}`
            : ""}
        </span>
      ) : null}
      {selectedFinding ? (
        <span className="statusbar__item statusbar__hint">
          {selectedFinding.id}
          {selectedChoice === "accept" ? ` · ${t.acceptedByYou}` : selectedChoice === "dismiss" ? ` · ${t.dismissedByYou}` : ""}
          {canDecide ? (
            <>
              <kbd>a</kbd> {t.accept} <kbd>d</kbd> {t.dismiss}
            </>
          ) : null}
        </span>
      ) : null}

      <span className="statusbar__spacer" />

      {counts
        ? LEVEL_ORDER.filter((level) => counts[level] > 0).map((level) => (
            <span key={level} className={`statusbar__item statusbar__level statusbar__level--${level}`}>
              <span className="statusbar__dot" aria-hidden="true" />
              {counts[level]} {t.level[level].toLowerCase()}
            </span>
          ))
        : null}
      {session ? <span className="statusbar__item statusbar__engine">{engineLabel(session.engine, session.model, t)}</span> : null}
      {tokens > 0 && session ? (
        <span className="statusbar__item">
          {t.tokens(formatTokens(tokens))} · {formatCost(session.usage.costUsd)}
        </span>
      ) : null}
      {elapsed !== null ? (
        <span className="statusbar__item statusbar__time">
          <Icon name="clock" size={13} />
          {formatDuration(elapsed)}
        </span>
      ) : null}
      <button type="button" className={`statusbar__button${logOpen ? " is-on" : ""}`} aria-pressed={logOpen} onClick={onToggleLog}>
        <Icon name="terminal" size={13} />
        {t.sessionLog}
      </button>
    </footer>
  );
}
