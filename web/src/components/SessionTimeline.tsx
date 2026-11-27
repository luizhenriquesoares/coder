import type { ReviewerId, Round, Stance } from "../../../src/domain/deliberation/model.js";
import { STANCES } from "../../../src/domain/deliberation/model.js";
import type { SessionState, Statement } from "../../../src/domain/deliberation/state.js";
import { formatClock, formatDuration } from "../state/format.js";
import type { Strings } from "../state/i18n.js";
import { consensusCounts, LEVEL_ORDER } from "../state/selectors.js";
import { personaName, VerdictCard, type CardContext } from "./cards.js";
import { engineLabel } from "./ConveneControl.js";
import { Avatar, Icon, LevelChip } from "./primitives.js";

/** What a reviewer produced in a round, said in one line under their statement. */
function Contribution({ statement, cards }: { statement: Statement; cards: CardContext }) {
  const { state, t } = cards;
  const { reviewer, round } = statement;
  if (round === "opening") {
    const raised = state.findings.filter((finding) => finding.author === reviewer);
    return (
      <p className="statement__extra">
        <span>{t.raised(raised.length)}</span>
        {raised.map((finding) => (
          <button key={finding.id} type="button" className={`mark mark--${finding.severity}`} title={finding.title} onClick={() => cards.onSelectFinding(finding.id)}>
            {finding.id}
          </button>
        ))}
      </p>
    );
  }
  if (round === "debate") {
    const positions = state.positions.filter((position) => position.reviewer === reviewer);
    if (positions.length === 0) return null;
    const count = (stance: Stance) => positions.filter((position) => position.stance === stance).length;
    return (
      <p className="statement__extra">
        <span>{t.tookPositions(positions.length)}</span>
        {STANCES.filter((stance) => count(stance) > 0).map((stance) => (
          <span key={stance} className={`stance stance--${stance}`}>
            {count(stance)} {t.stanceCount[stance]}
          </span>
        ))}
      </p>
    );
  }
  if (round === "implementation") {
    const patches = state.patches.filter((patch) => patch.author === reviewer);
    const declined = state.declined.filter((entry) => entry.by === reviewer);
    return (
      <p className="statement__extra">
        <span>{t.proposed(patches.length)}</span>
        {patches.map((patch) => (
          <button key={patch.id} type="button" className="tag tag--patch" disabled={!patch.applicable} title={patch.path} onClick={() => cards.onPreviewPatch(patch)}>
            <Icon name="patch" size={12} />
            {patch.id}
          </button>
        ))}
        {declined.length > 0 ? <span>· {t.declinedCount(declined.length)}</span> : null}
      </p>
    );
  }
  return null;
}

function StatementRow({ statement, cards }: { statement: Statement; cards: CardContext }) {
  const { t, language } = cards;
  return (
    <article className={`statement${statement.failed ? " statement--failed" : ""}`}>
      <Avatar reviewer={statement.reviewer} />
      <div className="statement__main">
        <header className="statement__head">
          <span className="statement__who">{personaName(statement.reviewer, language)}</span>
          <span className="statement__when">
            {formatClock(statement.at, language)}
            {statement.durationMs > 0 ? ` · ${formatDuration(statement.durationMs)}` : ""}
          </span>
        </header>
        {statement.failed ? (
          <p className="statement__failure">
            <Icon name="alert" size={14} />
            {t.couldNotAnswer}: {statement.text}
          </p>
        ) : (
          <>
            <p className="voice statement__text">{statement.text}</p>
            <Contribution statement={statement} cards={cards} />
          </>
        )}
      </div>
    </article>
  );
}

function ThinkingRow({ reviewer, round, cards }: { reviewer: ReviewerId; round: Round; cards: CardContext }) {
  return (
    <div className="statement statement--thinking" role="status">
      <Avatar reviewer={reviewer} active />
      <p className="statement__thinking">
        <span className="statement__who">{personaName(reviewer, cards.language)}</span> {cards.t.working[round]}
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </p>
    </div>
  );
}

function ConsensusSummary({ state, t }: { state: SessionState; t: Strings }) {
  const counts = consensusCounts(state);
  return (
    <p className="consensus">
      <span className="consensus__label">{t.consensusSettled}</span>
      {LEVEL_ORDER.filter((level) => counts[level] > 0).map((level) => (
        <LevelChip key={level} level={level} t={t} tally={String(counts[level])} />
      ))}
    </p>
  );
}

/** The session as it happened: who said what, round by round. */
export function SessionTimeline({ cards }: { cards: CardContext }) {
  const { state, t, language } = cards;
  const settled = Object.keys(state.consensus).length > 0;
  return (
    <div className="timeline">
      <p className="timeline__convened">
        {t.trigger[state.trigger]} · {formatClock(state.startedAt, language)} · {engineLabel(state.engine, state.model, t)}
      </p>
      {state.rounds.map((round) => (
        <section key={round} className="round">
          <header className="round__head">
            <h3 className="round__name">{t.round[round]}</h3>
            <p className="round__purpose">{t.roundPurpose[round]}</p>
          </header>
          {state.statements
            .filter((statement) => statement.round === round)
            .map((statement) => (
              <StatementRow key={`${statement.reviewer}:${statement.at}`} statement={statement} cards={cards} />
            ))}
          {round === "debate" && settled ? <ConsensusSummary state={state} t={t} /> : null}
          {round === "verdict" && state.verdict ? <VerdictCard state={state} t={t} language={language} /> : null}
          {state.currentRound === round
            ? state.thinking.map((reviewer) => <ThinkingRow key={reviewer} reviewer={reviewer} round={round} cards={cards} />)
            : null}
        </section>
      ))}
      {state.status === "failed" ? (
        <div className="callout callout--failed">
          <p className="callout__title">{t.sessionFailedTitle}</p>
          <p className="callout__body">{state.failureReason}</p>
        </div>
      ) : null}
    </div>
  );
}
