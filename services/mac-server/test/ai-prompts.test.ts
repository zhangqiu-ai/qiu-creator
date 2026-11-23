import fs from 'node:fs';
import path from 'node:path';
import { ApiError, promptSuggestionOf, rewriteOf, suggestionsOf } from '@qiu-creator/api-client';
import { AI_NOTICE_VERSION, type AiJobRecord } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, PROMPTS_ROLLBACK_SQL } from '../src/db/migrations.js';
import { FakeAiServer, ok } from './fake-ai.js';
import { authHeaders, makeTempHome, startTestServer, type TestServer } from './helpers.js';

/**
 * QC-075 (prototype PT-20261122-003): output language, prompt library,
 * remembered models. Fake providers only; temporary home.
 */

const KEY = 'sk-proj-fake-prompts-0123456789';
const MARKDOWN = '# 京都秋天\n\n今年的紅葉比往年早。\n\n清水寺人很多，嵐山比較安靜。\n';

const servers: TestServer[] = [];
const fakes: FakeAiServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(markdown = MARKDOWN) {
  const fake = new FakeAiServer();
  await fake.start();
  fakes.push(fake);
  const s = await startTestServer({
    ai: { baseUrls: fake.baseUrls(), retryBaseMs: 10, pollMs: 10, timeoutMs: 2000 },
  });
  servers.push(s);
  await s.client.ai.setKey('openai', KEY);
  await s.client.ai.consent('openai', AI_NOTICE_VERSION);
  const work = await s.client.works.create({ title: '京都秋天', markdown, tags: ['旅行'] });
  return { s, fake, work };
}

