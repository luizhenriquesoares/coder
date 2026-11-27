import type { DiffLine, Hunk } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses the hunk section of a unified diff (the `patch` field GitHub returns
 * for each file) into hunks with old/new line numbers.
 */
export function parseUnifiedPatch(patch: string | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: MutableHunk | null = null;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (current) hunks.push(freeze(current));
      current = startHunk(raw, header);
      continue;
    }
    if (!current) continue; // preamble such as "diff --git" or "+++ b/file"
    appendLine(current, raw);
  }
  if (current) hunks.push(freeze(current));
  return hunks;
}

interface MutableHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  nextOld: number;
  nextNew: number;
}

function startHunk(raw: string, match: RegExpExecArray): MutableHunk {
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  return {
    header: raw,
    oldStart,
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart,
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    lines: [],
    nextOld: oldStart,
    nextNew: newStart,
  };
}

function appendLine(hunk: MutableHunk, raw: string): void {
  const marker = raw[0];
  const content = raw.slice(1);
  if (marker === "+") {
    hunk.lines.push({ kind: "add", content, oldLine: null, newLine: hunk.nextNew++ });
  } else if (marker === "-") {
    hunk.lines.push({ kind: "del", content, oldLine: hunk.nextOld++, newLine: null });
  } else if (marker === " " || raw === "") {
    // An empty raw line inside a hunk is a context line whose content is empty
    // (some providers strip the leading space). Skip it if the hunk is full.
    if (raw === "" && isComplete(hunk)) return;
    hunk.lines.push({ kind: "context", content, oldLine: hunk.nextOld++, newLine: hunk.nextNew++ });
  }
  // "\ No newline at end of file" and anything else carries no line.
}

function isComplete(hunk: MutableHunk): boolean {
  return hunk.nextOld >= hunk.oldStart + hunk.oldLines && hunk.nextNew >= hunk.newStart + hunk.newLines;
}

function freeze(hunk: MutableHunk): Hunk {
  const { header, oldStart, oldLines, newStart, newLines, lines } = hunk;
  return { header, oldStart, oldLines, newStart, newLines, lines };
}
