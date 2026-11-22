import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ApiError, imageResultOf } from '@qiu-creator/api-client';
import { AI_NOTICE_VERSION, type AiJobRecord } from '@qiu-creator/contracts';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { insertImage } from '../src/ai/image-tasks.js';
import { pngBytes } from './fixtures.js';
import { startTestServer, TEST_TOKEN, type StartOptions, type TestServer } from './helpers.js';

/**
 * QC-070: New API image and cover generation. Only a local fake relay is
 * called; temporary CREATORHUB_HOME; the key lives in a memory secret store.
 */

const KEY = 'sk-relay-image-key-0123456789';
/** What the Keychain holds; the adapter is pointed at the fake relay instead. */
const STORED_BASE = 'https://relay.invalid/v1';
const MODEL = 'gpt-image-1';

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}
interface Reply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

/** A New API relay: `POST /v1/images/generations`, and image files at `/files/*`. */
class FakeRelay {
  readonly seen: Seen[] = [];
  readonly aborted: string[] = [];
  readonly replies: Reply[] = [];
  readonly files = new Map<string, { type: string; data: Buffer }>();
  private server: http.Server | undefined;
  baseUrl = '';
  origin = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/redirect-out') {
        res.writeHead(302, { location: 'http://10.0.0.1/secret.png' }).end();
        return;
      }
      if (req.method === 'GET' && url.startsWith('/files/')) {
        const file = this.files.get(url.slice('/files/'.length));
        if (file === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': file.type }).end(file.data);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
          string,
          unknown
        >;
        this.seen.push({ path: url, headers: req.headers, body });
        const reply = this.replies.shift() ?? { body: { data: [] } };
        let done = false;
        res.on('close', () => {
          if (!done) this.aborted.push(url);
        });
        const send = (): void => {
          done = true;
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body ?? {}));
        };
        if (reply.delayMs === undefined) send();
        else setTimeout(send, reply.delayMs);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${String(port)}`;
    this.baseUrl = `${this.origin}/v1`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }
}

const servers: TestServer[] = [];
const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const r of relays.splice(0)) await r.stop();
});

async function start(
  options: { logs?: string[]; consent?: boolean; images?: { candidateTtlMs?: number } } = {},
): Promise<{ s: TestServer; relay: FakeRelay }> {
  const relay = new FakeRelay();
  await relay.start();
  relays.push(relay);
  const logs = options.logs;
  const extra: StartOptions =
    logs === undefined
      ? {}
      : { logger: true, logStream: { write: (line: string) => logs.push(line) } };
  const s = await startTestServer({
    ...extra,
    jobs: { start: false },
    ai: {
      baseUrls: { 'new-api': relay.baseUrl },
      timeoutMs: 2000,
      start: false,
      ...(options.images === undefined ? {} : { images: options.images }),
    },
  });
  servers.push(s);
  const status = await s.client.ai.setKey('new-api', KEY, STORED_BASE);
  if (options.consent !== false) {
    await s.client.ai.consent('new-api', AI_NOTICE_VERSION, status.notice.credential_id ?? '');
  }
  return { s, relay };
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

async function run(s: TestServer, id: string): Promise<AiJobRecord> {
  s.ai.start();
  await s.ai.drain();
  return s.client.ai.job(id);
}

const b64 = (data: Buffer): { b64_json: string } => ({ b64_json: data.toString('base64') });

async function article(s: TestServer, markdown = '# 京都散步\n\n第一段。\n\n第二段。\n') {
  return s.client.works.create({ title: '京都散步', markdown });
}

describe('AI images (QC-070)', () => {
  it('estimates from the per-image price, or says it cannot', async () => {
    const { s } = await start();
    const w = await article(s);
    const body = {
      provider: 'new-api' as const,
      model: MODEL,
      purpose: 'image' as const,
      prompt: '楓葉',
      n: 3,
    };
    const unpriced = await s.client.ai.images.estimate(w.id, body);
    expect(unpriced.estimate).toMatchObject({ image_count: 3, max_cost_usd: null, price: null });
    await s.client.ai.patchSettings({
      price_overrides: { [MODEL]: { input_per_mtok: 0, output_per_mtok: 0, per_image_usd: 0.04 } },
    });
    const priced = await s.client.ai.images.estimate(w.id, body);
    expect(priced.estimate.max_cost_usd).toBeCloseTo(0.12, 10);
  });

  it('generates candidates from base64, cropped to the ratio, outside the work until kept', async () => {
    const logs: string[] = [];
    const { s, relay } = await start({ logs });
    await s.client.ai.patchSettings({
      price_overrides: { [MODEL]: { input_per_mtok: 0, output_per_mtok: 0, per_image_usd: 0.04 } },
    });
    const w = await article(s);
    relay.replies.push({
      body: {
        created: 1,
        data: [b64(await pngBytes(400, 600, '#cc3300')), b64(await pngBytes(400, 600, '#0033cc'))],
      },
    });
    const { job: queued } = await s.client.ai.images.create(w.id, {
      provider: 'new-api',
      model: MODEL,
      purpose: 'image',
      prompt: '紅葉下的寺廟',
      style: '水彩',
      aspect_ratio: '3:4',
      n: 2,
    });
    expect(queued).toMatchObject({
      action: 'image_generation',
      max_attempts: 1,
      source_revision: w.current_revision_id,
    });
    const job = await run(s, queued.id);
    expect(job).toMatchObject({ status: 'succeeded' });
    expect(job.cost_usd).toBeCloseTo(0.08, 10);

    // One request, to the relay only, key in the Authorization header only.
    expect(relay.seen).toHaveLength(1);
    const seen = relay.seen[0];
    expect(seen?.path).toBe('/v1/images/generations');
    expect(seen?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen?.body).toEqual({
      model: MODEL,
      prompt: '紅葉下的寺廟\n風格：水彩',
      n: 2,
      size: '1024x1536',
    });

    const result = imageResultOf(job);
    expect(result?.candidates).toHaveLength(2);
    for (const c of result?.candidates ?? []) {
      // 400×600 (2:3) cropped to 3:4 → 400×533.
      expect(c).toMatchObject({ width: 400, height: 533, mime: 'image/jpeg', expired: false });
      expect(c.url).toMatch(/^\/media\/v1\/image-candidates\/[0-9a-f-]+\/\d\?/);
      expect(c.url).not.toContain(KEY);
      const res = await fetch(`${s.baseUrl}${c.url ?? ''}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect([meta.width, meta.height]).toEqual([400, 533]);
    }
    // Nothing was written to the work.
    const after = await s.client.works.get(w.id);
    expect(after.current_revision_id).toBe(w.current_revision_id);
    // Works start with an empty assets/ folder; it stays empty.
    expect(fs.readdirSync(path.join(s.layout.abs(s.layout.workDirRel(w.id)), 'assets'))).toEqual(
      [],
    );
    expect((await s.client.assets.list()).total).toBe(0);
    // The key never reaches the logs or the job record.
    expect(logs.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(job)).not.toContain(KEY);
  });

  it('keeps a candidate into the text as an ai_accepted revision, once', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    relay.replies.push({ body: { data: [b64(await pngBytes(300, 300, '#22aa22'))] } });
    const { job: queued } = await s.client.ai.images.create(w.id, {
      provider: 'new-api',
      model: MODEL,
      purpose: 'image',
      prompt: '竹林',
    });
    const job = await run(s, queued.id);
    const offset = w.markdown.indexOf('第一段') + 2;

    // A stale base is refused before anything is copied.
    const stale = await apiError(
      s.client.ai.images.keep(w.id, job.id, {
        index: 0,
        base_revision: '00000000-0000-4000-8000-000000000000',
        placement: { type: 'insert', offset },
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body?.error.code).toBe('revision_conflict');
    expect((await s.client.assets.list()).total).toBe(0);

    const kept = await s.client.ai.images.keep(w.id, job.id, {
      index: 0,
      base_revision: w.current_revision_id,
      placement: { type: 'insert', offset, alt: '竹林' },
    });
    expect(kept.src).toMatch(/^assets\/ai-\d{8}T\d{6}-1\.jpg$/);
    expect(kept.work.markdown).toBe(`# 京都散步\n\n第一段。\n\n![竹林](${kept.src})\n\n第二段。\n`);
    const file = path.join(s.layout.abs(s.layout.workDirRel(w.id)), kept.src);
    expect(fs.existsSync(file)).toBe(true);
    expect((await s.client.assets.get(kept.asset_id)).origin).toBe('manual');
    const revisions = await s.client.works.revisions(w.id);
    expect(revisions.items[0]).toMatchObject({ source: 'ai_accepted', ai_job_id: job.id });
    expect((await s.client.ai.job(job.id)).accepted_revision_id).toBe(
      kept.work.current_revision_id,
    );

    // The candidate left the cache: shown as expired, and cannot be kept twice.
    const again = imageResultOf(await s.client.ai.job(job.id));
    expect(again?.candidates[0]).toMatchObject({ expired: true, url: null });
    const twice = await apiError(
      s.client.ai.images.keep(w.id, job.id, {
        index: 0,
        base_revision: kept.work.current_revision_id,
        placement: { type: 'library' },
      }),
    );
    expect(twice.status).toBe(409);
    expect(twice.body?.error.code).toBe('ai_job_not_acceptable');
  });

  it('builds a cover from the title and text, and sets it as the front-matter cover', async () => {
    const { s, relay } = await start();
    const w = await article(s, '# 京都散步\n\n秋天的嵐山，竹林與渡月橋。\n');
    relay.replies.push({ body: { data: [b64(await pngBytes(1536, 1024, '#884400'))] } });
    const { job: queued } = await s.client.ai.images.create(w.id, {
      provider: 'new-api',
      model: MODEL,
      purpose: 'cover',
      prompt: '暖色調',
      aspect_ratio: '2.35:1',
    });
    const job = await run(s, queued.id);
    const prompt = String(relay.seen[0]?.body.prompt);
    expect(prompt).toContain('標題：京都散步');
    expect(prompt).toContain('秋天的嵐山，竹林與渡月橋。');
    expect(prompt).toContain('補充要求：暖色調');
    expect(relay.seen[0]?.body.size).toBe('1536x1024');
    const c = imageResultOf(job)?.candidates[0];
    expect(c).toMatchObject({ width: 1536, height: 654 });

    const kept = await s.client.ai.images.keep(w.id, job.id, {
      index: 0,
      base_revision: w.current_revision_id,
      placement: { type: 'cover' },
    });
    expect(kept.work.markdown).toBe(
      `---\ncover: ${kept.src}\n---\n# 京都散步\n\n秋天的嵐山，竹林與渡月橋。\n`,
    );
    const card = (await s.client.works.list()).items.find((i) => i.id === w.id)?.card_image;
    expect(card?.url).not.toBeNull();
  });

  it('downloads URL answers from the relay itself, refuses other private addresses', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    relay.files.set('a.png', { type: 'image/png', data: await pngBytes(200, 200, '#123456') });
    relay.replies.push({ body: { data: [{ url: `${relay.origin}/files/a.png` }] } });
    const ok = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'a',
        })
      ).job.id,
    );
    expect(ok.status).toBe('succeeded');
    expect(imageResultOf(ok)?.candidates[0]).toMatchObject({ width: 200, height: 200 });

    relay.replies.push({ body: { data: [{ url: 'http://10.0.0.1/secret.png' }] } });
    const blocked = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'b',
        })
      ).job.id,
    );
    expect(blocked).toMatchObject({ status: 'failed', error_code: 'invalid_output', attempts: 1 });
    expect(blocked.error_detail).toContain('blocked_address');
    expect(fs.existsSync(s.layout.aiImageJobDir(blocked.id))).toBe(false);

    // Trusting the relay's origin does not extend to where it redirects.
    relay.replies.push({ body: { data: [{ url: `${relay.origin}/redirect-out` }] } });
    const redirected = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'r',
        })
      ).job.id,
    );
    expect(redirected.error_detail).toContain('blocked_address');

    relay.files.set('page.html', { type: 'text/html', data: Buffer.from('<html></html>') });
    relay.replies.push({ body: { data: [{ url: `${relay.origin}/files/page.html` }] } });
    const html = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'c',
        })
      ).job.id,
    );
    expect(html.error_detail).toContain('unsupported_content_type');

    relay.replies.push({ body: { data: [b64(Buffer.from('not an image at all'))] } });
    const garbage = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'd',
        })
      ).job.id,
    );
    expect(garbage).toMatchObject({ status: 'failed', error_code: 'invalid_output' });
  });

  it('keeps transparency as PNG and can keep into the library only', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    const alpha = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    relay.replies.push({ body: { data: [b64(alpha)] } });
    const job = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'x',
        })
      ).job.id,
    );
    expect(imageResultOf(job)?.candidates[0]?.mime).toBe('image/png');
    const kept = await s.client.ai.images.keep(w.id, job.id, {
      index: 0,
      base_revision: w.current_revision_id,
      placement: { type: 'library' },
    });
    expect(kept.work.current_revision_id).toBe(w.current_revision_id);
    expect(kept.src).toMatch(/\.png$/);
    expect((await s.client.assets.list()).total).toBe(1);
  });

  it('classifies relay refusals, never retries, and needs the notice confirmed', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    relay.replies.push({
      status: 400,
      body: { error: { code: 'content_policy_violation', message: `prompt was ${KEY}` } },
    });
    const blocked = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'x',
        })
      ).job.id,
    );
    expect(blocked).toMatchObject({ status: 'failed', error_code: 'content_blocked', attempts: 1 });
    expect(JSON.stringify(blocked)).not.toContain(KEY);

    relay.replies.push({ status: 503, body: { error: { message: 'busy' } } });
    const busy = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'y',
        })
      ).job.id,
    );
    expect(busy).toMatchObject({
      status: 'failed',
      error_code: 'provider_unavailable',
      attempts: 1,
    });
    expect(relay.seen).toHaveLength(2);

    await s.client.ai.withdrawConsent('new-api');
    const consent = await apiError(
      s.client.ai.images.create(w.id, {
        provider: 'new-api',
        model: MODEL,
        purpose: 'image',
        prompt: 'z',
      }),
    );
    expect(consent.body?.error.code).toBe('ai_consent_required');
  });

  it('makes a platform cover in that platform’s ratio (QC-076)', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    relay.replies.push({ body: { data: [b64(await pngBytes(1024, 1536, '#335577'))] } });
    const { job } = await s.client.ai.images.create(w.id, {
      provider: 'new-api',
      model: MODEL,
      purpose: 'cover',
      platform: 'wechat_channels',
    });
    expect(job.task).toMatchObject({ aspect_ratio: '6:7', platform: 'wechat_channels' });
    const done = await run(s, job.id);
    expect(relay.seen[0]?.body.size).toBe('1024x1536');
    expect(String(relay.seen[0]?.body.prompt)).toContain('微信視頻號的封面圖');
    // 1024×1536 cropped to 6:7 → 1024×1195.
    expect(imageResultOf(done)?.candidates[0]).toMatchObject({ width: 1024, height: 1195 });
    // Kept into the library; the app then sets it as the variant's cover.
    const kept = await s.client.ai.images.keep(w.id, job.id, {
      index: 0,
      base_revision: w.current_revision_id,
      placement: { type: 'library' },
    });
    const { created } = await s.client.variants.generate(w.id, { platforms: ['wechat_channels'] });
    const draft = created[0];
    if (draft === undefined) throw new Error('no variant');
    const withCover = await s.client.variants.patch(w.id, 'wechat_channels', {
      base_revision: draft.revision,
      cover: { asset_id: kept.asset_id },
    });
    expect(withCover.cover).toMatchObject({ asset_id: kept.asset_id });
    expect(kept.work.current_revision_id).toBe(w.current_revision_id);
  });

  it('uses an image prompt from the library, with its variables (QC-075)', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    const prompt = await s.client.ai.prompts.create({
      name: '水彩配圖',
      content: '為《{標題}》畫一張水彩插圖，主題：{選取}',
      scene: 'image',
    });
    relay.replies.push({ body: { data: [b64(await pngBytes(64, 64))] } });
    const { job } = await s.client.ai.images.create(w.id, {
      provider: 'new-api',
      model: MODEL,
      purpose: 'image',
      prompt_id: prompt.id,
      prompt: '竹林小徑',
    });
    expect(job.task).toMatchObject({ prompt_id: prompt.id });
    await run(s, job.id);
    expect(relay.seen[0]?.body.prompt).toBe('為《京都散步》畫一張水彩插圖，主題：竹林小徑');
    expect((await s.client.ai.preferences()).last_models.image).toEqual({
      provider: 'new-api',
      model: MODEL,
    });
    const wrong = await apiError(
      s.client.ai.images.create(w.id, {
        provider: 'new-api',
        model: MODEL,
        purpose: 'image',
        prompt_id: 'builtin-polish',
      }),
    );
    expect(wrong.status).toBe(400);
  });

  it('refuses works that are not articles and requests without a prompt', async () => {
    const { s } = await start();
    const gallery = await s.client.works.create({ title: '相簿', type: 'image' });
    const notArticle = await apiError(
      s.client.ai.images.create(gallery.id, {
        provider: 'new-api',
        model: MODEL,
        purpose: 'image',
        prompt: 'x',
      }),
    );
    expect(notArticle.status).toBe(400);
    const w = await article(s);
    const res = await fetch(`${s.baseUrl}/api/v1/works/${w.id}/ai/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'new-api', model: MODEL, purpose: 'image' }),
    });
    expect(res.status).toBe(400);
  });

  it('cancels a running generation and aborts the relay call', async () => {
    const { s, relay } = await start();
    const w = await article(s);
    relay.replies.push({ delayMs: 5000, body: { data: [] } });
    const { job } = await s.client.ai.images.create(w.id, {
      provider: 'new-api',
      model: MODEL,
      purpose: 'image',
      prompt: 'slow',
    });
    s.ai.start();
    for (let i = 0; i < 200 && relay.seen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await s.client.ai.cancel(job.id)).status).toBe('cancelled');
    await s.ai.drain();
    for (let i = 0; i < 200 && relay.aborted.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(relay.aborted).toEqual(['/v1/images/generations']);
    expect((await s.client.ai.job(job.id)).status).toBe('cancelled');
  });

  it('discards candidates and sweeps old ones', async () => {
    const { s, relay } = await start({ images: { candidateTtlMs: 60_000 } });
    const w = await article(s);
    relay.replies.push({
      body: { data: [b64(await pngBytes(64, 64)), b64(await pngBytes(64, 64, '#00ff00'))] },
    });
    const job = await run(
      s,
      (
        await s.client.ai.images.create(w.id, {
          provider: 'new-api',
          model: MODEL,
          purpose: 'image',
          prompt: 'x',
          n: 2,
        })
      ).job.id,
    );
    await s.client.ai.images.discard(w.id, job.id, 0);
    const shown = imageResultOf(await s.client.ai.job(job.id));
    expect(shown?.candidates.map((c) => c.expired)).toEqual([true, false]);
    const gone = await fetch(`${s.baseUrl}/api/v1/works/${w.id}/ai/images/${job.id}/candidates/0`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(gone.status).toBe(404);

    expect(s.images.sweep()).toBe(0);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(s.layout.aiImageJobDir(job.id), old, old);
    expect(s.images.sweep()).toBe(1);
    expect(imageResultOf(await s.client.ai.job(job.id))?.candidates[1]?.expired).toBe(true);
  });
});

describe('insertImage (QC-070)', () => {
  it('puts the image in its own paragraph at a line end, never in the front matter', () => {
    expect(insertImage('a\nb\n', 0, 'assets/x.png')).toBe('![](assets/x.png)\n\na\nb\n');
    expect(insertImage('a\nb', 1, 'assets/x.png', 'X')).toBe('a\n\n![X](assets/x.png)\n\nb');
    expect(insertImage('a', 99, 'assets/x.png')).toBe('a\n\n![](assets/x.png)\n');
    expect(insertImage('---\ncover: c.png\n---\nbody\n', 2, 'assets/x y.png')).toBe(
      '---\ncover: c.png\n---\n![](<assets/x y.png>)\n\nbody\n',
    );
    expect(insertImage('a', 0, 'assets/x.png', 'a]b')).toBe('![a b](assets/x.png)\n\na');
  });
});
