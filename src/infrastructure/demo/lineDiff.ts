/**
 * A small line-based diff (longest common subsequence) that renders unified
 * hunks. Demo fixtures store both versions of each file; the patch shown to
 * the council is computed from them so the two can never disagree.
 */

type Op = { readonly kind: "context" | "add" | "del"; readonly text: string };

export interface UnifiedDiff {
  readonly patch: string;
  readonly additions: number;
  readonly deletions: number;
}

export function unifiedDiff(original: string, modified: string, contextLines = 3): UnifiedDiff {
  const ops = diffLines(splitLines(original), splitLines(modified));
  const additions = ops.filter((op) => op.kind === "add").length;
  const deletions = ops.filter((op) => op.kind === "del").length;
  return { patch: renderHunks(ops, contextLines), additions, deletions };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i++]! });
    } else {
      ops.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ kind: "del", text: a[i++]! });
  while (j < b.length) ops.push({ kind: "add", text: b[j++]! });
  return ops;
}

function renderHunks(ops: readonly Op[], contextLines: number): string {
  const changed = ops.map((op, index) => (op.kind === "context" ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return "";

  // Group changes whose surrounding context would overlap into one hunk.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const oldLineAt = prefixCount(ops, (op) => op.kind !== "add");
  const newLineAt = prefixCount(ops, (op) => op.kind !== "del");
  const marker = { context: " ", add: "+", del: "-" } as const;

  return ranges
    .map(({ start, end }) => {
      const slice = ops.slice(start, end + 1);
      const oldCount = slice.filter((op) => op.kind !== "add").length;
      const newCount = slice.filter((op) => op.kind !== "del").length;
      const oldStart = oldCount === 0 ? oldLineAt[start]! : oldLineAt[start]! + 1;
      const newStart = newCount === 0 ? newLineAt[start]! : newLineAt[start]! + 1;
      const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
      return [header, ...slice.map((op) => marker[op.kind] + op.text)].join("\n");
    })
    .join("\n");
}

/** counts[i] = number of ops before index i that satisfy the predicate. */
function prefixCount(ops: readonly Op[], predicate: (op: Op) => boolean): number[] {
  const counts: number[] = [];
  let count = 0;
  for (const op of ops) {
    counts.push(count);
    if (predicate(op)) count++;
  }
  return counts;
}
