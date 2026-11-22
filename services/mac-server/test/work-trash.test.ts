import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemTrash } from '../src/assets/system-trash.js';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, WORK_TRASH_ROLLBACK_SQL } from '../src/db/migrations.js';
import { pngBytes } from './fixtures.js';
import {
  authHeaders,
  makeTempHome,
  startTestServer,
  type StartOptions,
  type TestServer,
} from './helpers.js';

/**
 * QC-051: works in 最近刪除, restore, permanent deletion and batch edits.
 * Every test uses a temporary CREATORHUB_HOME and a fake Trash.
 */

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(options: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false }, ...options });
  servers.push(s);
  return s;
}

function tempDir(): string {
  const d = makeTempHome();
  dirs.push(d);
  return d;
}

/** Moves "trashed" files into a temp folder; never the real Trash. */
class FakeTrash implements SystemTrash {
  readonly moved: string[] = [];
  fail: Error | null = null;
  constructor(readonly bin: string) {}
  moveToTrash(absPath: string): Promise<void> {
    if (this.fail !== null) return Promise.reject(this.fail);
    this.moved.push(absPath);
    fs.renameSync(absPath, path.join(this.bin, path.basename(absPath)));
    return Promise.resolve();
  }
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

function events(s: TestServer, action: string): { entity_id: string; data: string }[] {
  return s.db
    .prepare<[string], { entity_id: string; data: string }>(
      'SELECT entity_id, data FROM change_log WHERE action = ? ORDER BY seq',
    )
    .all(action);
}

async function article(s: TestServer, title: string, markdown = `# ${title}\n\n正文\n`) {
  return s.client.works.create({ title, type: 'article', markdown });
}

const workDir = (s: TestServer, id: string): string => path.join(s.home, 'library/works', id);

describe('deleting and restoring a managed work', () => {
  it('moves it to 最近刪除 with its folder in place, and restores it with the same revision', async () => {
    const s = await start();
    const w = await article(s, '京都');
    const revisions = await s.client.works.revisions(w.id);

    expect((await apiError(s.client.works.trash(w.id))).status).toBe(428);
    const deleted = await s.client.works.trash(w.id, { base_revision: w.current_revision_id });
    expect(deleted.work).toMatchObject({
      id: w.id,
      removal: 'trashed',
      current_revision_id: w.current_revision_id,
    });
    const deletedAt = Date.parse(deleted.work.deleted_at ?? '');
    expect(Date.parse(deleted.work.purge_at ?? '') - deletedAt).toBe(30 * 24 * 60 * 60 * 1000);
    expect(fs.readFileSync(path.join(workDir(s, w.id), 'source.md'), 'utf8')).toBe(w.markdown);

    expect((await s.client.works.list()).items.map((i) => i.id)).toEqual([]);
    expect((await s.client.works.list({ scope: 'trash' })).items.map((i) => i.id)).toEqual([w.id]);
    expect(await s.client.works.list({ ids: [w.id] })).toMatchObject({
      items: [],
      missing_ids: [w.id],
    });
    // Still readable for the 最近刪除 preview.
    expect(await s.client.works.get(w.id)).toMatchObject({ markdown: w.markdown });

    const again = await apiError(
      s.client.works.trash(w.id, { base_revision: w.current_revision_id }),
    );
    expect(again.body?.error.code).toBe('work_in_trash');

    const restored = await s.client.works.restoreFromTrash(w.id, {
      base_revision: w.current_revision_id,
    });
    expect(restored).toMatchObject({
      current_revision_id: w.current_revision_id,
      markdown: w.markdown,
      deleted_at: null,
      purge_at: null,
      removal: null,
    });
    expect(await s.client.works.revisions(w.id)).toEqual(revisions);
    expect((await s.client.works.list()).items.map((i) => i.id)).toEqual([w.id]);
    // Restoring an active work changes nothing.
    expect(
      (await s.client.works.restoreFromTrash(w.id, { base_revision: w.current_revision_id }))
        .current_revision_id,
    ).toBe(w.current_revision_id);

    expect(events(s, 'work.trashed')).toEqual([
      { entity_id: w.id, data: JSON.stringify({ removal: 'trashed' }) },
    ]);
    expect(events(s, 'work.restored').map((e) => e.entity_id)).toEqual([w.id]);
  });

  it('checks the revision with If-Match too; a stale base is 409 and nothing changes', async () => {
    const s = await start();
    const w = await article(s, 'v1');
    const v2 = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      markdown: '# v2\n',
    });
    const stale = await apiError(
      s.client.works.trash(w.id, {}, { ifMatch: w.current_revision_id }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body?.error).toMatchObject({
      code: 'revision_conflict',
      details: { current_revision: v2.current_revision_id },
    });
    expect((await s.client.works.get(w.id)).deleted_at).toBeNull();
    const ok = await s.client.works.trash(w.id, {}, { ifMatch: v2.current_revision_id });
    expect(ok.work.removal).toBe('trashed');
  });

  it('refuses edits to a work in 最近刪除, on the work and its sub-resources', async () => {
    const s = await start();
    const w = await article(s, '草稿');
    const a = (await s.client.assets.upload({ data: await pngBytes(4, 4), filename: 'a.png' }))
      .asset;
    await s.client.works.trash(w.id, { base_revision: w.current_revision_id });
    const base = w.current_revision_id;
    for (const call of [
      () => s.client.works.patch(w.id, { base_revision: base, title: '新' }),
      () => s.client.works.attachMedia(w.id, a.id),
      () => s.client.variants.generate(w.id),
      () => s.client.works.restore(w.id, base, { base_revision: base }),
    ]) {
      const err = await apiError(call());
      expect(err.status).toBe(409);
      expect(err.body?.error.code).toBe('work_in_trash');
    }
    expect((await s.client.works.get(w.id)).current_revision_id).toBe(base);
  });

  it('agent tokens with write may delete and restore, but not purge or move files to the Trash', async () => {
    const s = await start();
    const w = await article(s, '代理');
    const agent = s.tokens.create({ name: 'agent', scopes: ['read', 'write'] });
    const asAgent = createClient({ baseUrl: s.baseUrl, token: agent.secret });
    const reader = s.tokens.create({ name: 'reader', scopes: ['read'] });
    const asReader = createClient({ baseUrl: s.baseUrl, token: reader.secret });
    const base = { base_revision: w.current_revision_id };

    expect((await apiError(asReader.works.trash(w.id, base))).status).toBe(403);
    const forbidden = await apiError(
      asAgent.works.trash(w.id, { ...base, move_original_to_trash: true }),
    );
    expect(forbidden.status).toBe(403);
    await asAgent.works.trash(w.id, base);
    expect((await asReader.works.list({ scope: 'trash' })).total).toBe(1);
    expect((await apiError(asAgent.works.purge(w.id))).status).toBe(403);
    expect((await apiError(asAgent.works.emptyTrash())).status).toBe(403);
    // Agents must send an idempotency key on batch.
    expect(
      (await apiError(asAgent.works.batch({ action: 'restore', items: [{ id: w.id, ...base }] })))
        .status,
    ).toBe(428);
    await asAgent.works.restoreFromTrash(w.id, base);
    expect((await s.client.works.get(w.id)).deleted_at).toBeNull();
  });
});

