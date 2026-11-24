import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { ProjectRulesInput, TokenScope } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, PROJECT_RULES_ROLLBACK_SQL } from '../src/db/migrations.js';
import { makeTempHome, startTestServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<TestServer> {
  const s = await startTestServer();
  servers.push(s);
  return s;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

function agent(
  s: TestServer,
  scopes: TokenScope[],
  extra: { project_ids?: string[] } = {},
): { client: CreatorHubClient; id: string } {
  const t = s.tokens.create({ name: 'rules agent', scopes, ...extra });
  return { client: createClient({ baseUrl: s.baseUrl, token: t.secret }), id: t.token.id };
}

const KYOTO: ProjectRulesInput = { keywords: ['京都', '嵐山'], tags: ['旅行'] };

/** Projects 京都 (rules), 食譜 (rules), 空白 (no rules). */
async function projectsWithRules(s: TestServer) {
  const kyoto = await s.client.projects.create({
    name: '京都',
    description: '京都旅行的筆記',
    rules: KYOTO,
  });
  const recipes = await s.client.projects.create({
    name: '食譜',
    rules: { keywords: ['食譜'], domains: ['cookpad.com'] },
  });
  const blank = await s.client.projects.create({ name: '空白' });
  return { kyoto, recipes, blank };
}

describe('project description and rules (QC-092)', () => {
  it('are saved with base_revision and returned with the project', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: '京都' });
    expect(p).toMatchObject({
      description: '',
      rules: { keywords: [], tags: [], folders: [], domains: [] },
    });
    const updated = await s.client.projects.patch(p.id, {
      base_revision: p.revision,
      description: '京都旅行',
      rules: { keywords: ['京都'], domains: ['Example.COM'] },
    });
    expect(updated).toMatchObject({
      revision: p.revision + 1,
      description: '京都旅行',
      rules: { keywords: ['京都'], tags: [], folders: [], domains: ['example.com'] },
    });
    const stale = await apiError(
      s.client.projects.patch(p.id, { base_revision: p.revision, description: 'x' }),
    );
    expect(stale.status).toBe(409);
    const bad = await apiError(
      s.client.projects.patch(p.id, {
        base_revision: updated.revision,
        rules: { domains: ['not a host'] },
      }),
    );
    expect(bad.status).toBe(400);
  });
});

describe('suggestions and rule preview (QC-092)', () => {
  it('ranks projects with rules by score, with reasons; no AI involved', async () => {
    const s = await start();
    const { kyoto, recipes } = await projectsWithRules(s);
    const work = await s.client.works.create({
      title: '京都三日',
      markdown: '# 京都三日\n\n嵐山很美。參考 https://cookpad.com/r/1',
      tags: ['旅行'],
    });
    const items = (await s.client.projects.workSuggestions(work.id)).items;
    expect(items.map((m) => [m.project_id, m.score, m.outcome])).toEqual([
      [kyoto.id, 0.9, 'auto'],
      [recipes.id, 0.7, 'suggest'],
    ]);
    expect(items[0]?.reasons.map((r) => r.text)).toEqual([
      '標題出現「京都」',
      '正文出現「嵐山」',
      '有標籤「旅行」',
    ]);
    // Drafts are scored the same way, without saving anything.
    const draft = await s.client.projects.suggest({ title: '晚餐食譜', tags: [] });
    expect(draft.items.map((m) => [m.project_name, m.outcome])).toEqual([['食譜', 'suggest']]);
  });

  it('previews rules on the 20 most recent works without saving them', async () => {
    const s = await start();
    const { kyoto } = await projectsWithRules(s);
    const inProject = await s.client.works.create({
      title: '京都秋天',
      tags: ['旅行'],
      project_ids: [kyoto.id],
    });
    await s.client.works.create({ title: '嵐山小火車' });
    for (let i = 0; i < 20; i++) await s.client.works.create({ title: `其他 ${String(i)}` });
    const preview = await s.client.projects.previewRules(kyoto.id, {
      rules: { keywords: ['嵐山'] },
    });
    expect(preview.items).toHaveLength(20);
    expect(preview.items.some((i) => i.work_id === inProject.id)).toBe(false);
    const wider = await s.client.projects.previewRules(kyoto.id, {
      rules: { keywords: ['嵐山', '京都'] },
      limit: 50,
    });
    expect(
      wider.items.filter((i) => i.score > 0).map((i) => [i.title, i.outcome, i.member]),
    ).toEqual([
      ['嵐山小火車', 'suggest', false],
      ['京都秋天', 'suggest', true],
    ]);
    // Nothing was saved.
    expect((await s.client.projects.get(kyoto.id)).rules).toEqual({
      keywords: ['京都', '嵐山'],
      tags: ['旅行'],
      folders: [],
      domains: [],
    });
  });

  it('matches external works by mount and folder', async () => {
    const s = await start();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-rules-mount-')));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'kyoto'));
    fs.writeFileSync(path.join(dir, 'kyoto', 'a.md'), '# 筆記\n\n內容');
    fs.writeFileSync(path.join(dir, 'b.md'), '# 其他\n\n內容');
    const mount = await s.client.mounts.create({ path: dir });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const p = await s.client.projects.create({
      name: '京都資料夾',
      rules: { folders: [path.join(dir, 'kyoto')] },
    });
    const works = (await s.client.works.list()).items;
    const a = works.find((w) => w.title === '筆記');
    const b = works.find((w) => w.title === '其他');
    expect((await s.client.projects.workSuggestions(a?.id ?? '')).items).toEqual([
      expect.objectContaining({ project_id: p.id, score: 0.9, outcome: 'auto' }),
    ]);
    expect((await s.client.projects.workSuggestions(b?.id ?? '')).items).toEqual([]);
    await s.client.projects.patch(p.id, {
      base_revision: p.revision,
      rules: { folders: [mount.id] },
    });
    expect((await s.client.projects.workSuggestions(b?.id ?? '')).items[0]?.score).toBe(0.9);
  });
});

