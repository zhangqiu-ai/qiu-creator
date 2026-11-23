import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  AI_NOTICE_VERSION,
  type AiJobRecord,
  type AiProvider,
  type WorkDetail,
} from '@qiu-creator/contracts';
import {
  buildServer,
  type BuildServerOptions,
  type CreatorHubServer,
} from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngBytes } from '../../../services/mac-server/test/fixtures.js';
import { AiProviders } from '../src/renderer/ai-session.js';
import {
  COVER_COUNT,
  CoverGenSession,
  coverPromptFrom,
  coverRatio,
  ratioStyle,
} from '../src/renderer/preview-cover.js';
import {
  candidatesFor,
  PreviewTitleSession,
  titleLimitOf,
} from '../src/renderer/preview-titles.js';

/**
 * QC-076 預覽 inside the editor: AI 標題 for one platform and AI 封面 at that
 * platform's ratio, against a real mac-server. Both providers are in-process
 * fakes (a scripted Anthropic and a local New API relay): nothing leaves the
 * machine, no key touches the Keychain, CREATORHUB_HOME is temporary.
 */

const TOKEN = 'test-token-0123456789abcdef';
const MD = '# 書房改造\n\n白天的採光太強，螢幕上的顏色每個小時都在變。\n';
const IMAGE_MODEL = 'gpt-image-1';

type ServerAi = NonNullable<BuildServerOptions['ai']>;
type FakeProvider = NonNullable<NonNullable<ServerAi['providers']>['anthropic']>;
type GenerateArgs = Parameters<FakeProvider['generateText']>;

/** Scripted text provider: each call takes the next reply. */
class ScriptedProvider implements FakeProvider {
  readonly id = 'anthropic' as const;
  readonly replies: (string | Error)[] = [];
  readonly prompts: string[] = [];

  generateText(...[request]: GenerateArgs) {
    this.prompts.push(request.prompt);
    const next = this.replies.shift() ?? new Error('no scripted reply');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({
      text: next,
      model: request.model,
      finish: 'stop' as const,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }
}

/** `GET /v1/models` and `POST /v1/images/generations` for the New API relay. */
class FakeRelay {
  readonly generations: Record<string, unknown>[] = [];
  readonly replies: { body: unknown }[] = [];
  private server: http.Server | undefined;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: IMAGE_MODEL }] }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.generations.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
        );
        const reply = this.replies.shift() ?? { body: { data: [] } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
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

class MemorySecrets {
  private readonly values = new Map<AiProvider, string>();
  get(p: AiProvider) {
    return Promise.resolve(this.values.get(p) ?? null);
  }
  set(p: AiProvider, v: string) {
    this.values.set(p, v);
    return Promise.resolve();
  }
  delete(p: AiProvider) {
    return Promise.resolve(this.values.delete(p));
  }
}

let server: CreatorHubServer;
let home: string;
let client: CreatorHubClient;
let provider: ScriptedProvider;
let relay: FakeRelay;
let work: WorkDetail;
const disposers: (() => void)[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-pv-'));
  provider = new ScriptedProvider();
  relay = new FakeRelay();
  await relay.start();
  server = await buildServer({
    config: { home, token: TOKEN },
    ai: {
      secrets: new MemorySecrets(),
      providers: { anthropic: provider },
      baseUrls: { 'new-api': relay.baseUrl },
      retryBaseMs: 10,
      pollMs: 10,
      timeoutMs: 5000,
    },
  });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  work = await client.works.create({ title: '書房改造', markdown: MD, source: 'mac-app' });
});

