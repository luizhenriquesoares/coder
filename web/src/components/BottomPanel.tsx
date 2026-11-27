import { useEffect, useRef } from "react";
import type { DomainEvent } from "../../../src/domain/deliberation/events.js";
import type { Language } from "../../../src/domain/deliberation/model.js";
import type { PublicationPlan } from "../../../src/domain/deliberation/publicationPlanner.js";
import { formatClock, formatDuration } from "../state/format.js";
import type { Strings } from "../state/i18n.js";
import { personaName } from "./cards.js";
import { EmptyState, Icon } from "./primitives.js";

export type BottomTab = "log" | "publication";

export interface BottomPanelProps {
  readonly t: Strings;
  readonly language: Language;
  readonly tab: BottomTab;
  onTab(tab: BottomTab): void;
  onClose(): void;
  readonly events: readonly DomainEvent[];
  readonly plan: PublicationPlan | null;
  readonly planError: string | null;
}

/** What an event says, beyond its name. The log is the session's event stream, unedited. */
function describe(event: DomainEvent, t: Strings, language: Language): string {
  const who = (reviewer: Parameters<typeof personaName>[0]) => personaName(reviewer, language);
  switch (event.type) {
    case "ReviewSessionConvened":
      return `${t.engineName[event.payload.engine]}${event.payload.model ? ` · ${event.payload.model}` : ""} · ${event.payload.pullRequest.headSha.slice(0, 7)}`;
    case "RoundStarted":
      return t.round[event.payload.round];
    case "ReviewerStartedThinking":
      return who(event.payload.reviewer);
    case "StatementMade":
      return `${who(event.payload.reviewer)} · ${formatDuration(event.payload.durationMs)}`;
    case "ReviewerFailed":
      return `${who(event.payload.reviewer)} · ${event.payload.reason}`;
    case "FindingRaised": {
      const { finding } = event.payload;
      return `${finding.id} ${t.severity[finding.severity].toLowerCase()} · ${finding.title} · ${who(finding.author)}`;
    }
    case "PositionTaken": {
      const { position } = event.payload;
      return `${who(position.reviewer)} ${t.stance[position.stance].toLowerCase()} ${position.findingId}`;
    }
    case "ConsensusComputed":
      return event.payload.consensus.map((entry) => `${entry.findingId} ${t.level[entry.level].toLowerCase()}`).join(" · ");
    case "PatchProposed":
      return `${event.payload.patch.id} → ${event.payload.patch.path}`;
    case "FindingDeclined":
      return `${event.payload.declined.findingId} · ${event.payload.declined.reason}`;
    case "VerdictIssued":
      return `${t.outcome[event.payload.verdict.decision]} · ${t.mergeRisk.toLowerCase()} ${t.riskWord[event.payload.verdict.mergeRisk]}`;
    case "ReviewSessionConcluded":
      return formatDuration(event.payload.durationMs);
    case "ReviewSessionFailed":
      return event.payload.reason;
    case "HumanDecisionRecorded": {
      const { decision } = event.payload;
      return `${decision.by} · ${t[decision.action].toLowerCase()} ${decision.target.id}`;
    }
    case "PublicationStarted":
      return "";
    case "PublicationFailed":
      return event.payload.reason;
    case "ReviewPublished":
      return `${t.decision[event.payload.decision]} · ${event.payload.inlineComments} ${t.inlineComments.toLowerCase()}${event.payload.simulated ? ` · ${t.simulated}` : ""}`;
  }
}

function SessionLog({ events, t, language }: { events: readonly DomainEvent[]; t: Strings; language: Language }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [events.length]);
  if (events.length === 0) return <EmptyState title={t.emptyLog} icon="terminal" />;
  return (
    <ol className="log">
      {events.map((event) => (
        <li key={event.seq} className={`log__line log__line--${event.type}`}>
          <span className="log__time">{formatClock(event.at, language)}</span>
          <span className="log__seq">{String(event.seq).padStart(3, "0")}</span>
          <span className="log__type">{event.type}</span>
          <span className="log__detail">{describe(event, t, language)}</span>
        </li>
      ))}
      <div ref={end} />
    </ol>
  );
}

function Publication({ plan, planError, t }: { plan: PublicationPlan | null; planError: string | null; t: Strings }) {
  if (!plan) return planError ? <EmptyState title={t.previewFailed(planError)} icon="alert" /> : <EmptyState title={t.emptyPublication} icon="send" />;
  return (
    <div className="publication">
      <section className="publication__part">
        <h3 className="finding__label">
          {t.reviewBody} · <span className={`reviewevent reviewevent--${plan.decision}`}>{t.decision[plan.decision]}</span>
        </h3>
        {plan.decision !== plan.councilDecision ? <p className="publication__changed">{t.outcomeChanged(plan.councilDecision, plan.decision)}</p> : null}
        <pre className="publication__text">{plan.body}</pre>
      </section>
      <section className="publication__part">
        <h3 className="finding__label">
          {t.inlineComments} · {plan.comments.length}
        </h3>
        {plan.comments.map((comment, index) => (
          <article key={index} className="publication__comment">
            <p className="publication__where">
              {comment.path}:{comment.startLine ? `${comment.startLine}–` : ""}
              {comment.line}
            </p>
            <pre className="publication__text">{comment.body}</pre>
          </article>
        ))}
      </section>
    </div>
  );
}

/** The panel under the editor: the raw event stream, and exactly what would be sent to GitHub. */
export function BottomPanel({ t, language, tab, onTab, onClose, events, plan, planError }: BottomPanelProps) {
  return (
    <section className="bottom">
      <header className="bottom__head" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "log"} className={`bottom__tab${tab === "log" ? " is-active" : ""}`} onClick={() => onTab("log")}>
          {t.sessionLog}
          {events.length > 0 ? <span className="council__count">{events.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "publication"}
          className={`bottom__tab${tab === "publication" ? " is-active" : ""}`}
          onClick={() => onTab("publication")}
        >
          {t.publicationPreview}
        </button>
        <button type="button" className="iconbtn bottom__close" aria-label={t.close} title={t.close} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="bottom__body">{tab === "log" ? <SessionLog events={events} t={t} language={language} /> : <Publication plan={plan} planError={planError} t={t} />}</div>
    </section>
  );
}
