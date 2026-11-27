import { useState, type FormEvent } from "react";
import type { AppConfig, Inbox, InboxItem, PullRequestDetail } from "../../../src/application/api.js";
import type { PullRequestRef } from "../../../src/domain/change/types.js";
import type { Finding, Language } from "../../../src/domain/deliberation/model.js";
import { levelOf, type SessionState } from "../../../src/domain/deliberation/state.js";
import { relativeTime } from "../state/format.js";
import type { Strings } from "../state/i18n.js";
import { directory, fileName, findingsInReadingOrder, findingsOfFile, inboxErrorLines, locationLabel, sameRef, worstSeverity } from "../state/selectors.js";
import type { SideView } from "./ActivityBar.js";
import { DiffStat, EmptyState, Icon, LevelChip } from "./primitives.js";

export interface SidePanelProps {
  readonly t: Strings;
  readonly language: Language;
  readonly view: SideView;
  readonly config: AppConfig;
  readonly inbox: Inbox | null;
  readonly selected: PullRequestRef | null;
  onSelectPullRequest(ref: PullRequestRef): void;
  readonly importing: boolean;
  onImport(url: string): Promise<boolean>;
  readonly detail: PullRequestDetail | null;
  readonly session: SessionState | null;
  readonly activePath: string | null;
  onOpenFile(path: string): void;
  readonly selectedFindingId: string | null;
  onSelectFinding(finding: Finding): void;
}

/** The explorer: pull requests waiting, the files of the open one, or what the council found in it. */
export function SidePanel(props: SidePanelProps) {
  if (props.view === "pulls") return <PullRequests {...props} />;
  if (props.view === "files") return <ChangedFiles {...props} />;
  return <Findings {...props} />;
}

function PanelHead({ title, note }: { title: string; note?: string | undefined }) {
  return (
    <header className="panelhead">
      <h2 className="panelhead__title">{title}</h2>
      {note ? <span className="panelhead__note">{note}</span> : null}
    </header>
  );
}

function PullRequestStatus({ item, t }: { item: InboxItem; t: Strings }) {
  const { state } = item.pullRequest;
  return (
    <>
      {state !== "open" ? <span className={`prstate prstate--${state}`}>{t.pullRequestState[state]}</span> : null}
      <SessionStatus item={item} t={t} />
    </>
  );
}

function SessionStatus({ item, t }: { item: InboxItem; t: Strings }) {
  const session = item.latestSession;
  if (!session) return <span className="prstate prstate--none">{t.notReviewed}</span>;
  if (session.status === "in_progress") {
    return (
      <span className="prstate prstate--live">
        <span className="live-dot" aria-hidden="true" />
        {t.inSession}
      </span>
    );
  }
  if (session.status === "failed") return <span className="prstate prstate--failed">{t.sessionFailed}</span>;
  return (
    <>
      {session.decision ? (
        <span className={`prstate prstate--${session.decision}`}>
          {session.published ? <Icon name="send" size={12} /> : null}
          {t.outcome[session.decision]}
          {session.published ? <span className="visually-hidden"> · {t.published}</span> : null}
        </span>
      ) : null}
      {item.stale ? <span className="prstate prstate--stale">{t.newCommits}</span> : null}
      <span className="prstate__count">{t.findingCount(session.findings)}</span>
    </>
  );
}

