import type { ChangeSet } from "../change/ChangeSet.js";
import type { CodeLocation } from "./model.js";

export interface LocationDraft {
  readonly path: string | null;
  readonly line: number | null;
  readonly quote: string;
}

/** Head-side contents of the files in a change set, keyed by path. */
export type HeadContents = ReadonlyMap<string, string>;

/**
 * Models miscount lines. A finding is re-anchored by searching the quoted
 * code in the head version of the file and choosing the occurrence closest to
 * the line the reviewer claimed.
 */
export function anchorLocation(draft: LocationDraft, changeSet: ChangeSet, contents: HeadContents): CodeLocation {
  const path = draft.path ? changeSet.resolvePath(draft.path) : null;
  if (!path) return { path: null, line: null, quote: draft.quote, anchored: false };

  const text = contents.get(path);
  const claimed = draft.line && draft.line > 0 ? draft.line : null;
  if (text === undefined) return { path, line: claimed, quote: draft.quote, anchored: false };

  const matches = findQuoteLines(text, draft.quote);
  if (matches.length > 0) {
    const line = claimed === null ? matches[0]! : closestTo(matches, claimed);
    return { path, line, quote: draft.quote, anchored: true };
  }
  const lineCount = text.split("\n").length;
  const line = claimed !== null && claimed <= lineCount ? claimed : null;
  return { path, line, quote: draft.quote, anchored: false };
}

/** 1-based line numbers where the first meaningful line of `quote` appears. */
export function findQuoteLines(text: string, quote: string): number[] {
  const needle = firstMeaningfulLine(quote);
  if (needle.length < 3) return [];
  const lines = text.split("\n");
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (line.includes(needle) || normalizeSpaces(line).includes(normalizeSpaces(needle))) hits.push(index + 1);
  });
  return hits;
}

function firstMeaningfulLine(quote: string): string {
  return (
    quote
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function closestTo(candidates: readonly number[], target: number): number {
  return candidates.reduce((best, current) => (Math.abs(current - target) < Math.abs(best - target) ? current : best));
}
