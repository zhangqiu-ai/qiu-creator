import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, PROJECTS_ROLLBACK_SQL } from '../src/db/migrations.js';
import { pngBytes } from './fixtures.js';
import {
  authHeaders,
  makeTempHome,
  startTestServer,
  type StartOptions,
  type TestServer,
} from './helpers.js';

/** QC-062: projects. Temporary CREATORHUB_HOME; no network. */

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

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

function events(
  s: TestServer,
  action: string,
): { entity: string; entity_id: string; data: string }[] {
  return s.db
    .prepare<[string], { entity: string; entity_id: string; data: string }>(
      'SELECT entity, entity_id, data FROM change_log WHERE action = ? ORDER BY seq',
    )
    .all(action);
}

const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);

describe('projects (QC-062)', () => {
  it('creates, renames, recolors, archives and reorders, with revision checks', async () => {
    const s = await start();
    const a = await s.client.projects.create({ name: '  京都旅行  ', color: 3 });
    const b = await s.client.projects.create({ name: '工作' });
    expect(a).toMatchObject({
      name: '京都旅行',
      color: 3,
      sort_order: 0,
      revision: 1,
      archived: false,
      work_count: 0,
      deleted_at: null,
    });
    expect(b).toMatchObject({ color: 0, sort_order: 1 });

    // 60 characters (CJK counts as one) is fine, 61 is not; colors are 0–7.
    expect((await s.client.projects.create({ name: '字'.repeat(60) })).name).toHaveLength(60);
    for (const body of [{ name: '字'.repeat(61) }, { name: '   ' }, { name: 'x', color: 8 }]) {
      const res = await fetch(`${s.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }

    expect((await apiError(s.client.projects.patch(a.id, { name: '新' }))).status).toBe(428);
    const renamed = await s.client.projects.patch(a.id, {
      base_revision: 1,
      name: '關西旅行',
      color: 5,
    });
    expect(renamed).toMatchObject({ name: '關西旅行', color: 5, revision: 2 });
    const stale = await apiError(
      s.client.projects.patch(a.id, { base_revision: 1, archived: true }),
    );
    expect(stale.body?.error).toMatchObject({
      code: 'revision_conflict',
      details: { current_revision: 2 },
    });
    const archived = await s.client.projects.patch(a.id, { archived: true }, { ifMatch: 2 });
    expect(archived).toMatchObject({ archived: true, revision: 3 });
    expect(archived.archived_at).not.toBeNull();

    const third = (await s.client.projects.list()).items[2];
    if (third === undefined) throw new Error('missing project');
    const reordered = await s.client.projects.reorder([third.id, b.id, a.id]);
    expect(ids(reordered.items)).toEqual([third.id, b.id, a.id]);
    expect(reordered.items.map((p) => p.sort_order)).toEqual([0, 1, 2]);
    const partial = await apiError(s.client.projects.reorder([a.id]));
    expect(partial.status).toBe(400);
    expect(partial.body?.error.details).toMatchObject({ missing: [third.id, b.id] });

    expect(events(s, 'project.created').every((e) => e.entity === 'project')).toBe(true);
    expect(JSON.parse(events(s, 'project.updated')[0]?.data ?? '{}')).toEqual({
      fields: ['name', 'color'],
      revision: 2,
    });
    expect(events(s, 'project.reordered')).toHaveLength(1);
  });

  it('deletes softly and restores with the same works and place; works are never deleted', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'A' });
    const q = await s.client.projects.create({ name: 'B' });
    const w = await s.client.works.create({ title: '稿', project_ids: [p.id, q.id] });

    const deleted = await s.client.projects.remove(p.id);
    expect(deleted.deleted_at).not.toBeNull();
    expect(ids((await s.client.projects.list()).items)).toEqual([q.id]);
    expect((await apiError(s.client.projects.get(p.id))).status).toBe(404);
    expect((await s.client.works.get(w.id)).project_ids).toEqual([q.id]);
    expect((await apiError(s.client.works.list({ project_id: p.id }))).status).toBe(404);

    const restored = await s.client.projects.restore(p.id);
    expect(restored).toMatchObject({ id: p.id, deleted_at: null, work_count: 1, sort_order: 0 });
    expect((await s.client.works.get(w.id)).project_ids).toEqual([p.id, q.id]);
    expect(events(s, 'project.deleted').map((e) => e.entity_id)).toEqual([p.id]);
    expect(events(s, 'project.restored').map((e) => e.entity_id)).toEqual([p.id]);
  });

  it('removes projects deleted more than 30 days ago, keeping their works', async () => {
    let now = new Date('2026-11-01T00:00:00.000Z');
    const s = await start({ projects: { now: () => now } });
    const p = await s.client.projects.create({ name: '舊' });
    const w = await s.client.works.create({ title: '稿', project_ids: [p.id] });
    await s.client.projects.remove(p.id);
    now = new Date('2026-11-30T23:59:59.000Z');
    expect(s.projects.purgeExpired()).toEqual([]);
    now = new Date('2026-12-01T00:00:01.000Z');
    expect(s.projects.purgeExpired()).toEqual([p.id]);
    expect((await apiError(s.client.projects.restore(p.id))).status).toBe(404);
    expect(await s.client.works.get(w.id)).toMatchObject({ id: w.id, project_ids: [] });
    expect(s.db.prepare('SELECT count(*) AS n FROM work_projects').get()).toEqual({ n: 0 });
    expect(JSON.parse(events(s, 'project.deleted').at(-1)?.data ?? '{}')).toEqual({ purged: true });
  });
});

describe('works and projects (QC-062)', () => {
  it('adds and removes works in batches, per item, without touching their files or revisions', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const q = await s.client.projects.create({ name: 'Q' });
    const a = await s.client.works.create({ title: 'A', markdown: '# A\n' });
    const b = await s.client.works.create({ title: 'B', markdown: '# B\n' });
    const gone = await s.client.works.create({ title: 'G' });
    await s.client.works.trash(gone.id, { base_revision: gone.current_revision_id });
    const file = path.join(s.home, 'library/works', a.id, 'source.md');
    const before = fs.readFileSync(file, 'utf8');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await s.client.projects.batchWorks({
      work_ids: [a.id, b.id, gone.id, unknown],
      add: [q.id, p.id],
    });
    expect(res).toMatchObject({ succeeded: 2, failed: 2 });
    expect(res.results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'ok',
      'ok',
      'work_in_trash',
      'not_found',
    ]);
    const first = res.results[0];
    // Sidebar order, not request order.
    expect(first?.ok === true && first.work.project_ids).toEqual([p.id, q.id]);
    expect(first?.ok === true && first.work.current_revision_id).toBe(a.current_revision_id);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // Adding again changes nothing and records nothing.
    const changes = events(s, 'work.projects_changed').length;
    await s.client.projects.batchWorks({ work_ids: [a.id], add: [p.id] });
    expect(events(s, 'work.projects_changed')).toHaveLength(changes);

    const moved = await s.client.projects.batchWorks({ work_ids: [a.id], remove: [q.id] });
    expect(moved.results[0]?.ok === true && moved.results[0].work.project_ids).toEqual([p.id]);
    expect(JSON.parse(events(s, 'work.projects_changed').at(-1)?.data ?? '{}')).toEqual({
      added: [],
      removed: [q.id],
      // QC-092: who changed the membership.
      by: 'user',
    });

    // A deleted project stops the whole request before anything changes.
    await s.client.projects.remove(q.id);
    const refused = await apiError(
      s.client.projects.batchWorks({ work_ids: [b.id], remove: [q.id] }),
    );
    expect(refused.status).toBe(404);
    expect(refused.body?.error.details).toEqual({ project_id: q.id });
    expect(
      s.db.prepare('SELECT count(*) AS n FROM work_projects WHERE project_id = ?').get(q.id),
    ).toEqual({
      n: 1,
    });
  });

  it('creates works straight into projects; an unknown project creates nothing', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const w = await s.client.works.create({ title: '新稿', project_ids: [p.id] });
    expect(w.project_ids).toEqual([p.id]);
    expect(JSON.parse(events(s, 'work.created').at(-1)?.data ?? '{}')).toMatchObject({
      project_ids: [p.id],
    });
    const before = (await s.client.works.list()).total;
    const err = await apiError(
      s.client.works.create({ title: 'x', project_ids: ['00000000-0000-4000-8000-000000000000'] }),
    );
    expect(err.status).toBe(404);
    expect((await s.client.works.list()).total).toBe(before);
    expect(fs.readdirSync(path.join(s.home, 'library/works'))).toEqual([w.id]);
  });

  it('filters by project and by unassigned; counts leave out works in 最近刪除', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const archivedProject = await s.client.projects.create({ name: '封存' });
    const deletedProject = await s.client.projects.create({ name: '刪除' });
    const inP = await s.client.works.create({ title: 'inP', project_ids: [p.id] });
    const inArchived = await s.client.works.create({
      title: 'inA',
      project_ids: [archivedProject.id],
    });
    const inDeleted = await s.client.works.create({
      title: 'inD',
      project_ids: [deletedProject.id],
    });
    const loose = await s.client.works.create({ title: 'loose' });
    await s.client.projects.patch(archivedProject.id, { base_revision: 1, archived: true });
    await s.client.projects.remove(deletedProject.id);

    expect(ids((await s.client.works.list({ project_id: p.id })).items)).toEqual([inP.id]);
    expect(ids((await s.client.works.list({ project_id: archivedProject.id })).items)).toEqual([
      inArchived.id,
    ]);
    expect(new Set(ids((await s.client.works.list({ unassigned: '1' })).items))).toEqual(
      new Set([inDeleted.id, loose.id]),
    );
    const both = await apiError(s.client.works.list({ project_id: p.id, unassigned: '1' }));
    expect(both.status).toBe(400);

    await s.client.works.trash(inP.id, { base_revision: inP.current_revision_id });
    expect((await s.client.projects.get(p.id)).work_count).toBe(0);
    expect((await s.client.works.list({ project_id: p.id })).total).toBe(0);
    // Back from 最近刪除: back in its project.
    await s.client.works.restoreFromTrash(inP.id, { base_revision: inP.current_revision_id });
    expect((await s.client.projects.get(p.id)).work_count).toBe(1);
    expect((await s.client.works.get(inP.id)).project_ids).toEqual([p.id]);
  });

  it('summarises a project and lists the library assets its live works use', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const upload = async (name: string, size: number) =>
      (await s.client.assets.upload({ data: await pngBytes(size, size), filename: name })).asset;
    const linked = await upload('linked.png', 8);
    const inImages = await upload('front.png', 9);
    const ofTrashed = await upload('trashed.png', 10);
    const unrelated = await upload('other.png', 11);

    const article = await s.client.works.create({
      title: '文章',
      status: 'ready',
      project_ids: [p.id],
    });
    await s.client.workAssets.link(article.id, { asset_id: linked.id, role: 'cover' });
    const post = await s.client.works.create({ title: '貼圖', type: 'image', project_ids: [p.id] });
    await s.client.works.patch(post.id, {
      base_revision: post.current_revision_id,
      images: [inImages.id],
    });
    const trashed = await s.client.works.create({ title: '刪', project_ids: [p.id] });
    await s.client.workAssets.link(trashed.id, { asset_id: ofTrashed.id, role: 'cover' });
    await s.client.works.trash(trashed.id, { base_revision: trashed.current_revision_id });
    const outside = await s.client.works.create({ title: '外' });
    await s.client.workAssets.link(outside.id, { asset_id: unrelated.id, role: 'cover' });

    const summary = await s.client.projects.summary(p.id);
    expect(summary).toMatchObject({
      project: { id: p.id, work_count: 2 },
      by_status: { drafting: 1, in_review: 0, ready: 1, published: 0 },
      asset_count: 2,
    });
    expect(summary.last_updated_at).not.toBeNull();
    const assets = await s.client.assets.list({ project_id: p.id });
    expect(new Set(ids(assets.items))).toEqual(new Set([linked.id, inImages.id]));
    expect(assets.total).toBe(2);

    await s.client.projects.remove(p.id);
    expect((await apiError(s.client.assets.list({ project_id: p.id }))).status).toBe(404);
    expect((await apiError(s.client.projects.summary(p.id))).status).toBe(404);
  });

  it('puts mounted works in projects without touching their files', async () => {
    const s = await start({
      jobs: { pollMs: 5 },
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    });
    const folder = tempDir();
    const file = path.join(folder, 'note.md');
    fs.writeFileSync(file, '# 外部\n\n內容\n');
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const w = (await s.client.works.list()).items[0];
    if (w === undefined) throw new Error('no external work');
    const p = await s.client.projects.create({ name: '外部' });
    const res = await s.client.projects.batchWorks({ work_ids: [w.id], add: [p.id] });
    expect(res.succeeded).toBe(1);
    expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(hash);
    expect(fs.readdirSync(folder)).toEqual(['note.md']);
    expect(ids((await s.client.works.list({ project_id: p.id })).items)).toEqual([w.id]);
  });

  it('needs read to look and write to change', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const w = await s.client.works.create({ title: 'W' });
    const reader = createClient({
      baseUrl: s.baseUrl,
      token: s.tokens.create({ name: 'r', scopes: ['read'] }).secret,
    });
    const writer = createClient({
      baseUrl: s.baseUrl,
      token: s.tokens.create({ name: 'w', scopes: ['read', 'write'] }).secret,
    });
    expect(ids((await reader.projects.list()).items)).toEqual([p.id]);
    expect((await reader.projects.summary(p.id)).project.id).toBe(p.id);
    for (const call of [
      () => reader.projects.create({ name: 'x' }),
      () => reader.projects.patch(p.id, { base_revision: 1, name: 'x' }),
      () => reader.projects.reorder([p.id]),
      () => reader.projects.remove(p.id),
      () => reader.projects.restore(p.id),
      () => reader.projects.batchWorks({ work_ids: [w.id], add: [p.id] }),
    ]) {
      expect((await apiError(call())).status).toBe(403);
    }
    expect((await writer.projects.batchWorks({ work_ids: [w.id], add: [p.id] })).succeeded).toBe(1);
    expect((await writer.projects.create({ name: 'by agent' })).name).toBe('by agent');
  });
});

describe('migration 0017 rollback', () => {
  it('drops projects and their events, keeps works and every other event, and re-applies cleanly', () => {
    const home = tempDir();
    // Up to 0017: later migrations would be unknown to the rolled-back build.
    const upTo0017 = migrations.filter((m) => m.id <= '0017');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0017);
    try {
      const now = '2026-11-21T00:00:00.000Z';
      db.prepare(
        `INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
           current_revision_id, created_at, updated_at)
         VALUES ('w1', 't', 'article', 'drafting', '[]', 'test', 'managed', 'p', 'r1', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO projects (id, name, color, sort_order, created_at, updated_at)
         VALUES ('p1', 'P', 0, 0, ?, ?)`,
      ).run(now, now);
      db.prepare(
        "INSERT INTO work_projects (work_id, project_id, added_at) VALUES ('w1', 'p1', ?)",
      ).run(now);
      const log = db.prepare(
        "INSERT INTO change_log (entity, entity_id, action, data, created_at) VALUES (?, ?, ?, '{}', ?)",
      );
      log.run('work', 'w1', 'work.created', now);
      log.run('project', 'p1', 'project.created', now);
      log.run('work', 'w1', 'work.projects_changed', now);

      db.exec(PROJECTS_ROLLBACK_SQL);
      const tables = db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name);
      expect(tables).not.toContain('projects');
      expect(tables).not.toContain('work_projects');
      expect(
        db.prepare<[], { action: string }>('SELECT action FROM change_log ORDER BY seq').all(),
      ).toEqual([{ action: 'work.created' }, { action: 'work.projects_changed' }]);
      expect(
        runMigrations(
          db,
          migrations.filter((m) => m.id < '0017'),
        ),
      ).toEqual([]);
      expect(db.prepare("SELECT id FROM works WHERE id = 'w1'").get()).toEqual({ id: 'w1' });
      // The sequence keeps increasing after the rebuild.
      log.run('work', 'w1', 'work.updated', now);
      expect(
        db
          .prepare<[], { seq: number }>("SELECT seq FROM change_log WHERE action = 'work.updated'")
          .get(),
      ).toEqual({ seq: 4 });

      expect(runMigrations(db, upTo0017)).toEqual(['0017']);
    } finally {
      db.close();
    }
  });
});
