import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { TokenScope } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, PROJECT_GROUPS_ROLLBACK_SQL } from '../src/db/migrations.js';
import {
  authHeaders,
  makeTempHome,
  startTestServer,
  type StartOptions,
  type TestServer,
} from './helpers.js';

/** QC-113: groups and series inside a project. Temporary CREATORHUB_HOME; no network. */

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

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

function agent(
  s: TestServer,
  scopes: TokenScope[],
  extra: { project_ids?: string[] } = {},
): { client: CreatorHubClient; id: string } {
  const t = s.tokens.create({ name: '分組 agent', scopes, ...extra });
  return { client: createClient({ baseUrl: s.baseUrl, token: t.secret }), id: t.token.id };
}

function groupEvents(s: TestServer): Record<string, unknown>[] {
  return s.db
    .prepare<[], { data: string }>(
      "SELECT data FROM change_log WHERE action = 'project.groups_changed' ORDER BY seq",
    )
    .all()
    .map((r) => JSON.parse(r.data) as Record<string, unknown>);
}

async function projectWithWorks(
  s: TestServer,
  titles: string[],
): Promise<{ projectId: string; workIds: string[] }> {
  const p = await s.client.projects.create({ name: '京都' });
  const workIds: string[] = [];
  for (const title of titles) {
    workIds.push((await s.client.works.create({ title, project_ids: [p.id] })).id);
  }
  return { projectId: p.id, workIds };
}

