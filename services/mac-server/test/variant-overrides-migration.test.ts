import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveVariantBody } from '@qiu-creator/platform-preview';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Db } from '../src/db/database.js';
import { migrations, VARIANT_OVERRIDES_ROLLBACK_SQL } from '../src/db/migrations.js';
import { pngBytes } from './fixtures.js';
import { makeTempHome, startTestServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = '2026-11-01T00:00:00.000Z';

interface Legacy {
  title: string;
  body: string;
  cover?: string | null;
  frame?: number | null;
  images?: string[];
  tags?: string[];
  inherit?: boolean;
}

/** Insert a pre-QC-084 variant row and its history (oldest first) the way the old service did. */
function insertLegacy(
  db: Db,
  id: string,
  workId: string,
  platform: string,
  history: { source: 'draft' | 'edit'; v: Legacy }[],
): void {
  const last = history[history.length - 1];
  if (last === undefined) throw new Error('empty history');
  const cols = (v: Legacy) => [
    v.title,
    v.body,
    v.cover ?? null,
    JSON.stringify(v.images ?? []),
    JSON.stringify(v.tags ?? []),
    v.inherit === true ? 1 : 0,
    v.frame ?? null,
  ];
  db.prepare(
    `INSERT INTO platform_variants (id, work_id, platform, title, body, cover_asset_id,
       image_asset_ids, tags, inherit, cover_time_seconds, revision, created_at, updated_at,
       source_work_revision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, workId, platform, ...cols(last.v), history.length, NOW, NOW);
  history.forEach((h, i) => {
    db.prepare(
      `INSERT INTO platform_variant_revisions (variant_id, revision, source, title, body,
         cover_asset_id, image_asset_ids, tags, inherit, cover_time_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, i + 1, h.source, ...cols(h.v), NOW);
  });
}

const OLD_COLUMNS = `id, work_id, platform, title, body, cover_asset_id, image_asset_ids, tags,
  inherit, cover_time_seconds, revision, created_at, updated_at, deleted_at, source_work_revision_id`;

function snapshot(db: Db): unknown {
  return {
    variants: db.prepare(`SELECT ${OLD_COLUMNS} FROM platform_variants ORDER BY id`).all(),
    revisions: db
      .prepare(
        `SELECT variant_id, revision, source, title, body, cover_asset_id, image_asset_ids, tags,
           inherit, cover_time_seconds, created_at
         FROM platform_variant_revisions ORDER BY variant_id, revision`,
      )
      .all(),
  };
}

function columnNames(db: Db, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((c) => c.name);
}

describe('migration 0020 variant overrides: SQL round trip', () => {
  it('adds override columns, rolls back to the exact old tables, and re-applies', () => {
    const home = makeTempHome();
    dirs.push(home);
    // Later migrations are not part of this round trip.
    const upTo0020 = migrations.filter((m) => m.id <= '0020');
    const db = openDatabase(
      path.join(home, 'db.sqlite'),
      migrations.filter((m) => m.id < '0020'),
    );
    try {
      const before0020 = columnNames(db, 'platform_variants');
      db.prepare(
        `INSERT INTO works (id, title, type, status, source, storage_mode, source_path,
           current_revision_id, created_at, updated_at)
         VALUES ('w1', 'T', 'article', 'drafting', 'app', 'managed', 'library/works/w1/source.md',
           'r1', ?, ?)`,
      ).run(NOW, NOW);
      insertLegacy(db, 'v1', 'w1', 'douyin', [
        { source: 'draft', v: { title: 'T', body: 'b', tags: ['a'] } },
        { source: 'edit', v: { title: '改', body: '改過', tags: ['a', 'b'], inherit: true } },
      ]);
      const original = snapshot(db);

      expect(runMigrations(db, upTo0020)).toEqual(['0020']);
      expect(columnNames(db, 'platform_variants')).toEqual([
        ...before0020,
        'title_override',
        'cover_override',
        'image_order_override',
        'tags_override',
        'body_override',
        'overrides_ready',
      ]);
      // Nothing is rewritten by the SQL step; rows wait for the service backfill.
      expect(snapshot(db)).toEqual(original);
      expect(db.prepare('SELECT overrides_ready FROM platform_variants').pluck().all()).toEqual([
        0,
      ]);

      db.exec(VARIANT_OVERRIDES_ROLLBACK_SQL);
      expect(columnNames(db, 'platform_variants')).toEqual(before0020);
      expect(snapshot(db)).toEqual(original);
      expect(runMigrations(db, upTo0020)).toEqual(['0020']);
    } finally {
      db.close();
    }
  });
});

