/**
 * Line-level change sets for agent proposals (QC-089). Pure functions, no
 * I/O, shared by the server and (later) the apps.
 *
 * A proposal is split into hunks against its base text. Later edits of the
 * work are split the same way (base → current). A hunk overlaps a later edit
 * when their base line ranges intersect or touch at an insertion point;
 * non-overlapping hunks can be applied to the current text because the base
 * lines they replace are unchanged there.
 *
 * Lines are `text.split('\n')`, so joining with `\n` restores the text
 * exactly. Ranges are 0-based, end exclusive.
 */

export interface LineRange {
  start: number;
  end: number;
}

/** A change from base to another text: base lines `[base_start, base_end)` became `added`. */
export interface LineChange {
  base_start: number;
  base_end: number;
  /** Where the change sits in the other text. */
  other_start: number;
  other_end: number;
  removed: string[];
  added: string[];
}

export interface ProposalHunkData {
  id: string;
  base_start: number;
  base_end: number;
  removed: string[];
  added: string[];
}

type Op = { kind: 'same' | 'removed' | 'added'; a: number; b: number };

/** Above this many LCS cells the differing middle is treated as one replacement. */
const MAX_CELLS = 4_000_000;

export const splitLines = (text: string): string[] => text.split('\n');

/** Edit script from `a` to `b` (LCS on lines, common head and tail trimmed first). */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'same', a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) ops.push({ kind: 'removed', a: i, b: start });
    for (let j = start; j < endB; j++) ops.push({ kind: 'added', a: endA, b: j });
  } else {
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i] as Uint32Array;
      const next = lcs[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j--) {
        row[j] =
          a[start + i] === b[start + j]
            ? (next[j + 1] as number) + 1
            : Math.max(next[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ kind: 'same', a: start + i, b: start + j });
        i++;
        j++;
      } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
        ops.push({ kind: 'removed', a: start + i, b: start + j });
        i++;
      } else {
        ops.push({ kind: 'added', a: start + i, b: start + j });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ kind: 'removed', a: start + i, b: start + j });
    for (; j < m; j++) ops.push({ kind: 'added', a: start + i, b: start + j });
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ kind: 'same', a: endA + k, b: endB + k });
  return ops;
}

