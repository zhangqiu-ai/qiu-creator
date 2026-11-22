import tsCharacters from '#opencc/ts-characters';

/**
 * 搜尋比對 (QC-068): one rule for what a search matches, shared by the service
 * (which finds works and assets) and the app (which highlights the hits), so a
 * highlight is never shown where the search found nothing, or missed where it
 * found something.
 *
 * Text and query are folded the same way, one character at a time:
 * - NFKC: full-width letters, digits and punctuation equal their half-width
 *   forms (`ＡＢＣ１` = `ABC1`), and compatibility forms their plain ones;
 * - lower case: `Markdown` = `markdown`;
 * - Traditional to Simplified, by single characters (OpenCC's TSCharacters
 *   table): `設計` = `设计`. Character by character, not by phrase, so a few
 *   Traditional characters that share one Simplified form also match each
 *   other (`發`, `髮` → `发`); for search that is the useful side to err on.
 */

let table: Map<string, string> | null = null;

/** Traditional → Simplified for single characters; the first candidate wins. */
function t2s(): Map<string, string> {
  if (table !== null) return table;
  table = new Map();
  for (const entry of tsCharacters.split('|')) {
    const [from, to] = entry.split(' ');
    if (from !== undefined && to !== undefined && from !== '' && to !== '') table.set(from, to);
  }
  return table;
}

function foldChar(c: string): string {
  const plain = c.normalize('NFKC').toLowerCase();
  const map = t2s();
  let out = '';
  for (const p of plain) out += map.get(p) ?? p;
  return out;
}

/** Folded text, with where each of its UTF-16 units came from in the original. */
export interface FoldedText {
  text: string;
  /** For each unit of `text`: the start, in the original, of the character it came from. */
  from: number[];
  /** For each unit of `text`: the end, in the original, of the character it came from. */
  to: number[];
}

/** Fold text for matching, keeping a map back to the original. */
export function foldWithMap(source: string): FoldedText {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const c of source) {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k += 1) {
      from.push(i);
      to.push(i + c.length);
    }
    text += f;
    i += c.length;
  }
  return { text, from, to };
}

/** Fold a query or a text for matching (no map). */
export function foldForSearch(source: string): string {
  let out = '';
  for (const c of source) out += foldChar(c);
  return out;
}

/** The query as the search uses it: trimmed and folded. Empty means "no search". */
export function searchKey(query: string): string {
  return foldForSearch(query.trim());
}

export interface MatchRange {
  /** Inclusive start in the original text. */
  start: number;
  /** Exclusive end in the original text. */
  end: number;
}

/** Every place `query` occurs in `text`, by the folding above, in order and not overlapping. */
export function findMatches(text: string, query: string): MatchRange[] {
  const key = searchKey(query);
  if (key === '' || text === '') return [];
  const folded = foldWithMap(text);
  const out: MatchRange[] = [];
  let at = folded.text.indexOf(key);
  while (at !== -1) {
    const start = folded.from[at] ?? 0;
    const end = folded.to[at + key.length - 1] ?? text.length;
    const last = out[out.length - 1];
    if (last !== undefined && start < last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
    at = folded.text.indexOf(key, at + key.length);
  }
  return out;
}

/** Whether `query` occurs in `text`, by the folding above. */
export function matchesSearch(text: string, query: string): boolean {
  const key = searchKey(query);
  return key !== '' && foldForSearch(text).includes(key);
}

/**
 * A passage of `text` around the first match, at most `max` characters, with
 * `…` where it was cut, for a card whose title does not show the hit. Null
 * when the query does not occur.
 */
export function matchExcerpt(text: string, query: string, max: number): string | null {
  const first = findMatches(text, query)[0];
  if (first === undefined) return null;
  const chars = Array.from(text);
  // Positions in code points, so a cut never splits a surrogate pair.
  const startCp = Array.from(text.slice(0, first.start)).length;
  const hitCp = Array.from(text.slice(first.start, first.end)).length;
  const room = Math.max(0, max - hitCp);
  // A little context before the hit, the rest after it.
  let begin = Math.max(0, startCp - Math.min(Math.floor(room / 3), 24));
  const finish = Math.min(chars.length, begin + max);
  begin = Math.max(0, Math.min(begin, finish - max));
  const body = chars.slice(begin, finish).join('').trim();
  return `${begin > 0 ? '…' : ''}${body}${finish < chars.length ? '…' : ''}`;
}
