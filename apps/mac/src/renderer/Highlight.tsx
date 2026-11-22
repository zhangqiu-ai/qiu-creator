import {
  findMatches,
  matchesSearch,
  PINYIN_LONG_TEXT_MIN_LENGTH,
  type SearchOptions,
} from '@qiu-creator/domain/search';
import { t } from './i18n.js';
import { createContext, Fragment, useContext, useMemo, type ReactNode } from 'react';

/**
 * 搜尋高亮 (QC-068): the words a search typed are marked wherever the page
 * shows them (titles, excerpts, file names), by the same matching the service
 * searches with (full/half width, letter case, Traditional/Simplified alike).
 *
 * The page provides the query once; it changes on every keystroke but never
 * mid-composition, so an IME's half-typed pinyin or zhuyin never marks text.
 */
const SearchQuery = createContext('');

export function SearchHighlight({ query, children }: { query: string; children: ReactNode }) {
  return <SearchQuery.Provider value={query}>{children}</SearchQuery.Provider>;
}

/**
 * Body text and its excerpts (QC-079): a pinyin query needs 4 letters there,
 * as on the service (two initials like `cy` would match nearly every article).
 */
const LONG_TEXT: SearchOptions = { pinyinMinLength: PINYIN_LONG_TEXT_MIN_LENGTH };

/** Characters kept before the first hit when a passage is cut to show it. */
const LEAD = 10;

/**
 * A passage cut to begin a little before its first hit, so a clamped cover
 * or a one-line row shows the hit rather than the words leading up to it.
 */
export function leadToHit(text: string, query: string, options?: SearchOptions): string {
  const first = findMatches(text, query, options)[0];
  if (first === undefined) return text;
  const before = Array.from(text.slice(0, first.start));
  if (before.length <= LEAD + 1) return text;
  return `…${before.slice(-LEAD).join('')}${text.slice(first.start)}`;
}

/** A passage of the text, starting near its first hit, with every hit marked. */
export function HitPassage({ text }: { text: string }) {
  const query = useContext(SearchQuery);
  return <Highlight text={leadToHit(text, query, LONG_TEXT)} long />;
}

/**
 * `text`, with every hit of the page's search wrapped in `<mark>`. `long`:
 * body text or an excerpt of it (pinyin needs a longer query there).
 */
export function Highlight({ text, long = false }: { text: string; long?: boolean }) {
  const query = useContext(SearchQuery);
  const ranges = useMemo(
    () => findMatches(text, query, long ? LONG_TEXT : undefined),
    [text, query, long],
  );
  if (ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at)
      out.push(<Fragment key={`t${String(at)}`}>{text.slice(at, r.start)}</Fragment>);
    out.push(
      <mark key={r.start} className="hit">
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  }
  if (at < text.length) out.push(<Fragment key={`t${String(at)}`}>{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

/**
 * Where a search hit that is not in the title shows (QC-069, PT-20261122-001):
 * 「內文 …passage…」 for a hit in the text (the service's `match_excerpt`), or
 * 「標籤 #tag」 for a hit only in the tags. A text card shows the passage on
 * its cover instead (`inCover`), so here it is only read out.
 */
export function HitLine({
  title,
  tags,
  excerpt,
  inCover = false,
  className = 'hitline',
}: {
  title: string;
  tags: readonly string[];
  excerpt: string | null | undefined;
  inCover?: boolean;
  className?: string;
}) {
  const query = useContext(SearchQuery);
  if (query.trim() === '' || matchesSearch(title, query)) return null;
  if (excerpt != null) {
    if (inCover) return <span className="visually-hidden">{excerpt}</span>;
    return (
      <span className={className}>
        <span className="hitline__k">{t('library.hitBody')}</span>
        <HitPassage text={excerpt} />
      </span>
    );
  }
  const hits = tags.filter((tag) => matchesSearch(tag, query));
  if (hits.length === 0) return null;
  return (
    <span className={className}>
      <span className="hitline__k">{t('library.hitTags')}</span>
      {hits.map((tag) => (
        <span key={tag} className="hitline__tag">
          #<Highlight text={tag} />
        </span>
      ))}
    </span>
  );
}
