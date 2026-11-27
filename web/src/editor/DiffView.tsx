import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Severity } from "../../../src/domain/deliberation/model.js";
import { applyEditorTheme, CODE_FONT, monaco, type EditorTheme } from "./monaco.js";

/** Something the council pointed at: a mark in the gutter of the new version. */
export interface LineMarker {
  readonly id: string;
  readonly line: number;
  readonly severity: Severity;
  /** Markdown shown when hovering the gutter mark. */
  readonly hover: string;
  /** The council rejected it, or the human dismissed it. */
  readonly dimmed: boolean;
}

export interface DiffViewProps {
  readonly original: string;
  readonly modified: string;
  readonly language: string;
  readonly theme: EditorTheme;
  readonly sideBySide: boolean;
  readonly collapseUnchanged: boolean;
  readonly markers: readonly LineMarker[];
  readonly selectedMarkerId: string | null;
  readonly onSelectMarker: (id: string) => void;
  /** Rendered inside the editor, right under the selected marker's line. */
  readonly inlineCard?: ReactNode;
}

const MAX_CARD_WIDTH = 720;
const RULER_COLOR: Record<Severity, string> = { blocker: "#ff6b6b", major: "#ffa24d", minor: "#dcc36e", nit: "#8891a5" };
const GUTTER_TARGETS = new Set([
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
]);

/** The pull request's diff in Monaco, with the council's findings marked on the code. */
export function DiffView(props: DiffViewProps) {
  const { original, modified, language, theme, sideBySide, collapseUnchanged, markers, selectedMarkerId, inlineCard } = props;
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const latest = useRef(props);
  latest.current = props;

  // The inline card lives in a DOM node Monaco positions between two lines; React renders into it.
  const [zone] = useState(() => {
    const outer = document.createElement("div");
    outer.className = "inline-zone";
    outer.style.zIndex = "5"; // above the text layer, so the card can be clicked
    const inner = document.createElement("div");
    inner.className = "inline-zone__content";
    outer.append(inner);
    return { outer, inner };
  });

  useEffect(() => {
    const editor = monaco.editor.createDiffEditor(host.current!, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: latest.current.sideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 760,
      hideUnchangedRegions: { enabled: latest.current.collapseUnchanged, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderOverviewRuler: true,
      glyphMargin: true,
      lineNumbersMinChars: 3,
      folding: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      contextmenu: false,
      fontFamily: CODE_FONT,
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 8, bottom: 8 },
      renderLineHighlight: "none",
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      stickyScroll: { enabled: false },
    });
    editorRef.current = editor;
    const code = editor.getModifiedEditor();
    decorations.current = code.createDecorationsCollection();
    const clicks = code.onMouseDown((event) => {
      if (!GUTTER_TARGETS.has(event.target.type)) return;
      const line = event.target.position?.lineNumber;
      const marker = latest.current.markers.find((candidate) => candidate.line === line);
      if (marker) latest.current.onSelectMarker(marker.id);
    });
    return () => {
      clicks.dispose();
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = editor.getModel();
    editor.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [original, modified, language]);

  useEffect(() => applyEditorTheme(theme), [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide, hideUnchangedRegions: { enabled: collapseUnchanged } });
  }, [sideBySide, collapseUnchanged]);

  useEffect(() => {
    decorations.current?.set(
      markers.map((marker) => ({
        range: new monaco.Range(marker.line, 1, marker.line, 1),
        options: {
          isWholeLine: true,
          className: [
            "finding-line",
            `finding-line--${marker.severity}`,
            marker.id === selectedMarkerId ? "finding-line--selected" : "",
            marker.dimmed ? "finding-line--dimmed" : "",
          ].join(" "),
          glyphMarginClassName: `finding-glyph finding-glyph--${marker.severity}${marker.dimmed ? " finding-glyph--dimmed" : ""}`,
          glyphMarginHoverMessage: { value: marker.hover },
          overviewRuler: { color: RULER_COLOR[marker.severity], position: monaco.editor.OverviewRulerLane.Right },
        },
      })),
    );
  }, [markers, selectedMarkerId, original, modified, language]);

  const selectedLine = markers.find((marker) => marker.id === selectedMarkerId)?.line ?? null;
  const showCard = selectedLine !== null && inlineCard !== undefined && inlineCard !== null;

  useEffect(() => {
    const code = editorRef.current?.getModifiedEditor();
    if (!code || selectedLine === null) return;
    if (!showCard) {
      code.revealLineInCenterIfOutsideViewport(selectedLine, monaco.editor.ScrollType.Smooth);
      return;
    }

    let zoneId: string | null = null;
    const viewZone: monaco.editor.IViewZone = {
      afterLineNumber: selectedLine,
      heightInPx: Math.max(zone.inner.offsetHeight, 96),
      domNode: zone.outer,
    };
    // Monaco makes a zone as wide as the longest line. The card should be as wide as what is visible.
    const fitWidth = () => {
      const layout = code.getLayoutInfo();
      zone.inner.style.width = `${Math.max(240, Math.min(MAX_CARD_WIDTH, layout.contentWidth - layout.verticalScrollbarWidth - 8))}px`;
    };
    fitWidth();
    const layoutChanges = code.onDidLayoutChange(fitWidth);
    code.changeViewZones((accessor) => {
      zoneId = accessor.addZone(viewZone);
    });
    // The card opens under the line: bring the line near the top so the card is in view too.
    // Only once the editor has made room for it, or there is nowhere to scroll to yet.
    const reveal = () => code.revealLineNearTop(selectedLine, monaco.editor.ScrollType.Smooth);
    let revealed = false;
    // The card decides its own height; the editor makes room for it.
    const resize = new ResizeObserver(() => {
      const height = zone.inner.offsetHeight;
      if (height === 0) return;
      if (height !== viewZone.heightInPx) {
        viewZone.heightInPx = height;
        code.changeViewZones((accessor) => zoneId && accessor.layoutZone(zoneId));
      }
      if (!revealed) reveal();
      revealed = true;
    });
    resize.observe(zone.inner);
    return () => {
      resize.disconnect();
      layoutChanges.dispose();
      code.changeViewZones((accessor) => zoneId && accessor.removeZone(zoneId));
    };
  }, [selectedLine, showCard, zone, original, modified, language]);

  return (
    <>
      <div ref={host} className="diffview" />
      {showCard ? createPortal(inlineCard, zone.inner) : null}
    </>
  );
}
