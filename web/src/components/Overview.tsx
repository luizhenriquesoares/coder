import type { AppConfig, PullRequestDetail } from "../../../src/application/api.js";
import type { Engine, Language } from "../../../src/domain/deliberation/model.js";
import { COUNCIL_ORDER, PERSONAS } from "../../../src/domain/deliberation/personas.js";
import type { SessionState } from "../../../src/domain/deliberation/state.js";
import { formatDuration, relativeTime } from "../state/format.js";
import type { Strings } from "../state/i18n.js";
import { directory, fileName, findingsOfFile, worstSeverity } from "../state/selectors.js";
import { personaName, VerdictCard } from "./cards.js";
import { ConveneControl, engineLabel } from "./ConveneControl.js";
import { Avatar, DiffStat, Icon, RiskChip } from "./primitives.js";

const FILES_TO_LOOK_AT = 5;

export interface OverviewProps {
  readonly t: Strings;
  readonly language: Language;
  readonly config: AppConfig;
  readonly detail: PullRequestDetail;
  readonly session: SessionState | null;
  /** The pull request moved on since the council reviewed it. */
  readonly stale: boolean;
  readonly convening: boolean;
  onConvene(engine?: Engine): void;
  onOpenFile(path: string): void;
}

/** The pull request at a glance: how risky, how long by hand, and what the council concluded. */
export function Overview({ t, language, config, detail, session, stale, convening, onConvene, onOpenFile }: OverviewProps) {
  const { pullRequest, risk, stats } = detail;
  const risks = new Map(risk.files.map((file) => [file.path, file]));
  const firstFiles = risk.reviewOrder.slice(0, FILES_TO_LOOK_AT);
  const councilTime =
    session?.durationMs != null ? formatDuration(session.durationMs) : session?.status === "in_progress" ? t.inSession : t.notYet;

  return (
    <div className="overview">
      <article className="overview__page">
        <header className="prhead">
          <p className="prhead__kicker">
            {pullRequest.ref.owner}/{pullRequest.ref.repo}
            <span className="prhead__number">#{pullRequest.ref.number}</span>
            {pullRequest.draft ? <span className="prstate prstate--none">Draft</span> : null}
          </p>
          <h1 className="prhead__title">{pullRequest.title}</h1>
          <p className="prhead__merge">
            {t.wantsToMerge(pullRequest.author.login, pullRequest.headBranch, pullRequest.baseBranch)}
            {pullRequest.ref.provider === "github" ? (
              <a className="link prhead__link" href={pullRequest.url} target="_blank" rel="noreferrer">
                {t.viewOnGitHub}
                <Icon name="external" size={13} />
              </a>
            ) : null}
          </p>
        </header>

        <dl className="metrics">
          <div className={`metric metric--risk-${risk.level}`}>
            <dt>{t.riskScore}</dt>
            <dd className="metric__value">
              {risk.score}
              <span className="metric__unit">/100</span>
            </dd>
            <dd className="metric__note">
              <RiskChip level={risk.level} t={t} />
            </dd>
          </div>
          <div className="metric">
            <dt>{t.humanReview}</dt>
            <dd className="metric__value">{t.minutes(risk.estimatedHumanReviewMinutes)}</dd>
            <dd className="metric__note">
              {t.humanReviewNote} · {t.files(stats.files)} <DiffStat additions={stats.additions} deletions={stats.deletions} />
            </dd>
          </div>
          <div className="metric metric--council">
            <dt>{t.councilSession}</dt>
            <dd className="metric__value">{councilTime}</dd>
            <dd className="metric__note">{session ? t.councilSessionNote(session.findings.length, session.patches.length) : "—"}</dd>
          </div>
        </dl>

        <section className="overview__section">
          {stale ? (
            <p className="banner banner--warn">
              <Icon name="alert" size={15} />
              <span>{t.staleSession}</span>
            </p>
          ) : null}
          {!session ? (
            <div className="callout">
              <p className="callout__title">{t.noSessionTitle}</p>
              <p className="callout__body">{t.noSessionBody}</p>
              <ConveneControl t={t} config={config} detail={detail} convening={convening} onConvene={onConvene} />
            </div>
          ) : session.status === "in_progress" ? (
            <div className="callout callout--live">
              <p className="callout__title">
                <span className="live-dot" aria-hidden="true" />
                {t.statusInSession}
                {session.currentRound ? ` · ${t.round[session.currentRound]}` : ""}
              </p>
              <p className="callout__body">{session.currentRound ? t.roundPurpose[session.currentRound] : t.loading}</p>
            </div>
          ) : session.status === "failed" ? (
            <div className="callout callout--failed">
              <p className="callout__title">{t.sessionFailedTitle}</p>
              <p className="callout__body">{session.failureReason}</p>
              <ConveneControl t={t} config={config} detail={detail} convening={convening} again onConvene={onConvene} />
            </div>
          ) : (
            <>
              <VerdictCard state={session} t={t} language={language} />
              <p className="overview__session">
                <span>
                  {t.trigger[session.trigger]} · {relativeTime(session.startedAt, language)} · {engineLabel(session.engine, session.model, t)}
                </span>
                <ConveneControl t={t} config={config} detail={detail} convening={convening} again quiet={!stale} onConvene={onConvene} />
              </p>
            </>
          )}
        </section>

        <section className="overview__section">
          <h2 className="overview__heading">{t.whereToLook}</h2>
          <ol className="lookfirst">
            {firstFiles.map((path) => {
              const fileRisk = risks.get(path);
              const findings = findingsOfFile(session, path);
              const worst = worstSeverity(findings);
              return (
                <li key={path}>
                  <button type="button" className="lookfirst__file" onClick={() => onOpenFile(path)}>
                    <span className="lookfirst__path">
                      <span className="file__dir">{directory(path)}</span>
                      <span className="file__name">{fileName(path)}</span>
                    </span>
                    <span className="lookfirst__why">
                      {fileRisk ? <RiskChip level={fileRisk.level} t={t} score={fileRisk.score} /> : null}
                      {fileRisk?.reasons.map((reason) => (
                        <span key={reason} className="reason">
                          {t.riskReason[reason]}
                        </span>
                      ))}
                      {worst ? <span className={`count count--${worst}`}>{findings.length}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="overview__section">
          <h2 className="overview__heading">{t.description}</h2>
          {pullRequest.description.trim() ? <p className="description">{pullRequest.description.trim()}</p> : <p className="muted">{t.noDescription}</p>}
        </section>

        <section className="overview__section">
          <h2 className="overview__heading">{t.theCouncil}</h2>
          <ul className="roster">
            {COUNCIL_ORDER.map((id) => {
              const persona = PERSONAS[id];
              return (
                <li key={id} className="roster__seat">
                  <Avatar reviewer={id} size="lg" />
                  <div>
                    <p className="roster__name">{personaName(id, language)}</p>
                    <p className="roster__school">{persona.school[language]}</p>
                    <p className="roster__lens">{persona.lens[language]}</p>
                    {persona.inspiredBy ? (
                      <p className="roster__inspired">
                        {t.inspiredBy}: {persona.inspiredBy}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </article>
    </div>
  );
}