afterEach(async () => {
  for (const d of disposers.splice(0)) d();
  await server.app.close();
  await relay.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('預覽的 AI 封面參數 (QC-076)', () => {
  it('each platform has its own cover ratio', () => {
    expect(coverRatio('xiaohongshu')).toBe('3:4');
    expect(coverRatio('wechat_mp')).toBe('2.35:1');
    expect(coverRatio('douyin')).toBe('3:4');
    expect(coverRatio('wechat_channels')).toBe('6:7');
    expect(ratioStyle('wechat_channels')).toBe('6 / 7');
    expect(COVER_COUNT).toBe(4);
  });

  it('the prompt starts from the platform version: its title, then its text', () => {
    expect(coverPromptFrom(' 書房改造 ', ' 白天的採光太強。 ')).toBe('書房改造\n白天的採光太強。');
    expect(coverPromptFrom('標題', 'x'.repeat(900), 20)).toHaveLength(20);
    expect(coverPromptFrom('', '')).toBe('');
  });
});

describe('預覽的標題候選 (QC-076)', () => {
  const titleJob = (titles: string[]): AiJobRecord =>
    ({
      status: 'succeeded',
      result: {
        json: {
          type: 'platform_suggestions',
          platforms: [
            { platform: 'wechat_channels', titles: titles.map((text) => ({ text, warnings: [] })) },
          ],
        },
      },
    }) as unknown as AiJobRecord;

  it('reads the asked-for platform candidates, drops blanks and marks over-limit ones', () => {
    const limit = titleLimitOf('wechat_channels') ?? 0;
    expect(limit).toBe(16);
    const got = candidatesFor(
      titleJob(['書房改剪輯室', '  ', 'x'.repeat(limit + 2)]),
      'wechat_channels',
    );
    expect(got?.map((c) => [c.text, c.over])).toEqual([
      ['書房改剪輯室', false],
      ['x'.repeat(limit + 2), true],
    ]);
    // Another platform was not asked for, so it has nothing.
    expect(candidatesFor(titleJob(['書房改剪輯室']), 'douyin')).toEqual([]);
  });

  it('asks for one platform only and never writes: a candidate is applied by the panel', async () => {
    await client.ai.setKey('anthropic', 'sk-ant-fake-0123456789abcdef');
    await client.ai.consent('anthropic', AI_NOTICE_VERSION);
    const titles = new PreviewTitleSession(client, work.id, new AiProviders(client), 20);
    disposers.push(() => {
      titles.dispose();
    });
    provider.replies.push(
      JSON.stringify({ douyin: { titles: ['書房改剪輯室半年：光比設備重要', '剪輯室改造復盤'] } }),
    );
    await titles.generate('douyin', null);
    await until(() => titles.snapshot.phase === 'ready', 'candidates');
    expect(titles.snapshot.platform).toBe('douyin');
    expect(titles.snapshot.candidates.map((c) => c.text)).toEqual([
      '書房改剪輯室半年：光比設備重要',
      '剪輯室改造復盤',
    ]);
    // Only 抖音 was asked for, with its own limit; the other platforms are not in the prompt.
    const prompt = provider.prompts[0] ?? '';
    expect(prompt).toContain('抖音');
    expect(prompt).not.toContain('小紅書');
    // Nothing was written: every platform still follows the work.
    expect((await client.variants.list(work.id)).items.map((v) => v.exists)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // 捨棄 clears the list without writing either.
    titles.clear();
    expect(titles.snapshot.candidates).toEqual([]);
  });

  it('reports a failure instead of candidates', async () => {
    await client.ai.setKey('anthropic', 'sk-ant-fake-0123456789abcdef');
    await client.ai.consent('anthropic', AI_NOTICE_VERSION);
    const titles = new PreviewTitleSession(client, work.id, new AiProviders(client), 20);
    disposers.push(() => {
      titles.dispose();
    });
    provider.replies.push('not json');
    await titles.generate('xiaohongshu', null);
    await until(() => titles.snapshot.phase === 'failed', 'failure');
    expect(titles.snapshot.failure?.code).toBe('invalid_output');
  });
});

describe('預覽的 AI 封面 (QC-076)', () => {
  async function ready(): Promise<CoverGenSession> {
    const status = await client.ai.setKey(
      'new-api',
      'sk-relay-fake-0123456789',
      'https://relay.invalid/v1',
    );
    await client.ai.consent('new-api', AI_NOTICE_VERSION, status.notice.credential_id ?? '');
    const covers = new CoverGenSession(client, work.id, new AiProviders(client), 60_000);
    disposers.push(() => {
      covers.dispose();
    });
    await covers.load();
    return covers;
  }

  it('says what is missing before New API is ready', async () => {
    const covers = new CoverGenSession(client, work.id, new AiProviders(client), 60_000);
    disposers.push(() => {
      covers.dispose();
    });
    await covers.load();
    expect(covers.snapshot).toMatchObject({ block: 'key', models: [] });
  });

  it('sends the platform and its ratio, and 保留 only puts the image in the library', async () => {
    const covers = await ready();
    expect(covers.snapshot.models?.map((m) => m.id)).toEqual([IMAGE_MODEL]);
    await relay.images('#9E4428', '#3E4A57', '#5E7A8A', '#B8862B');
    await covers.generate('wechat_channels', IMAGE_MODEL, '書房改造\n白天的採光太強。');
    expect(covers.snapshot).toMatchObject({ phase: 'generating', platform: 'wechat_channels' });
    expect(covers.snapshot.pending).toBe(COVER_COUNT);
    const jobId = covers.snapshot.jobId ?? '';
    expect(jobId).not.toBe('');
    const queued = await client.ai.job(jobId);
    expect(queued.task).toMatchObject({
      type: 'image_generation',
      purpose: 'cover',
      aspect_ratio: '6:7',
    });

    await server.ai.drain();
    await covers.jobChanged(jobId);
    await until(() => covers.snapshot.phase === 'ready', 'candidates');
    expect(covers.snapshot.candidates).toHaveLength(4);
    expect(covers.snapshot.candidates[0]?.src).toMatch(/\/media\/v1\/image-candidates\//);

    // Nothing reached the work: the original keeps its revision and its cover.
    const before = await client.works.get(work.id);
    expect(before.current_revision_id).toBe(work.current_revision_id);

    const kept = await covers.keep(1, work.current_revision_id);
    expect(kept.ok).toBe(true);
    if (!kept.ok) throw new Error('not kept');
    expect((await client.assets.get(kept.assetId)).kind).toBe('image');
    expect((await client.works.get(work.id)).current_revision_id).toBe(work.current_revision_id);
    expect(covers.snapshot.candidates[1]?.fate).toBe('kept');

    // The panel then sets it as this platform's cover; the other platforms keep theirs.
    const saved = await client.variants.patch(work.id, 'wechat_channels', {
      base_revision: 0,
      cover: { asset_id: kept.assetId },
    });
    expect(saved).toMatchObject({ cover: { asset_id: kept.assetId }, cover_source: 'override' });
    const others = (await client.variants.list(work.id)).items.filter(
      (v) => v.platform !== 'wechat_channels',
    );
    expect(others.map((v) => v.cover_source)).toEqual(['work', 'work', 'work']);
  });

  it('捨棄 takes the run off the screen and deletes the candidates', async () => {
    const covers = await ready();
    await relay.images('#9E4428', '#3E4A57', '#5E7A8A', '#B8862B');
    await covers.generate('xiaohongshu', IMAGE_MODEL, '書房改造');
    const jobId = covers.snapshot.jobId ?? '';
    await server.ai.drain();
    await covers.jobChanged(jobId);
    await until(() => covers.snapshot.phase === 'ready', 'candidates');
    await covers.discardAll();
    expect(covers.snapshot).toMatchObject({ phase: 'idle', jobId: null, candidates: [] });
    const gone = await covers.keep(0, work.current_revision_id);
    expect(gone).toEqual({ ok: false, reason: 'failed' });
  });
});