describe('permanent deletion', () => {
  it('purges by hand: records, history and folder go; 404 for works not in 最近刪除', async () => {
    const s = await start();
    const w = await article(s, '要刪');
    const keep = await article(s, '保留');
    expect((await apiError(s.client.works.purge(w.id))).status).toBe(404);
    await s.client.works.trash(w.id, { base_revision: w.current_revision_id });

    expect(await s.client.works.purge(w.id)).toEqual({ id: w.id, removal: 'trashed' });
    expect((await apiError(s.client.works.get(w.id))).status).toBe(404);
    expect(fs.existsSync(workDir(s, w.id))).toBe(false);
    expect(s.db.prepare('SELECT count(*) AS n FROM revisions WHERE work_id = ?').get(w.id)).toEqual(
      { n: 0 },
    );
    expect(s.db.prepare('SELECT count(*) AS n FROM works_fts WHERE work_id = ?').get(w.id)).toEqual(
      { n: 0 },
    );
    expect((await s.client.works.list({ q: '要刪' })).total).toBe(0);
    expect(fs.existsSync(path.join(workDir(s, keep.id), 'source.md'))).toBe(true);
    expect(events(s, 'work.deleted')).toEqual([
      { entity_id: w.id, data: JSON.stringify({ removal: 'trashed', reason: 'manual' }) },
    ]);
  });

  it('keeps library assets stored in the work folder by moving them to the asset library', async () => {
    const s = await start();
    const w = await article(s, '有圖');
    const src = path.join(tempDir(), 'p.png');
    fs.writeFileSync(src, await pngBytes(5, 5));
    const { id: assetId } = s.assets.registerFromFile(w.id, src);
    const before = await s.client.assets.get(assetId);
    expect(before.path.startsWith(path.join('library/works', w.id))).toBe(true);

    await s.client.works.trash(w.id, { base_revision: w.current_revision_id });
    await s.client.works.purge(w.id);

    const after = await s.client.assets.get(assetId);
    expect(after.path).toBe(path.join('library/assets', assetId, path.basename(before.path)));
    expect(fs.readFileSync(path.join(s.home, after.path)).equals(fs.readFileSync(src))).toBe(true);
    expect(fs.existsSync(workDir(s, w.id))).toBe(false);
  });

  it('empties 最近刪除 and purges works deleted more than 30 days ago', async () => {
    let now = new Date('2026-11-01T00:00:00.000Z');
    const s = await start({ workTrash: { now: () => now } });
    const old = await article(s, '舊');
    await s.client.works.trash(old.id, { base_revision: old.current_revision_id });
    now = new Date('2026-11-20T00:00:00.000Z');
    const recent = await article(s, '新');
    await s.client.works.trash(recent.id, { base_revision: recent.current_revision_id });

    now = new Date('2026-12-01T00:00:01.000Z');
    expect(s.workTrash.purgeExpired()).toEqual([{ id: old.id, removal: 'trashed' }]);
    expect(events(s, 'work.deleted').map((e) => JSON.parse(e.data) as unknown)).toEqual([
      { removal: 'trashed', reason: 'expired' },
    ]);
    expect((await s.client.works.list({ scope: 'trash' })).items.map((i) => i.id)).toEqual([
      recent.id,
    ]);

    const res = await fetch(`${s.baseUrl}/api/v1/trash/works`, {
      method: 'DELETE',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await s.client.works.emptyTrash()).toEqual({
      purged: [{ id: recent.id, removal: 'trashed' }],
    });
    expect((await s.client.works.list({ scope: 'trash' })).total).toBe(0);
  });
});

describe('external works', () => {
  async function externalWork(trash?: SystemTrash) {
    const s = await start({
      jobs: { pollMs: 5 },
      // Polling, as in mounts.test.ts: deterministic under load.
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
      ...(trash === undefined ? {} : { workTrash: { trash } }),
    });
    const folder = tempDir();
    const file = path.join(folder, 'note.md');
    fs.writeFileSync(file, '# 外部筆記\n\n內容\n');
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const work = (await s.client.works.list()).items[0];
    if (work === undefined) throw new Error('no external work');
    return { s, folder, file, mount, work };
  }

  async function rescan(s: TestServer, mountId: string): Promise<void> {
    await s.client.mounts.rescan(mountId);
    await s.jobs.drain();
  }

  it('only unindexes by default; the file stays and rescans do not bring it back, even after purging', async () => {
    const { s, file, mount, work } = await externalWork();
    const content = fs.readFileSync(file, 'utf8');
    const res = await s.client.works.trash(work.id, { base_revision: work.current_revision_id });
    expect(res.work).toMatchObject({ removal: 'unindexed', external_state: 'present' });
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect((await s.client.mounts.get(mount.id)).work_count).toBe(0);

    await rescan(s, mount.id);
    expect((await s.client.works.list()).total).toBe(0);
    expect((await s.client.works.get(work.id)).removal).toBe('unindexed');

    expect(await s.client.works.purge(work.id)).toEqual({ id: work.id, removal: 'unindexed' });
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(fs.existsSync(workDir(s, work.id))).toBe(false);
    await rescan(s, mount.id);
    expect((await s.client.works.list()).total).toBe(0);

    // A new file in the same folder is still indexed.
    fs.writeFileSync(path.join(path.dirname(file), 'other.md'), '# 另一篇\n');
    await rescan(s, mount.id);
    expect((await s.client.works.list()).items.map((i) => i.title)).toEqual(['另一篇']);
  });

  it('moves the file to the Trash only when asked; restore waits until it is put back', async () => {
    const bin = tempDir();
    const fake = new FakeTrash(bin);
    const { s, file, work } = await externalWork(fake);
    const base = { base_revision: work.current_revision_id };

    fake.fail = new Error('no permission');
    const failed = await apiError(
      s.client.works.trash(work.id, { ...base, move_original_to_trash: true }),
    );
    expect(failed.status).toBe(500);
    expect(failed.body?.error.code).toBe('trash_failed');
    expect(fs.existsSync(file)).toBe(true);
    expect((await s.client.works.get(work.id)).deleted_at).toBeNull();

    fake.fail = null;
    const res = await s.client.works.trash(work.id, { ...base, move_original_to_trash: true });
    expect(res.work.removal).toBe('original_trashed');
    expect(fake.moved).toEqual([fs.realpathSync(path.dirname(file)) + '/note.md']);
    expect(fs.existsSync(file)).toBe(false);

    const early = await apiError(s.client.works.restoreFromTrash(work.id, base));
    expect(early.body?.error.code).toBe('source_missing');

    // "Put Back" in Finder.
    fs.renameSync(path.join(bin, 'note.md'), file);
    const restored = await s.client.works.restoreFromTrash(work.id, base);
    expect(restored).toMatchObject({ deleted_at: null, external_state: 'present' });
  });

  it('refuses move_original_to_trash for managed works', async () => {
    const fake = new FakeTrash(tempDir());
    const s = await start({ workTrash: { trash: fake } });
    const w = await article(s, '託管');
    const err = await apiError(
      s.client.works.trash(w.id, {
        base_revision: w.current_revision_id,
        move_original_to_trash: true,
      }),
    );
    expect(err.status).toBe(400);
    expect(fake.moved).toEqual([]);
  });
});

describe('batch', () => {
  it('handles each item on its own and reports failures per item', async () => {
    const s = await start();
    const a = await article(s, 'A');
    const b = await article(s, 'B');
    const c = await article(s, 'C');
    const cNew = await s.client.works.patch(c.id, {
      base_revision: c.current_revision_id,
      markdown: '# C2\n',
    });
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await s.client.works.batch({
      action: 'trash',
      items: [
        { id: a.id, base_revision: a.current_revision_id },
        { id: c.id, base_revision: c.current_revision_id },
        { id: unknown, base_revision: a.current_revision_id },
        { id: b.id, base_revision: b.current_revision_id },
      ],
    });
    expect(res).toMatchObject({ succeeded: 2, failed: 2 });
    expect(res.results.map((r) => [r.id, r.ok])).toEqual([
      [a.id, true],
      [c.id, false],
      [unknown, false],
      [b.id, true],
    ]);
    const conflict = res.results[1];
    expect(conflict?.ok === false && conflict.error).toMatchObject({
      code: 'revision_conflict',
      details: { current_revision: cNew.current_revision_id },
    });
    const missing = res.results[2];
    expect(missing?.ok === false && missing.error.code).toBe('not_found');
    expect((await s.client.works.list()).items.map((i) => i.id)).toEqual([c.id]);

    const restored = await s.client.works.batch({
      action: 'restore',
      items: [
        { id: a.id, base_revision: a.current_revision_id },
        { id: b.id, base_revision: b.current_revision_id },
      ],
    });
    expect(restored.succeeded).toBe(2);
    expect((await s.client.works.list()).total).toBe(3);
  });

  it('sets status and adds or removes tags as new revisions; unchanged items keep their revision', async () => {
    const s = await start();
    const a = await s.client.works.create({ title: 'A', tags: ['旅行'] });
    const b = await s.client.works.create({ title: 'B', status: 'ready' });

    const status = await s.client.works.batch({
      action: 'set_status',
      status: 'ready',
      items: [
        { id: a.id, base_revision: a.current_revision_id },
        { id: b.id, base_revision: b.current_revision_id },
      ],
    });
    const [ra, rb] = status.results;
    expect(ra?.ok === true && ra.work).toMatchObject({ status: 'ready' });
    expect(ra?.ok === true && ra.work.current_revision_id).not.toBe(a.current_revision_id);
    expect(rb?.ok === true && rb.work.current_revision_id).toBe(b.current_revision_id);
    const aRev = ra?.ok === true ? ra.work.current_revision_id : '';

    const tags = await s.client.works.batch({
      action: 'add_tags',
      tags: ['京都', '旅行'],
      items: [
        { id: a.id, base_revision: aRev },
        { id: b.id, base_revision: b.current_revision_id },
      ],
    });
    expect(tags.results.map((r) => r.ok && r.work.tags)).toEqual([
      ['旅行', '京都'],
      ['京都', '旅行'],
    ]);
    const after = await s.client.works.list({ tag: '京都' });
    expect(after.total).toBe(2);

    const removed = await s.client.works.batch({
      action: 'remove_tags',
      tags: ['旅行'],
      items: tags.results.map((r) => ({
        id: r.id,
        base_revision: r.ok ? r.work.current_revision_id : '',
      })),
    });
    expect(removed.results.map((r) => r.ok && r.work.tags)).toEqual([['京都'], ['京都']]);
    // Markdown untouched by metadata changes on an article.
    expect((await s.client.works.get(a.id)).markdown).toBe(a.markdown);
  });

  it('writes tags of an image work into its front matter', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '貼圖', type: 'image', tags: ['舊'] });
    const res = await s.client.works.batch({
      action: 'add_tags',
      tags: ['新'],
      items: [{ id: w.id, base_revision: w.current_revision_id }],
    });
    expect(res.succeeded).toBe(1);
    const md = (await s.client.works.get(w.id)).markdown;
    expect(md).toContain('tags:\n  - 舊\n  - 新\n');
  });

  it('fails status and tag changes on works in 最近刪除', async () => {
    const s = await start();
    const w = await article(s, 'X');
    await s.client.works.trash(w.id, { base_revision: w.current_revision_id });
    const res = await s.client.works.batch({
      action: 'set_status',
      status: 'published',
      items: [{ id: w.id, base_revision: w.current_revision_id }],
    });
    const r = res.results[0];
    expect(r?.ok === false && r.error.code).toBe('work_in_trash');
  });

  it('replays the first response for the same Idempotency-Key and 422s for a different body', async () => {
    const s = await start();
    const a = await article(s, 'A');
    const body = {
      action: 'set_status' as const,
      status: 'in_review' as const,
      items: [{ id: a.id, base_revision: a.current_revision_id }],
    };
    const post = (b: unknown) =>
      fetch(`${s.baseUrl}/api/v1/works/batch`, {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/json',
          'idempotency-key': 'batch-key-0001',
        }),
        body: JSON.stringify(b),
      });
    const [first, concurrent] = await Promise.all([post(body), post(body)]);
    const firstBody: unknown = await first.json();
    expect(first.status).toBe(200);
    expect(await concurrent.json()).toEqual(firstBody);
    expect([first, concurrent].map((r) => r.headers.get('idempotent-replayed')).sort()).toEqual([
      null,
      'true',
    ]);

    const replay = await post(body);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(firstBody);
    // Applied once: one new revision.
    expect((await s.client.works.revisions(a.id)).items).toHaveLength(2);

    const reused = await post({ ...body, status: 'ready' });
    expect(reused.status).toBe(422);
  });

  it('rejects repeated ids and more than 200 items', async () => {
    const s = await start();
    const a = await article(s, 'A');
    const item = { id: a.id, base_revision: a.current_revision_id };
    const post = (items: unknown[]) =>
      fetch(`${s.baseUrl}/api/v1/works/batch`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ action: 'trash', items }),
      });
    expect((await post([item, item])).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      base_revision: a.current_revision_id,
    }));
    expect((await post(many)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await s.client.works.get(a.id)).deleted_at).toBeNull();
  });
});