function PullRequests({ t, language, config, inbox, selected, onSelectPullRequest, importing, onImport }: SidePanelProps) {
  const [url, setUrl] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() && (await onImport(url.trim()))) setUrl("");
  };
  return (
    <section className="panel">
      <PanelHead title={t.viewPulls} note={inbox ? String(inbox.items.length) : undefined} />
      {config.mode === "server" ? (
        <form className="import" onSubmit={(event) => void submit(event)}>
          <input
            type="url"
            inputMode="url"
            value={url}
            placeholder={t.importPlaceholder}
            aria-label={t.importPlaceholder}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="btn btn--small" disabled={importing || !url.trim()}>
            <Icon name="plus" size={14} />
            {t.importAction}
          </button>
        </form>
      ) : null}
      {inbox
        ? inboxErrorLines(inbox.errors).map((error) => (
            <p key={`${error.provider}:${error.message}`} className="panel__alert">
              <Icon name="alert" size={14} />
              <span>
                {t.provider[error.provider]}: {error.message}
              </span>
            </p>
          ))
        : null}
      <div className="panel__scroll">
        {!inbox ? (
          <EmptyState title={t.loading} />
        ) : inbox.items.length === 0 ? (
          <EmptyState title={t.noPulls} icon="pulls" />
        ) : (
          <ul className="list">
            {inbox.items.map((item) => {
              const { pullRequest } = item;
              const active = sameRef(selected, pullRequest.ref);
              return (
                <li key={`${pullRequest.ref.owner}/${pullRequest.ref.repo}#${pullRequest.ref.number}`}>
                  <button type="button" className={`pr${active ? " is-active" : ""}`} aria-current={active} onClick={() => onSelectPullRequest(pullRequest.ref)}>
                    <span className="pr__title">
                      <span className="pr__number">#{pullRequest.ref.number}</span> {pullRequest.title}
                    </span>
                    <span className="pr__meta">
                      {pullRequest.ref.owner}/{pullRequest.ref.repo} · {pullRequest.author.login} · {relativeTime(pullRequest.updatedAt, language)}
                    </span>
                    <span className="pr__status">
                      <PullRequestStatus item={item} t={t} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

const STATUS_LETTER = { added: "A", modified: "M", removed: "D", renamed: "R" } as const;

function ChangedFiles({ t, detail, session, activePath, onOpenFile }: SidePanelProps) {
  if (!detail) {
    return (
      <section className="panel">
        <PanelHead title={t.viewFiles} />
        <EmptyState title={t.noFilesYet} icon="files" />
      </section>
    );
  }
  const byPath = new Map(detail.files.map((file) => [file.path, file]));
  return (
    <section className="panel">
      <PanelHead title={t.viewFiles} note={t.filesInReviewOrder} />
      <p className="panel__summary">
        {t.files(detail.stats.files)}
        <DiffStat additions={detail.stats.additions} deletions={detail.stats.deletions} />
      </p>
      <div className="panel__scroll">
        <ul className="list">
          {detail.risk.reviewOrder.map((path) => {
            const file = byPath.get(path);
            if (!file) return null;
            const findings = findingsOfFile(session, path);
            const worst = worstSeverity(findings);
            const active = activePath === path;
            return (
              <li key={path}>
                <button type="button" className={`file${active ? " is-active" : ""}`} aria-current={active} title={path} onClick={() => onOpenFile(path)}>
                  <span className={`file__status file__status--${file.status}`} title={t.fileStatus[file.status]}>
                    {STATUS_LETTER[file.status]}
                  </span>
                  <span className="file__path">
                    <span className="file__name">{fileName(path)}</span>
                    <span className="file__dir">{directory(path)}</span>
                  </span>
                  {worst ? <span className={`count count--${worst}`}>{findings.length}</span> : null}
                  <DiffStat additions={file.additions} deletions={file.deletions} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Findings({ t, session, selectedFindingId, onSelectFinding }: SidePanelProps) {
  const findings = session ? findingsInReadingOrder(session) : [];
  return (
    <section className="panel">
      <PanelHead title={t.viewFindings} note={findings.length > 0 ? String(findings.length) : undefined} />
      <div className="panel__scroll">
        {!session ? (
          <EmptyState title={t.noFindingsYet} icon="findings" />
        ) : findings.length === 0 ? (
          <EmptyState title={session.status === "in_progress" ? t.noFindingsYet : t.noFindingsRaised} icon="findings" />
        ) : (
          <ul className="list">
            {findings.map((finding) => {
              const level = levelOf(session, finding);
              const active = finding.id === selectedFindingId;
              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    className={`row-finding${active ? " is-active" : ""}`}
                    data-severity={finding.severity}
                    aria-current={active}
                    onClick={() => onSelectFinding(finding)}
                  >
                    <span className="row-finding__bar" aria-hidden="true" />
                    <span className="row-finding__text">
                      <span className="row-finding__title">
                        <span className="row-finding__id">{finding.id}</span> {finding.title}
                      </span>
                      <span className="row-finding__meta">
                        <span className={`sev-text sev-text--${finding.severity}`}>{t.severity[finding.severity]}</span>
                        <span>{locationLabel(finding, t.changeWide)}</span>
                        {level ? <LevelChip level={level} t={t} /> : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