describe('project groups (QC-113)', () => {
  it('creates, renames, moves and deletes groups, with revision checks and events', async () => {
    const s = await start();
    const { projectId, workIds } = await projectWithWorks(s, ['A', 'B']);
    const [a] = workIds;

    const series = await s.client.projects.createGroup(projectId, {
      name: '  京都秋季系列 ',
      ordered: true,
    });
    expect(series).toMatchObject({
      project_id: projectId,
      name: '京都秋季系列',
      ordered: true,
      sort_order: 0,
      revision: 1,
      created_by: { kind: 'user', token_id: null, token_name: null },
      work_count: 0,
      work_ids: [],
    });
    const gear = await s.client.projects.createGroup(projectId, { name: '器材' });
    const food = await s.client.projects.createGroup(projectId, { name: '一人食' });
    expect([gear.sort_order, gear.ordered, food.sort_order]).toEqual([1, false, 2]);

    // GET /projects/:id carries the groups in order; the list does not.
    const project = await s.client.projects.get(projectId);
    expect(project.groups?.map((g) => g.name)).toEqual(['京都秋季系列', '器材', '一人食']);
    expect((await s.client.projects.list()).items[0]?.groups).toBeUndefined();

    // Names are unique in a project, 1–60 characters.
    const taken = await apiError(s.client.projects.createGroup(projectId, { name: '器材' }));
    expect([taken.status, taken.code, taken.body?.error.details]).toEqual([
      409,
      'group_name_taken',
      { group_id: gear.id },
    ]);
    for (const name of ['   ', '字'.repeat(61)]) {
      expect((await apiError(s.client.projects.createGroup(projectId, { name }))).status).toBe(400);
    }
    // Another project may use the same name.
    const other = await s.client.projects.create({ name: '別的' });
    expect((await s.client.projects.createGroup(other.id, { name: '器材' })).name).toBe('器材');

    // PATCH needs the group's revision.
    const url = `${s.baseUrl}/api/v1/projects/${projectId}/groups/${gear.id}`;
    const noBase = await fetch(url, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: '器材與工作室' }),
    });
    expect(noBase.status).toBe(428);
    const renamed = await fetch(url, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json', 'if-match': '"1"' }),
      body: JSON.stringify({ name: '器材與工作室' }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.headers.get('etag')).toBe('"2"');
    const stale = await apiError(
      s.client.projects.patchGroup(projectId, gear.id, { base_revision: 1, ordered: true }),
    );
    expect([stale.status, stale.code, stale.body?.error.details]).toEqual([
      409,
      'revision_conflict',
      { current_revision: 2, base_revision: '1' },
    ]);
    const dup = await apiError(
      s.client.projects.patchGroup(projectId, gear.id, { base_revision: 2, name: '一人食' }),
    );
    expect(dup.code).toBe('group_name_taken');

    // 上移／下移: sort_order moves one group, the others shift.
    const moved = await s.client.projects.patchGroup(projectId, food.id, {
      base_revision: 1,
      sort_order: 0,
    });
    expect(moved).toMatchObject({ sort_order: 0, revision: 2 });
    const order = async (): Promise<string[]> =>
      ((await s.client.projects.get(projectId)).groups ?? []).map((g) => g.name);
    expect(await order()).toEqual(['一人食', '京都秋季系列', '器材與工作室']);
    await s.client.projects.patchGroup(projectId, food.id, { base_revision: 2, sort_order: 99 });
    expect(await order()).toEqual(['京都秋季系列', '器材與工作室', '一人食']);
    // Nothing to change: same revision, no event.
    const quiet = groupEvents(s).length;
    expect(
      (await s.client.projects.patchGroup(projectId, food.id, { base_revision: 3, sort_order: 2 }))
        .revision,
    ).toBe(3);
    expect(groupEvents(s)).toHaveLength(quiet);

    // Deleting a group puts its works back in 未分組; they stay in the project.
    await s.client.projects.assignGroup(projectId, { work_ids: workIds, group_id: gear.id });
    const work = await s.client.works.get(a ?? '');
    const after = await s.client.projects.removeGroup(projectId, gear.id);
    expect(after.groups?.map((g) => [g.name, g.sort_order])).toEqual([
      ['京都秋季系列', 0],
      ['一人食', 1],
    ]);
    const back = await s.client.works.get(a ?? '');
    expect(back).toMatchObject({
      project_ids: [projectId],
      project_groups: [],
      current_revision_id: work.current_revision_id,
    });
    expect((await apiError(s.client.projects.removeGroup(projectId, gear.id))).status).toBe(404);
    // A group is only reachable through its own project.
    expect((await apiError(s.client.projects.removeGroup(other.id, series.id))).status).toBe(404);

    expect(groupEvents(s).map((e) => e['change'])).toEqual([
      'created',
      'created',
      'created',
      'created',
      'updated',
      'updated',
      'updated',
      'assigned',
      'deleted',
    ]);
    expect(groupEvents(s).at(-1)).toEqual({
      change: 'deleted',
      group_id: gear.id,
      work_ids: workIds,
    });
    expect(groupEvents(s)[4]).toEqual({
      change: 'updated',
      group_id: gear.id,
      fields: ['name'],
      revision: 2,
      work_ids: [],
    });
  });

  it('keeps series numbered 1..n without gaps: insert, move, leave, trash', async () => {
    const s = await start();
    const { projectId, workIds } = await projectWithWorks(s, ['一', '二', '三', '四', '五']);
    const [w1, w2, w3, w4, w5] = workIds as [string, string, string, string, string];
    const series = await s.client.projects.createGroup(projectId, {
      name: '系列',
      ordered: true,
    });
    const ids = async (): Promise<string[]> =>
      (await s.client.projects.get(projectId)).groups?.find((g) => g.id === series.id)?.work_ids ??
      [];
    const episode = async (workId: string): Promise<number | null | undefined> =>
      (await s.client.works.get(workId)).project_groups?.find((g) => g.group_id === series.id)
        ?.episode;

    await s.client.projects.assignGroup(projectId, {
      work_ids: [w1, w2, w3],
      group_id: series.id,
    });
    expect(await ids()).toEqual([w1, w2, w3]);
    expect((await s.client.works.get(w2)).project_groups).toEqual([
      {
        project_id: projectId,
        group_id: series.id,
        group_name: '系列',
        ordered: true,
        episode: 2,
      },
    ]);

    // Insert at episode 2: the others move down.
    await s.client.projects.assignGroup(projectId, {
      work_ids: [w4, w5],
      group_id: series.id,
      position: 2,
    });
    expect(await ids()).toEqual([w1, w4, w5, w2, w3]);
    expect(await episode(w3)).toBe(5);
    expect(
      JSON.parse(
        s.db
          .prepare<[], { data: string }>(
            "SELECT data FROM change_log WHERE action = 'project.groups_changed' ORDER BY seq DESC LIMIT 1",
          )
          .get()?.data ?? '{}',
      ),
    ).toEqual({ change: 'assigned', group_id: series.id, work_ids: [w2, w3, w4, w5] });

    // Moving a work already in the series reorders it.
    await s.client.projects.assignGroup(projectId, {
      work_ids: [w3],
      group_id: series.id,
      position: 1,
    });
    expect(await ids()).toEqual([w3, w1, w4, w5, w2]);
    // Past the end means last.
    await s.client.projects.assignGroup(projectId, {
      work_ids: [w3],
      group_id: series.id,
      position: 50,
    });
    expect(await ids()).toEqual([w1, w4, w5, w2, w3]);
    // Same place again: nothing changes, no event.
    const quiet = groupEvents(s).length;
    await s.client.projects.assignGroup(projectId, {
      work_ids: [w3],
      group_id: series.id,
      position: 5,
    });
    expect(groupEvents(s)).toHaveLength(quiet);

    // Leaving: back to 未分組, and the rest close up.
    await s.client.projects.assignGroup(projectId, { work_ids: [w4], group_id: null });
    expect(await ids()).toEqual([w1, w5, w2, w3]);
    expect((await s.client.works.get(w4)).project_groups).toEqual([]);
    expect(
      s.db
        .prepare<[string], { work_id: string; position: number }>(
          'SELECT work_id, position FROM work_projects WHERE group_id = ? ORDER BY position',
        )
        .all(series.id),
    ).toEqual([
      { work_id: w1, position: 1 },
      { work_id: w5, position: 2 },
      { work_id: w2, position: 3 },
      { work_id: w3, position: 4 },
    ]);

    // A work in 回收站 leaves the numbering, and comes back at its place.
    const trashed = await s.client.works.get(w5);
    await s.client.works.trash(w5, { base_revision: trashed.current_revision_id });
    expect(await ids()).toEqual([w1, w2, w3]);
    expect(await episode(w3)).toBe(3);
    // Positions count works not in 回收站: episode 2 lands before w2.
    await s.client.projects.assignGroup(projectId, {
      work_ids: [w4],
      group_id: series.id,
      position: 2,
    });
    expect(await ids()).toEqual([w1, w4, w2, w3]);
    // w5 kept its place right after w1; episode 2 went right before w2.
    await s.client.works.restoreFromTrash(w5, { base_revision: trashed.current_revision_id });
    expect(await ids()).toEqual([w1, w5, w4, w2, w3]);

    // A plain group has no episodes; turning the series off keeps the order.
    const off = await s.client.projects.patchGroup(projectId, series.id, {
      base_revision: 1,
      ordered: false,
    });
    expect(off.work_ids).toEqual([w1, w5, w4, w2, w3]);
    expect(await episode(w1)).toBeNull();
    expect(groupEvents(s).at(-1)).toMatchObject({ fields: ['ordered'], work_ids: off.work_ids });
  });

  it('keeps one group per work in a project, separately in each project', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: 'P' });
    const q = await s.client.projects.create({ name: 'Q' });
    const w = await s.client.works.create({ title: '稿', project_ids: [p.id, q.id] });
    const outsider = await s.client.works.create({ title: '外' });
    const pa = await s.client.projects.createGroup(p.id, { name: 'A' });
    const pb = await s.client.projects.createGroup(p.id, { name: 'B', ordered: true });
    const qa = await s.client.projects.createGroup(q.id, { name: 'A' });
    const file = path.join(s.home, 'library/works', w.id, 'source.md');
    const before = fs.readFileSync(file, 'utf8');

    await s.client.projects.assignGroup(p.id, { work_ids: [w.id], group_id: pa.id });
    await s.client.projects.assignGroup(q.id, { work_ids: [w.id], group_id: qa.id });
    // Moving within P takes it out of A.
    const res = await s.client.projects.assignGroup(p.id, { work_ids: [w.id], group_id: pb.id });
    expect(res.groups?.map((g) => [g.name, g.work_ids])).toEqual([
      ['A', []],
      ['B', [w.id]],
    ]);
    const got = await s.client.works.get(w.id);
    expect(got.project_groups).toEqual([
      { project_id: p.id, group_id: pb.id, group_name: 'B', ordered: true, episode: 1 },
      { project_id: q.id, group_id: qa.id, group_name: 'A', ordered: false, episode: null },
    ]);
    // Card data comes with list items too.
    const listed = (await s.client.works.list({ project_id: p.id })).items.find(
      (i) => i.id === w.id,
    );
    expect(listed?.project_groups).toEqual(got.project_groups);
    // Metadata only: same revision, same file.
    expect(got.current_revision_id).toBe(w.current_revision_id);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // All or nothing.
    const notIn = await apiError(
      s.client.projects.assignGroup(p.id, { work_ids: [w.id, outsider.id], group_id: pa.id }),
    );
    expect([notIn.status, notIn.code, notIn.body?.error.details]).toEqual([
      409,
      'work_not_in_project',
      { work_ids: [outsider.id] },
    ]);
    expect((await s.client.works.get(w.id)).project_groups?.[0]?.group_id).toBe(pb.id);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await apiError(
          s.client.projects.assignGroup(p.id, { work_ids: [unknown], group_id: pa.id }),
        )
      ).status,
    ).toBe(404);
    // A group of another project is not found here.
    expect(
      (await apiError(s.client.projects.assignGroup(p.id, { work_ids: [w.id], group_id: qa.id })))
        .status,
    ).toBe(404);
    // position needs a group.
    expect(
      (
        await apiError(
          s.client.projects.assignGroup(p.id, { work_ids: [w.id], group_id: null, position: 1 }),
        )
      ).status,
    ).toBe(400);

    // Leaving the project leaves its group too; coming back starts in 未分組.
    await s.client.projects.batchWorks({ work_ids: [w.id], remove: [p.id] });
    expect((await s.client.works.get(w.id)).project_groups?.map((g) => g.project_id)).toEqual([
      q.id,
    ]);
    await s.client.projects.batchWorks({ work_ids: [w.id], add: [p.id] });
    expect((await s.client.works.get(w.id)).project_groups?.map((g) => g.project_id)).toEqual([
      q.id,
    ]);
  });

  it('puts new works and rule assignments in 未分組', async () => {
    const s = await start();
    const p = await s.client.projects.create({
      name: '京都',
      rules: { keywords: ['京都'], tags: ['京都'] },
    });
    await s.client.projects.createGroup(p.id, { name: '系列', ordered: true });
    const created = await s.client.works.create({ title: '京都一日', project_ids: [p.id] });
    expect(created.project_groups).toEqual([]);
    const ruled = await s.client.works.create({
      title: '京都紅葉',
      markdown: '# 京都紅葉\n\n京都的秋天。\n',
      tags: ['京都'],
      auto_assign: true,
    });
    expect(ruled.project_ids).toEqual([p.id]);
    expect(ruled.project_groups).toEqual([]);
  });

  it('follows its project: hidden while deleted, back on restore, gone on purge', async () => {
    let now = new Date('2026-11-01T00:00:00.000Z');
    const s = await start({ projects: { now: () => now } });
    const { projectId, workIds } = await projectWithWorks(s, ['A']);
    const [a] = workIds as [string];
    const g = await s.client.projects.createGroup(projectId, { name: '系列', ordered: true });
    await s.client.projects.assignGroup(projectId, { work_ids: [a], group_id: g.id });

    await s.client.projects.remove(projectId);
    expect((await s.client.works.get(a)).project_groups).toEqual([]);
    expect((await apiError(s.client.projects.createGroup(projectId, { name: '新' }))).status).toBe(
      404,
    );
    expect(
      (await apiError(s.client.projects.assignGroup(projectId, { work_ids: [a], group_id: null })))
        .status,
    ).toBe(404);

    const restored = await s.client.projects.restore(projectId);
    expect(restored.groups?.map((x) => [x.id, x.work_ids])).toEqual([[g.id, [a]]]);
    expect((await s.client.works.get(a)).project_groups?.[0]).toMatchObject({ episode: 1 });

    await s.client.projects.remove(projectId);
    now = new Date('2026-12-02T00:00:00.000Z');
    expect(s.projects.purgeExpired()).toEqual([projectId]);
    expect(s.db.prepare('SELECT count(*) AS n FROM project_groups').get()).toEqual({ n: 0 });
  });

  it('lets write tokens manage groups, records the agent, and keeps project limits', async () => {
    const s = await start();
    const { projectId, workIds } = await projectWithWorks(s, ['A']);
    const [a] = workIds as [string];
    const other = await s.client.projects.create({ name: '別的' });

    const writer = agent(s, ['read', 'write']);
    const g = await writer.client.projects.createGroup(projectId, { name: 'Agent 分組' });
    expect(g.created_by).toEqual({ kind: 'agent', token_id: writer.id, token_name: '分組 agent' });
    await writer.client.projects.assignGroup(projectId, { work_ids: [a], group_id: g.id });
    const renamed = await writer.client.projects.patchGroup(projectId, g.id, {
      base_revision: 1,
      name: '改名',
    });
    expect(renamed.created_by.kind).toBe('agent');
    expect(
      s.db
        .prepare<[], { actor: string | null }>(
          "SELECT actor FROM change_log WHERE action = 'project.groups_changed' ORDER BY seq",
        )
        .all()
        .map((r) => r.actor),
    ).toEqual([writer.id, writer.id, writer.id]);

    // read and propose tokens cannot change groups (propose-only cannot delete).
    for (const scopes of [['read'], ['read', 'propose']] satisfies TokenScope[][]) {
      const t = agent(s, scopes);
      expect((await t.client.projects.get(projectId)).groups?.length).toBe(1);
      expect((await apiError(t.client.projects.createGroup(projectId, { name: 'x' }))).status).toBe(
        403,
      );
      expect((await apiError(t.client.projects.removeGroup(projectId, g.id))).status).toBe(403);
      expect(
        (
          await apiError(
            t.client.projects.assignGroup(projectId, { work_ids: [a], group_id: null }),
          )
        ).status,
      ).toBe(403);
    }

    // A token limited to another project does not see this one's groups.
    const limited = agent(s, ['read', 'write'], { project_ids: [other.id] });
    expect(
      (await apiError(limited.client.projects.createGroup(projectId, { name: 'x' }))).status,
    ).toBe(404);
    expect((await apiError(limited.client.projects.removeGroup(projectId, g.id))).status).toBe(404);
    expect((await s.client.works.get(a)).project_groups?.length).toBe(1);

    await writer.client.projects.removeGroup(projectId, g.id);
    expect((await s.client.works.get(a)).project_groups).toEqual([]);
  });
});