describe('auto_assign and who assigned what (QC-092)', () => {
  it('assigns ≥ 0.8 on create, only suggests 0.5–0.8, and records the rule with its reasons', async () => {
    const s = await start();
    const { kyoto, recipes } = await projectsWithRules(s);
    const work = await s.client.works.create({
      title: '京都食譜',
      markdown: '# 京都食譜',
      tags: ['旅行'],
      auto_assign: true,
    });
    expect(work.auto_assignment?.assigned.map((m) => [m.project_id, m.score])).toEqual([
      [kyoto.id, 0.84],
    ]);
    expect(work.auto_assignment?.suggested.map((m) => m.project_id)).toEqual([recipes.id]);
    const memberships = (await s.client.projects.workMemberships(work.id)).items;
    expect(memberships).toHaveLength(1);
    const [rule] = memberships;
    expect(rule?.project_id).toBe(kyoto.id);
    expect(rule?.project_name).toBe('京都');
    expect(rule?.added_by).toMatchObject({ kind: 'rule', token_id: null, score: 0.84 });
    expect(rule?.added_by.reasons.map((r) => [r.kind, r.value])).toEqual([
      ['keyword_title', '京都'],
      ['tag', '旅行'],
    ]);
    // Without auto_assign nothing is assigned and there is no auto_assignment.
    const plain = await s.client.works.create({ title: '京都', tags: ['旅行'] });
    expect(plain.auto_assignment).toBeUndefined();
    expect((await s.client.projects.workMemberships(plain.id)).items).toEqual([]);
  });

  it('keeps or undoes rule and agent assignments; manual ones are never touched by agents', async () => {
    const s = await start();
    const { kyoto, recipes, blank } = await projectsWithRules(s);
    const work = await s.client.works.create({
      title: '京都',
      tags: ['旅行'],
      auto_assign: true,
      project_ids: [blank.id],
    });
    const w = agent(s, ['read', 'write']);
    await w.client.projects.batchWorks({ work_ids: [work.id], add: [recipes.id] });
    const kinds = async () =>
      Object.fromEntries(
        (await s.client.projects.workMemberships(work.id)).items.map((m) => [
          m.project_name,
          [m.added_by.kind, m.added_by.token_id],
        ]),
      );
    expect(await kinds()).toEqual({
      京都: ['rule', null],
      食譜: ['agent', w.id],
      空白: ['user', null],
    });

    // An agent cannot take it out of a project the owner chose, nor turn the owner's into its own.
    const removeManual = await w.client.projects.batchWorks({
      work_ids: [work.id],
      remove: [blank.id],
    });
    expect(removeManual.results[0]).toMatchObject({
      ok: false,
      error: { code: 'membership_manual' },
    });
    await w.client.projects.batchWorks({ work_ids: [work.id], add: [blank.id] });
    expect((await kinds())['空白']).toEqual(['user', null]);

    // Keeping makes it manual; undo only removes agent or rule assignments.
    await s.client.projects.keepMembership(work.id, kyoto.id);
    expect((await kinds())['京都']).toEqual(['user', null]);
    expect((await apiError(s.client.projects.undoMembership(work.id, kyoto.id))).code).toBe(
      'membership_manual',
    );
    const undone = await s.client.projects.undoMembership(work.id, recipes.id);
    expect(undone.items.map((m) => m.project_name)).toEqual(['京都', '空白']);
    // The owner adding by hand also makes an agent's assignment manual.
    await w.client.projects.batchWorks({ work_ids: [work.id], add: [recipes.id] });
    await s.client.projects.batchWorks({ work_ids: [work.id], add: [recipes.id] });
    expect((await kinds())['食譜']).toEqual(['user', null]);

    // Keep and undo are the user's decisions.
    expect((await apiError(w.client.projects.keepMembership(work.id, recipes.id))).status).toBe(
      403,
    );
    expect((await apiError(w.client.projects.undoMembership(work.id, recipes.id))).status).toBe(
      403,
    );
  });

  it('a token limited to projects only auto-assigns inside them', async () => {
    const s = await start();
    const { kyoto, recipes } = await projectsWithRules(s);
    const limited = agent(s, ['read', 'import'], { project_ids: [recipes.id] });
    // Fits 京都 only, which is outside: refused, nothing created.
    const refused = await apiError(
      limited.client.works.create(
        { title: '京都', tags: ['旅行'], auto_assign: true },
        { idempotencyKey: 'limited-auto-0001' },
      ),
    );
    expect(refused).toMatchObject({ status: 403, code: 'project_scope' });
    expect((await s.client.works.list()).items).toEqual([]);
    // Suggestions never mention projects outside.
    expect(
      (await limited.client.projects.suggest({ title: '京都食譜', tags: ['旅行'] })).items.map(
        (m) => m.project_id,
      ),
    ).toEqual([recipes.id]);
    const created = await limited.client.works.create(
      { title: '京都食譜', markdown: 'https://cookpad.com/x', tags: ['旅行'], auto_assign: true },
      { idempotencyKey: 'limited-auto-0002' },
    );
    expect(created.auto_assignment?.assigned.map((m) => m.project_id)).toEqual([recipes.id]);
    expect(
      (await s.client.projects.workMemberships(created.id)).items.map((m) => [
        m.project_id,
        m.added_by.kind,
        m.added_by.token_id,
      ]),
    ).toEqual([[recipes.id, 'rule', limited.id]]);
    expect(kyoto.id).not.toBe(recipes.id);
  });

  it('suggestions and previews only need read', async () => {
    const s = await start();
    const { kyoto } = await projectsWithRules(s);
    const work = await s.client.works.create({ title: '京都' });
    const reader = agent(s, ['read']);
    expect((await reader.client.projects.workSuggestions(work.id)).items).toHaveLength(1);
    expect((await reader.client.projects.suggest({ title: '京都' })).items).toHaveLength(1);
    expect(
      (await reader.client.projects.previewRules(kyoto.id, { rules: { keywords: ['京都'] } }))
        .items,
    ).toHaveLength(1);
    expect((await reader.client.projects.workMemberships(work.id)).items).toEqual([]);
  });
});