describe('renaming through PATCH title', () => {
  it('managed article: only the work title changes, the Markdown and its H1 stay', async () => {
    const s = await start();
    const w = await article(s, '舊名', '# 舊的標題\n\n正文\n');
    const renamed = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      title: '新名',
    });
    expect(renamed).toMatchObject({ title: '新名', markdown: '# 舊的標題\n\n正文\n' });
    expect((await s.client.works.list({ q: '新名' })).items.map((i) => i.id)).toEqual([w.id]);
    const revs = (await s.client.works.revisions(w.id)).items;
    expect(revs).toHaveLength(2);
    expect((await s.client.works.revision(w.id, revs[0]?.revision_id ?? '')).title).toBe('新名');
  });

  it('image and video works: the title is written into the front matter', async () => {
    const s = await start();
    for (const type of ['image', 'video'] as const) {
      const w: WorkDetail = await s.client.works.create({ title: '原名', type });
      const renamed = await s.client.works.patch(w.id, {
        base_revision: w.current_revision_id,
        title: '改名後',
      });
      expect(renamed.title).toBe('改名後');
      expect(renamed.markdown).toContain('title: 改名後\n');
      expect(renamed.markdown).not.toContain('原名');
    }
  });

  it('external article: the title changes but the file and its name stay; a rescan keeps the title', async () => {
    const s = await start({
      jobs: { pollMs: 5 },
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    });
    const folder = tempDir();
    const file = path.join(folder, 'draft.md');
    fs.writeFileSync(file, '# 外部\n\n內容\n');
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const w = (await s.client.works.list()).items[0];
    if (w === undefined) throw new Error('no external work');
    const renamed = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      title: '改過的名字',
    });
    expect(renamed.title).toBe('改過的名字');
    expect(fs.readFileSync(file, 'utf8')).toBe('# 外部\n\n內容\n');
    expect(fs.readdirSync(folder)).toEqual(['draft.md']);
    await s.client.mounts.rescan(mount.id);
    await s.jobs.drain();
    expect((await s.client.works.get(w.id)).title).toBe('改過的名字');
  });
});

