import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { WORK_REFS_MAX, type ListWorksQuery, type WorkListItem } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { authHeaders, startTestServer, type TestServer } from './helpers.js';

/** QC-067: cursor paging, filter counts and refs of the whole filtered set. Temporary CREATORHUB_HOME; no network. */

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false } });
  servers.push(s);
  return s;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);

/** Every page from the start, following `next_cursor`. */
async function allPages(
  client: CreatorHubClient,
  query: ListWorksQuery,
): Promise<{ pages: WorkListItem[][]; totals: number[] }> {
  const pages: WorkListItem[][] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.works.list({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page.items);
    totals.push(page.total);
    if (page.next_cursor === null) return { pages, totals };
    cursor = page.next_cursor;
  }
}

function setTimes(
  s: TestServer,
  column: 'updated_at' | 'deleted_at',
  at: Map<string, string>,
): void {
  const stmt = s.db.prepare<[string, string]>(`UPDATE works SET ${column} = ? WHERE id = ?`);
  for (const [id, value] of at) stmt.run(value, id);
}

describe('works paging (QC-067)', () => {
  it('pages with a cursor in list order, ties broken by id, with the total of the whole filter', async () => {
    const s = await start();
    const created: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      created.push((await s.client.works.create({ title: `稿 ${String(i)}` })).id);
    }
    // Groups of three share a timestamp, so pages must split ties by id.
    setTimes(
      s,
      'updated_at',
      new Map(
        created.map((id, i) => [
          id,
          new Date(Date.UTC(2026, 0, 1, 0, Math.floor(i / 3))).toISOString(),
        ]),
      ),
    );
    const expected = s.db
      .prepare<[], { id: string }>(
        'SELECT id FROM works WHERE deleted_at IS NULL ORDER BY updated_at DESC, id',
      )
      .all()
      .map((r) => r.id);

    const { pages, totals } = await allPages(s.client, { limit: 5 });
    expect(pages.map((p) => p.length)).toEqual([5, 5, 5, 5, 3]);
    expect(pages.flat().map((w) => w.id)).toEqual(expected);
    expect(totals).toEqual([23, 23, 23, 23, 23]);

    const first = await s.client.works.list({ limit: 5 });
    if (first.next_cursor === null) throw new Error('expected a next page');
    // With a cursor, offset is ignored and reported as 0.
    const second = await s.client.works.list({ limit: 5, offset: 10, cursor: first.next_cursor });
    expect(second.offset).toBe(0);
    expect(ids(second.items)).toEqual(expected.slice(5, 10));
    // Offset paging still works as before.
    expect(ids((await s.client.works.list({ limit: 5, offset: 10 })).items)).toEqual(
      expected.slice(10, 15),
    );
    // An exact last page has no next page.
    expect((await s.client.works.list({ limit: 23 })).next_cursor).toBeNull();
    expect((await s.client.works.list({ ids: expected.slice(0, 2) })).next_cursor).toBeNull();
  });

  it('neither repeats nor skips works when one is updated between pages', async () => {
    const s = await start();
    const created: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      created.push((await s.client.works.create({ title: `稿 ${String(i)}` })).id);
    }
    setTimes(
      s,
      'updated_at',
      new Map(created.map((id, i) => [id, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()])),
    );
    const before = ids((await s.client.works.list({ limit: 50 })).items);
    const first = await s.client.works.list({ limit: 3 });
    expect(ids(first.items)).toEqual(before.slice(0, 3));

    // A work further down is edited: it moves to the top, ahead of the cursor.
    const moved = before[6];
    if (moved === undefined || first.next_cursor === null) throw new Error('setup');
    const work = await s.client.works.get(moved);
    await s.client.works.patch(moved, {
      base_revision: work.current_revision_id,
      status: 'ready',
    });

    const rest: string[] = [];
    let cursor: string | null = first.next_cursor;
    while (cursor !== null) {
      const page = await s.client.works.list({ limit: 3, cursor });
      rest.push(...ids(page.items));
      cursor = page.next_cursor;
    }
    const seen = [...ids(first.items), ...rest];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(before.filter((id) => id !== moved));
  });

  it('pages 最近刪除 by deletion time and rejects a cursor from the other scope or altered', async () => {
    const s = await start();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const w = await s.client.works.create({ title: `稿 ${String(i)}` });
      await s.client.works.trash(w.id, { base_revision: w.current_revision_id });
      created.push(w.id);
    }
    setTimes(
      s,
      'deleted_at',
      new Map(created.map((id, i) => [id, new Date(Date.UTC(2026, 10, 1, i)).toISOString()])),
    );
    const { pages } = await allPages(s.client, { scope: 'trash', limit: 2 });
    expect(pages.flat().map((w) => w.id)).toEqual([...created].reverse());

    const trashPage = await s.client.works.list({ scope: 'trash', limit: 2 });
    if (trashPage.next_cursor === null) throw new Error('expected a next page');
    const wrongScope = await apiError(
      s.client.works.list({ scope: 'active', cursor: trashPage.next_cursor }),
    );
    expect(wrongScope.status).toBe(400);
    expect(wrongScope.body?.error).toMatchObject({
      code: 'validation_error',
      details: { field: 'cursor' },
    });
    for (const cursor of ['not-a-cursor', Buffer.from('{"s":"trash"}').toString('base64url')]) {
      const err = await apiError(s.client.works.list({ scope: 'trash', cursor }));
      expect(err.status).toBe(400);
      expect(err.body?.error.details).toMatchObject({ field: 'cursor' });
    }
  });

  it('counts by type and status under the other filters, ignoring type and status', async () => {
    const s = await start();
    const project = await s.client.projects.create({ name: '旅行' });
    await s.client.works.create({ title: '文 1', tags: ['京都'] });
    await s.client.works.create({ title: '文 2', status: 'ready', tags: ['京都'] });
    await s.client.works.create({ title: '圖 1', type: 'image', project_ids: [project.id] });
    await s.client.works.create({
      title: '圖 2',
      type: 'image',
      status: 'published',
      tags: ['京都'],
      project_ids: [project.id],
    });
    const gone = await s.client.works.create({ title: '影 1', type: 'video' });
    await s.client.works.trash(gone.id, { base_revision: gone.current_revision_id });

    expect(await s.client.works.facets()).toEqual({
      total: 4,
      by_type_status: { article: { drafting: 1, ready: 1 }, image: { drafting: 1, published: 1 } },
    });
    expect(await s.client.works.facets({ tag: '京都' })).toEqual({
      total: 3,
      by_type_status: { article: { drafting: 1, ready: 1 }, image: { published: 1 } },
    });
    expect(await s.client.works.facets({ project_id: project.id })).toEqual({
      total: 2,
      by_type_status: { image: { drafting: 1, published: 1 } },
    });
    expect((await s.client.works.facets({ unassigned: '1' })).total).toBe(2);
    expect(await s.client.works.facets({ scope: 'trash' })).toEqual({
      total: 1,
      by_type_status: { video: { drafting: 1 } },
    });
    // type and status are not facet filters: the counts stay the same.
    const res = await fetch(`${s.baseUrl}/api/v1/works/facets?type=image&status=ready`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(4);
    // The list total agrees with the facets.
    expect((await s.client.works.list({ type: 'image' })).total).toBe(2);
  });

  it('lists every matching work as light refs in list order', async () => {
    const s = await start();
    const a = await s.client.projects.create({ name: 'A' });
    const b = await s.client.projects.create({ name: 'B' });
    const one = await s.client.works.create({
      title: '一',
      tags: ['x'],
      project_ids: [b.id, a.id],
    });
    const two = await s.client.works.create({ title: '二', type: 'image', status: 'ready' });
    await s.client.projects.patch(b.id, { base_revision: 1, archived: true });

    const refs = await s.client.works.refs();
    expect(refs.total).toBe(2);
    expect(refs.items).toEqual(
      ids((await s.client.works.list()).items).map((id) =>
        id === one.id
          ? {
              id: one.id,
              title: '一',
              type: 'article',
              status: 'drafting',
              tags: ['x'],
              current_revision_id: one.current_revision_id,
              storage_mode: 'managed',
              external_state: null,
              // Archived projects included, in sidebar order.
              project_ids: [a.id, b.id],
            }
          : {
              id: two.id,
              title: '二',
              type: 'image',
              status: 'ready',
              tags: [],
              current_revision_id: two.current_revision_id,
              storage_mode: 'managed',
              external_state: null,
              project_ids: [],
            },
      ),
    );
    expect(ids((await s.client.works.refs({ type: 'image' })).items)).toEqual([two.id]);
    expect(ids((await s.client.works.refs({ project_id: a.id })).items)).toEqual([one.id]);
    expect(ids((await s.client.works.refs({ q: '二' })).items)).toEqual([two.id]);
    expect(
      (await apiError(s.client.works.refs({ project_id: a.id, unassigned: '1' }))).status,
    ).toBe(400);
  });

  it(`returns up to ${String(WORK_REFS_MAX)} refs and answers 413 above that`, async () => {
    const s = await start();
    const seed = await s.client.works.create({ title: '種子' });
    // Clone the row in SQL: the API would take too long for this many works.
    const clone = (from: number, to: number): void => {
      s.db
        .prepare<[number, number, string]>(
          `WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
                              current_revision_id, created_at, updated_at, media_index)
           SELECT '00000000-0000-4000-8000-' || printf('%012d', n.i), title || n.i, type, status,
                  tags, source, storage_mode, source_path || n.i, current_revision_id,
                  created_at, updated_at, media_index
           FROM works, n WHERE works.id = ?`,
        )
        .run(from, to, seed.id);
    };
    clone(1, WORK_REFS_MAX - 1);
    const all = await s.client.works.refs();
    expect(all.total).toBe(WORK_REFS_MAX);
    expect(all.items).toHaveLength(WORK_REFS_MAX);
    expect((await s.client.works.facets()).total).toBe(WORK_REFS_MAX);

    clone(WORK_REFS_MAX, WORK_REFS_MAX);
    const err = await apiError(s.client.works.refs());
    expect(err.status).toBe(413);
    expect(err.body?.error).toMatchObject({
      code: 'payload_too_large',
      details: { total: WORK_REFS_MAX + 1, max: WORK_REFS_MAX },
    });
    // Narrower filters still work.
    s.db.prepare<[string]>("UPDATE works SET status = 'ready' WHERE id = ?").run(seed.id);
    expect(ids((await s.client.works.refs({ status: 'ready' })).items)).toEqual([seed.id]);
  });

  it('counts the works a deleted project would leave in no project', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const other = await s.client.projects.create({ name: '其他' });
    const archived = await s.client.projects.create({ name: '封存' });
    await s.client.projects.patch(archived.id, { base_revision: 1, archived: true });
    const gone = await s.client.projects.create({ name: '已刪' });

    await s.client.works.create({ title: '只在 P', project_ids: [p.id] });
    await s.client.works.create({ title: '也在其他', project_ids: [p.id, other.id] });
    await s.client.works.create({ title: '也在封存', project_ids: [p.id, archived.id] });
    await s.client.works.create({ title: '也在已刪', project_ids: [p.id, gone.id] });
    const trashed = await s.client.works.create({ title: '在最近刪除', project_ids: [p.id] });
    await s.client.works.trash(trashed.id, { base_revision: trashed.current_revision_id });
    await s.client.projects.remove(gone.id);

    const summary = await s.client.projects.summary(p.id);
    // 只在 P, and 也在已刪 (its other project is deleted); not the archived or trashed ones.
    expect(summary.sole_count).toBe(2);
    expect((await s.client.projects.summary(other.id)).sole_count).toBe(0);
  });
});