/** Maximal runs of changed lines from `base` to `other`. */
export function lineChanges(base: readonly string[], other: readonly string[]): LineChange[] {
  const out: LineChange[] = [];
  let current: LineChange | null = null;
  for (const op of diffOps(base, other)) {
    if (op.kind === 'same') {
      if (current !== null) out.push(current);
      current = null;
      continue;
    }
    current ??= {
      base_start: op.a,
      base_end: op.a,
      other_start: op.b,
      other_end: op.b,
      removed: [],
      added: [],
    };
    if (op.kind === 'removed') {
      current.removed.push(base[op.a] as string);
      current.base_end = op.a + 1;
    } else {
      current.added.push(other[op.b] as string);
      current.other_end = op.b + 1;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/** A proposal's hunks against its base, with stable ids `h1`, `h2`, … in text order. */
export function proposalHunks(base: string, proposed: string): ProposalHunkData[] {
  return lineChanges(splitLines(base), splitLines(proposed)).map((c, i) => ({
    id: `h${String(i + 1)}`,
    base_start: c.base_start,
    base_end: c.base_end,
    removed: c.removed,
    added: c.added,
  }));
}

/**
 * Whether two base ranges collide: they share a line, or one is an
 * insertion point inside or at the edge of the other.
 */
export function rangesOverlap(x: LineRange, y: LineRange): boolean {
  if (x.start < y.end && y.start < x.end) return true;
  const point = x.start === x.end || y.start === y.end;
  return point && x.start <= y.end && y.start <= x.end;
}

const rangeOf = (c: { base_start: number; base_end: number }): LineRange => ({
  start: c.base_start,
  end: c.base_end,
});

/** Ids of hunks that collide with edits made between base and current. */
export function overlappingHunks(
  base: string,
  current: string,
  hunks: readonly ProposalHunkData[],
): Set<string> {
  const edits = lineChanges(splitLines(base), splitLines(current)).map(rangeOf);
  return new Set(
    hunks.filter((h) => edits.some((e) => rangesOverlap(rangeOf(h), e))).map((h) => h.id),
  );
}

/** Index in `current` of each unchanged base line (null for changed ones). */
function baseToCurrent(base: readonly string[], current: readonly string[]): (number | null)[] {
  const map: (number | null)[] = base.map(() => null);
  for (const op of diffOps(base, current)) if (op.kind === 'same') map[op.a] = op.b;
  return map;
}

export class HunkConflictError extends Error {
  constructor(readonly hunkIds: string[]) {
    super(`hunks overlap later edits: ${hunkIds.join(', ')}`);
    this.name = 'HunkConflictError';
  }
}

/**
 * Apply `hunks` (made against `base`) to `current`. Throws
 * `HunkConflictError` when any of them overlaps edits made since the base.
 */
export function applyHunks(
  base: string,
  current: string,
  hunks: readonly ProposalHunkData[],
): string {
  const conflicting = overlappingHunks(base, current, hunks);
  if (conflicting.size > 0) throw new HunkConflictError([...conflicting]);
  const baseLines = splitLines(base);
  const lines = splitLines(current);
  const map = baseToCurrent(baseLines, lines);
  // Where base line `i` sits in current; base lines around a hunk are unchanged.
  const at = (i: number): number => {
    if (i < baseLines.length) {
      const mapped = map[i];
      if (mapped !== null && mapped !== undefined) return mapped;
    }
    if (i > 0) {
      const before = map[i - 1];
      if (before !== null && before !== undefined) return before + 1;
    }
    return i === 0 ? 0 : lines.length;
  };
  const sorted = [...hunks].sort((x, y) => y.base_start - x.base_start);
  for (const h of sorted) {
    const start = at(h.base_start);
    lines.splice(start, h.base_end - h.base_start, ...h.added);
  }
  return lines.join('\n');
}

export interface ConflictRegion {
  hunk_ids: string[];
  base_start: number;
  base_end: number;
  base: string;
  mine: string;
  theirs: string;
}

/** Text of `other` for the base region `[start, end)`, following an edit script. */
function regionText(base: readonly string[], other: readonly string[], r: LineRange): string {
  const out: string[] = [];
  for (const op of diffOps(base, other)) {
    const inside =
      op.kind === 'added' ? op.a >= r.start && op.a <= r.end : op.a >= r.start && op.a < r.end;
    if (inside && op.kind !== 'removed') out.push(other[op.b] as string);
  }
  return out.join('\n');
}

/**
 * Three-way merge input for the hunks that overlap later edits: each region
 * spans the overlapping hunks and edits, with its base, current ("mine") and
 * proposed ("theirs") text.
 */
export function conflictRegions(
  base: string,
  current: string,
  proposed: string,
  hunks: readonly ProposalHunkData[],
): ConflictRegion[] {
  const baseLines = splitLines(base);
  const currentLines = splitLines(current);
  const proposedLines = splitLines(proposed);
  const edits = lineChanges(baseLines, currentLines).map(rangeOf);
  const regions: { range: LineRange; ids: string[] }[] = [];
  for (const h of hunks) {
    const hit = edits.filter((e) => rangesOverlap(rangeOf(h), e));
    if (hit.length === 0) continue;
    const range = {
      start: Math.min(h.base_start, ...hit.map((e) => e.start)),
      end: Math.max(h.base_end, ...hit.map((e) => e.end)),
    };
    const merged = regions.find((r) => rangesOverlap(r.range, range));
    if (merged === undefined) regions.push({ range, ids: [h.id] });
    else {
      merged.range = {
        start: Math.min(merged.range.start, range.start),
        end: Math.max(merged.range.end, range.end),
      };
      merged.ids.push(h.id);
    }
  }
  return regions.map(({ range, ids }) => ({
    hunk_ids: ids,
    base_start: range.start,
    base_end: range.end,
    base: baseLines.slice(range.start, range.end).join('\n'),
    mine: regionText(baseLines, currentLines, range),
    theirs: regionText(baseLines, proposedLines, range),
  }));
}
