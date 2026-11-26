import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  ImportJobRecord,
  Project,
  UploadAssetResponse,
  VariantView,
  WorkDetail,
} from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCreatorHubMcpServer } from '../mcp/index.js';

const OWNER = 'mcp-write-owner-token-0123456789';
// A PNG signature plus an IHDR chunk: enough for magic-byte detection.
const png = (n: number): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    Buffer.alloc(64, n),
  ]);

let home: string;
let files: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
let upstream: http.Server;
const clients: Client[] = [];

beforeEach(async () => {
  // Throwaway CREATORHUB_HOME and file folder; never the user's data.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-write-'));
  files = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-files-'));
  // Local stand-in for a public file host; never the real internet.
  upstream = http.createServer((req, res) => {
    if (req.url === '/pic.png') {
      const body = png(7);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  server = await buildServer({
    config: { home, token: OWNER },
    ffprobe: null,
    ffmpeg: null,
    backups: { schedule: false },
    jobs: { pollMs: 5 },
    download: {
      resolver: (host) =>
        host === 'files.example.com'
          ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
          : host === 'intranet.example.com'
            ? Promise.resolve([{ address: '10.0.0.8', family: 4 }])
            : Promise.reject(new Error('ENOTFOUND')),
      connectOverride: () => ({ host: '127.0.0.1', port: upstreamPort }),
    },
  });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  owner = createClient({ baseUrl, token: OWNER });
  // These scenarios write Traditional Chinese as agents; keep it as written
  // (QC-103 conversion is covered by mcp-text-script.test.ts).
  await owner.settings.setTextScript({ script: 'zh-Hant' });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await server.app.close();
  await new Promise<void>((r) => {
    upstream.close(() => {
      r();
    });
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(files, { recursive: true, force: true });
});

type Scope = 'read' | 'import' | 'write';

async function agent(scopes: Scope[] = ['read', 'import', 'write']): Promise<Client> {
  const token = server.tokens.create({ name: `agent ${scopes.join('+')}`, scopes });
  const mcp = createCreatorHubMcpServer({ client: createClient({ baseUrl, token: token.secret }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'write-agent', version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return { isError: result.isError === true, text: first?.type === 'text' ? first.text : '' };
}

async function ok<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(c, name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return JSON.parse(r.text) as T;
}

interface ToolError {
  error: { status: number | null; code: string; details: Record<string, unknown>; retry: string };
}

async function fails(c: Client, name: string, args: Record<string, unknown>) {
  const r = await call(c, name, args);
  expect(r.isError, `${name} should fail: ${r.text}`).toBe(true);
  return (JSON.parse(r.text) as ToolError).error;
}

describe('MCP scenario: an agent builds a post', () => {
  it('creates an article, uploads a local file, imports a URL, links them and files it in a project', async () => {
    const c = await agent();

    // New article; retrying with the same key returns the same work.
    const args = {
      title: '京都三日',
      markdown: '# 京都三日\n\n第一天。\n',
      tags: ['旅行'],
      idempotency_key: 'agent-create-0001',
    };
    const work = await ok<WorkDetail>(c, 'work_create', args);
    expect(work).toMatchObject({ title: '京都三日', type: 'article', source: 'mcp' });
    expect((await ok<WorkDetail>(c, 'work_create', args)).id).toBe(work.id);
    const reused = await fails(c, 'work_create', { ...args, title: '別的' });
    expect(reused).toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    expect(reused.retry).toContain('new key');

    // Upload a local file (streamed by tus).
    const local = path.join(files, '嵐山 1.png');
    fs.writeFileSync(local, png(1));
    const uploaded = await ok<UploadAssetResponse>(c, 'asset_upload_file', { path: local });
    expect(uploaded).toMatchObject({ deduplicated: false, asset: { kind: 'image' } });
    expect(uploaded.asset.original_name).toBe('嵐山 1.png');
    const again = await ok<UploadAssetResponse>(c, 'asset_upload_file', {
      path: local,
      filename: 'copy.png',
    });
    expect(again).toMatchObject({ deduplicated: true, asset: { id: uploaded.asset.id } });

    // Import a URL as a job, linked to the work, and wait for it.
    const job = await ok<ImportJobRecord>(c, 'asset_import_url', {
      url: 'http://files.example.com/pic.png',
      work_id: work.id,
      role: 'body',
      idempotency_key: 'agent-import-0001',
    });
    const waited = await ok<{ timed_out: boolean; job: ImportJobRecord }>(c, 'job_wait', {
      id: job.id,
      timeout_seconds: 30,
    });
    expect(waited).toMatchObject({ timed_out: false, job: { status: 'succeeded' } });
    const imported = waited.job.result_asset_id ?? '';
    expect((await ok<ImportJobRecord>(c, 'job_get', { id: job.id })).status).toBe('succeeded');
    expect(
      (await ok<{ items: { id: string }[] }>(c, 'jobs_list', {})).items.map((j) => j.id),
    ).toEqual([job.id]);

    // Link the upload as cover and as a body image, reorder, unlink.
    await ok(c, 'work_attach_asset', {
      work_id: work.id,
      asset_id: uploaded.asset.id,
      role: 'cover',
    });
    await ok(c, 'work_attach_asset', {
      work_id: work.id,
      asset_id: uploaded.asset.id,
      role: 'body',
    });
    const ordered = await ok<{ items: { role: string; asset: { id: string } }[] }>(
      c,
      'work_reorder_assets',
      { work_id: work.id, role: 'body', asset_ids: [uploaded.asset.id, imported] },
    );
    expect(ordered.items.filter((i) => i.role === 'body').map((i) => i.asset.id)).toEqual([
      uploaded.asset.id,
      imported,
    ]);
    const detached = await ok<{ items: { role: string }[] }>(c, 'work_detach_asset', {
      work_id: work.id,
      asset_id: imported,
      role: 'body',
    });
    expect(detached.items.map((i) => i.role).sort()).toEqual(['body', 'cover']);
    // Copying a body image into the work folder gives the src to reference.
    const copied = await ok<{ src: string }>(c, 'work_attach_asset', {
      work_id: work.id,
      asset_id: imported,
      role: 'body',
      copy_into_work: true,
    });
    expect(copied.src).toMatch(/^assets\//);

    // File it in a new project.
    const project = await ok<Project>(c, 'project_create', { name: '關西', color: 3 });
    const assigned = await ok<{ results: { ok: boolean }[] }>(c, 'works_assign_projects', {
      work_ids: [work.id],
      add: [project.id],
    });
    expect(assigned.results.map((r) => r.ok)).toEqual([true]);
    const inProject = await ok<{ items: { id: string }[] }>(c, 'works_search', {
      project_id: project.id,
    });
    expect(inProject.items.map((w) => w.id)).toEqual([work.id]);

    // The work's text was never touched by any of this.
    expect((await owner.works.get(work.id)).markdown).toBe(args.markdown);
  });
});

describe('MCP scenario: an agent builds an image post and a video (QC-102)', () => {
  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from('isomiso2'),
    Buffer.alloc(128, 3),
  ]);

  async function upload(c: Client, name: string, data: Buffer): Promise<string> {
    const local = path.join(files, name);
    fs.writeFileSync(local, data);
    return (await ok<UploadAssetResponse>(c, 'asset_upload_file', { path: local })).asset.id;
  }

  const get = (c: Client, id: string) =>
    ok<{ work: WorkDetail; assets: { role: string; asset: { id: string } }[] }>(c, 'work_get', {
      id,
    });

  it('shows the attached images, video and covers on the works', async () => {
    const c = await agent();

    const post = await ok<WorkDetail>(c, 'work_create', {
      title: '嵐山貼圖',
      type: 'image',
      description: '楓葉。',
      idempotency_key: 'qc102-post-0001',
    });
    const pics: string[] = [];
    for (const n of [1, 2, 3, 4]) pics.push(await upload(c, `p${String(n)}.png`, png(n)));
    const [first = '', second = '', third = '', fourth = ''] = pics;
    for (const asset_id of [second, third, fourth]) {
      await ok(c, 'work_attach_asset', { work_id: post.id, asset_id, role: 'body' });
    }
    await ok(c, 'work_attach_asset', {
      work_id: post.id,
      asset_id: first,
      role: 'body',
      position: 0,
    });
    await ok(c, 'work_attach_asset', { work_id: post.id, asset_id: third, role: 'cover' });

    const seen = await get(c, post.id);
    expect(seen.work.media?.images.map((i) => [i.asset_id, i.status])).toEqual(
      pics.map((id) => [id, 'present']),
    );
    expect(seen.work.media?.cover).toMatchObject({ kind: 'image', item: { asset_id: third } });
    expect(seen.work.description).toBe('楓葉。');
    expect(seen.assets.map((a) => [a.role, a.asset.id])).toEqual([
      ...pics.map((id) => ['body', id]),
      ['cover', third],
    ]);

    const reversed = [...pics].reverse();
    await ok(c, 'work_reorder_assets', { work_id: post.id, role: 'body', asset_ids: reversed });
    await ok(c, 'work_detach_asset', { work_id: post.id, asset_id: fourth, role: 'body' });
    expect((await get(c, post.id)).work.media?.images.map((i) => i.asset_id)).toEqual([
      third,
      second,
      first,
    ]);

    const film = await ok<WorkDetail>(c, 'work_create', {
      title: '嵐山短片',
      type: 'video',
      idempotency_key: 'qc102-film-0001',
    });
    const clip = await upload(c, 'clip.mp4', mp4);
    const poster = await upload(c, 'poster.png', png(9));
    await ok(c, 'work_attach_asset', { work_id: film.id, asset_id: clip, role: 'video' });
    await ok(c, 'work_attach_asset', { work_id: film.id, asset_id: poster, role: 'cover' });

    const made = (await get(c, film.id)).work;
    expect(made.media?.video).toMatchObject({ asset_id: clip, status: 'present' });
    expect(made.media?.cover).toMatchObject({ kind: 'image', item: { asset_id: poster } });
    for (const platform of ['douyin', 'wechat_channels']) {
      const variant = await ok<{ cover: unknown }>(c, 'variant_get', { id: film.id, platform });
      expect(variant.cover).toEqual({ asset_id: poster });
    }

    const cards = await ok<{ items: { id: string; thumbnail: { asset_id: string } | null }[] }>(
      c,
      'works_search',
      {},
    );
    expect(Object.fromEntries(cards.items.map((w) => [w.id, w.thumbnail?.asset_id]))).toEqual({
      [post.id]: third,
      [film.id]: poster,
    });
  });

  it('says what a work cannot take instead of linking something invisible', async () => {
    const c = await agent();
    const film = await owner.works.create({ title: '短片', type: 'video' });
    const pic = await upload(c, 'a.png', png(1));
    const body = await fails(c, 'work_attach_asset', {
      work_id: film.id,
      asset_id: pic,
      role: 'body',
    });
    expect(body).toMatchObject({ status: 400, details: { allowed: ['video', 'cover'] } });
    const copy = await call(c, 'work_attach_asset', {
      work_id: film.id,
      asset_id: pic,
      role: 'cover',
      copy_into_work: true,
    });
    expect(copy.isError).toBe(true);
    expect(copy.text).toContain('leave it out');
    expect((await owner.workAssets.list(film.id)).items).toEqual([]);
  });
});

describe('MCP scenario: edits, conflicts and history', () => {
  it('updates metadata with base_revision; a stale base gets 409 with the revision to retry with', async () => {
    const c = await agent();
    const work = await owner.works.create({ title: '舊標題', markdown: '原文' });
    const v2 = await ok<WorkDetail>(c, 'work_update_meta', {
      id: work.id,
      base_revision: work.current_revision_id,
      title: '新標題',
      tags: ['京都'],
      status: 'in_review',
    });
    expect(v2).toMatchObject({ title: '新標題', tags: ['京都'], status: 'in_review' });

    const stale = await fails(c, 'work_update_meta', {
      id: work.id,
      base_revision: work.current_revision_id,
      title: '從舊畫面改的',
    });
    expect(stale).toMatchObject({
      status: 409,
      code: 'revision_conflict',
      details: { current_revision: v2.current_revision_id },
    });
    expect(stale.retry).toContain(v2.current_revision_id);
    expect((await owner.works.get(work.id)).title).toBe('新標題');

    // The text is not editable here: unknown arguments are refused, not dropped.
    const body = await call(c, 'work_update_meta', {
      id: work.id,
      base_revision: v2.current_revision_id,
      markdown: '覆蓋原文',
    });
    expect(body.isError).toBe(true);
    expect(body.text).toContain('markdown');
    const noBase = await call(c, 'work_update_meta', { id: work.id, title: 'x' });
    expect(noBase.isError).toBe(true);
    expect((await owner.works.get(work.id)).markdown).toBe('原文');

    // Restoring changes the text: it needs the direct-edit switch (QC-089).
    const restoreArgs = {
      id: work.id,
      revision_id: work.current_revision_id,
      base_revision: v2.current_revision_id,
    };
    const noSwitch = await fails(c, 'work_restore_revision', restoreArgs);
    expect(noSwitch).toMatchObject({ status: 403, code: 'direct_edit_not_allowed' });
    expect(noSwitch.retry).toContain('work_propose_edit');
    const token = (await owner.tokens.list()).items.find(
      (t) => t.name === 'agent read+import+write',
    );
    await owner.tokens.update(token?.id ?? '', { allow_direct_body_edit: true });
    // Restore the first revision: a new revision, history kept.
    const restored = await ok<WorkDetail>(c, 'work_restore_revision', restoreArgs);
    expect(restored.title).toBe('舊標題');
    expect((await owner.works.revisions(work.id)).items).toHaveLength(3);
  });

  it('trashes and restores works, one by one and in a batch', async () => {
    const c = await agent();
    const a = await owner.works.create({ title: 'A' });
    const b = await owner.works.create({ title: 'B' });
    await ok(c, 'work_trash', { id: a.id, base_revision: a.current_revision_id });
    const trash = await ok<{ items: { id: string }[] }>(c, 'works_search', { scope: 'trash' });
    expect(trash.items.map((w) => w.id)).toEqual([a.id]);
    const inTrash = await fails(c, 'work_update_meta', {
      id: a.id,
      base_revision: a.current_revision_id,
      title: 'x',
    });
    expect(inTrash).toMatchObject({ status: 409, code: 'work_in_trash' });
    expect(inTrash.retry).toContain('work_restore');
    await ok(c, 'work_restore', { id: a.id, base_revision: a.current_revision_id });

    const batch = await ok<{ results: { id: string; ok: boolean }[] }>(c, 'works_batch', {
      action: 'add_tags',
      tags: ['精選'],
      items: [
        { id: a.id, base_revision: a.current_revision_id },
        { id: b.id, base_revision: b.current_revision_id },
      ],
      idempotency_key: 'agent-batch-0001',
    });
    expect(batch.results.map((r) => r.ok)).toEqual([true, true]);
    expect((await owner.works.get(b.id)).tags).toEqual(['精選']);
    const missingStatus = await fails(c, 'works_batch', {
      action: 'set_status',
      items: [{ id: a.id, base_revision: a.current_revision_id }],
      idempotency_key: 'agent-batch-0002',
    });
    expect(missingStatus).toMatchObject({ status: 400, code: 'validation_error' });
  });

  it('overrides a platform version and follows the work again; the body is never set', async () => {
    const c = await agent();
    const work = await owner.works.create({ title: '原稿標題', markdown: '原稿正文' });
    const v1 = await ok<VariantView>(c, 'variant_update', {
      id: work.id,
      platform: 'xiaohongshu',
      base_revision: 0,
      title: '小紅書標題',
      tags: ['京都'],
    });
    expect(v1).toMatchObject({
      revision: 1,
      title: '小紅書標題',
      title_source: 'override',
      body: '原稿正文',
      body_source: 'work',
    });
    const stale = await fails(c, 'variant_update', {
      id: work.id,
      platform: 'xiaohongshu',
      base_revision: 0,
      title: '舊畫面',
    });
    expect(stale).toMatchObject({ status: 409, details: { current_revision: 1 } });
    expect(stale.retry).toContain('base_revision = 1');
    const body = await call(c, 'variant_update', {
      id: work.id,
      platform: 'xiaohongshu',
      base_revision: 1,
      body: '平台正文',
    });
    expect(body.isError).toBe(true);
    const reset = await ok<VariantView>(c, 'variant_update', {
      id: work.id,
      platform: 'xiaohongshu',
      base_revision: 1,
      reset_all: true,
    });
    expect(reset).toMatchObject({
      exists: false,
      revision: 2,
      title: '原稿標題',
      title_source: 'work',
    });
  });

  it('renames, deletes and restores projects', async () => {
    const c = await agent();
    const p = await ok<Project>(c, 'project_create', { name: '旅行' });
    const renamed = await ok<Project>(c, 'project_update', {
      id: p.id,
      base_revision: p.revision,
      name: '旅行 2026',
    });
    expect(renamed.name).toBe('旅行 2026');
    const stale = await fails(c, 'project_update', {
      id: p.id,
      base_revision: p.revision,
      color: 5,
    });
    expect(stale).toMatchObject({ status: 409, code: 'revision_conflict' });
    await ok(c, 'project_delete', { id: p.id });
    expect((await owner.projects.list()).items).toEqual([]);
    await ok(c, 'project_restore', { id: p.id });
    expect((await owner.projects.list()).items.map((x) => x.name)).toEqual(['旅行 2026']);
  });
});

describe('MCP scenario: permissions and bad input', () => {
  it('a token without the scope gets 403 with what it lacks, and nothing changes', async () => {
    const reader = await agent(['read']);
    const denied = await fails(reader, 'work_create', {
      title: 'x',
      idempotency_key: 'agent-denied-0001',
    });
    expect(denied).toMatchObject({
      status: 403,
      code: 'forbidden',
      details: { required: 'import' },
    });
    expect(denied.retry).toContain('"import"');

    const importer = await agent(['import']);
    const work = await ok<WorkDetail>(importer, 'work_create', {
      title: '匯入者建立',
      idempotency_key: 'agent-import-only-01',
    });
    const noWrite = await fails(importer, 'work_update_meta', {
      id: work.id,
      base_revision: work.current_revision_id,
      title: '改',
    });
    expect(noWrite).toMatchObject({ status: 403, details: { required: 'write' } });
    expect((await owner.works.list()).items.map((w) => w.title)).toEqual(['匯入者建立']);
  });

  it('only uploads regular local files given by absolute path', async () => {
    const c = await agent();
    for (const p of ['relative.png', files, path.join(files, 'missing.png')]) {
      const err = await fails(c, 'asset_upload_file', { path: p });
      expect(err.status, p).toBe(400);
    }
    // The server decides what is acceptable: plain text is not a media file.
    const txt = path.join(files, 'notes.bin');
    fs.writeFileSync(txt, Buffer.alloc(32, 1));
    const rejected = await fails(c, 'asset_upload_file', { path: txt });
    expect(rejected.status).toBe(415);
    expect((await owner.assets.list()).items).toEqual([]);
  });

  it('a URL to a private address fails as a job, without touching the network', async () => {
    const c = await agent();
    const job = await ok<ImportJobRecord>(c, 'asset_import_url', {
      url: 'https://intranet.example.com/x.png',
      idempotency_key: 'agent-import-bad-01',
    });
    const done = await ok<{ job: ImportJobRecord }>(c, 'job_wait', {
      id: job.id,
      timeout_seconds: 30,
    });
    expect(done.job).toMatchObject({ status: 'failed', error_code: 'blocked_address' });
  });
});

describe('resumable upload from a chunk reader (api-client)', () => {
  it('sends a source in several PATCH chunks', async () => {
    const data = png(9);
    const reads: [number, number][] = [];
    const res = await owner.assets.uploadResumable({
      filename: 'chunks.png',
      chunkSize: 16,
      source: {
        size: data.length,
        read: (start, end) => {
          reads.push([start, end]);
          return Promise.resolve(new Uint8Array(data.subarray(start, end)));
        },
      },
    });
    expect(res.asset.bytes).toBe(data.length);
    expect(reads.length).toBe(Math.ceil(data.length / 16));
    expect(reads[0]).toEqual([0, 16]);
  });
});