describe('migration 0016 rollback', () => {
  it('undoes the columns and table so an older build opens the database, and re-applies cleanly', () => {
    const home = tempDir();
    // Rollbacks run newest first: this one starts from a database at 0016.
    const upTo0016 = migrations.filter((m) => m.id <= '0016');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0016);
    try {
      runMigrations(db, upTo0016);
      db.prepare(
        `INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
           current_revision_id, created_at, updated_at, deleted_at, removal)
         VALUES ('w1', 't', 'article', 'drafting', '[]', 'test', 'managed', 'p', 'r1',
           '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'trashed')`,
      ).run();

      db.exec(WORK_TRASH_ROLLBACK_SQL);
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('works')")
        .all()
        .map((c) => c.name);
      expect(columns).not.toContain('deleted_at');
      expect(columns).not.toContain('removal');
      const older = migrations.filter((m) => m.id < '0016');
      expect(runMigrations(db, older)).toEqual([]);
      expect(db.prepare("SELECT id FROM works WHERE id = 'w1'").get()).toEqual({ id: 'w1' });

      expect(runMigrations(db, upTo0016)).toEqual(['0016']);
      expect(db.prepare("SELECT deleted_at FROM works WHERE id = 'w1'").get()).toEqual({
        deleted_at: null,
      });
    } finally {
      db.close();
    }
  });
});
