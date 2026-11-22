/**
 * 作品庫的分頁清單 (QC-067): the works for one filter, loaded a page at a time
 * with the service's cursor, so a library of any size shows every work. The
 * page asks for more when the end of the list scrolls into view.
 *
 * Kept apart from React so it can be tested with a fake service: pages come
 * from `fetchPage`, and every change is announced to subscribers.
 */

/** One page from the service: works in order, the cursor for the next page, the total count. */
export interface FeedPage<T> {
  items: readonly T[];
  next_cursor: string | null;
  total: number;
}

export type FetchPage<T> = (cursor: string | null, limit: number) => Promise<FeedPage<T>>;

export interface FeedState<T> {
  /** Null before the first page arrives. */
  items: readonly T[] | null;
  /** How many works match in all (not just loaded). */
  total: number | null;
  /** More pages wait on the service. */
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
}

/** Works per page: a few screens of cards, small enough to arrive fast. */
export const PAGE_SIZE = 60;

export class LibraryFeed<T extends { id: string }> {
  private state: FeedState<T> = {
    items: null,
    total: null,
    hasMore: false,
    loading: false,
    failed: false,
  };
  private cursor: string | null = null;
  /** Bumped by every reset/refresh, so a page that arrives late for an old query is dropped. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private fetchPage: FetchPage<T>,
    private readonly pageSize = PAGE_SIZE,
  ) {}

  getSnapshot = (): FeedState<T> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<FeedState<T>>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** A new filter: forget what was loaded and fetch its first page. */
  reset(fetchPage: FetchPage<T>): Promise<void> {
    this.fetchPage = fetchPage;
    this.cursor = null;
    this.generation += 1;
    this.set({ items: null, total: null, hasMore: false, loading: false, failed: false });
    return this.loadMore();
  }

  /** The next page, when there is one and none is on its way. */
  async loadMore(): Promise<void> {
    const { items, hasMore, loading } = this.state;
    if (loading || (items !== null && !hasMore)) return;
    const gen = this.generation;
    this.set({ loading: true, failed: false });
    try {
      const page = await this.fetchPage(this.cursor, this.pageSize);
      if (gen !== this.generation) return;
      this.cursor = page.next_cursor;
      // A work that moved up while paging may arrive twice: keep the first.
      const seen = new Set((items ?? []).map((w) => w.id));
      const fresh = page.items.filter((w) => !seen.has(w.id));
      this.set({
        items: [...(items ?? []), ...fresh],
        total: page.total,
        hasMore: page.next_cursor !== null,
        loading: false,
      });
    } catch {
      if (gen === this.generation) this.set({ loading: false, failed: true });
    }
  }

  /**
   * Read the list again from the top, as far as it was loaded (a change from
   * SSE, another device, or this page's own edits), so the person keeps their
   * place and nothing they scrolled to disappears.
   */
  async refresh(): Promise<void> {
    const want = Math.max(this.state.items?.length ?? 0, this.pageSize);
    const gen = ++this.generation;
    const out: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let total: number;
    try {
      do {
        const page: FeedPage<T> = await this.fetchPage(cursor, this.pageSize);
        if (gen !== this.generation) return;
        for (const w of page.items) {
          if (seen.has(w.id)) continue;
          seen.add(w.id);
          out.push(w);
        }
        cursor = page.next_cursor;
        total = page.total;
      } while (cursor !== null && out.length < want);
      this.cursor = cursor;
      this.set({ items: out, total, hasMore: cursor !== null, loading: false, failed: false });
    } catch {
      if (gen === this.generation) this.set({ failed: true });
    }
  }

  /** Change loaded works in place (a rename or status change the service confirmed). */
  patch(id: string, change: Partial<T>): void {
    const items = this.state.items;
    if (items === null) return;
    this.set({ items: items.map((w) => (w.id === id ? { ...w, ...change } : w)) });
  }

  /** Take works out (deleted, or no longer matching), and from the total. */
  remove(ids: ReadonlySet<string>): void {
    const items = this.state.items;
    if (items === null) return;
    const kept = items.filter((w) => !ids.has(w.id));
    const gone = items.length - kept.length;
    this.set({
      items: kept,
      total: this.state.total === null ? null : Math.max(0, this.state.total - gone),
    });
  }
}
