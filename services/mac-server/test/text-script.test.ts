import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { TokenScope } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, PROJECT_TEXT_SCRIPT_ROLLBACK_SQL } from '../src/db/migrations.js';
import { convertMarkdown, convertPlain } from '../src/works/text-script.js';
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

const ALL: TokenScope[] = ['read', 'import', 'write', 'propose'];

function agent(
  s: TestServer,
  scopes: TokenScope[] = ALL,
  extra: { project_ids?: string[]; allow_direct_body_edit?: boolean } = {},
): CreatorHubClient {
  const t = s.tokens.create({ name: '字體 agent', scopes, ...extra });
  return createClient({ baseUrl: s.baseUrl, token: t.secret });
}

const TRAD_MD = [
  '---',
  'title: 這是設計筆記',
  'cover: assets/設計圖.png',
  'tags:',
  '  - 軟體',
  '---',
  '# 臺灣的軟體設計',
  '',
  '看這個[連結說明](https://例子.com/設計) 和 ![圖片說明](./圖片/設計.png)',
  '',
  '`程式碼` 與 https://www.例子.tw/路徑',
  '',
  '```js',
  'const 說明 = "繁體";',
  '```',
  '<img src="圖片/設計.png"> 後面的文字',
  '',
].join('\n');

describe('script conversion (QC-103)', () => {
  it('converts Traditional to Simplified, leaving code, URLs, paths and front-matter keys', () => {
    const out = convertMarkdown(TRAD_MD, 'zh-Hans');
    expect(out).toContain('title: 这是设计笔记');
    expect(out).toContain('cover: assets/設計圖.png');
    expect(out).toContain('  - 软体');
    expect(out).toContain('# 台湾的软体设计');
    expect(out).toContain(
      '看这个[连结说明](https://例子.com/設計) 和 ![图片说明](./圖片/設計.png)',
    );
    expect(out).toContain('`程式碼` 与 https://www.例子.tw/路徑');
    expect(out).toContain('const 說明 = "繁體";');
    expect(out).toContain('<img src="圖片/設計.png"> 后面的文字');
  });

  it('converts Simplified to Traditional (characters only, no vocabulary changes)', () => {
    expect(convertPlain('软件设计与发展', 'zh-Hant')).toBe('軟件設計與發展');
    expect(convertMarkdown('这里[说明](./图片/设计.md)\n\n`代码`', 'zh-Hant')).toBe(
      '這裡[說明](./图片/设计.md)\n\n`代码`',
    );
  });

  it('leaves text already in the target script, and non-Chinese text, unchanged', () => {
    expect(convertPlain('设计与发展', 'zh-Hans')).toBe('设计与发展');
    expect(convertPlain('設計與發展', 'zh-Hant')).toBe('設計與發展');
    const english = '# Title\n\nSome `code` and [a link](https://example.com).\n';
    expect(convertMarkdown(english, 'zh-Hans')).toBe(english);
  });

  it('keys of `key: value` front matter stay, even when they are Chinese', () => {
    expect(convertMarkdown('---\n標題: 軟體設計\n---\n正文', 'zh-Hans')).toBe(
      '---\n標題: 软体设计\n---\n正文',
    );
  });
});

describe('作品文字字體 setting (QC-103)', () => {
  it('defaults to zh-Hans; only the owner changes it', async () => {
    const s = await start();
    expect(await s.client.settings.textScript()).toEqual({ script: 'zh-Hans', updated_at: null });
    const set = await s.client.settings.setTextScript({ script: 'zh-Hant' });
    expect(set.script).toBe('zh-Hant');
    expect(set.updated_at).not.toBeNull();
    expect(await s.client.settings.textScript()).toEqual(set);
    const a = agent(s);
    expect((await a.settings.textScript()).script).toBe('zh-Hant');
    expect((await apiError(a.settings.setTextScript({ script: 'zh-Hans' }))).status).toBe(403);
    expect(
      (await apiError(s.client.settings.setTextScript({ script: 'en' as 'zh-Hans' }))).status,
    ).toBe(400);
  });

  it('project overrides are the owner’s: saved, cleared with null, 403 for agents', async () => {
    const s = await start();
    const p = await s.client.projects.create({ name: '臺灣', text_script: 'zh-Hant' });
    expect(p.text_script).toBe('zh-Hant');
    const plain = await s.client.projects.create({ name: '空白' });
    expect(plain.text_script).toBeNull();
    const cleared = await s.client.projects.patch(p.id, {
      base_revision: p.revision,
      text_script: null,
    });
    expect(cleared).toMatchObject({ text_script: null, revision: p.revision + 1 });

    const a = agent(s);
    expect(
      (await apiError(a.projects.create({ name: '代理', text_script: 'zh-Hant' }))).status,
    ).toBe(403);
    expect(
      (
        await apiError(
          a.projects.patch(p.id, { base_revision: cleared.revision, text_script: 'zh-Hans' }),
        )
      ).status,
    ).toBe(403);
    // Other project edits by agents still work.
    await a.projects.patch(p.id, { base_revision: cleared.revision, description: '說明' });
  });

  it('session reports the default and the overrides the token may see', async () => {
    const s = await start();
    const tw = await s.client.projects.create({ name: '臺灣', text_script: 'zh-Hant' });
    const other = await s.client.projects.create({ name: '別的', text_script: 'zh-Hant' });
    await s.client.projects.create({ name: '空白' });
    expect((await s.client.session()).text_script).toEqual({
      default: 'zh-Hans',
      projects: [
        { project_id: tw.id, name: '臺灣', script: 'zh-Hant' },
        { project_id: other.id, name: '別的', script: 'zh-Hant' },
      ],
    });
    const limited = agent(s, ['read'], { project_ids: [tw.id] });
    expect((await limited.session()).text_script).toEqual({
      default: 'zh-Hans',
      projects: [{ project_id: tw.id, name: '臺灣', script: 'zh-Hant' }],
    });
  });
});

