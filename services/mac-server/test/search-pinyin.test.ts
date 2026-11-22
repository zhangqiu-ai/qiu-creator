import { findMatches, PINYIN_LONG_TEXT_MIN_LENGTH } from '@qiu-creator/domain/search';
import { afterEach, describe, expect, it } from 'vitest';
import { pngBytes } from './fixtures.js';
import { startTestServer, type TestServer } from './helpers.js';

/** QC-079: pinyin search for works and assets. Temporary CREATORHUB_HOME; no network. */

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false } });
  servers.push(s);
  return s;
}

const ids = (items: { id: string }[]): string[] => items.map((i) => i.id).sort();

describe('pinyin search (QC-079)', () => {
  it('finds works by the pinyin of titles and tags from 2 letters, bodies from 4', async () => {
    const s = await start();
    const tools = await s.client.works.create({
      title: '常用工具',
      markdown: '# 常用工具\n\n清單',
    });
    const trip = await s.client.works.create({
      title: '週末',
      tags: ['京都旅行'],
      markdown: '# 週末\n\n散步',
    });
    const bank = await s.client.works.create({ title: '銀行帳戶', markdown: '# 銀行帳戶\n\n筆記' });
    const autumn = await s.client.works.create({
      title: '隨筆',
      markdown: '# 隨筆\n\n很久以前寫的。今年的秋天旅行很愉快，紅葉也早。',
    });

    expect(ids((await s.client.works.list({ q: 'cy' })).items)).toEqual([tools.id]);
    expect(ids((await s.client.works.list({ q: 'changyong' })).items)).toEqual([tools.id]);
    expect(ids((await s.client.works.list({ q: 'Chang Yong' })).items)).toEqual([tools.id]);
    expect(ids((await s.client.works.list({ q: 'jdlx' })).items)).toEqual([trip.id]);
    expect(ids((await s.client.works.list({ q: 'yinhang' })).items)).toEqual([bank.id]);
    // Body: 4 letters and up only.
    expect(ids((await s.client.works.list({ q: 'qtlx' })).items)).toEqual([autumn.id]);
    expect(ids((await s.client.works.list({ q: 'qiutian' })).items)).toEqual([autumn.id]);
    expect((await s.client.works.list({ q: 'qt' })).total).toBe(0);
    expect('qt'.length).toBeLessThan(PINYIN_LONG_TEXT_MIN_LENGTH);
    // Literal search still works alongside.
    expect(ids((await s.client.works.list({ q: '常用' })).items)).toEqual([tools.id]);

    // Facets, refs and paging agree with the list.
    expect((await s.client.works.facets({ q: 'cy' })).total).toBe(1);
    expect(ids((await s.client.works.refs({ q: 'qtlx' })).items)).toEqual([autumn.id]);
    const page = await s.client.works.list({ q: 'cy', limit: 1 });
    expect(page).toMatchObject({ total: 1, next_cursor: null });
  });

  it('gives a body passage whose hit the app can mark with the same rule', async () => {
    const s = await start();
    const w = await s.client.works.create({
      title: '隨筆',
      markdown: `# 隨筆\n\n${'前言'.repeat(40)}今年的秋天旅行很愉快。`,
    });
    const item = (await s.client.works.list({ q: 'qiutianlvxing' })).items.find(
      (i) => i.id === w.id,
    );
    const passage = item?.match_excerpt ?? '';
    expect(passage).toContain('秋天旅行');
    const marked = findMatches(passage, 'qiutianlvxing', {
      pinyinMinLength: PINYIN_LONG_TEXT_MIN_LENGTH,
    }).map((r) => passage.slice(r.start, r.end));
    expect(marked).toEqual(['秋天旅行']);
    // A title hit gives no passage; a tag hit neither.
    const titled = await s.client.works.create({ title: '秋天旅行', markdown: '# 秋天旅行\n\n文' });
    const tagged = await s.client.works.create({
      title: '照片',
      tags: ['秋天'],
      markdown: '# 照片\n\n',
    });
    const page = await s.client.works.list({ q: 'qiutian' });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(titled.id)?.match_excerpt).toBeNull();
    expect(byId.get(tagged.id)?.match_excerpt).toBeNull();
  });

  it('finds assets by the pinyin of their names', async () => {
    const s = await start();
    const { asset } = await s.client.assets.upload({
      data: await pngBytes(8, 8, '#336699'),
      filename: '京都紅葉.png',
    });
    await s.client.assets.upload({ data: await pngBytes(8, 8, '#996633'), filename: 'other.png' });
    expect((await s.client.assets.list({ q: 'jdhy' })).items.map((i) => i.id)).toEqual([asset.id]);
    expect((await s.client.assets.list({ q: 'jingdu' })).items.map((i) => i.id)).toEqual([
      asset.id,
    ]);
    await s.client.assets.update(asset.id, { base_revision: 1, display_name: '常用封面' });
    expect((await s.client.assets.list({ q: 'cyfm' })).items.map((i) => i.id)).toEqual([asset.id]);
  });
});
