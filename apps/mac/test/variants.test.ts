import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Platform, WorkDetail } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftWarnings, moveId } from '../src/renderer/PreviewPanel.js';
import { changedFields, VariantSession } from '../src/renderer/variant-session.js';

/** Integration (QC-013): platform variant sessions against a real mac-server. */
const TOKEN = 'test-token-0123456789abcdef';
const ALL: Platform[] = ['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels'];

let server: CreatorHubServer;
let home: string;
let client: CreatorHubClient;
let work: WorkDetail;
const sessions: VariantSession[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-var-'));
  server = await buildServer({ config: { home, token: TOKEN } });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  work = await client.works.create({
    title: '京都紅葉季七日慢遊路線',
    markdown: '# 京都紅葉季\n\n第一天走嵐山。\n',
    source: 'mac-app',
  });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function open(
  platform: Platform,
  record = null as Awaited<ReturnType<typeof client.variants.get>> | null,
) {
  const s = new VariantSession(client, work.id, platform, record, 10_000);
  sessions.push(s);
  return s;
}

describe('VariantSession', () => {
  it('creates each platform from the original and edits them independently', async () => {
    const per = new Map<Platform, VariantSession>();
    for (const p of ALL) {
      const s = open(p);
      await s.draftFromSource();
      expect(s.snapshot.record?.revision).toBe(1);
      per.set(p, s);
    }
    const titles: Record<Platform, string> = {
      xiaohongshu: '紅葉七日',
      wechat_mp: '京都紅葉季：七日慢遊完整路線',
      douyin: '京都紅葉 7 天',
      wechat_channels: '紅葉七日',
    };
    for (const p of ALL) {
      const s = per.get(p);
      s?.edit({ title: titles[p], body: `${p} 的正文` });
      await s?.save();
    }
    const list = (await client.variants.list(work.id)).items;
    for (const p of ALL) {
      const v = list.find((x) => x.platform === p);
      expect(v).toMatchObject({ title: titles[p], body: `${p} 的正文`, revision: 2 });
    }
    // The original is untouched.
    expect((await client.works.get(work.id)).markdown).toBe('# 京都紅葉季\n\n第一天走嵐山。\n');
  });

  it('turns a concurrent edit of the same platform into a 409 choice, never an overwrite', async () => {
    const first = open('xiaohongshu');
    await first.draftFromSource();
    const record = first.snapshot.record;
    const second = open('xiaohongshu', record);

    first.edit({ title: '視窗一' });
    await first.save();
    second.edit({ title: '視窗二' });
    await second.save();
    expect(second.snapshot).toMatchObject({ status: 'conflict', conflictRevision: 2 });
    expect((await client.variants.get(work.id, 'xiaohongshu')).title).toBe('視窗一');
    expect(second.snapshot.draft?.title).toBe('視窗二');

    // Autosave stays off while the conflict is open.
    second.edit({ body: '還在打字' });
    await second.save();
    expect((await client.variants.get(work.id, 'xiaohongshu')).revision).toBe(2);

    expect(await second.keepMine()).toBe('saved');
    const after = await client.variants.get(work.id, 'xiaohongshu');
    expect(after).toMatchObject({ title: '視窗二', body: '還在打字', revision: 3 });

    // 載入最新 on the other window discards its stale view.
    await first.remoteRevision(3);
    expect(first.snapshot).toMatchObject({ status: 'saved', epoch: 2 });
    expect(first.snapshot.draft?.title).toBe('視窗二');
  });

  it('holds a remote revision as a conflict while there are unsaved edits', async () => {
    const s = open('douyin');
    await s.draftFromSource();
    s.setComposing(true);
    s.edit({ title: '組字中' });
    await client.variants.patch(work.id, 'douyin', { base_revision: 1, title: '別處改的' });
    await s.remoteRevision(2);
    s.setComposing(false);
    expect(s.snapshot).toMatchObject({ status: 'conflict', conflictRevision: 2 });
    await s.takeLatest();
    expect(s.snapshot.draft?.title).toBe('別處改的');
    expect(s.snapshot.status).toBe('saved');
  });

  it('ignores the SSE echo of its own revision', async () => {
    const s = open('wechat_mp');
    await s.draftFromSource();
    s.edit({ title: '我的' });
    await s.save();
    await s.remoteRevision(s.snapshot.record?.revision ?? 0);
    expect(s.snapshot).toMatchObject({ status: 'saved', epoch: 1 });
  });

  it('copies the 公眾號 version into another platform', async () => {
    const mp = open('wechat_mp');
    await mp.draftFromSource();
    mp.edit({ title: '公眾號標題', tags: ['京都'] });
    await mp.save();
    const sph = open('wechat_channels');
    await sph.copyFrom(
      mp.snapshot.draft ?? {
        title: '',
        body: '',
        cover_asset_id: null,
        image_asset_ids: [],
        tags: [],
      },
    );
    expect(await client.variants.get(work.id, 'wechat_channels')).toMatchObject({
      title: '公眾號標題',
      tags: ['京都'],
    });
    expect((await client.variants.get(work.id, 'wechat_mp')).revision).toBe(2);
  });

  it('redrafts from the original as a new revision and keeps history', async () => {
    const s = open('xiaohongshu');
    await s.draftFromSource();
    s.edit({ title: '改過' });
    await s.save();
    await s.draftFromSource();
    expect(s.snapshot.record?.revision).toBe(3);
    const revs = await client.variants.revisions(work.id, 'xiaohongshu');
    expect(revs.items.map((r) => r.source)).toEqual(['draft', 'edit', 'draft']);
  });
});

describe('helpers', () => {
  it('sends only changed fields', () => {
    const base = {
      title: 'a',
      body: 'b',
      cover_asset_id: null,
      image_asset_ids: ['1', '2'],
      tags: ['x'],
    };
    expect(changedFields({ ...base, image_asset_ids: ['2', '1'] }, base)).toEqual({
      image_asset_ids: ['2', '1'],
    });
    expect(changedFields(base, base)).toEqual({});
  });

  it('moves images within bounds', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('warns live per platform without blocking', () => {
    const d = {
      title: '一'.repeat(18),
      body: '',
      cover_asset_id: null,
      image_asset_ids: [],
      tags: [],
    };
    expect(draftWarnings('xiaohongshu', d)).toEqual([]);
    expect(draftWarnings('wechat_channels', d).map((w) => w.code)).toEqual(['title_too_long']);
    expect(draftWarnings('douyin', null)).toEqual([]);
  });
});
