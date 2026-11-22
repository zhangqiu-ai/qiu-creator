import fs from 'node:fs';
import path from 'node:path';
import { WORK_EXCERPT_MAX_CHARS } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { migrations, SEARCH_FOLD_ROLLBACK_SQL } from '../src/db/migrations.js';
import { pngBytes } from './fixtures.js';
import { makeTempHome, startTestServer, type TestServer } from './helpers.js';

/** QC-068: search folds width, case and Traditional/Simplified; hit passages. Temporary CREATORHUB_HOME; no network. */

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false } });
  servers.push(s);
  return s;
}

const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);

describe('search folding (QC-068)', () => {
  it('matches works across width, case and Traditional/Simplified, short queries in the body too', async () => {
    const s = await start();
    const design = await s.client.works.create({
      title: '設計筆記',
      markdown: '# 設計筆記\n\n草稿',
    });
    const body = await s.client.works.create({
      title: '週記',
      markdown: '# 週記\n\n這些是我常用的 Markdown 工具。',
    });
    const wide = await s.client.works.create({ title: 'ＡＢＣ 清單', tags: ['Ｔｏｏｌｓ'] });
    await s.client.works.create({ title: '無關', markdown: '# 無關\n\n別的內容' });

    // Two characters: the short-query path, now over the body as well.
    expect(ids((await s.client.works.list({ q: '常用' })).items)).toEqual([body.id]);
    expect(ids((await s.client.works.list({ q: '设计' })).items)).toEqual([design.id]);
    expect(ids((await s.client.works.list({ q: 'ab' })).items)).toEqual([wide.id]);
    // Three or more: the trigram index, folded the same way.
    expect(ids((await s.client.works.list({ q: '設計筆記' })).items)).toEqual([design.id]);
    expect(ids((await s.client.works.list({ q: '设计笔记' })).items)).toEqual([design.id]);
    expect(ids((await s.client.works.list({ q: 'MARKDOWN' })).items)).toEqual([body.id]);
    expect(ids((await s.client.works.list({ q: 'abc' })).items)).toEqual([wide.id]);
    expect(ids((await s.client.works.list({ q: 'tools' })).items)).toEqual([wide.id]);
    // Whitespace-only queries are no search.
    expect((await s.client.works.list({ q: '常用 ' })).total).toBe(1);
    // facets and refs use the same filters.
    expect((await s.client.works.facets({ q: '常用' })).total).toBe(1);
    expect(ids((await s.client.works.refs({ q: '设计' })).items)).toEqual([design.id]);
  });

  it('keeps the index folded when a work is edited', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '草稿', markdown: '# 草稿\n\n' });
    expect((await s.client.works.list({ q: '鬱金香' })).total).toBe(0);
    await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      markdown: '# 草稿\n\n鬱金香花田',
    });
    expect(ids((await s.client.works.list({ q: '郁金香' })).items)).toEqual([w.id]);
    const row = s.db
      .prepare<[string], { body: string }>('SELECT body FROM works_fts WHERE work_id = ?')
      .get(w.id);
    expect(row?.body).toContain('郁金香');
  });

  it('gives the passage around a hit only when the title does not show it', async () => {
    const s = await start();
    const filler = '前言'.repeat(60);
    const far = await s.client.works.create({
      title: '旅行',
      markdown: `# 旅行\n\n${filler}我們在**京都**看了紅葉。後面還有很多文字。`,
    });
    const titled = await s.client.works.create({
      title: '京都散步',
      markdown: '# 京都散步\n\n京都',
    });
    const tagged = await s.client.works.create({ title: '照片', tags: ['京都'] });
    const linked = await s.client.works.create({
      title: '連結',
      markdown: '# 連結\n\n[地圖](https://example.com/京都)',
    });

    const page = await s.client.works.list({ q: '京都' });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    const passage = byId.get(far.id)?.match_excerpt ?? '';
    expect(passage).toContain('京都');
    expect(passage.startsWith('…')).toBe(true);
    expect(Array.from(passage.replaceAll('…', '')).length).toBeLessThanOrEqual(
      WORK_EXCERPT_MAX_CHARS,
    );
    // Simplified query, same passage.
    const simplified = await s.client.works.list({ q: '红叶' });
    expect(simplified.items[0]?.match_excerpt).toContain('紅葉');
    expect(byId.get(titled.id)?.match_excerpt).toBeNull();
    expect(byId.get(tagged.id)?.match_excerpt).toBeNull();
    // The URL is not card text: the work is found, but has no passage.
    expect(byId.has(linked.id)).toBe(true);
    expect(byId.get(linked.id)?.match_excerpt).toBeNull();
    // Without a query there is no match_excerpt at all.
    expect((await s.client.works.list()).items.every((i) => i.match_excerpt === undefined)).toBe(
      true,
    );
  });

  it('matches asset names the same way', async () => {
    const s = await start();
    const { asset: a } = await s.client.assets.upload({
      data: await pngBytes(8, 8, '#336699'),
      filename: 'ＫＹＯＴＯ紅葉.png',
    });
    await s.client.assets.upload({ data: await pngBytes(8, 8, '#996633'), filename: 'other.png' });
    expect(ids((await s.client.assets.list({ q: 'kyoto红叶' })).items)).toEqual([a.id]);
    expect(ids((await s.client.assets.list({ q: '叶' })).items)).toEqual([a.id]);
    await s.client.assets.update(a.id, { base_revision: 1, display_name: '楓葉 Cover' });
    expect(ids((await s.client.assets.list({ q: '枫叶 cover' })).items)).toEqual([a.id]);
  });
});

describe('migration 0018 search_fold', () => {
  it('folds the existing index in place, and rolls back to an older build', () => {
    const home = makeTempHome();
    dirs.push(home);
    const upTo0017 = migrations.filter((m) => m.id <= '0017');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0017);
    try {
      db.prepare('INSERT INTO works_fts (work_id, title, tags, body) VALUES (?, ?, ?, ?)').run(
        'w1',
        '設計 ＡＢＣ',
        'Ｔａｇ',
        'Markdown 常用',
      );
      expect(runMigrations(db, migrations)).toEqual(['0018']);
      expect(db.prepare('SELECT title, tags, body FROM works_fts').get()).toEqual({
        title: '设计 abc',
        tags: 'tag',
        body: 'markdown 常用',
      });

      db.exec(SEARCH_FOLD_ROLLBACK_SQL);
      expect(runMigrations(db, upTo0017)).toEqual([]);
      // Re-applying is harmless: folding folded text changes nothing.
      expect(runMigrations(db, migrations)).toEqual(['0018']);
      expect(db.prepare('SELECT title FROM works_fts').get()).toEqual({ title: '设计 abc' });
    } finally {
      db.close();
    }
  });
});
