import type { Finding, Language, Patch, Position, ReviewerId } from "../../../src/domain/deliberation/model.js";
import { PERSONAS } from "../../../src/domain/deliberation/personas.js";
import { isPublished, levelOf, type SessionState } from "../../../src/domain/deliberation/state.js";
import type { Strings } from "../state/i18n.js";
import { choiceFor, fileName, isSetAside, locationLabel, patchesFixing, type HumanChoice } from "../state/selectors.js";
import { Avatar, Icon, LevelChip, RiskChip, SeverityMark } from "./primitives.js";

export interface CardContext {
  readonly state: SessionState;
  readonly t: Strings;
  readonly language: Language;
  /** Decisions close once the review is published. */
  readonly readOnly: boolean;
  onDecide(kind: "finding" | "patch", id: string, action: "accept" | "dismiss"): void;
  onSelectFinding(id: string): void;
  onShowInCode(finding: Finding): void;
  onPreviewPatch(patch: Patch): void;
}

export function personaName(reviewer: ReviewerId, language: Language): string {
  return PERSONAS[reviewer].name[language];
}

function DecisionButtons({ choice, disabled, t, onChoose }: { choice: HumanChoice; disabled: boolean; t: Strings; onChoose(action: "accept" | "dismiss"): void }) {
  return (
    <span className="decide" role="group">
      <button type="button" className={`btn btn--small btn--accept${choice === "accept" ? " is-on" : ""}`} aria-pressed={choice === "accept"} disabled={disabled} onClick={() => onChoose("accept")}>
        <Icon name="check" size={14} />
        {t.accept}
      </button>
      <button type="button" className={`btn btn--small btn--dismiss${choice === "dismiss" ? " is-on" : ""}`} aria-pressed={choice === "dismiss"} disabled={disabled} onClick={() => onChoose("dismiss")}>
        <Icon name="x" size={14} />
        {t.dismiss}
      </button>
    </span>
  );
}

function PositionRow({ position, t, language }: { position: Position; t: Strings; language: Language }) {
  return (
    <li className="position">
      <Avatar reviewer={position.reviewer} size="sm" />
      <div className="position__text">
        <span className="position__who">{personaName(position.reviewer, language)}</span>
        <span className={`stance stance--${position.stance}`}>{t.stance[position.stance]}</span>
        <p className="voice">{position.argument}</p>
      </div>
    </li>
  );
}

export interface FindingCardProps extends CardContext {
  readonly finding: Finding;
  readonly expanded: boolean;
  /** "inline" is the card shown inside the editor, under the line it is about. */
  readonly variant?: "list" | "inline";
}

export function FindingCard({ finding, expanded, variant = "list", ...context }: FindingCardProps) {
  const { state, t, language } = context;
  const level = levelOf(state, finding);
  const consensus = state.consensus[finding.id];
  const choice = choiceFor(state, "finding", finding.id);
  const positions = state.positions.filter((position) => position.findingId === finding.id);
  const patches = patchesFixing(state, finding.id);
  const settled = level !== null;
  const muted = isSetAside(state, finding);

  return (
    <article
      className={`finding finding--${variant}${expanded ? " is-expanded" : ""}${muted ? " is-muted" : ""}`}
      data-severity={finding.severity}
      data-finding={finding.id}
    >
      <button type="button" className="finding__head" aria-expanded={expanded} onClick={() => context.onSelectFinding(finding.id)}>
        <SeverityMark severity={finding.severity} t={t} compact />
        <span className="finding__id">{finding.id}</span>
        <span className="finding__title">{finding.title}</span>
        <Avatar reviewer={finding.author} size="sm" />
      </button>
      <div className="finding__meta">
        <span className={`sev-text sev-text--${finding.severity}`}>{t.severity[finding.severity]}</span>
        <span>{t.category[finding.category]}</span>
        {level ? <LevelChip level={level} t={t} {...(consensus ? { tally: `${consensus.support.length}–${consensus.opposition.length}` } : {})} /> : null}
        {variant === "list" ? (
          <button type="button" className="link finding__where" disabled={!finding.location.path} onClick={() => context.onShowInCode(finding)}>
            {locationLabel(finding, t.changeWide)}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="finding__body">
          <p className="finding__label">{t.whyItMatters}</p>
          <p className="voice">{finding.rationale}</p>
          {finding.recommendation ? (
            <>
              <p className="finding__label">{t.recommendation}</p>
              <p className="voice">{finding.recommendation}</p>
            </>
          ) : null}
          {finding.principle ? (
            <p className="finding__principle">
              <span className="finding__label">{t.principle}</span> {finding.principle}
            </p>
          ) : null}
          {variant === "list" && finding.location.quote ? <pre className="code-quote">{finding.location.quote.trim()}</pre> : null}

          {variant === "list" && (settled || positions.length > 0) ? (
            <>
              <p className="finding__label">
                {t.positions}
                {consensus ? <span className="finding__tally"> · {t.tally(consensus.support.length, consensus.opposition.length)}</span> : null}
              </p>
              {positions.length > 0 ? (
                <ul className="positions">
                  {positions.map((position) => (
                    <PositionRow key={position.reviewer} position={position} t={t} language={language} />
                  ))}
                </ul>
              ) : (
                <p className="muted">{t.noPositions}</p>
              )}
            </>
          ) : null}

          {patches.length > 0 ? (
            <p className="finding__patches">
              <span className="finding__label">{t.fixedBy}</span>
              {patches.map((patch) => (
                <button key={patch.id} type="button" className="tag tag--patch" disabled={!patch.applicable} onClick={() => context.onPreviewPatch(patch)}>
                  <Icon name="patch" size={12} />
                  {patch.id}
                </button>
              ))}
            </p>
          ) : null}

          <footer className="finding__actions">
            <DecisionButtons choice={choice} disabled={context.readOnly} t={t} onChoose={(action) => context.onDecide("finding", finding.id, action)} />
            {settled ? (
              <span className={`publish-state${isPublished(state, finding) ? " is-yes" : ""}`}>
                {choice === "accept" ? t.acceptedByYou : choice === "dismiss" ? t.dismissedByYou : isPublished(state, finding) ? t.willPublish : t.wontPublish}
              </span>
            ) : null}
          </footer>
        </div>
      ) : null}
    </article>
  );
}

