import { findMatches } from '@qiu-creator/domain/search';
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

/** `text`, with every hit of the page's search wrapped in `<mark>`. */
export function Highlight({ text }: { text: string }) {
  const query = useContext(SearchQuery);
  const ranges = useMemo(() => findMatches(text, query), [text, query]);
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
