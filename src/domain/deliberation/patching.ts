/**
 * Locating and applying the implementer's patches.
 *
 * A patch replaces an `original` snippet of the head file. Models often get
 * indentation slightly wrong, so when the exact text is not found we fall back
 * to matching line by line with surrounding whitespace ignored. A snippet that
 * occurs more than once is placed at the occurrence nearest to the finding it
 * fixes; when that is not clear, it is not placed at all.
 */

export interface SnippetLocation {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly exact: boolean;
}

/** What `applyPatches` needs of a patch: where it was located and what replaces those lines. */
export interface LocatedPatch {
  readonly applicable: boolean;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly replacementLines: readonly string[] | null;
}

/**
 * Finds the lines `snippet` occupies in `content`. `near` are the lines the
 * patch is about (its findings' lines): with several matches, the nearest one
 * wins. Several matches with no `near` line, or a tie, are ambiguous: null.
 */
export function locateSnippet(content: string, snippet: string, near: readonly number[] = []): SnippetLocation | null {
  const needle = trimBlankEdges(snippet).split("\n");
  if (needle.every((line) => line.trim() === "")) return null;
  const haystack = content.split("\n");
  // Patches replace whole lines, so a snippet must match whole lines too.
  const exact = matchesOf(haystack, needle, (line) => line.replace(/\s+$/, ""), true);
  const matches = exact.length > 0 ? exact : matchesOf(haystack, needle, (line) => line.trim(), false);
  return nearest(matches, near);
}

function matchesOf(
  haystack: readonly string[],
  needle: readonly string[],
  normalize: (line: string) => string,
  exact: boolean,
): SnippetLocation[] {
  const lines = haystack.map(normalize);
  const wanted = needle.map(normalize);
  const matches: SnippetLocation[] = [];
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (wanted.every((line, offset) => lines[start + offset] === line)) {
      matches.push({ startLine: start + 1, endLine: start + wanted.length, exact });
    }
  }
  return matches;
}

function nearest(matches: readonly SnippetLocation[], near: readonly number[]): SnippetLocation | null {
  if (matches.length <= 1) return matches[0] ?? null;
  if (near.length === 0) return null;
  const distance = (match: SnippetLocation) =>
    Math.min(...near.map((line) => (line < match.startLine ? match.startLine - line : line > match.endLine ? line - match.endLine : 0)));
  const ranked = [...matches].sort((a, b) => distance(a) - distance(b));
  return distance(ranked[0]!) === distance(ranked[1]!) ? null : ranked[0]!;
}

/**
 * The lines that replace the located snippet, exactly as they will be written:
 * re-indented to the file when the snippet matched loosely, none for a deletion.
 */
export function replacementLinesAt(content: string, location: SnippetLocation, replacement: string): string[] {
  const lines = linesOf(replacement);
  if (location.exact) return lines;
  return reindent(lines, leadingWhitespace(content.split("\n")[location.startLine - 1] ?? ""));
}

/** Returns the patched content, or null when the snippet cannot be placed. */
export function applySnippetPatch(content: string, original: string, replacement: string): string | null {
  const location = locateSnippet(content, original);
  if (!location) return null;
  return applyPatches(content, [{ ...location, applicable: true, replacementLines: replacementLinesAt(content, location, replacement) }]);
}

/**
 * Applies the applicable patches of one file by their recorded line ranges,
 * from the bottom of the file up so earlier ranges stay valid. A patch whose
 * range overlaps one already applied is skipped.
 */
export function applyPatches(content: string, patches: readonly LocatedPatch[]): string {
  const lines = content.split("\n");
  const applied: { start: number; end: number }[] = [];
  const located = patches
    .filter((patch) => patch.applicable && patch.startLine !== null && patch.endLine !== null && patch.replacementLines !== null)
    .map((patch) => ({ start: patch.startLine!, end: patch.endLine!, replacement: patch.replacementLines! }))
    .sort((a, b) => b.start - a.start);
  for (const patch of located) {
    if (applied.some((range) => patch.start <= range.end && range.start <= patch.end)) continue;
    lines.splice(patch.start - 1, patch.end - patch.start + 1, ...patch.replacement);
    applied.push(patch);
  }
  return lines.join("\n");
}

/** An empty replacement deletes the snippet: it contributes no lines at all. */
function linesOf(replacement: string): string[] {
  const trimmed = trimBlankEdges(replacement);
  return trimmed.trim() === "" ? [] : trimmed.split("\n");
}

function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

function reindent(lines: readonly string[], indent: string): string[] {
  const base = Math.min(...lines.filter((l) => l.trim()).map((l) => leadingWhitespace(l).length));
  return lines.map((line) => (line.trim() ? indent + line.slice(Number.isFinite(base) ? base : 0) : line));
}