function MiniDiff({ patch }: { patch: Patch }) {
  const lines = (text: string) => text.replace(/^\n+|\n+$/g, "").split("\n");
  const removed = lines(patch.original);
  const added = patch.replacement.trim() === "" ? [] : lines(patch.replacement);
  return (
    <pre className="minidiff">
      <code>
        {removed.map((line, index) => (
          <span key={`del-${index}`} className="minidiff__line minidiff__line--del">
            <span className="minidiff__sign">−</span>
            {line || " "}
          </span>
        ))}
        {added.map((line, index) => (
          <span key={`add-${index}`} className="minidiff__line minidiff__line--add">
            <span className="minidiff__sign">+</span>
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function PatchCard({ patch, ...context }: CardContext & { patch: Patch }) {
  const { state, t, language } = context;
  const choice = choiceFor(state, "patch", patch.id);
  const where =
    patch.startLine !== null && patch.endLine !== null ? `${fileName(patch.path)} · ${t.lines(patch.startLine, patch.endLine)}` : fileName(patch.path);
  return (
    <article className={`patch${choice === "dismiss" ? " is-muted" : ""}`} data-patch={patch.id}>
      <header className="patch__head">
        <span className="patch__id">
          <Icon name="patch" size={14} />
          {patch.id}
        </span>
        <button type="button" className="link patch__where" disabled={!patch.applicable} onClick={() => context.onPreviewPatch(patch)} title={patch.path}>
          {where}
        </button>
        <Avatar reviewer={patch.author} size="sm" />
      </header>
      {patch.explanation ? <p className="voice">{patch.explanation}</p> : null}
      <MiniDiff patch={patch} />
      {patch.applicable ? null : (
        <p className="patch__warning">
          <Icon name="alert" size={14} />
          {t.notLocated}
        </p>
      )}
      <footer className="patch__foot">
        <span className="patch__fixes">
          <span className="finding__label">{t.fixes}</span>
          {patch.findingIds.map((id) => (
            <button key={id} type="button" className="tag" onClick={() => context.onSelectFinding(id)}>
              {id}
            </button>
          ))}
        </span>
        <span className="patch__actions">
          <button type="button" className="btn btn--small" disabled={!patch.applicable} onClick={() => context.onPreviewPatch(patch)}>
            <Icon name="eye" size={14} />
            {t.previewPatch}
          </button>
          <DecisionButtons choice={choice} disabled={context.readOnly} t={t} onChoose={(action) => context.onDecide("patch", patch.id, action)} />
        </span>
      </footer>
      <p className="visually-hidden">{personaName(patch.author, language)}</p>
    </article>
  );
}

export function VerdictCard({ state, t, language }: { state: SessionState; t: Strings; language: Language }) {
  const { verdict } = state;
  if (!verdict) return null;
  return (
    <section className={`verdict verdict--${verdict.decision}`} aria-label={t.round.verdict}>
      <header className="verdict__head">
        <span className="verdict__stamp">{t.outcome[verdict.decision]}</span>
        <span className="verdict__risk">
          <span className="finding__label">{t.mergeRisk}</span>
          <RiskChip level={verdict.mergeRisk} t={t} />
        </span>
      </header>
      <p className="voice verdict__summary">{verdict.summary}</p>
      {verdict.overriddenByPolicy && verdict.decision !== verdict.proposedDecision ? (
        <p className="verdict__policy">
          <Icon name="alert" size={14} />
          {t.policyOverride}
        </p>
      ) : null}
      {verdict.humanAttention.length > 0 ? (
        <>
          <p className="finding__label">{t.humanAttention}</p>
          <ol className="verdict__attention">
            {verdict.humanAttention.map((item) => (
              <li key={item} className="voice">
                {item}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <footer className="verdict__signed">
        <Avatar reviewer="moderator" size="sm" />
        {personaName("moderator", language)}
      </footer>
    </section>
  );
}
