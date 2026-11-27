import { useEffect, useMemo, useRef, useState } from "react";
import type { CoderApi, PullRequestDetail } from "../../../src/application/api.js";
import type { FileChange, FileContents } from "../../../src/domain/change/types.js";
import { applyPatches } from "../../../src/domain/deliberation/patching.js";
import type { SessionState } from "../../../src/domain/deliberation/state.js";
import { DiffView, type LineMarker } from "../editor/DiffView.js";
import type { EditorTheme } from "../editor/monaco.js";
import type { Strings } from "../state/i18n.js";
import { directory, fileName, findingsOfFile, isInsideHunk, isSetAside, previewablePatches, stepThrough, toggleSelection } from "../state/selectors.js";
import { isConflict, loadFile } from "../state/useWorkspace.js";
import { FindingCard, type CardContext } from "./cards.js";
import { DiffStat, EmptyState, Icon } from "./primitives.js";

/** The pull request's own diff, or the same file after the council's patches. */
export type DiffMode = "pr" | "patched";

export interface FileViewProps {
  readonly api: CoderApi;
  readonly t: Strings;
  readonly theme: EditorTheme;
  readonly detail: PullRequestDetail;
  readonly file: FileChange;
  readonly session: SessionState | null;
  /** The session reviewed another commit: nothing of it is drawn on this file. */
  readonly stale: boolean;
  readonly convening: boolean;
  onConvene(): void;
  /** Reading the file found the pull request on a newer commit. */
  onPullRequestMoved(): void;
  readonly cards: CardContext | null;
  readonly sideBySide: boolean;
  onSideBySide(value: boolean): void;
  readonly collapseUnchanged: boolean;
  onCollapseUnchanged(value: boolean): void;
  readonly diffMode: DiffMode;
  onDiffMode(mode: DiffMode): void;
  readonly selectedFindingId: string | null;
  onSelectFinding(id: string | null): void;
  /** A narrow editor: the selected finding's card docks under the code instead of opening inside it. */
  readonly compact: boolean;
}

type Loaded = { readonly contents: FileContents | null; readonly error: string | null };

