import { describe, expect, it } from 'vitest';
import { statusCounts, typeCounts } from '../src/renderer/library-counts.js';
import { LibraryFeed, type FeedPage, type FetchPage } from '../src/renderer/library-feed.js';

type W = { id: string; title: string };

/** A fake service: `rows` in order, paged by an index cursor. */
function service(rows: W[]): FetchPage<W> & { calls: number } {
  const fn = ((cursor: string | null, limit: number): Promise<FeedPage<W>> => {
    fn.calls += 1;
    const start = cursor === null ? 0 : Number(cursor);
    const items = rows.slice(start, start + limit);
    const end = start + items.length;
    return Promise.resolve({
      items,
      next_cursor: end < rows.length ? String(end) : null,
      total: rows.length,
    });
  }) as FetchPage<W> & { calls: number };
  fn.calls = 0;
  return fn;
}

const works = (n: number, from = 1): W[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${String(from + i)}`,
    title: `作品 ${String(from + i)}`,
  }));

describe('作品庫分頁 (QC-067)', () => {
  it('loads a page at a time until every work is there', async () => {
    const rows = works(130);
    const feed = new LibraryFeed(service(rows), 60);
    await feed.reset(service(rows));
    expect(feed.getSnapshot().items).toHaveLength(60);
    expect(feed.getSnapshot()).toMatchObject({ total: 130, hasMore: true });
    await feed.loadMore();
    await feed.loadMore();
    const s = feed.getSnapshot();
    expect(s.items?.map((w) => w.id)).toEqual(rows.map((w) => w.id));
    expect(s.hasMore).toBe(false);
    // Nothing left: no more requests.
    const fetch = service(rows);
    await feed.reset(fetch);
    await feed.loadMore();
    await feed.loadMore();
    const calls = fetch.calls;
    await feed.loadMore();
    expect(fetch.calls).toBe(calls);
  });

  it('never shows a work twice when one moved up while paging', async () => {
    const rows = works(5);
    const fetch: FetchPage<W> = (cursor) => {
      // The second page repeats w3 (it was edited and moved) before the rest.
      if (cursor === null)
        return Promise.resolve({ items: rows.slice(0, 3), next_cursor: 'p2', total: 5 });
      return Promise.resolve({
        items: [rows[2] as W, ...rows.slice(3)],
        next_cursor: null,
        total: 5,
      });
    };
    const feed = new LibraryFeed(fetch, 3);
    await feed.reset(fetch);
    await feed.loadMore();
    expect(feed.getSnapshot().items?.map((w) => w.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });

  it('a page that arrives after the filter changed is dropped', async () => {
    let release: (() => void) | null = null;
    const slow: FetchPage<W> = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ items: works(3, 100), next_cursor: null, total: 3 });
        };
      });
    const feed = new LibraryFeed(slow, 60);
    const first = feed.reset(slow);
    await feed.reset(service(works(2)));
    const done = release as (() => void) | null;
    done?.();
    await first;
    expect(feed.getSnapshot().items?.map((w) => w.id)).toEqual(['w1', 'w2']);
  });

  it('refresh reads again as deep as was loaded, and keeps going from there', async () => {
    const rows = works(150);
    const feed = new LibraryFeed(service(rows), 60);
    await feed.reset(service(rows));
    await feed.loadMore();
    expect(feed.getSnapshot().items).toHaveLength(120);
    // A new work arrives at the top.
    rows.unshift({ id: 'new', title: '新作品' });
    await feed.refresh();
    const s = feed.getSnapshot();
    expect(s.items?.[0]?.id).toBe('new');
    expect(s.items?.length).toBeGreaterThanOrEqual(120);
    expect(s.total).toBe(151);
    await feed.loadMore();
    expect(feed.getSnapshot().items).toHaveLength(151);
  });

  it('patch and remove change the loaded works and the total', async () => {
    const rows = works(4);
    const feed = new LibraryFeed(service(rows), 60);
    await feed.reset(service(rows));
    feed.patch('w2', { title: '改名' });
    feed.remove(new Set(['w1', 'w4']));
    const s = feed.getSnapshot();
    expect(s.items).toEqual([
      { id: 'w2', title: '改名' },
      { id: 'w3', title: '作品 3' },
    ]);
    expect(s.total).toBe(2);
  });

  it('a failed page says so and can be tried again', async () => {
    let fail = true;
    const rows = works(3);
    const ok = service(rows);
    const flaky: FetchPage<W> = (cursor, limit) =>
      fail ? Promise.reject(new Error('down')) : ok(cursor, limit);
    const feed = new LibraryFeed(flaky, 60);
    await feed.reset(flaky);
    expect(feed.getSnapshot()).toMatchObject({ failed: true, items: null });
    fail = false;
    await feed.loadMore();
    expect(feed.getSnapshot()).toMatchObject({ failed: false, total: 3 });
  });
});

describe('篩選數量來自服務的總數 (QC-067)', () => {
  it('sums the (type, status) counts; missing pairs are zero', () => {
    const by = {
      article: { drafting: 150, ready: 50 },
      image: { drafting: 120, published: 80 },
    };
    expect(typeCounts(by)).toEqual({ all: 400, article: 200, image: 200, video: 0, mixed: 0 });
    expect(statusCounts(by, 'all')).toEqual({
      all: 400,
      drafting: 270,
      in_review: 0,
      ready: 50,
      published: 80,
    });
    expect(statusCounts(by, 'image')).toEqual({
      all: 200,
      drafting: 120,
      in_review: 0,
      ready: 0,
      published: 80,
    });
    expect(statusCounts({}, 'video').all).toBe(0);
  });
});
