/**
 * Line diff for `work_diff` (LCS on lines, common head and tail trimmed
 * first). The same algorithm as the Mac app's `renderer/diff.ts`; kept here so
 * the MCP adapter does not depend on the app.
 */
export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/** Above this many LCS cells the middle is reported as replaced wholesale. */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    return [
      ...head,
      ...midA.map((text): DiffLine => ({ kind: 'removed', text })),
      ...midB.map((text): DiffLine => ({ kind: 'added', text })),
      ...tail,
    ];
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        midA[i] === midB[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ kind: 'same', text: midA[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      mid.push({ kind: 'removed', text: midA[i] as string });
      i++;
    } else {
      mid.push({ kind: 'added', text: midB[j] as string });
      j++;
    }
  }
  while (i < n) mid.push({ kind: 'removed', text: midA[i++] as string });
  while (j < m) mid.push({ kind: 'added', text: midB[j++] as string });
  return [...head, ...mid, ...tail];
}

/**
 * Unified diff (`@@ -a,b +c,d @@` hunks, `context` lines around changes).
 * Empty string when the texts are equal.
 */
export function unifiedDiff(
  before: string,
  after: string,
  labels: { from: string; to: string },
  context = 3,
): string {
  const lines = diffLines(before, after);
  if (lines.every((l) => l.kind === 'same')) return '';
  // Old and new line numbers (1-based) before each diff line.
  const pos: { a: number; b: number }[] = [];
  let a = 1;
  let b = 1;
  for (const l of lines) {
    pos.push({ a, b });
    if (l.kind !== 'added') a++;
    if (l.kind !== 'removed') b++;
  }
  const changed = lines.flatMap((l, k) => (l.kind === 'same' ? [] : [k]));
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const from = Math.max(0, k - context);
    const to = Math.min(lines.length, k + context + 1);
    const last = hunks.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  for (const [from, to] of hunks) {
    const slice = lines.slice(from, to);
    const start = pos[from] ?? { a: 1, b: 1 };
    const oldCount = slice.filter((l) => l.kind !== 'added').length;
    const newCount = slice.filter((l) => l.kind !== 'removed').length;
    out.push(
      `@@ -${String(start.a)},${String(oldCount)} +${String(start.b)},${String(newCount)} @@`,
    );
    for (const l of slice) {
      out.push(`${l.kind === 'same' ? ' ' : l.kind === 'added' ? '+' : '-'}${l.text}`);
    }
  }
  return `${out.join('\n')}\n`;
}
