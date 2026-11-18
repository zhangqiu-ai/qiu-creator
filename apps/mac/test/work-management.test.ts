import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkMediaResolver } from '../src/renderer/media.js';
import { WorkSession } from '../src/renderer/work-session.js';

/**
 * Integration (QC-011): WorkSession and the media resolver against a real
 * mac-server on a random port, with a throwaway CREATORHUB_HOME and mount folder.
 */
const TOKEN = 'test-token-0123456789abcdef';
// 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let server: CreatorHubServer;
let home: string;
let mountDir: string;
let baseUrl: string;
let client: CreatorHubClient;
const sessions: WorkSession[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-wm-'));
  mountDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-mount-')));
  server = await buildServer({
    config: { home, token: TOKEN },
    mounts: { stabilityMs: 50, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
  });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(mountDir, { recursive: true, force: true });
});

function open(work: WorkDetail, autosaveMs = 20): WorkSession {
  const s = new WorkSession(client, work, { autosaveMs });
  sessions.push(s);
  return s;
}

async function newWork(markdown = '第一版\n'): Promise<WorkDetail> {
  return client.works.create({ title: '測試', markdown, source: 'mac-app' });
}

describe('status and tags', () => {
  it('saves them right away through the same base_revision queue', async () => {
    const work = await newWork();
    const s = open(work, 10_000);
    s.edit({ status: 'ready' });
    await vi.waitFor(async () => {
      expect((await client.works.get(work.id)).status).toBe('ready');
    });
    s.edit({ tags: ['旅行', '京都'] });
    await vi.waitFor(async () => {
      expect((await client.works.get(work.id)).tags).toEqual(['旅行', '京都']);
    });
    expect(s.snapshot.status).toBe('saved');
    expect((await client.works.revisions(work.id)).items).toHaveLength(3);
  });
});

describe('remote revisions', () => {
  it('adopts a newer revision silently when nothing is unsaved', async () => {
    const work = await newWork();
    const mine = open(work);
    const theirs = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '別處改的\n',
    });
    await mine.remoteRevision(theirs.current_revision_id, 'edit');
    expect(mine.snapshot).toMatchObject({
      baseRevision: theirs.current_revision_id,
      remote: null,
      epoch: 1,
    });
    expect(mine.snapshot.draft.markdown).toBe('別處改的\n');
  });

  it('holds it as a notice while there are unsaved edits, and pauses autosave', async () => {
    const work = await newWork();
    const mine = open(work, 30);
    mine.setComposing(true); // keep the edit unsaved while the remote write lands
    mine.edit({ markdown: '我在打字\n' });
    const theirs = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '別處改的\n',
    });
    await mine.remoteRevision(theirs.current_revision_id, 'external');
    mine.setComposing(false);
    expect(mine.snapshot.remote).toEqual({
      revisionId: theirs.current_revision_id,
      source: 'external',
      draftBase: work.current_revision_id,
    });
    await new Promise((r) => setTimeout(r, 120));
    // Nothing was written over the other change.
    expect((await client.works.get(work.id)).markdown).toBe('別處改的\n');
    expect(mine.snapshot.draft.markdown).toBe('我在打字\n');

    mine.compareRemote();
    expect(mine.snapshot).toMatchObject({
      status: 'conflict',
      conflictRevision: theirs.current_revision_id,
      remote: null,
    });
    await mine.reloadFromServer();
    expect(mine.snapshot).toMatchObject({ status: 'saved', remote: null });
    expect(mine.snapshot.draft.markdown).toBe('別處改的\n');
  });

  it('ignores the SSE echo of its own saves, even when it arrives mid-request', async () => {
    const work = await newWork();
    const s = open(work, 10_000);
    s.edit({ markdown: '我的\n' });
    const saving = s.save();
    // An echo for an unknown revision while the PATCH is in flight is held, not applied.
    await s.remoteRevision('00000000-0000-4000-8000-000000000000', 'edit');
    await saving;
    const own = s.snapshot.baseRevision;
    await s.remoteRevision(own, 'edit');
    expect(s.snapshot).toMatchObject({ remote: null, status: 'saved' });
    expect(s.snapshot.draft.markdown).toBe('我的\n');
  });
});