describe('migration 0024 rollback', () => {
  it('drops groups and work group columns only, and re-applies', () => {
    const home = makeTempHome();
    dirs.push(home);
    const upTo0024 = migrations.filter((m) => m.id <= '0024');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0024);
    try {
      const now = '2026-11-27T00:00:00.000Z';
      db.prepare(
        `INSERT INTO projects (id, name, color, sort_order, revision, created_at, updated_at)
         VALUES ('p1', 'P', 0, 0, 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO project_groups (id, project_id, name, sort_order, created_by, created_at, updated_at)
         VALUES ('g1', 'p1', 'G', 0, 'user', ?, ?)`,
      ).run(now, now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO project_groups (id, project_id, name, sort_order, created_by, created_at, updated_at)
             VALUES ('g2', 'p1', 'G', 1, 'user', ?, ?)`,
          )
          .run(now, now),
      ).toThrow();
      db.exec(PROJECT_GROUPS_ROLLBACK_SQL);
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('work_projects')")
        .all()
        .map((c) => c.name);
      expect(cols).not.toContain('group_id');
      expect(cols).not.toContain('position');
      expect(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'project_groups'").get(),
      ).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
      expect(runMigrations(db, upTo0024)).toEqual(['0024']);
      expect(db.prepare('SELECT count(*) AS n FROM project_groups').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