function useFileContents(api: CoderApi, detail: PullRequestDetail, path: string, onMoved: () => void): Loaded {
  const { ref, headSha } = detail.pullRequest;
  const [loaded, setLoaded] = useState<Loaded>({ contents: null, error: null });
  const moved = useRef(onMoved);
  moved.current = onMoved;
  useEffect(() => {
    let cancelled = false;
    setLoaded({ contents: null, error: null });
    loadFile(api, ref, headSha, path).then(
      (contents) => !cancelled && setLoaded({ contents, error: null }),
      (error: unknown) => {
        if (cancelled) return;
        // Never draw a newer file under markers placed on the commit this view was loaded at: reload instead.
        if (isConflict(error)) return moved.current();
        setLoaded({ contents: null, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // The ref is the same pull request for as long as this view is mounted.
  }, [api, headSha, path]);
  return loaded;
}

/** One changed file: the diff, with the council's findings on the lines they are about. */
export function FileView(props: FileViewProps) {
  const { api, t, theme, detail, file, session: current, stale, cards, sideBySide, collapseUnchanged, diffMode, selectedFindingId } = props;
  const { contents, error } = useFileContents(api, detail, file.path, props.onPullRequestMoved);
  // A session is never drawn over code it did not review.
  const session = stale ? null : current;

  const findings = useMemo(
    () => findingsOfFile(session, file.path).sort((a, b) => (a.location.line ?? 0) - (b.location.line ?? 0)),
    [session, file.path],
  );
  const patches = useMemo(() => previewablePatches(session, file.path), [session, file.path]);
  const patched = diffMode === "patched" && patches.length > 0;

  const markers = useMemo<LineMarker[]>(() => {
    if (!session || patched) return []; // after the patches, line numbers no longer match the findings
    return findings.flatMap((finding) => {
      const { line } = finding.location;
      if (!line) return [];
      return {
        id: finding.id,
        line,
        severity: finding.severity,
        hover: `**${finding.id} · ${t.severity[finding.severity]}** — ${finding.title}`,
        dimmed: isSetAside(session, finding),
      };
    });
  }, [session, findings, patched, t]);

  const sides = useMemo(() => {
    if (!contents) return null;
    return patched
      ? { original: contents.modified, modified: applyPatches(contents.modified, patches) }
      : { original: contents.original, modified: contents.modified };
  }, [contents, patched, patches]);

  const selected = findings.find((finding) => finding.id === selectedFindingId) ?? null;
  const selectedLine = patched ? null : (selected?.location.line ?? null);
  // A finding can sit on a line the diff folds away. Unfold while it is selected.
  const collapse = collapseUnchanged && (selectedLine === null || isInsideHunk(file, selectedLine));
  const step = (direction: 1 | -1) => {
    const next = stepThrough(findings, selectedFindingId, direction);
    if (next) props.onSelectFinding(next.id);
  };
  const toggleMarker = (id: string) => props.onSelectFinding(toggleSelection(selectedFindingId, id));

  const card =
    selected && cards && !patched ? (
      <FindingCard {...cards} finding={selected} expanded variant="inline" onSelectFinding={() => props.onSelectFinding(null)} />
    ) : undefined;
  // Inside the code, under its line, when there is a line and room for it. Otherwise docked under the editor.
  const docked = props.compact || selectedLine === null;

  return (
    <div className="fileview">
      <div className="filebar">
        <span className="filebar__path" title={file.path}>
          <span className={`file__status file__status--${file.status}`}>{t.fileStatus[file.status]}</span>
          <span className="filebar__dir">{directory(file.path)}</span>
          <span className="filebar__name">{fileName(file.path)}</span>
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </span>

        <span className="filebar__tools">
          {patches.length > 0 ? (
            <span className="segmented" role="group">
              <button type="button" aria-pressed={!patched} onClick={() => props.onDiffMode("pr")}>
                {t.pullRequestDiff}
              </button>
              <button type="button" aria-pressed={patched} onClick={() => props.onDiffMode("patched")}>
                <Icon name="patch" size={13} />
                {t.withPatches(patches.length)}
              </button>
            </span>
          ) : null}
          <span className="segmented filebar__layout" role="group">
            <button type="button" aria-pressed={sideBySide} title={t.sideBySide} aria-label={t.sideBySide} onClick={() => props.onSideBySide(true)}>
              <Icon name="columns" size={15} />
            </button>
            <button type="button" aria-pressed={!sideBySide} title={t.inline} aria-label={t.inline} onClick={() => props.onSideBySide(false)}>
              <Icon name="rows" size={15} />
            </button>
          </span>
          <button
            type="button"
            className={`iconbtn${collapseUnchanged ? " is-on" : ""}`}
            aria-pressed={collapseUnchanged}
            title={t.collapseUnchanged}
            aria-label={t.collapseUnchanged}
            onClick={() => props.onCollapseUnchanged(!collapseUnchanged)}
          >
            <Icon name="fold" />
          </button>
        </span>
      </div>

      {findings.length > 0 && !patched ? (
        <div className="markbar">
          <button type="button" className="iconbtn" title={t.previousFinding} aria-label={t.previousFinding} onClick={() => step(-1)}>
            <Icon name="arrowUp" />
          </button>
          <button type="button" className="iconbtn" title={t.nextFinding} aria-label={t.nextFinding} onClick={() => step(1)}>
            <Icon name="arrowDown" />
          </button>
          <span className="markbar__marks">
            {findings.map((finding) => (
              <button
                key={finding.id}
                type="button"
                className={`mark mark--${finding.severity}${finding.id === selectedFindingId ? " is-on" : ""}`}
                aria-pressed={finding.id === selectedFindingId}
                title={finding.title}
                onClick={() => toggleMarker(finding.id)}
              >
                {finding.id}
                {finding.location.line ? <span className="mark__line">:{finding.location.line}</span> : null}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      {stale ? (
        <p className="banner banner--stale">
          <Icon name="alert" size={15} />
          <span>{t.staleFile}</span>
          <button type="button" className="link" disabled={props.convening} onClick={props.onConvene}>
            {props.convening ? t.convening : t.conveneAgain}
          </button>
        </p>
      ) : null}

      {patched ? (
        <p className="banner">
          <Icon name="patch" size={15} />
          <span>{t.patchBanner(patches.length)}</span>
          <button type="button" className="link" onClick={() => props.onDiffMode("pr")}>
            {t.backToDiff}
          </button>
        </p>
      ) : null}

      <div className="fileview__editor">
        {file.binary ? (
          <EmptyState title={t.binaryFile} icon="files" />
        ) : error ? (
          <EmptyState title={error} icon="alert" />
        ) : !sides ? (
          <EmptyState title={t.loading} />
        ) : (
          <DiffView
            original={sides.original}
            modified={sides.modified}
            language={file.language}
            theme={theme}
            sideBySide={sideBySide}
            collapseUnchanged={collapse}
            markers={markers}
            selectedMarkerId={selectedLine === null ? null : selectedFindingId}
            onSelectMarker={toggleMarker}
            inlineCard={docked ? undefined : card}
          />
        )}
      </div>

      {docked && card ? <div className="fileview__docked">{card}</div> : null}
    </div>
  );
}
