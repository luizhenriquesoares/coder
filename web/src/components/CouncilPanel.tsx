import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppConfig, PullRequestDetail } from "../../../src/application/api.js";
import type { ConsensusLevel, Engine, Language } from "../../../src/domain/deliberation/model.js";
import { ROUNDS } from "../../../src/domain/deliberation/model.js";
import { COUNCIL_ORDER } from "../../../src/domain/deliberation/personas.js";
import type { PublicationPlan } from "../../../src/domain/deliberation/publicationPlanner.js";
import type { SessionState } from "../../../src/domain/deliberation/state.js";
import type { Strings } from "../state/i18n.js";
import { consensusCounts, findingsInReadingOrder, levelOf, LEVEL_ORDER } from "../state/selectors.js";
import { FindingCard, PatchCard, personaName, type CardContext } from "./cards.js";
import { ConveneControl, engineLabel } from "./ConveneControl.js";
import { Avatar, EmptyState, Icon } from "./primitives.js";
import { SessionTimeline } from "./SessionTimeline.js";

export type CouncilTab = "session" | "findings" | "patches";

export interface CouncilPanelProps {
  readonly t: Strings;
  readonly language: Language;
  readonly config: AppConfig;
  readonly detail: PullRequestDetail | null;
  readonly session: SessionState | null;
  readonly cards: CardContext | null;
  readonly tab: CouncilTab;
  onTab(tab: CouncilTab): void;
  readonly selectedFindingId: string | null;
  readonly convening: boolean;
  onConvene(engine?: Engine): void;
  readonly plan: PublicationPlan | null;
  readonly stale: boolean;
  readonly canPublish: boolean;
  readonly publishing: boolean;
  onPublish(): void;
  onPreviewPublication(): void;
}

/** How close to the end of the transcript still counts as "following along". */
const FOLLOW_MARGIN_PX = 96;

