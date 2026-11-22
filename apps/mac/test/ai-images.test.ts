import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AI_NOTICE_VERSION } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { pngBytes } from '../../../services/mac-server/test/fixtures.js';
import { startTestServer, type TestServer } from '../../../services/mac-server/test/helpers.js';
import {
  canSend,
  pendingCandidates,
  ImageGenSession,
  toApiRequest,
  type ImageRequest,
} from '../src/renderer/ai-images.js';
import { AiProviders } from '../src/renderer/ai-session.js';
import { WorkSession } from '../src/renderer/work-session.js';

/**
 * QC-070 AI 生成圖片與封面, the editor's data layer against a real service.
 * The New API relay is a local fake: nothing leaves the machine, the key lives
 * in the test server's memory secret store, CREATORHUB_HOME is temporary.
 */

const MODEL = 'gpt-image-1';
const MD = '# 京都散步\n\n第一段。\n\n第二段。\n';

interface Reply {
  status?: number;
  body?: unknown;
}

/** `GET /v1/models` and `POST /v1/images/generations`, each answered from a script. */
class FakeRelay {
  readonly generations: Record<string, unknown>[] = [];
  readonly replies: Reply[] = [];
  private server: http.Server | undefined;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL }, { id: 'gpt-5.5' }] }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.generations.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
        );
        const reply = this.replies.shift() ?? { body: { data: [] } };
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${String(port)}/v1`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }

  async images(...colors: string[]): Promise<void> {
    const data = await Promise.all(
      colors.map(async (c) => ({ b64_json: (await pngBytes(300, 400, c)).toString('base64') })),
    );
    this.replies.push({ body: { created: 1, data } });
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(options: { key?: boolean; consent?: boolean } = {}) {
  const relay = new FakeRelay();
  await relay.start();
  const s: TestServer = await startTestServer({
    jobs: { start: false },
    ai: { baseUrls: { 'new-api': relay.baseUrl }, timeoutMs: 2000, start: false },
  });
  cleanups.push(
    () => relay.stop(),
    () => s.close(),
  );
  if (options.key !== false) {
    const status = await s.client.ai.setKey(
      'new-api',
      'sk-relay-fake-0123456789',
      'https://relay.invalid/v1',
    );
    if (options.consent !== false)
      await s.client.ai.consent('new-api', AI_NOTICE_VERSION, status.notice.credential_id ?? '');
  }
  const work = await s.client.works.create({ title: '京都散步', markdown: MD, source: 'mac-app' });
  const ws = new WorkSession(s.client, work, { autosaveMs: 10_000 });
  const session = new ImageGenSession(s.client, ws, new AiProviders(s.client), 60_000);
  cleanups.push(() => {
    session.dispose();
    ws.dispose();
  });
  /** Run queued jobs, then tell the session (as the SSE event would). */
  const run = async (): Promise<void> => {
    s.ai.start();
    await s.ai.drain();
    for (const j of session.snapshot.jobs) if (j.jobId !== null) await session.jobChanged(j.jobId);
  };
  /** The newest job. */
  const latest = () => {
    const j = session.snapshot.jobs[0];
    if (j === undefined) throw new Error('no job');
    return j;
  };
  return { s, relay, ws, session, work, run, latest };
}

const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  purpose: 'image',
  model: MODEL,
  prompt: '紅葉下的寺廟',
  aspectRatio: '3:4',
  count: 2,
  ...over,
});

describe('圖片生成的請求 (QC-070)', () => {
  it('an image needs a prompt, a cover does not; blank words are left out', () => {
    expect(canSend(request({ prompt: '  ' }))).toBe(false);
    expect(canSend(request({ purpose: 'cover', prompt: '' }))).toBe(true);
    expect(canSend(request({ model: '' }))).toBe(false);
    expect(toApiRequest(request({ style: ' ', prompt: ' 寺廟 ' }), 'r1')).toEqual({
      provider: 'new-api',
      model: MODEL,
      purpose: 'image',
      prompt: '寺廟',
      aspect_ratio: '3:4',
      n: 2,
      source_revision: 'r1',
    });
  });
});

describe('ImageGenSession (QC-070)', () => {
  it('says what is missing before New API is ready, then lists only image models', async () => {
    const none = await start({ key: false });
    await none.session.load();
    expect(none.session.snapshot).toMatchObject({ block: 'key', models: [] });

    const notAccepted = await start({ consent: false });
    await notAccepted.session.load();
    expect(notAccepted.session.snapshot.block).toBe('consent');

    const { session } = await start();
    await session.load();
    expect(session.snapshot.block).toBeNull();
    expect(session.snapshot.models?.map((m) => m.id)).toEqual([MODEL]);
  });

  it('estimates before sending: images × price, or 無法預估 without a price', async () => {
    const { s, session } = await start();
    await session.estimate(request({ prompt: '' }));
    expect(session.snapshot.estimate).toBeNull();
    await session.estimate(request());
    expect(session.snapshot.estimate?.estimate).toMatchObject({
      image_count: 2,
      max_cost_usd: null,
    });
    await s.client.ai.patchSettings({
      price_overrides: { [MODEL]: { input_per_mtok: 0, output_per_mtok: 0, per_image_usd: 0.04 } },
    });
    await session.estimate(request());
    expect(session.snapshot.estimate?.estimate.max_cost_usd).toBeCloseTo(0.08, 10);
  });

  it('generates candidates outside the work; keeps one inline (復原 undoes it), one in the library', async () => {
    const { s, relay, ws, session, work, run, latest } = await start();
    await relay.images('#cc3300', '#0033cc');
    const key = await session.generate(request({ count: 2 }));
    expect(latest()).toMatchObject({ key, phase: 'generating', origin: 'panel' });
    expect(relay.generations).toHaveLength(0);
    await run();
    const { candidates } = latest();
    expect(latest().phase).toBe('ready');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media\/v1\/image-candidates\//);
    // Nothing reached the work yet.
    expect((await s.client.works.get(work.id)).current_revision_id).toBe(work.current_revision_id);

    // Insert after the first paragraph.
    const offset = MD.indexOf('第一段。') + '第一段。'.length;
    expect(await session.keep(key, 0, { type: 'insert', offset, alt: '紅葉' })).toBe('kept');
    expect(ws.snapshot.draft.markdown).toMatch(
      /第一段。\n\n!\[紅葉\]\(assets\/[^)]+\)\n\n第二段。/,
    );
    expect(latest().candidates[0]).toMatchObject({ fate: 'kept', keptAs: 'insert' });
    const afterInsert = ws.snapshot.baseRevision;
    expect(afterInsert).not.toBe(work.current_revision_id);

    // Into the library only: the work stays as it is, and 復原 still undoes the insert.
    expect(await session.keep(key, 1, { type: 'library' })).toBe('kept');
    expect(ws.snapshot.baseRevision).toBe(afterInsert);
    expect((await s.client.assets.list({ limit: 10 })).total).toBe(2);
    expect(session.snapshot.undo?.placement).toBe('insert');
    expect(await session.undo()).toBe('restored');
    expect(ws.snapshot.draft.markdown).toBe(MD);
  });

  it('an inline placeholder stands after its block; a new one replaces it and the panel keeps its own', async () => {
    const { relay, session, run } = await start();
    const end = MD.indexOf('第一段。') + '第一段。'.length;
    await relay.images('#111111');
    const panel = await session.generate(request({ count: 1 }));
    await relay.images('#222222', '#333333');
    const first = await session.generate(request(), { origin: 'inline', anchor: end });
    await relay.images('#444444', '#555555');
    const second = await session.generate(request(), { origin: 'inline', anchor: end });
    expect(session.snapshot.jobs.map((j) => j.key)).toEqual([second, panel]);
    expect(session.job(first)).toBeUndefined();
    await run();
    expect(session.job(second)).toMatchObject({ phase: 'ready', anchor: end });
    expect(session.job(panel)?.phase).toBe('ready');
  });

  it('makes a cover from the title and text, discards, and a gone candidate says so', async () => {
    const { s, relay, ws, session, run, latest } = await start();
    await relay.images('#336633', '#663333');
    const key = await session.generate(
      request({ purpose: 'cover', prompt: '', aspectRatio: '2.35:1' }),
    );
    await run();
    expect(String(relay.generations[0]?.['prompt'])).toContain('京都散步');
    expect(await session.keep(key, 0, { type: 'cover' })).toBe('kept');
    expect(ws.snapshot.draft.markdown).toMatch(/^---\n[\s\S]*cover: assets\//);
    expect(session.snapshot.undo?.placement).toBe('cover');

    await session.discard(key, 1);
    expect(latest().candidates[1]?.fate).toBe('discarded');
    const job = await s.client.ai.job(latest().jobId ?? '');
    expect(job.result?.json).toMatchObject({ candidates: [{ expired: true }, { expired: true }] });
    // Neither can be kept again.
    expect(await session.keep(key, 1, { type: 'library' })).toBe('blocked');
  });

  it('a work changed elsewhere is not overwritten: keep reports a conflict', async () => {
    const { s, relay, ws, session, work, run, latest } = await start();
    await relay.images('#123456');
    const key = await session.generate(request({ count: 1 }));
    await run();
    await s.client.works.patch(work.id, {
      base_revision: ws.snapshot.baseRevision,
      markdown: `${MD}\n另一台裝置寫的。\n`,
    });
    expect(await session.keep(key, 0, { type: 'insert', offset: 0 })).toBe('conflict');
    // Nothing was written over the other device's text; with no local edits the
    // editor simply takes the newer revision, and the candidate can still be kept.
    const server = await s.client.works.get(work.id);
    expect(server.markdown).not.toContain('assets/');
    expect(ws.snapshot.draft.markdown).toContain('另一台裝置寫的。');
    expect(latest().candidates[0]?.fate).toBe('new');
    expect(await session.keep(key, 0, { type: 'insert', offset: 0 })).toBe('kept');
    expect(ws.snapshot.draft.markdown).toContain('另一台裝置寫的。');
    expect(ws.snapshot.draft.markdown).toMatch(/!\[\]\(assets\//);
  });

  it('a failed generation says why and can be tried again; removing discards what was left', async () => {
    const { s, relay, session, run, latest } = await start();
    relay.replies.push({ status: 500, body: { error: { message: 'upstream down' } } });
    const key = await session.generate(request({ count: 1 }));
    await run();
    expect(latest().phase).toBe('failed');
    expect(latest().failure?.code).not.toBeNull();

    await relay.images('#abcdef');
    await session.retry(key);
    await run();
    expect(latest().phase).toBe('ready');
    expect(pendingCandidates(session.snapshot)).toBe(1);
    const jobId = latest().jobId ?? '';
    await session.remove(key);
    expect(session.snapshot.jobs).toEqual([]);
    const job = await s.client.ai.job(jobId);
    expect(job.result?.json).toMatchObject({ candidates: [{ expired: true }] });
  });
});