describe('migration 0020 variant overrides: backfill from a fixture', () => {
  async function fixture() {
    const s = await startTestServer({ jobs: { pollMs: 5 } });
    servers.push(s);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-png-'));
    dirs.push(tmp);
    const png = async (n: number): Promise<string> => {
      const f = path.join(tmp, `p${String(n)}.png`);
      fs.writeFileSync(f, await pngBytes(n, n));
      return f;
    };
    const markdown = '# 京都\n\n現在的**正文**。';
    const work = await s.client.works.create({ title: '京都', markdown, tags: ['旅行'] });
    const a = s.assets.registerFromFile(work.id, await png(10), { role: 'body' }).id;
    const b = s.assets.registerFromFile(work.id, await png(11), { role: 'body' }).id;
    const other = (
      await s.client.assets.upload({ filename: 'o.png', data: await pngBytes(12, 12) })
    ).asset.id;
    const plain = deriveVariantBody(markdown, 'xiaohongshu', { title: '京都' }).text;
    const article = deriveVariantBody(markdown, 'wechat_mp', { title: '京都' }).text;
    const current = { title: '京都', cover: a, images: [a, b], tags: ['旅行'] };

    // 小紅書: an untouched draft of the current work.
    insertLegacy(s.db, 'x', work.id, 'xiaohongshu', [
      { source: 'draft', v: { ...current, body: plain } },
    ]);
    // 抖音: an untouched draft of an older version of the work (title, body, tags since changed).
    insertLegacy(s.db, 'd', work.id, 'douyin', [
      {
        source: 'draft',
        v: { title: '舊標題', body: '舊正文', cover: a, images: [a], tags: ['舊'] },
      },
    ]);
    // 公眾號: both at once. Drafted from an older version of the work (which changed
    // since), then the user edited title and body; tags were left as drafted.
    insertLegacy(s.db, 'm', work.id, 'wechat_mp', [
      { source: 'draft', v: { ...current, title: '舊標題', body: '舊正文', tags: ['舊'] } },
      {
        source: 'edit',
        v: { ...current, title: '公眾號標題', body: '另外改過的正文', tags: ['舊'] },
      },
    ]);
    // 視頻號: the user changed cover and image order of the current work (title edited
    // while inheriting the shared copy).
    insertLegacy(s.db, 'c', work.id, 'wechat_channels', [
      { source: 'draft', v: { ...current, body: plain } },
      {
        source: 'edit',
        v: {
          ...current,
          title: '短',
          body: '手改',
          inherit: true,
          cover: other,
          images: [b, other],
        },
      },
    ]);
    return { s, work, a, b, other, plain, article };
  }

  it('turns only user changes into overrides, without moving revisions or sending events', async () => {
    const { s, work, a, b, other, plain, article } = await fixture();
    const old = snapshot(s.db);
    const seq = s.feed.since(0).length;
    const items = (await s.client.variants.list(work.id)).items;
    const by = Object.fromEntries(items.map((v) => [v.platform, v]));

    expect(by['xiaohongshu']).toMatchObject({
      revision: 1,
      title_source: 'work',
      body_source: 'work',
      body: plain,
      cover_source: 'work',
      images_source: 'work',
      tags_source: 'work',
    });
    // Differs from the work only because the work changed later: follows.
    expect(by['douyin']).toMatchObject({
      revision: 1,
      title: '京都',
      title_source: 'work',
      body: plain,
      body_source: 'work',
      tags: ['旅行'],
      tags_source: 'work',
      cover_source: 'work',
      images: [a, b],
      images_source: 'work',
    });
    expect(by['wechat_mp']).toMatchObject({
      revision: 2,
      title: '公眾號標題',
      title_source: 'override',
      body: '另外改過的正文',
      body_source: 'legacy_override',
      tags_source: 'work',
    });
    expect(by['wechat_mp']?.body).not.toBe(article);
    // inherit folds into following for title, body and tags; cover and images keep the user's choice.
    expect(by['wechat_channels']).toMatchObject({
      revision: 2,
      title: '京都',
      title_source: 'work',
      body_source: 'work',
      cover: { asset_id: other },
      cover_source: 'override',
      images: [b, other],
      images_source: 'override',
      hidden_images: [a],
    });
    // (Background thumbnail jobs of the uploads may log events; no variant ones.)
    expect(
      s.feed
        .since(0)
        .slice(seq)
        .filter((e) => e.action.startsWith('work.variant_')),
    ).toEqual([]);
    // The old columns and history are untouched; history shows the old content.
    expect(snapshot(s.db)).toEqual(old);
    const history = (await s.client.variants.revisions(work.id, 'wechat_mp')).items;
    expect(history.map((r) => [r.revision, r.source, r.legacy?.title, r.overrides])).toEqual([
      [2, 'edit', '公眾號標題', null],
      [1, 'draft', '舊標題', null],
    ]);

    // The legacy body can be dropped (back to following the work), not edited.
    const cleared = await s.client.variants.patch(work.id, 'wechat_mp', {
      base_revision: 2,
      body: null,
    });
    expect(cleared).toMatchObject({ revision: 3, body: article, body_source: 'work' });
    expect(cleared.title_source).toBe('override');
  });

  it('rolls back to the exact old tables after the backfill', async () => {
    const { s, work } = await fixture();
    const old = snapshot(s.db);
    await s.client.variants.list(work.id);
    s.db.exec(VARIANT_OVERRIDES_ROLLBACK_SQL);
    expect(snapshot(s.db)).toEqual(old);
    expect(columnNames(s.db, 'platform_variants')).not.toContain('title_override');
    // Re-applying needs a fresh backfill, which gives the same result.
    expect(runMigrations(s.db, migrations)).toEqual(['0020']);
    expect((await s.client.variants.get(work.id, 'wechat_mp')).body_source).toBe('legacy_override');
  });

  it('writes overrides set after the migration back into the old columns on rollback', async () => {
    const { s, work, b } = await fixture();
    await s.client.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 1,
      title: '新標題',
      tags: ['新'],
      images: [b],
      cover: { asset_id: b },
    });
    s.db.exec(VARIANT_OVERRIDES_ROLLBACK_SQL);
    const row = s.db
      .prepare<
        [],
        { title: string; tags: string; image_asset_ids: string; cover_asset_id: string }
      >(`SELECT title, tags, image_asset_ids, cover_asset_id FROM platform_variants WHERE id = 'x'`)
      .get();
    expect(row).toEqual({
      title: '新標題',
      tags: '["新"]',
      image_asset_ids: JSON.stringify([b]),
      cover_asset_id: b,
    });
  });
});
