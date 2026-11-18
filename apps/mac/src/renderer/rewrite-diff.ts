/**
 * Sentence-level diff for AI rewrite candidates (QC-024): the candidate is
 * split into 「處」 (hunks) the user can accept one by one. Tokenising is
 * lossless, so accepting every hunk gives exactly the candidate text and
 * accepting none gives exactly the original.
 */

const TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n', '…']);
const CLOSERS = new Set(['」', '』', '”', '"', '’', "'", '）', ')', '》', '】']);

/** Split into sentences, keeping every character (punctuation and closing quotes stay with their sentence). */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const chars = text;
  while (i < chars.length) {
    const c = chars[i] as string;
    const englishStop = c === '.' && (i + 1 === chars.length || /\s/.test(chars[i + 1] as string));
    if (TERMINATORS.has(c) || englishStop) {
      let j = i + 1;
      while (
        j < chars.length &&
        (TERMINATORS.has(chars[j] as string) || CLOSERS.has(chars[j] as string))
      )
        j++;
      // Trailing spaces after an English full stop belong to the sentence.
      if (englishStop) while (j < chars.length && chars[j] === ' ') j++;
      out.push(chars.slice(start, j));
      start = j;
      i = j;
    } else {
      i++;
    }
  }
  if (start < chars.length) out.push(chars.slice(start));
  return out;
}

export type Segment =
  { kind: 'same'; text: string } | { kind: 'change'; before: string; after: string; index: number };

const MAX_CELLS = 1_000_000;

/**
 * Diff `before` → `after` by sentence. A run of changed sentences becomes one
 * hunk per sentence when the counts match, otherwise one hunk for the run.
 */
export function diffSentences(before: string, after: string): Segment[] {
  const a = sentences(before);
  const b = sentences(after);
  const n = a.length;
  const m = b.length;
  type Op = { kind: 'same' | 'del' | 'ins'; text: string };
  const ops: Op[] = [];
  if (n * m > MAX_CELLS) {
    ops.push(...a.map((text): Op => ({ kind: 'del', text })));
    ops.push(...b.map((text): Op => ({ kind: 'ins', text })));
  } else {
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i] as Uint32Array;
      const next = lcs[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j--) {
        row[j] =
          a[i] === b[j]
            ? (next[j + 1] as number) + 1
            : Math.max(next[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ kind: 'same', text: a[i] as string });
        i++;
        j++;
      } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
        ops.push({ kind: 'del', text: a[i++] as string });
      } else {
        ops.push({ kind: 'ins', text: b[j++] as string });
      }
    }
    while (i < n) ops.push({ kind: 'del', text: a[i++] as string });
    while (j < m) ops.push({ kind: 'ins', text: b[j++] as string });
  }

  const segments: Segment[] = [];
  let index = 0;
  let dels: string[] = [];
  let inss: string[] = [];
  const flush = () => {
    if (dels.length === 0 && inss.length === 0) return;
    // Sentence for sentence (the usual polish): one 處 per sentence; otherwise one for the run.
    const pairs =
      dels.length === inss.length
        ? dels.map((d, i) => [d, inss[i] as string] as const)
        : [[dels.join(''), inss.join('')] as const];
    for (const [before, after] of pairs) {
      segments.push({ kind: 'change', before, after, index: index++ });
    }
    dels = [];
    inss = [];
  };
  for (const op of ops) {
    if (op.kind === 'del') dels.push(op.text);
    else if (op.kind === 'ins') inss.push(op.text);
    else {
      flush();
      const last = segments[segments.length - 1];
      if (last?.kind === 'same') last.text += op.text;
      else segments.push({ kind: 'same', text: op.text });
    }
  }
  flush();
  return segments;
}

/** Number of hunks in a diff. */
export function hunkCount(segments: readonly Segment[]): number {
  return segments.filter((s) => s.kind === 'change').length;
}

/** The text with the picked hunks taken from the candidate and the rest kept from the original. */
export function composeSegments(segments: readonly Segment[], picks: readonly boolean[]): string {
  return segments
    .map((s) => (s.kind === 'same' ? s.text : picks[s.index] === true ? s.after : s.before))
    .join('');
}

/** Replace `range` of `markdown` with `text`. */
export function splice(
  markdown: string,
  range: { start: number; end: number },
  text: string,
): string {
  return markdown.slice(0, range.start) + text + markdown.slice(range.end);
}

/**
 * 插入: keep the original and add the candidate as a new block right after
 * the rewritten range, separated by a blank line on both sides.
 */
export function insertAfter(
  markdown: string,
  range: { start: number; end: number },
  text: string,
): string {
  const head = markdown.slice(0, range.end).replace(/\s+$/, '');
  const tail = markdown.slice(range.end).replace(/^\s+/, '');
  const block = text.trim();
  if (tail === '') return `${head}\n\n${block}\n`;
  return `${head}\n\n${block}\n\n${tail}`;
}