async function finished(s: TestServer, id: string): Promise<AiJobRecord> {
  await s.ai.drain();
  return s.client.ai.job(id);
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

const sent = (fake: FakeAiServer, i: number) => {
  const req = fake.for('openai')[i];
  return {
    system: String(req?.body['instructions']),
    prompt: String(req?.body['input']),
    model: req?.body['model'],
  };
};

const range = (text: string) => ({
  start: MARKDOWN.indexOf(text),
  end: MARKDOWN.indexOf(text) + text.length,
});

describe('AI preferences (QC-075)', () => {
  it('defaults to follow, merges remembered models and records an event', async () => {
    const { s } = await start();
    expect(await s.client.ai.preferences()).toEqual({
      output_language: 'follow',
      last_models: { rewrite: null, suggestions: null, video: null, image: null, prompt: null },
    });
    await s.client.ai.patchPreferences({ output_language: 'en' });
    const both = await s.client.ai.patchPreferences({
      last_models: { image: { provider: 'new-api', model: 'gpt-image-1' } },
    });
    expect(both.output_language).toBe('en');
    expect(both.last_models.image).toEqual({ provider: 'new-api', model: 'gpt-image-1' });
    expect(
      (await s.client.ai.patchPreferences({ last_models: { image: null } })).last_models.image,
    ).toBeNull();
    expect(
      s.db
        .prepare("SELECT count(*) AS n FROM change_log WHERE action = 'ai_preferences.changed'")
        .get(),
    ).toEqual({ n: 3 });
    const res = await fetch(`${s.baseUrl}/api/v1/ai/preferences`, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ output_language: 'auto' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists the models of ready providers for the toolbar', async () => {
    const { s } = await start();
    expect(await s.client.ai.models()).toEqual({
      items: [
        // QC-082: the official providers list their configured text model.
        { provider: 'openai', model: 'gpt-5.5', kind: 'chat', default: true, source: 'configured' },
      ],
      errors: [],
    });
    expect((await s.client.ai.models('image')).items).toEqual([]);
  });
});

describe('prompt library (QC-075)', () => {
  it('lists read-only built-ins first, then custom prompts with revision checks', async () => {
    const { s } = await start();
    const initial = await s.client.ai.prompts.list();
    expect(initial.items.map((p) => p.id)).toEqual([
      'builtin-polish',
      'builtin-expand',
      'builtin-shorten',
      'builtin-tone',
      'builtin-title',
      'builtin-cover',
    ]);
    expect(initial.items.every((p) => p.builtin && p.revision === 0 && p.use_count === 0)).toBe(
      true,
    );

    const a = await s.client.ai.prompts.create({
      name: ' 翻成口語 ',
      content: '把 {選取} 改得更口語。',
      group: '風格',
    });
    expect(a).toMatchObject({
      name: '翻成口語',
      scene: 'selection',
      group: '風格',
      model: null,
      language: null,
      revision: 1,
      builtin: false,
    });
    const b = await s.client.ai.prompts.create({
      name: '小紅書標題',
      content: '寫{平台}風格的標題',
      scene: 'title',
      model: { provider: 'openai', model: 'gpt-5.5-mini' },
    });
    expect(b.model).toEqual({ provider: 'openai', model: 'gpt-5.5-mini' });
    // Name ≤ 40, content ≤ 4000 (PT-20261122-003).
    for (const body of [
      { name: '字'.repeat(41), content: 'x' },
      { name: 'n', content: 'x'.repeat(4001) },
      { name: 'n', content: 'x', scene: 'document' },
    ]) {
      const res = await fetch(`${s.baseUrl}/api/v1/ai/prompts`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }

    expect((await apiError(s.client.ai.prompts.patch(a.id, { name: 'x' }))).status).toBe(428);
    const edited = await s.client.ai.prompts.patch(a.id, {
      base_revision: 1,
      content: '把 {選取} 改得更口語、更短。',
      model: { provider: 'openai', model: 'gpt-5.5' },
    });
    expect(edited).toMatchObject({ revision: 2, model: { provider: 'openai', model: 'gpt-5.5' } });
    expect(
      (await s.client.ai.prompts.patch(a.id, { base_revision: 2, model: null })).model,
    ).toBeNull();
    const stale = await apiError(s.client.ai.prompts.patch(a.id, { base_revision: 1, name: 'y' }));
    expect(stale.status).toBe(409);
    expect(stale.body?.error.code).toBe('revision_conflict');

    expect(
      (await apiError(s.client.ai.prompts.patch('builtin-polish', { base_revision: 1, name: 'x' })))
        .status,
    ).toBe(403);
    expect((await apiError(s.client.ai.prompts.remove('builtin-polish'))).status).toBe(403);
    const copy = await s.client.ai.prompts.duplicate('builtin-polish');
    expect(copy).toMatchObject({ name: '潤色（副本）', builtin: false, scene: 'selection' });

    const reordered = await s.client.ai.prompts.reorder([copy.id, b.id, a.id]);
    expect(reordered.items.filter((p) => !p.builtin).map((p) => p.id)).toEqual([
      copy.id,
      b.id,
      a.id,
    ]);
    expect((await apiError(s.client.ai.prompts.reorder([a.id]))).status).toBe(400);

    await s.client.ai.prompts.remove(b.id);
    expect((await s.client.ai.prompts.list()).items.some((p) => p.id === b.id)).toBe(false);
    expect((await apiError(s.client.ai.prompts.remove(b.id))).status).toBe(404);
    const actions = s.db
      .prepare<[], { data: string }>(
        "SELECT data FROM change_log WHERE action = 'prompts.changed' ORDER BY seq",
      )
      .all()
      .map((r) => (JSON.parse(r.data) as { action: string }).action);
    expect(actions).toEqual([
      'created',
      'created',
      'updated',
      'updated',
      'created',
      'reordered',
      'deleted',
    ]);
  });

  it('exports custom prompts and imports a file, naming clashes 「（副本）」', async () => {
    const { s } = await start();
    await s.client.ai.prompts.create({ name: '口語', content: '改口語', language: 'zh-Hans' });
    const file = await s.client.ai.prompts.exportAll();
    expect(file).toMatchObject({
      version: 1,
      prompts: [
        { name: '口語', group: null, scene: 'selection', content: '改口語', language: 'zh-Hans' },
      ],
    });
    expect(file.prompts[0]).not.toHaveProperty('model');
    const result = await s.client.ai.prompts.import({
      version: 1,
      prompts: [
        { name: '口語', content: '改口語' },
        { name: '配圖', content: '為 {選取} 畫插圖', scene: 'image', group: '圖' },
        {
          name: '配圖',
          content: '另一種',
          scene: 'image',
          model: { provider: 'new-api', model: 'flux' },
        },
      ],
    });
    expect(result).toMatchObject({ imported: 3, renamed: 2 });
    expect(result.items.map((p) => p.name)).toEqual(['口語（副本）', '配圖', '配圖（副本）']);
    expect(result.items[2]?.model).toEqual({ provider: 'new-api', model: 'flux' });

    for (const bad of [
      { version: 2, prompts: [] },
      { version: 1, prompts: [{ name: 'n', content: 'b', scene: 'document' }] },
      { version: 1, prompts: Array.from({ length: 501 }, () => ({ name: 'n', content: 'b' })) },
    ]) {
      const res = await fetch(`${s.baseUrl}/api/v1/ai/prompts/import`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });

  it('previews the five variables and the language it would use', async () => {
    const { s, work } = await start();
    const preview = await s.client.ai.prompts.preview({
      content: '《{標題}》：把「{选取}」用{語言}改寫給{平台}，保留 {未知} 與 {tags}。',
      work_id: work.id,
      selection: range('今年的紅葉'),
      platform: 'xiaohongshu',
    });
    expect(preview).toEqual({
      text: '《京都秋天》：把「今年的紅葉」用繁體中文改寫給小紅書，保留 {未知} 與 {tags}。',
      variables: [
        { name: '標題', known: true },
        { name: '选取', known: true },
        { name: '語言', known: true },
        { name: '平台', known: true },
        { name: '未知', known: false },
        { name: 'tags', known: false },
      ],
      language: 'zh-Hant',
      language_source: 'detected',
    });
    // Nothing to detect: the interface language.
    const plain = await s.client.ai.prompts.preview({
      content: '{語言}',
      interface_language: 'en',
    });
    expect(plain).toMatchObject({ text: 'English', language: 'en', language_source: 'interface' });
  });
});

describe('AI jobs with language and prompts (QC-075)', () => {
  it('follows the selection’s language by default and remembers the model', async () => {
    const { s, fake, work } = await start(
      '# 京都\n\n今年的红叶比往年早。\n\nAutumn came early this year in Kyoto.\n',
    );
    fake.script('openai', ok('openai', '今年红叶早。', 'gpt-5.5'));
    const md = (await s.client.works.get(work.id)).markdown;
    const simp = { start: md.indexOf('今年'), end: md.indexOf('早。') + 2 };
    const { job } = await s.client.ai.rewrite(work.id, {
      provider: 'openai',
      model: 'gpt-5.5',
      mode: 'polish',
      selection: simp,
    });
    expect(job.task).toMatchObject({
      type: 'rewrite',
      language: 'zh-Hans',
      language_source: 'detected',
      model_source: 'request',
      prompt_id: null,
    });
    const done = await finished(s, job.id);
    expect(rewriteOf(done)).toMatchObject({
      language: 'zh-Hans',
      language_source: 'detected',
      model_source: 'request',
    });
    expect(sent(fake, 0).system).toContain('一律使用简体中文输出');
    expect(sent(fake, 0).system).not.toContain('使用與原文相同的語言');
    expect((await s.client.ai.preferences()).last_models.rewrite).toEqual({
      provider: 'openai',
      model: 'gpt-5.5',
    });

    // English text is detected as English.
    fake.script('openai', ok('openai', 'Autumn came early.'));
    const en = md.indexOf('Autumn');
    const { job: english } = await s.client.ai.rewrite(work.id, {
      provider: 'openai',
      mode: 'shorten',
      selection: { start: en, end: en + 'Autumn came early this year in Kyoto.'.length },
    });
    expect(english.task).toMatchObject({
      language: 'en',
      language_source: 'detected',
      model_source: 'default',
    });
    await finished(s, english.id);
    expect(sent(fake, 1).system).toContain('Write the output in English');

    // An explicit language, and the preference when none is sent.
    const { job: asked } = await s.client.ai.rewrite(work.id, {
      provider: 'openai',
      mode: 'polish',
      language: 'zh-Hant',
      selection: simp,
    });
    expect(asked.task).toMatchObject({ language: 'zh-Hant', language_source: 'request' });
    await s.client.ai.patchPreferences({ output_language: 'en' });
    const { job: preferred } = await s.client.ai.rewrite(work.id, {
      provider: 'openai',
      mode: 'expand',
      selection: simp,
    });
    expect(preferred.task).toMatchObject({ language: 'en', language_source: 'preference' });
  });

  it('a prompt’s own model and language win and are marked as the prompt’s', async () => {
    const { s, fake, work } = await start();
    await s.client.ai.patchPreferences({ output_language: 'en' });
    const before = (await s.client.ai.preferences()).last_models.rewrite;
    const prompt = await s.client.ai.prompts.create({
      name: '口語',
      content: '把「{選取}」改成《{標題}》讀者愛看的口語，用{語言}。',
      model: { provider: 'openai', model: 'gpt-5.5-mini' },
      language: 'zh-Hans',
    });
    fake.script('openai', ok('openai', '清水寺人超多。'));
    const { job } = await s.client.ai.rewrite(work.id, {
      provider: 'openai',
      model: 'gpt-5.5',
      language: 'zh-Hant',
      prompt_id: prompt.id,
      selection: range('清水寺人很多'),
    });
    expect(job).toMatchObject({ model: 'gpt-5.5-mini' });
    expect(job.task).toMatchObject({
      mode: 'custom',
      prompt_id: prompt.id,
      language: 'zh-Hans',
      language_source: 'prompt',
      model_source: 'prompt',
    });
    const done = await finished(s, job.id);
    expect(rewriteOf(done)).toMatchObject({ language_source: 'prompt', model_source: 'prompt' });
    const { prompt: input, system, model } = sent(fake, 0);
    expect(model).toBe('gpt-5.5-mini');
    expect(input).toContain(
      '依照這條指令改寫：把「清水寺人很多」改成《京都秋天》讀者愛看的口語，用简体中文。',
    );
    expect(system).toContain('一律使用简体中文输出');
    const used = (await s.client.ai.prompts.list()).items.find((p) => p.id === prompt.id);
    expect(used).toMatchObject({ use_count: 1 });
    expect(used?.last_used_at).not.toBeNull();
    // The toolbar's remembered model is left alone.
    expect((await s.client.ai.preferences()).last_models.rewrite).toEqual(before);

    // A built-in maps to its mode; another scene is refused.
    fake.script('openai', ok('openai', '短。'));
    const { job: builtin } = await s.client.ai.rewrite(work.id, {
      provider: 'openai',
      prompt_id: 'builtin-shorten',
    });
    expect(builtin.task).toMatchObject({ mode: 'shorten', prompt_id: 'builtin-shorten' });
    await finished(s, builtin.id);
    expect(sent(fake, 1).prompt).toContain('縮寫：精簡到約原文一半的長度');
    expect(
      (
        await apiError(
          s.client.ai.rewrite(work.id, { provider: 'openai', prompt_id: 'builtin-tone' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await apiError(
          s.client.ai.rewrite(work.id, { provider: 'openai', prompt_id: 'builtin-cover' }),
        )
      ).status,
    ).toBe(400);
  });

  it('writes titles for a platform with a title prompt and {平台} (QC-076)', async () => {
    const { s, fake, work } = await start();
    const titles = await s.client.ai.prompts.create({
      name: '數字標題',
      content: '{平台}標題要有數字，呼應《{標題}》。',
      scene: 'title',
    });
    fake.script(
      'openai',
      ok(
        'openai',
        JSON.stringify({ wechat_channels: { titles: ['3 個京都秋天的理由'] } }),
        'gpt-5.5',
      ),
    );
    const { job } = await s.client.ai.suggest(work.id, {
      provider: 'openai',
      platforms: ['wechat_channels'],
      fields: ['title'],
      prompt_id: titles.id,
    });
    const done = await finished(s, job.id);
    expect(suggestionsOf(done)).toMatchObject({ language: 'zh-Hant', language_source: 'detected' });
    const { prompt } = sent(fake, 0);
    expect(prompt).toContain('補充要求：微信視頻號標題要有數字，呼應《京都秋天》。');
    // The platform's own title limit is in the request.
    expect(prompt).toContain('微信視頻號（wechat_channels）：標題 ≤ 16 字');
    expect((await s.client.ai.preferences()).last_models.suggestions?.provider).toBe('openai');
  });

  it('drafts or rewrites a prompt as a candidate, writing nothing', async () => {
    const { s, fake } = await start();
    const mine = await s.client.ai.prompts.create({ name: '口語', content: '把 {選取} 改口語。' });
    fake.script(
      'openai',
      ok(
        'openai',
        JSON.stringify({
          name: '更口語',
          scene: 'selection',
          content: '把 {選取} 改得像跟朋友聊天。',
        }),
      ),
    );
    const { job } = await s.client.ai.prompts.suggest({
      provider: 'openai',
      description: '讓它更像聊天',
      base_prompt_id: mine.id,
    });
    expect(job).toMatchObject({ action: 'prompt_suggestion', work_id: null });
    const done = await finished(s, job.id);
    expect(promptSuggestionOf(done)).toEqual({
      type: 'prompt_suggestion',
      base_prompt_id: mine.id,
      base_revision: 1,
      original: { name: '口語', scene: 'selection', content: '把 {選取} 改口語。' },
      candidate: { name: '更口語', scene: 'selection', content: '把 {選取} 改得像跟朋友聊天。' },
      language: 'zh-Hant',
      language_source: 'detected',
    });
    const { prompt: input } = sent(fake, 0);
    expect(input).toContain('<描述>\n讓它更像聊天\n</描述>');
    expect(input).toContain('把 {選取} 改口語。');
    // Nothing written until kept.
    expect((await s.client.ai.prompts.list()).items.find((p) => p.id === mine.id)?.revision).toBe(
      1,
    );
    expect((await s.client.ai.preferences()).last_models.prompt?.provider).toBe('openai');

    fake.script(
      'openai',
      ok('openai', JSON.stringify({ name: '', scene: 'nope', content: '   ' })),
    );
    const { job: bad } = await s.client.ai.prompts.suggest({
      provider: 'openai',
      description: '空的',
    });
    expect((await finished(s, bad.id)).status).toBe('failed');
  });

  it('refuses agent tokens on the new routes', async () => {
    const { s } = await start();
    const agent = s.tokens.create({ name: 'all', scopes: ['read', 'import', 'write'] });
    for (const url of [
      '/api/v1/ai/preferences',
      '/api/v1/ai/models',
      '/api/v1/ai/prompts',
      '/api/v1/ai/prompts/export',
    ]) {
      const res = await fetch(`${s.baseUrl}${url}`, {
        headers: { authorization: `Bearer ${agent.secret}` },
      });
      expect(res.status, url).toBe(403);
    }
  });
});

describe('migration 0019 prompts', () => {
  it('rolls back to an older build and re-applies', () => {
    const home = makeTempHome();
    dirs.push(home);
    // Later migrations are not part of this rollback.
    const upTo0019 = migrations.filter((m) => m.id <= '0019');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0019);
    try {
      db.prepare(
        `INSERT INTO prompts (id, name, scene, content, sort_order, created_at, updated_at)
         VALUES ('p1', 'n', 'selection', 'c', 0, 'now', 'now')`,
      ).run();
      // A model needs both parts.
      expect(() =>
        db
          .prepare(
            `INSERT INTO prompts (id, name, scene, content, model_provider, sort_order, created_at, updated_at)
             VALUES ('p2', 'n', 'selection', 'c', 'openai', 1, 'now', 'now')`,
          )
          .run(),
      ).toThrow(/CHECK/);
      db.exec(PROMPTS_ROLLBACK_SQL);
      const tables = db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name);
      expect(tables).not.toContain('prompts');
      expect(tables).not.toContain('prompt_usage');
      expect(
        runMigrations(
          db,
          migrations.filter((m) => m.id < '0019'),
        ),
      ).toEqual([]);
      expect(runMigrations(db, upTo0019)).toEqual(['0019']);
    } finally {
      db.close();
    }
  });
});
