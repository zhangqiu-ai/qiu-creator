import { pinyin } from 'pinyin-pro';
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

/**
 * Every place `query` occurs in `text`, in order and not overlapping: as
 * folded text, and (QC-079) as pinyin of the characters, ranges always in
 * the original text, so `cy` marks 「常用」.
 */
export function findMatches(
  text: string,
  query: string,
  options: SearchOptions = {},
): MatchRange[] {
  const literal = literalMatches(text, query);
  const key = pinyinKey(query, options.pinyinMinLength);
  if (key === null) return literal;
  return mergeRanges([...literal, ...pinyinRanges(text, key)]);
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: MatchRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.start < last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function literalMatches(text: string, query: string): MatchRange[] {
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

/** Whether `query` occurs in `text`, as folded text or as pinyin (QC-079). */
export function matchesSearch(text: string, query: string, options: SearchOptions = {}): boolean {
  const key = searchKey(query);
  if (key === '') return false;
  if (foldForSearch(text).includes(key)) return true;
  const py = pinyinKey(query, options.pinyinMinLength);
  return py !== null && matchesPinyinFolded(foldForSearch(text), py);
}

/**
 * A passage of `text` around the first match, at most `max` characters, with
 * `…` where it was cut, for a card whose title does not show the hit. Null
 * when the query does not occur.
 */
export function matchExcerpt(
  text: string,
  query: string,
  max: number,
  options: SearchOptions = {},
): string | null {
  const first = findMatches(text, query, options)[0];
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

/** A language the AI can be told to write in (QC-075). */
export type DetectedLanguage = 'zh-Hans' | 'zh-Hant' | 'en';

let simplifiedOnly: Set<string> | null = null;

/** Simplified forms that are not themselves Traditional characters (from the same table). */
function simplifiedChars(): Set<string> {
  if (simplifiedOnly !== null) return simplifiedOnly;
  const map = t2s();
  simplifiedOnly = new Set();
  for (const [from, to] of map) {
    if (to !== from && !map.has(to)) simplifiedOnly.add(to);
  }
  return simplifiedOnly;
}

/**
 * The language of a passage for 「跟隨原文」 (QC-075), shared by the service
 * (which tells the AI) and the app (which shows 「這段是繁體中文」):
 * - English when Latin letters clearly outnumber Han characters (or there
 *   are no Han characters and at least 3 letters);
 * - otherwise Traditional or Simplified by which characters only one script
 *   uses (OpenCC's table), the larger count winning;
 * - null when it cannot tell (numbers only, or Han text with no telling
 *   characters, or a tie): use the interface language then.
 */
export function detectLanguage(text: string): DetectedLanguage | null {
  const map = t2s();
  const simp = simplifiedChars();
  let han = 0;
  let latin = 0;
  let traditional = 0;
  let simplified = 0;
  for (const c of text) {
    if (/[A-Za-z]/.test(c)) {
      latin += 1;
      continue;
    }
    if (!/\p{Script=Han}/u.test(c)) continue;
    han += 1;
    const to = map.get(c);
    if (to !== undefined && to !== c) traditional += 1;
    else if (simp.has(c)) simplified += 1;
  }
  if (han === 0) return latin >= 3 ? 'en' : null;
  if (latin > han * 2) return 'en';
  if (traditional > simplified) return 'zh-Hant';
  if (simplified > traditional) return 'zh-Hans';
  return null;
}

// ---- Pinyin (QC-079) ------------------------------------------------------------------

/**
 * The query as pinyin, or null when it is not one: letters only (spaces and
 * apostrophes dropped, case and width folded), at least 2 of them. `ü` is
 * typed `v` (or `u`).
 */
export function pinyinKey(query: string, minLength = PINYIN_MIN_LENGTH): string | null {
  const key = searchKey(query).replace(/[\s'’]/g, '');
  return /^[a-z]+$/.test(key) && key.length >= minLength ? key : null;
}

/** Shortest pinyin query for titles, tags and asset names. */
export const PINYIN_MIN_LENGTH = 2;
/**
 * Shortest pinyin query for long text (work bodies, their excerpts): two
 * initials such as `cy` occur somewhere in almost any article, so the body
 * needs at least four letters (`qtlx` 秋天旅行, `jingdu` 京都).
 */
export const PINYIN_LONG_TEXT_MIN_LENGTH = 4;

export interface SearchOptions {
  /** Shortest query matched as pinyin; default `PINYIN_MIN_LENGTH`. */
  pinyinMinLength?: number;
}

const readingCache = new Map<string, readonly string[] | null>();

/**
 * Every reading of one folded (Simplified, lower-case) character, without
 * tones, `ü` as `v` and `u`; null when it is not a Han character.
 */
function readings(c: string): readonly string[] | null {
  const cached = readingCache.get(c);
  if (cached !== undefined) return cached;
  let out: string[] | null = null;
  if (/^\p{Script=Han}$/u.test(c)) {
    const raw = pinyin(c, { toneType: 'none', type: 'array', multiple: true });
    const set = new Set<string>();
    for (const r of raw) {
      const plain = r.toLowerCase();
      if (!/^[a-zü]+$/.test(plain)) continue;
      set.add(plain.replaceAll('ü', 'v'));
      set.add(plain.replaceAll('ü', 'u'));
    }
    out = set.size === 0 ? null : [...set];
  }
  readingCache.set(c, out);
  return out;
}

/** What one reading may be typed as: the whole syllable, its initial (zh/ch/sh too). */
function spellings(reading: string): string[] {
  const out = [reading];
  const two = reading.slice(0, 2);
  if (two === 'zh' || two === 'ch' || two === 'sh') out.push(two);
  out.push(reading.charAt(0));
  return out;
}

/**
 * Where `key` (from `pinyinKey`) is spelt by consecutive characters of a
 * folded sequence: each Han character by any reading, its initial, or (the
 * last one) the start of a reading; other characters as themselves. Returns
 * the index after the last character used, or -1.
 */
function matchAt(chars: readonly string[], start: number, key: string): number {
  const failed = new Set<number>();
  const step = (idx: number, pos: number): number => {
    if (pos === key.length) return idx;
    if (idx >= chars.length) return -1;
    const memo = idx * (key.length + 1) + pos;
    if (failed.has(memo)) return -1;
    const c = chars[idx] ?? '';
    const rs = readings(c);
    if (rs === null) {
      if (c !== '' && key.startsWith(c, pos)) {
        const end = step(idx + 1, pos + c.length);
        if (end !== -1) return end;
      }
    } else {
      const rest = key.slice(pos);
      for (const r of rs) {
        for (const s of spellings(r)) {
          if (key.startsWith(s, pos)) {
            const end = step(idx + 1, pos + s.length);
            if (end !== -1) return end;
          }
        }
        // The last syllable may be only partly typed (`changyo`).
        if (r.startsWith(rest)) return idx + 1;
      }
    }
    failed.add(memo);
    return -1;
  };
  return step(start, 0);
}

const startMasks = new Map<string, number>();

/** Bit per letter a–z that some reading of a Han character starts with; 0 for others. */
function startMask(c: string): number {
  const cached = startMasks.get(c);
  if (cached !== undefined) return cached;
  let mask = 0;
  for (const r of readings(c) ?? []) mask |= 1 << (r.charCodeAt(0) - 97);
  startMasks.set(c, mask);
  return mask;
}

/** Whether a quick look at one character says a match could start there. */
function canStart(c: string, first: string): boolean {
  const mask = startMask(c);
  if (mask === 0) return c.startsWith(first);
  return (mask & (1 << (first.charCodeAt(0) - 97))) !== 0;
}

/** Pinyin match over text that is already folded (`foldForSearch`), as the index stores it. */
export function matchesPinyinFolded(folded: string, key: string): boolean {
  const first = key.charAt(0);
  // Cheap pass first: most texts have no character a match could start at.
  let chars: string[] | null = null;
  let i = 0;
  for (const c of folded) {
    if (canStart(c, first)) {
      chars ??= Array.from(folded);
      if (matchAt(chars, i, key) !== -1) return true;
    }
    i += 1;
  }
  return false;
}

/** Pinyin matches of `key` in `text`, as ranges of the original text. */
function pinyinRanges(text: string, key: string): MatchRange[] {
  // One folded unit per original character, with where it came from.
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = foldChar(c);
    chars.push(Array.from(f)[0] ?? f);
    from.push(i);
    to.push(i + c.length);
    i += c.length;
  }
  const out: MatchRange[] = [];
  const first = key.charAt(0);
  for (let k = 0; k < chars.length; k += 1) {
    if (!canStart(chars[k] ?? '', first)) continue;
    const end = matchAt(chars, k, key);
    if (end === -1) continue;
    out.push({ start: from[k] ?? 0, end: to[end - 1] ?? text.length });
    k = end - 1;
  }
  return out;
}
