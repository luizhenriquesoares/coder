/**
 * Locating and applying the implementer's patches.
 *
 * A patch replaces an `original` snippet of the head file. Models often get
 * indentation slightly wrong, so when the exact text is not found we fall back
 * to matching line by line with surrounding whitespace ignored.
 */

export interface SnippetLocation {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly exact: boolean;
}

export function locateSnippet(content: string, snippet: string): SnippetLocation | null {
  const needle = trimBlankEdges(snippet).split("\n");
  if (needle.every((line) => line.trim() === "")) return null;
  const haystack = content.split("\n");
  // Patches replace whole lines, so a snippet must match whole lines too.
  return (
    locateLines(haystack, needle, (line) => line.replace(/\s+$/, ""), true) ??
    locateLines(haystack, needle, (line) => line.trim(), false)
  );
}

function locateLines(
  haystack: readonly string[],
  needle: readonly string[],
  normalize: (line: string) => string,
  exact: boolean,
): SnippetLocation | null {
  const lines = haystack.map(normalize);
  const wanted = needle.map(normalize);
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (wanted.every((line, offset) => lines[start + offset] === line)) {
      return { startLine: start + 1, endLine: start + wanted.length, exact };
    }
  }
  return null;
}

/** Returns the patched content, or null when the snippet cannot be found. */
export function applySnippetPatch(content: string, original: string, replacement: string): string | null {
  const location = locateSnippet(content, original);
  if (!location) return null;
  const lines = content.split("\n");
  const replacementLines = linesOf(replacement);
  const replaced = location.exact
    ? replacementLines
    : reindent(replacementLines, leadingWhitespace(lines[location.startLine - 1] ?? ""));
  lines.splice(location.startLine - 1, location.endLine - location.startLine + 1, ...replaced);
  return lines.join("\n");
}

/** An empty replacement deletes the snippet: it contributes no lines at all. */
function linesOf(replacement: string): string[] {
  const trimmed = trimBlankEdges(replacement);
  return trimmed.trim() === "" ? [] : trimmed.split("\n");
}

/** Applies several patches to the same file in order; skips the ones that no longer apply. */
export function applyPatches(content: string, patches: readonly { original: string; replacement: string }[]): string {
  return patches.reduce((current, patch) => applySnippetPatch(current, patch.original, patch.replacement) ?? current, content);
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
