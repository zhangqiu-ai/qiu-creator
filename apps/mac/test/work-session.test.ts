import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performProxyRequest } from '../src/main/proxy.js';
import { bridgeFetch, connect } from '../src/renderer/api.js';
import { WorkSession } from '../src/renderer/work-session.js';

/**
 * Integration: renderer session logic -> api-client -> main-process proxy ->
 * real mac-server on a random port with a throwaway CREATORHUB_HOME.
 */
const TOKEN = 'test-token-0123456789abcdef';

let server: CreatorHubServer;
let home: string;
let baseUrl: string;
let client: CreatorHubClient;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-it-'));
  server = await buildServer({ config: { home, token: TOKEN } });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({
    baseUrl,
    token: TOKEN,
    fetch: bridgeFetch((req) => performProxyRequest(baseUrl, req)),
  });
});

afterEach(async () => {
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function sourceFile(workId: string): string {
  return fs.readFileSync(path.join(home, 'library', 'works', workId, 'source.md'), 'utf8');
}

describe('connect', () => {
  it('connects through the bridge with the token', async () => {
    const result = await connect({
      getConnection: () => Promise.resolve({ ok: true, baseUrl, token: TOKEN }),
      request: (req) => performProxyRequest(baseUrl, req),
    });
    expect(result.ok).toBe(true);
  });

  it('reports a wrong token as unauthorized', async () => {
    const result = await connect({
      getConnection: () => Promise.resolve({ ok: true, baseUrl, token: 'wrong-token-0123456789' }),
      request: (req) => performProxyRequest(baseUrl, req),
    });
    expect(result).toEqual({ ok: false, reason: 'unauthorized', baseUrl });
  });

  it('reports a stopped service as service_down', async () => {
    await server.app.close();
    const result = await connect({
      getConnection: () => Promise.resolve({ ok: true, baseUrl, token: TOKEN }),
      request: (req) => performProxyRequest(baseUrl, req),
    });
    expect(result).toEqual({ ok: false, reason: 'service_down', baseUrl });
    server = await buildServer({ config: { home, token: TOKEN } }); // for afterEach
  });

  it('reports a missing token file as service_down', async () => {
    const result = await connect({
      getConnection: () =>
        Promise.resolve({ ok: false, reason: 'token_missing', detail: 'x', baseUrl }),
      request: (req) => performProxyRequest(baseUrl, req),
    });
    expect(result).toEqual({ ok: false, reason: 'service_down', baseUrl });
  });
});

describe('WorkSession against mac-server', () => {
  it('saves with base_revision, writes source.md and records a revision', async () => {
    const work = await client.works.create({ title: '第一篇', markdown: '# 你好\n' });
    const onSaved = vi.fn();
    const session = new WorkSession(client, work, { onSaved });
    session.edit({ markdown: '# 你好\n\n新段落。\n' });
    expect(session.snapshot.status).toBe('dirty');
    await session.save();

    expect(session.snapshot.status).toBe('saved');
    expect(session.snapshot.baseRevision).not.toBe(work.current_revision_id);
    expect(sourceFile(work.id)).toBe('# 你好\n\n新段落。\n');
    expect(onSaved).toHaveBeenCalledTimes(1);
    const revs = await client.works.revisions(work.id);
    expect(revs.items.map((r) => r.source)).toEqual(['edit', 'create']); // newest first
    session.dispose();
  });

  it('autosaves after edits but never during IME composition', async () => {
    const work = await client.works.create({ title: '輸入法', markdown: '' });
    const session = new WorkSession(client, work, { autosaveMs: 10 });
    session.setComposing(true);
    session.edit({ markdown: 'zhong' });
    await new Promise((r) => setTimeout(r, 60));
    expect(session.snapshot.status).toBe('dirty');
    expect(sourceFile(work.id)).toBe('');

    // ⌘S during composition is ignored too.
    await session.save();
    expect(sourceFile(work.id)).toBe('');

    session.edit({ markdown: '中文' });
    session.setComposing(false);
    await vi.waitFor(() => {
      expect(session.snapshot.status).toBe('saved');
    });
    expect(sourceFile(work.id)).toBe('中文');
    session.dispose();
  });

  it('on 409 keeps the draft, does not overwrite the other writer, and offers keep-both', async () => {
    const work = await client.works.create({ title: '衝突', markdown: '原文\n' });
    const mine = new WorkSession(client, work);
    const theirs = new WorkSession(client, work);

    theirs.edit({ markdown: '別人改的\n' });
    await theirs.save();
    expect(theirs.snapshot.status).toBe('saved');

    mine.edit({ markdown: '我改的\n' });
    await mine.save();
    expect(mine.snapshot.status).toBe('conflict');
    expect(mine.snapshot.conflictRevision).toBe(theirs.snapshot.baseRevision);
    expect(mine.snapshot.draft.markdown).toBe('我改的\n');
    expect(sourceFile(work.id)).toBe('別人改的\n');

    // No further saves while the conflict is open, even explicit ones.
    mine.edit({ markdown: '我又改了\n' });
    await mine.save();
    expect(sourceFile(work.id)).toBe('別人改的\n');

    const server = await mine.fetchServerVersion();
    expect(server.markdown).toBe('別人改的\n');

    // 保留雙方: my draft becomes a new work; this work shows the server version.
    const copy = await mine.keepBoth();
    expect(copy.markdown).toBe('我又改了\n');
    expect(copy.title).toBe('衝突（我的修改）');
    expect(copy.id).not.toBe(work.id);
    expect(mine.snapshot).toMatchObject({
      status: 'saved',
      conflictRevision: null,
      draft: { markdown: '別人改的\n' },
      baseRevision: theirs.snapshot.baseRevision,
    });

    // After resolving, editing and saving works again.
    mine.edit({ title: '衝突已解決' });
    await mine.save();
    expect(mine.snapshot.status).toBe('saved');
    mine.dispose();
    theirs.dispose();
  });

  it('手動合併 saves the merged text on top of the compared server revision', async () => {
    const work = await client.works.create({ title: '合併', markdown: 'a\nb\n' });
    const mine = new WorkSession(client, work);
    const theirs = new WorkSession(client, work);
    theirs.edit({ markdown: 'a\nB（別人）\n' });
    await theirs.save();
    mine.edit({ markdown: 'A（我）\nb\n' });
    await mine.save();
    expect(mine.snapshot.status).toBe('conflict');

    const server = await mine.fetchServerVersion();
    // Someone else writes again before the user finishes merging: no silent overwrite.
    theirs.edit({ markdown: 'a\nB（別人第二次）\n' });
    await theirs.save();
    expect(await mine.resolveWithMerge('A（我）\nB（別人）\n', server.current_revision_id)).toBe(
      'conflict',
    );
    expect(sourceFile(work.id)).toBe('a\nB（別人第二次）\n');

    const latest = await mine.fetchServerVersion();
    expect(
      await mine.resolveWithMerge('A（我）\nB（別人第二次）\n', latest.current_revision_id),
    ).toBe('saved');
    expect(sourceFile(work.id)).toBe('A（我）\nB（別人第二次）\n');
    expect(mine.snapshot).toMatchObject({ status: 'saved', conflictRevision: null });
    const revs = await client.works.revisions(work.id);
    expect(revs.items).toHaveLength(4); // create, theirs ×2, merge — every step recoverable
    mine.dispose();
    theirs.dispose();
  });

  it('turns an external Finder edit into a conflict instead of overwriting it', async () => {
    const work = await client.works.create({ title: '外部', markdown: 'v1\n' });
    const session = new WorkSession(client, work);
    fs.writeFileSync(path.join(home, 'library', 'works', work.id, 'source.md'), 'Finder 改的\n');
    session.edit({ markdown: 'app 改的\n' });
    await session.save();
    expect(session.snapshot.status).toBe('conflict');
    expect(sourceFile(work.id)).toBe('Finder 改的\n');
    session.dispose();
  });

  it('reports a network failure as a retryable error and keeps the draft', async () => {
    const work = await client.works.create({ title: '斷線', markdown: 'a\n' });
    const session = new WorkSession(client, work);
    await server.app.close();
    session.edit({ markdown: 'b\n' });
    await session.save();
    expect(session.snapshot.status).toBe('error');
    expect(session.snapshot.draft.markdown).toBe('b\n');

    server = await buildServer({ config: { home, token: TOKEN } });
    await server.app.listen({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
    await session.save();
    expect(session.snapshot.status).toBe('saved');
    expect(sourceFile(work.id)).toBe('b\n');
    session.dispose();
  });

  it('flushes pending edits on close', async () => {
    const work = await client.works.create({ title: '切換', markdown: '' });
    const session = new WorkSession(client, work, { autosaveMs: 60_000 });
    session.edit({ markdown: '切換前打的字' });
    session.close();
    await vi.waitFor(() => {
      expect(sourceFile(work.id)).toBe('切換前打的字');
    });
  });

  it('refuses to save an empty title', async () => {
    const work = await client.works.create({ title: '有標題', markdown: '' });
    const session = new WorkSession(client, work);
    session.edit({ title: '  ' });
    await session.save();
    expect(session.snapshot.status).toBe('error');
    expect((await client.works.get(work.id)).title).toBe('有標題');
    session.dispose();
  });
});