describe('migration 0022 rollback', () => {
  it('drops descriptions, rules and provenance, keeps memberships, and re-applies', () => {
    const home = makeTempHome();
    dirs.push(home);
    const upTo0022 = migrations.filter((m) => m.id <= '0022');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0022);
    try {
      const now = '2026-11-24T00:00:00.000Z';
      db.prepare(
        `INSERT INTO works (id, title, type, status, source, storage_mode, source_path,
           current_revision_id, created_at, updated_at)
         VALUES ('w1', 'T', 'article', 'drafting', 'app', 'managed', 'x.md', 'r1', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO projects (id, name, color, sort_order, revision, created_at, updated_at,
           description, rules)
         VALUES ('p1', 'P', 0, 0, 1, ?, ?, 'd', '{"keywords":["k"]}')`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO work_projects (work_id, project_id, added_at, added_by, score, reasons)
         VALUES ('w1', 'p1', ?, 'rule', 0.9, '[]')`,
      ).run(now);
      db.exec(PROJECT_RULES_ROLLBACK_SQL);
      const cols = (t: string) =>
        db
          .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${t}')`)
          .all()
          .map((c) => c.name);
      expect(cols('projects')).not.toContain('rules');
      expect(cols('work_projects')).toEqual(['work_id', 'project_id', 'added_at']);
      expect(db.prepare('SELECT count(*) AS n FROM work_projects').get()).toEqual({ n: 1 });
      expect(runMigrations(db, upTo0022)).toEqual(['0022']);
      expect(db.prepare("SELECT added_by FROM work_projects WHERE work_id = 'w1'").get()).toEqual({
        added_by: 'user',
      });
    } finally {
      db.close();
    }
  });
});