/** The chamber: who sits on the council, where the session stands, and everything it produced. */
export function CouncilPanel(props: CouncilPanelProps) {
  const { t, language, session, cards, tab, detail } = props;
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // While the council is in session the transcript follows the newest statement,
  // unless the person scrolled up to read something.
  const live = session?.status === "in_progress";
  const wasLive = useRef(false);
  const lastSeq = session?.lastSeq;
  useEffect(() => {
    const element = body.current;
    // `wasLive` covers the last event of a session: the verdict arrives as the session stops being live.
    if (element && (live || wasLive.current) && tab === "session" && following.current) element.scrollTop = element.scrollHeight;
    wasLive.current = live;
  }, [lastSeq, live, tab]);
  // A layout effect, so that a list scrolling to its selected card afterwards has the last word.
  const sessionId = session?.id;
  useLayoutEffect(() => {
    following.current = true;
    if (body.current) body.current.scrollTop = 0;
  }, [sessionId, tab]);

  const trackFollowing = () => {
    const element = body.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_MARGIN_PX;
  };

  return (
    <section className="council">
      <header className="council__head">
        <div className="council__title">
          <h2>{t.viewCouncil}</h2>
          {session ? <span className="council__engine">{engineLabel(session.engine, session.model, t)}</span> : null}
        </div>
        <ul className="seats">
          {COUNCIL_ORDER.map((reviewer) => (
            <li key={reviewer} className="seats__seat" title={personaName(reviewer, language)}>
              <Avatar reviewer={reviewer} active={session?.thinking.includes(reviewer) ?? false} />
              <span className="visually-hidden">{personaName(reviewer, language)}</span>
            </li>
          ))}
        </ul>
        <ol className="stepper">
          {ROUNDS.map((round) => {
            const state = !session ? "pending" : session.currentRound === round ? "current" : session.rounds.includes(round) ? "done" : "pending";
            return (
              <li key={round} className={`stepper__step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                {t.round[round]}
              </li>
            );
          })}
        </ol>
      </header>

      {session && cards ? (
        <>
          <div className="council__tabs" role="tablist">
            <TabButton id="session" label={t.tabSession} {...props} />
            <TabButton id="findings" label={t.tabFindings} count={session.findings.length} {...props} />
            <TabButton id="patches" label={t.tabPatches} count={session.patches.length} {...props} />
          </div>
          <div className="council__body" ref={body} onScroll={trackFollowing}>
            {tab === "session" ? (
              <SessionTimeline cards={cards} />
            ) : tab === "findings" ? (
              <FindingList cards={cards} selectedFindingId={props.selectedFindingId} />
            ) : (
              <PatchList cards={cards} />
            )}
          </div>
          <PublishBar {...props} session={session} />
        </>
      ) : (
        <div className="council__body">
          <EmptyState title={t.noSessionTitle} icon="council">
            <p>{t.noSessionBody}</p>
            {detail ? <ConveneControl t={t} config={props.config} detail={detail} convening={props.convening} onConvene={props.onConvene} /> : null}
          </EmptyState>
        </div>
      )}
    </section>
  );
}

function TabButton({ id, label, count, tab, onTab }: { id: CouncilTab; label: string; count?: number; tab: CouncilTab; onTab(tab: CouncilTab): void }) {
  return (
    <button type="button" role="tab" aria-selected={tab === id} className={`council__tab${tab === id ? " is-active" : ""}`} onClick={() => onTab(id)}>
      {label}
      {count ? <span className="council__count">{count}</span> : null}
    </button>
  );
}

function FindingList({ cards, selectedFindingId }: { cards: CardContext; selectedFindingId: string | null }) {
  const { state, t } = cards;
  const [filter, setFilter] = useState<ConsensusLevel | "all">("all");
  const list = useRef<HTMLDivElement>(null);
  const counts = consensusCounts(state);
  const findings = findingsInReadingOrder(state);
  const selected = findings.find((finding) => finding.id === selectedFindingId);
  // Never hide the finding the person just selected in the editor.
  const active = filter !== "all" && selected && levelOf(state, selected) !== filter ? "all" : filter;
  const shown = active === "all" ? findings : findings.filter((finding) => levelOf(state, finding) === active);

  useEffect(() => {
    if (!selectedFindingId) return;
    list.current?.querySelector(`[data-finding="${CSS.escape(selectedFindingId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedFindingId]);

  if (findings.length === 0) {
    return <EmptyState title={state.status === "in_progress" ? t.noFindingsYet : t.noFindingsRaised} icon="findings" />;
  }
  const levels = LEVEL_ORDER.filter((level) => counts[level] > 0);
  return (
    <div className="cardlist" ref={list}>
      {levels.length > 1 ? (
        <div className="filters" role="group" aria-label={t.tabFindings}>
          <button type="button" className={`filter${active === "all" ? " is-on" : ""}`} aria-pressed={active === "all"} onClick={() => setFilter("all")}>
            {t.all} <span>{findings.length}</span>
          </button>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              className={`filter filter--${level}${active === level ? " is-on" : ""}`}
              aria-pressed={active === level}
              onClick={() => setFilter(level)}
            >
              {t.level[level]} <span>{counts[level]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {shown.map((finding) => (
        <FindingCard key={finding.id} {...cards} finding={finding} expanded={finding.id === selectedFindingId} />
      ))}
    </div>
  );
}

function PatchList({ cards }: { cards: CardContext }) {
  const { state, t } = cards;
  if (state.patches.length === 0 && state.declined.length === 0) return <EmptyState title={t.noPatches} icon="patch" />;
  return (
    <div className="cardlist">
      {state.patches.map((patch) => (
        <PatchCard key={patch.id} {...cards} patch={patch} />
      ))}
      {state.declined.length > 0 ? (
        <section className="declined">
          <h3 className="finding__label">{t.declined}</h3>
          {state.declined.map((entry) => (
            <p key={entry.findingId} className="declined__entry">
              <button type="button" className="tag" onClick={() => cards.onSelectFinding(entry.findingId)}>
                {entry.findingId}
              </button>
              <span className="voice">{entry.reason}</span>
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function PublishBar({ t, session, plan, stale, canPublish, publishing, onPublish, onPreviewPublication }: CouncilPanelProps & { session: SessionState }) {
  if (session.status !== "concluded") return null;
  const { publication } = session;
  if (publication) {
    return (
      <footer className="publishbar publishbar--done">
        <p className="publishbar__title">
          <Icon name="check" size={15} />
          {t.reviewPublished}
        </p>
        <p className="publishbar__note">
          {t.decision[publication.decision]} · {publication.inlineComments} {t.inlineComments.toLowerCase()}
          {publication.simulated ? (
            <> · {t.simulated}</>
          ) : (
            <>
              {" · "}
              <a className="link" href={publication.url} target="_blank" rel="noreferrer">
                {t.viewOnGitHub}
              </a>
            </>
          )}
        </p>
      </footer>
    );
  }
  const suggestions = plan ? plan.comments.filter((comment) => comment.patchId !== undefined).length : 0;
  const blocked = stale ? t.staleSession : canPublish ? null : t.needsGitHubToken;
  return (
    <footer className="publishbar">
      <div className="publishbar__row">
        <div className="publishbar__what">
          <p className="publishbar__title">{t.publishTitle}</p>
          <p className="publishbar__note">
            {plan ? `${t.decision[plan.decision]} · ${t.publishSummary(plan.comments.length, suggestions)}` : t.loading}
          </p>
        </div>
        <span className="publishbar__actions">
          <button type="button" className="btn" onClick={onPreviewPublication}>
            <Icon name="eye" size={14} />
            {t.preview}
          </button>
          <button type="button" className="btn btn--primary" disabled={publishing || !plan || blocked !== null} onClick={onPublish}>
            <Icon name="send" size={14} />
            {publishing ? t.publishing : t.publish}
          </button>
        </span>
      </div>
      {blocked ? (
        <p className="publishbar__warning">
          <Icon name="alert" size={14} />
          {blocked}
        </p>
      ) : null}
    </footer>
  );
}