describe('restore', () => {
  it('appends a restore revision with the old content and keeps history', async () => {
    const work = await newWork('一\n');
    const s = open(work, 10_000);
    const first = work.current_revision_id;
    s.edit({ markdown: '二\n' });
    await s.save();
    expect(await s.restore(first)).toBe('restored');
    expect(s.snapshot.draft.markdown).toBe('一\n');
    expect(s.snapshot.epoch).toBe(1);
    const revs = (await client.works.revisions(work.id)).items;
    expect(revs.map((r) => r.source)).toEqual(['restore', 'edit', 'create']);
    expect(fs.readFileSync(path.join(home, 'library', 'works', work.id, 'source.md'), 'utf8')).toBe(
      '一\n',
    );
  });

  it('saves pending edits before restoring', async () => {
    const work = await newWork('一\n');
    const s = open(work, 10_000);
    s.edit({ markdown: '還沒存\n' });
    expect(await s.restore(work.current_revision_id)).toBe('restored');
    const revs = (await client.works.revisions(work.id)).items;
    expect(revs.map((r) => r.source)).toEqual(['restore', 'edit', 'create']);
    const edit = await client.works.revision(work.id, revs[1]?.revision_id ?? '');
    expect(edit.markdown).toBe('還沒存\n');
  });

  it('does not overwrite a newer revision written elsewhere', async () => {
    const work = await newWork('一\n');
    const s = open(work, 10_000);
    const elsewhere = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '別處\n',
    });
    expect(await s.restore(work.current_revision_id)).toBe('conflict');
    expect((await client.works.get(work.id)).current_revision_id).toBe(
      elsewhere.current_revision_id,
    );
    // The newer revision was adopted (nothing was unsaved), so a second try works on top of it.
    expect(s.snapshot.baseRevision).toBe(elsewhere.current_revision_id);
  });
});

describe('external works', () => {
  async function mountedWork(): Promise<WorkDetail> {
    fs.writeFileSync(path.join(mountDir, 'a.md'), '# 外部\n');
    await client.mounts.create({ path: mountDir, name: '寫作' });
    let id = '';
    await vi.waitFor(async () => {
      const list = await client.works.list({ limit: 50 });
      const found = list.items.find((w) => w.storage_mode === 'external');
      expect(found).toBeDefined();
      id = found?.id ?? '';
    });
    return client.works.get(id);
  }

  it('goes read-only when the file disappears, keeps the edits, and recovers when it returns', async () => {
    const work = await mountedWork();
    const s = open(work, 10_000);
    fs.rmSync(path.join(mountDir, 'a.md'));
    await vi.waitFor(async () => {
      expect((await client.works.get(work.id)).external_state).toBe('missing');
    });
    // An edit made before the window noticed: the save is refused, the text stays here.
    s.edit({ markdown: '# 外部\n\n補一句\n' });
    await s.save();
    expect(s.snapshot.readOnly).toBe('missing');
    expect(s.snapshot.draft.markdown).toBe('# 外部\n\n補一句\n');
    s.edit({ markdown: 'ignored while read-only' });
    expect(s.snapshot.draft.markdown).toBe('# 外部\n\n補一句\n');
    expect(await s.restore(work.current_revision_id)).toBe('blocked');

    fs.writeFileSync(path.join(mountDir, 'a.md'), '# 外部\n');
    await vi.waitFor(async () => {
      expect((await client.works.get(work.id)).external_state).toBe('present');
    });
    await s.refreshExternalState();
    expect(s.snapshot.readOnly).toBeNull();
    await s.save();
    expect(fs.readFileSync(path.join(mountDir, 'a.md'), 'utf8')).toBe('# 外部\n\n補一句\n');
  });

  it('opens read-only when the folder is unmounted', async () => {
    const work = await mountedWork();
    await client.mounts.remove(work.mount_id ?? '');
    const s = open(await client.works.get(work.id));
    expect(s.snapshot.readOnly).toBe('unmounted');
  });
});

describe('Markdown images through signed URLs', () => {
  it('resolves ./assets paths to URLs that load without a token', async () => {
    const work = await newWork(
      '![](assets/dot.png)\n\n![](assets/nope.png)\n\n![](https://example.com/x.png)\n',
    );
    const dir = path.join(home, 'library', 'works', work.id, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dot.png'), PNG);
    const resolver = new WorkMediaResolver({
      load: () => client.works.media(work.id),
      absolute: (rel) => client.media.absoluteUrl(rel),
    });
    const url = await resolver.resolve('assets/dot.png');
    expect(url.startsWith(baseUrl)).toBe(true);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect(await resolver.resolve('assets/nope.png')).toMatch(/^data:image\/svg\+xml/);
    // Remote images are never fetched by the app.
    expect(decodeURIComponent(await resolver.resolve('https://example.com/x.png'))).toContain(
      '外部網址圖片未載入',
    );
  });
});
