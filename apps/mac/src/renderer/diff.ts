export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

const MAX_CELLS = 4_000_000;

/**
 * Line diff (LCS). `removed` = only in `before`, `added` = only in `after`.
 * Very large inputs fall back to "everything replaced" rather than freezing the UI.
 */
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