describe('agent writes are converted; the owner’s are not (QC-103)', () => {
  it('work create: agent text goes to the default script, owner text stays', async () => {
    const s = await start();
    const a = agent(s);
    const work = await a.works.create(
      { title: '臺灣軟體', markdown: TRAD_MD, tags: ['設計', '旅行'] },
      { idempotencyKey: 'qc103-create-1' },
    );
    expect(work.title).toBe('台湾软体');
    expect(work.tags).toEqual(['设计', '旅行']);
    expect(work.markdown).toBe(convertMarkdown(TRAD_MD, 'zh-Hans'));
    expect(work.script_conversion).toEqual({
      script: 'zh-Hans',
      fields: ['title', 'markdown', 'tags'],
    });
    // Stored that way, and a replay returns the same.
    expect((await s.client.works.get(work.id)).title).toBe('台湾软体');
    const replay = await a.works.create(
      { title: '臺灣軟體', markdown: TRAD_MD, tags: ['設計', '旅行'] },
      { idempotencyKey: 'qc103-create-1' },
    );
    expect(replay).toMatchObject({ id: work.id, script_conversion: work.script_conversion });

    const mine = await s.client.works.create({ title: '臺灣軟體', markdown: TRAD_MD });
    expect(mine.title).toBe('臺灣軟體');
    expect(mine.markdown).toBe(TRAD_MD);
    expect(mine.script_conversion).toBeUndefined();
  });

  it('nothing to convert: no script_conversion', async () => {
    const s = await start();
    const work = await agent(s).works.create(
      { title: '简体标题', markdown: '# 简体\n' },
      { idempotencyKey: 'qc103-create-2' },
    );
    expect(work.script_conversion).toBeUndefined();
  });

  it('global zh-Hant converts Simplified, including image descriptions', async () => {
    const s = await start();
    await s.client.settings.setTextScript({ script: 'zh-Hant' });
    const a = agent(s);
    const work = await a.works.create(
      { title: '软件设计', type: 'image', description: '这是说明 [链接](https://例子.com/图片)' },
      { idempotencyKey: 'qc103-create-3' },
    );
    expect(work.title).toBe('軟件設計');
    expect(work.description).toBe('這是說明 [鏈接](https://例子.com/图片)');
    expect(work.script_conversion).toEqual({ script: 'zh-Hant', fields: ['title', 'description'] });
  });

  it('a project override wins over the global setting, on create and on edit', async () => {
    const s = await start();
    const tw = await s.client.projects.create({ name: '臺灣', text_script: 'zh-Hant' });
    const a = agent(s);
    const inProject = await a.works.create(
      { title: '软件设计', markdown: '# 发展\n', project_ids: [tw.id] },
      { idempotencyKey: 'qc103-create-4' },
    );
    expect(inProject).toMatchObject({ title: '軟件設計', markdown: '# 發展\n' });
    const outside = await a.works.create(
      { title: '軟體設計' },
      { idempotencyKey: 'qc103-create-5' },
    );
    expect(outside.title).toBe('软体设计');

    const edited = await a.works.patch(inProject.id, {
      base_revision: inProject.current_revision_id,
      title: '新的标题',
      tags: ['发展'],
    });
    expect(edited).toMatchObject({ title: '新的標題', tags: ['發展'] });
    expect(edited.script_conversion).toEqual({ script: 'zh-Hant', fields: ['title', 'tags'] });

    // Projects that override differently: the global setting applies.
    const cn = await s.client.projects.create({ name: '大陸', text_script: 'zh-Hans' });
    await s.client.projects.batchWorks({ work_ids: [inProject.id], add: [cn.id] });
    const both = await a.works.patch(inProject.id, {
      base_revision: edited.current_revision_id,
      title: '新的標題二',
    });
    expect(both.title).toBe('新的标题二');
  });

  it('owner edits are never converted', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '简体' });
    const patched = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      title: '繁體標題',
      markdown: '# 繁體內容\n',
      tags: ['臺灣'],
    });
    expect(patched).toMatchObject({ title: '繁體標題', markdown: '# 繁體內容\n', tags: ['臺灣'] });
    expect(patched.script_conversion).toBeUndefined();
  });

  it('direct body edits by allowed agents are converted', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '简体', markdown: '# 原文\n' });
    const a = agent(s, ALL, { allow_direct_body_edit: true });
    const patched = await a.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '# 軟體開發\n\n```\n繁體程式\n```\n',
    });
    expect(patched.markdown).toBe('# 软体开发\n\n```\n繁體程式\n```\n');
    expect(patched.script_conversion).toEqual({ script: 'zh-Hans', fields: ['markdown'] });
  });

  it('proposals convert the candidate; the work changes only when accepted', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '简体', markdown: '# 原文\n' });
    const a = agent(s);
    const proposal = await a.proposals.create(
      work.id,
      { base_revision: work.current_revision_id, markdown: '# 原文\n\n軟體設計的說明\n' },
      { idempotencyKey: 'qc103-proposal-1' },
    );
    expect(proposal.proposed_markdown).toBe('# 原文\n\n软体设计的说明\n');
    expect(proposal.script_conversion).toEqual({ script: 'zh-Hans', fields: ['markdown'] });
    expect((await s.client.works.get(work.id)).markdown).toBe('# 原文\n');
    const stored = await s.client.proposals.get(proposal.id);
    expect(stored.proposed_markdown).toBe('# 原文\n\n软体设计的说明\n');
    expect(stored.script_conversion).toBeUndefined();
  });

  it('platform titles and tags are converted for agents only', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '简体' });
    const a = agent(s);
    const v = await a.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 0,
      title: '臺灣軟體',
      tags: ['設計'],
    });
    expect(v).toMatchObject({ title: '台湾软体', tags: ['设计'] });
    expect(v.script_conversion).toEqual({ script: 'zh-Hans', fields: ['title', 'tags'] });
    const mine = await s.client.variants.patch(work.id, 'douyin', {
      base_revision: 0,
      title: '臺灣軟體',
    });
    expect(mine.title).toBe('臺灣軟體');
    expect(mine.script_conversion).toBeUndefined();
  });

  it('batch add_tags converts tags agents add; remove_tags matches as written', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '简体', tags: ['臺灣'] });
    const a = agent(s);
    const added = await a.works.batch(
      {
        action: 'add_tags',
        tags: ['設計'],
        items: [{ id: work.id, base_revision: work.current_revision_id }],
      },
      { idempotencyKey: 'qc103-batch-1' },
    );
    const [first] = added.results;
    expect(first).toMatchObject({
      ok: true,
      work: { tags: ['臺灣', '设计'] },
      script_conversion: { script: 'zh-Hans', fields: ['tags'] },
    });
    const now = await s.client.works.get(work.id);
    const removed = await a.works.batch(
      {
        action: 'remove_tags',
        tags: ['臺灣'],
        items: [{ id: work.id, base_revision: now.current_revision_id }],
      },
      { idempotencyKey: 'qc103-batch-2' },
    );
    expect(removed.results[0]).toMatchObject({ ok: true, work: { tags: ['设计'] } });
  });
});

describe('migration 0023 rollback', () => {
  it('drops project overrides only, and re-applies', () => {
    const home = makeTempHome();
    dirs.push(home);
    const upTo0023 = migrations.filter((m) => m.id <= '0023');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0023);
    try {
      const now = '2026-11-26T00:00:00.000Z';
      db.prepare(
        `INSERT INTO projects (id, name, color, sort_order, revision, created_at, updated_at, text_script)
         VALUES ('p1', 'P', 0, 0, 1, ?, ?, 'zh-Hant')`,
      ).run(now, now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO projects (id, name, color, sort_order, revision, created_at, updated_at, text_script)
             VALUES ('p2', 'Q', 0, 1, 1, ?, ?, 'en')`,
          )
          .run(now, now),
      ).toThrow();
      db.exec(PROJECT_TEXT_SCRIPT_ROLLBACK_SQL);
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('projects')")
        .all()
        .map((c) => c.name);
      expect(cols).not.toContain('text_script');
      expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
      expect(runMigrations(db, upTo0023)).toEqual(['0023']);
      expect(db.prepare("SELECT text_script FROM projects WHERE id = 'p1'").get()).toEqual({
        text_script: null,
      });
    } finally {
      db.close();
    }
  });
});
