import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Platform, WorkDetail } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOwn, OverrideSession } from '../src/renderer/preview/override-session.js';

/** Integration (QC-084): per-platform overrides against a real mac-server. */
const TOKEN = 'test-token-0123456789abcdef';

let server: CreatorHubServer;
let home: string;
let client: CreatorHubClient;
let work: WorkDetail;
const sessions: OverrideSession[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-ovr-'));
  server = await buildServer({ config: { home, token: TOKEN } });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  work = await client.works.create({
    title: '京都紅葉季七日慢遊路線',
    markdown: '# 京都紅葉季七日慢遊路線\n\n第一天走嵐山。\n',
    source: 'mac-app',
  });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function open(platform: Platform, autosaveMs = 10_000): Promise<OverrideSession> {
  const s = new OverrideSession(
    client,
    work.id,
    await client.variants.get(work.id, platform),
    autosaveMs,
  );
  sessions.push(s);
  return s;
}

describe('OverrideSession', () => {
  it('starts following the work; a title becomes 自訂 and 改回跟隨原稿 follows again', async () => {
    const all = await client.variants.list(work.id);
    expect(all.items.map((v) => v.title_source)).toEqual(['work', 'work', 'work', 'work']);
    const xhs = await open('xiaohongshu');
    xhs.edit({ title: '紅葉七日' }, false);
    expect(isOwn(xhs.snapshot, 'title')).toBe(true);
    expect(xhs.snapshot.status).toBe('dirty');
    await xhs.save();
    expect(xhs.snapshot.status).toBe('saved');
    expect(xhs.snapshot.view).toMatchObject({
      title: '紅葉七日',
      title_source: 'override',
      revision: 1,
    });
    // Other platforms are untouched.
    expect((await client.variants.get(work.id, 'douyin')).title_source).toBe('work');

    xhs.edit({ title: null });
    await xhs.save();
    expect(isOwn(xhs.snapshot, 'title')).toBe(false);
    expect(xhs.snapshot.view).toMatchObject({
      title: '京都紅葉季七日慢遊路線',
      title_source: 'work',
      revision: 2,
    });
  });

  it('never saves while an input method is composing', async () => {
    const s = await open('douyin', 5);
    s.setComposing(true);
    s.edit({ title: '京都' }, false);
    await new Promise((r) => setTimeout(r, 40));
    expect((await client.variants.get(work.id, 'douyin')).revision).toBe(0);
    s.setComposing(false);
    await new Promise((r) => setTimeout(r, 60));
    expect((await client.variants.get(work.id, 'douyin')).title).toBe('京都');
  });

  it('saves tags and image order at once', async () => {
    const s = await open('wechat_channels', 10_000);
    s.edit({ tags: ['京都', '紅葉'] });
    await s.save();
    expect(s.snapshot.view).toMatchObject({ tags: ['京都', '紅葉'], tags_source: 'override' });
    s.edit({ tags: null });
    await s.save();
    expect(s.snapshot.view.tags_source).toBe('work');
  });

  it('a 409 keeps my value; 保留我的 writes it on the latest, 使用對方的 takes theirs', async () => {
    const mine = await open('xiaohongshu');
    const other = await open('xiaohongshu');
    other.edit({ title: '別處改的' });
    await other.save();
    mine.edit({ title: '我的標題' });
    await mine.save();
    expect(mine.snapshot.status).toBe('conflict');
    expect(mine.snapshot.conflict?.fields).toEqual(['title']);
    expect(mine.snapshot.conflict?.theirs.title).toBe('別處改的');
    expect(mine.snapshot.pending.title).toBe('我的標題');
    await mine.keepMine();
    expect(mine.snapshot.status).toBe('saved');
    expect((await client.variants.get(work.id, 'xiaohongshu')).title).toBe('我的標題');

    other.edit({ title: '又改了' });
    await other.save();
    expect(other.snapshot.status).toBe('conflict');
    other.useTheirs();
    expect(other.snapshot).toMatchObject({ status: 'saved', pending: {} });
    expect(other.snapshot.view.title).toBe('我的標題');
  });

  it('adopts a newer revision from elsewhere when nothing is pending', async () => {
    const a = await open('wechat_mp');
    const b = await open('wechat_mp');
    b.edit({ title: '公眾號標題' });
    await b.save();
    await a.refresh(1);
    expect(a.snapshot.view.title).toBe('公眾號標題');
    expect(a.snapshot.epoch).toBe(1);
  });
});
