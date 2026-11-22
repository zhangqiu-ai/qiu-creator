import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, createClient } from '@qiu-creator/api-client';
import type { AiProvider } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type StartOptions, type TestServer } from './helpers.js';

/**
 * QC-057: 測試連線. Every provider is a local fake HTTP server; no real
 * request is made. Each provider's key is distinct so the fake can tell
 * whose request it is and the tests can check where each key went.
 */

const KEYS: Record<AiProvider, string> = {
  gemini: 'AIza-fake-gemini-key-0123456789',
  anthropic: 'sk-ant-fake-key-0123456789',
  openai: 'sk-proj-fake-openai-0123456789',
  'new-api': 'sk-relay-fake-key-0123456789',
};

interface Seen {
  provider: AiProvider | 'unknown';
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  bodyBytes: number;
}

type Reply = { status: number; body: unknown } | 'hang';

/** Answers like each provider's model-list endpoint; `replies` overrides per provider. */
class FakeProviders {
  readonly seen: Seen[] = [];
  readonly replies: Partial<Record<AiProvider, Reply>> = {};
  private server: http.Server | undefined;
  private port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let bytes = 0;
      req.on('data', (c: Buffer) => {
        bytes += c.length;
      });
      req.on('end', () => {
        const provider = whose(req);
        this.seen.push({
          provider,
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          bodyBytes: bytes,
        });
        if (provider === 'unknown') {
          res.writeHead(404).end();
          return;
        }
        const reply = this.replies[provider] ?? defaultReply(provider);
        if (reply === 'hang') return;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  baseUrls(): Record<AiProvider, string> {
    const origin = `http://127.0.0.1:${String(this.port)}`;
    return { anthropic: origin, openai: `${origin}/v1`, gemini: origin, 'new-api': `${origin}/v1` };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    this.server = undefined;
  }
}

function whose(req: http.IncomingMessage): AiProvider | 'unknown' {
  const path = req.url ?? '';
  const bearer = req.headers.authorization;
  if (path === '/v1beta/models?pageSize=1000' && req.headers['x-goog-api-key'] === KEYS.gemini) {
    return 'gemini';
  }
  if (path === '/v1/models?limit=1000' && req.headers['x-api-key'] === KEYS.anthropic) {
    return 'anthropic';
  }
  if (path === '/v1/models' && bearer === `Bearer ${KEYS.openai}`) return 'openai';
  if (path === '/v1/models' && bearer === `Bearer ${KEYS['new-api']}`) return 'new-api';
  return 'unknown';
}

function defaultReply(provider: AiProvider): Reply {
  switch (provider) {
    case 'gemini':
      return {
        status: 200,
        body: {
          models: [
            { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
            { name: 'models/gemini-3.5-flash-lite' },
            { name: 'models/text-embedding-004' },
          ],
        },
      };
    case 'anthropic':
      return {
        status: 200,
        body: {
          data: [
            { id: 'claude-opus-5-5', type: 'model' },
            { id: 'claude-sonnet-5-5', type: 'model' },
          ],
          has_more: false,
        },
      };
    case 'openai':
      return {
        status: 200,
        body: { object: 'list', data: [{ id: 'gpt-5.5' }, { id: 'gpt-5-mini' }, { id: 'tts-1' }] },
      };
    case 'new-api':
      // The configured text model (gpt-4o-mini by default) is not in this list.
      return { status: 200, body: { data: [{ id: 'gpt-image-2' }] } };
  }
}

const servers: TestServer[] = [];
const fakes: FakeProviders[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function start(
  options: { logs?: string[]; timeoutMs?: number } = {},
): Promise<{ s: TestServer; fake: FakeProviders }> {
  const fake = new FakeProviders();
  await fake.start();
  fakes.push(fake);
  const logs = options.logs;
  const extra: StartOptions =
    logs === undefined
      ? {}
      : { logger: true, logStream: { write: (line: string) => logs.push(line) } };
  const s = await startTestServer({
    ...extra,
    ai: { baseUrls: fake.baseUrls(), timeoutMs: options.timeoutMs ?? 2000, start: false },
  });
  servers.push(s);
  return { s, fake };
}

async function storeKeys(s: TestServer): Promise<void> {
  for (const p of ['gemini', 'anthropic', 'openai'] as const) await s.client.ai.setKey(p, KEYS[p]);
  await s.client.ai.setKey('new-api', KEYS['new-api'], 'https://relay.example.test/v1');
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

describe('測試連線 (QC-057)', () => {
  it('lists each provider’s models with its own key: a GET with no body and no consent needed', async () => {
    const logs: string[] = [];
    const { s, fake } = await start({ logs });
    await storeKeys(s);

    const results = Object.fromEntries(
      await Promise.all(
        (['gemini', 'anthropic', 'openai', 'new-api'] as const).map(
          async (p) => [p, await s.client.ai.testProvider(p)] as const,
        ),
      ),
    );
    expect(results).toMatchObject({
      gemini: {
        provider: 'gemini',
        ok: true,
        model_count: 3,
        text_model_listed: true,
        error: null,
      },
      anthropic: { ok: true, model_count: 2, text_model_listed: true, error: null },
      openai: { ok: true, model_count: 3, text_model_listed: true, error: null },
      'new-api': { ok: true, model_count: 1, text_model_listed: false, error: null },
    });
    for (const r of Object.values(results)) {
      expect(Number.isInteger(r.latency_ms) && r.latency_ms >= 0).toBe(true);
      expect(Number.isNaN(Date.parse(r.tested_at))).toBe(false);
    }

    expect(fake.seen.map((r) => r.provider).sort()).toEqual([
      'anthropic',
      'gemini',
      'new-api',
      'openai',
    ]);
    for (const r of fake.seen) {
      expect(r.method).toBe('GET');
      expect(r.bodyBytes).toBe(0);
    }
    expect(fake.seen.find((r) => r.provider === 'anthropic')?.headers['anthropic-version']).toBe(
      '2023-06-01',
    );
    // No consent was given, and none was needed: nothing but the key was sent.
    expect((await s.client.ai.providers()).items.every((p) => p.consent === null)).toBe(true);

    const everything = JSON.stringify(results) + logs.join('\n');
    for (const key of Object.values(KEYS)) expect(everything).not.toContain(key);
  });

  it('reports a failed probe as ok: false with the error code and reason', async () => {
    const logs: string[] = [];
    const { s, fake } = await start({ logs });
    await storeKeys(s);
    const cases: {
      provider: AiProvider;
      reply: Reply;
      code: string;
      details: Record<string, unknown>;
    }[] = [
      {
        provider: 'openai',
        reply: { status: 401, body: { error: { message: `Incorrect key ${KEYS.openai}` } } },
        code: 'ai_key_invalid',
        details: { status: 401 },
      },
      {
        provider: 'openai',
        reply: { status: 429, body: { error: { code: 'insufficient_quota', message: 'x' } } },
        code: 'ai_gateway_unreachable',
        details: { reason: 'quota', status: 429 },
      },
      {
        provider: 'gemini',
        reply: { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } },
        code: 'ai_gateway_unreachable',
        details: { reason: 'quota', status: 429 },
      },
      {
        provider: 'new-api',
        reply: { status: 402, body: {} },
        code: 'ai_gateway_unreachable',
        details: { reason: 'quota', status: 402 },
      },
      {
        provider: 'anthropic',
        reply: { status: 429, body: { type: 'error', error: { type: 'rate_limit_error' } } },
        code: 'ai_gateway_unreachable',
        details: { reason: 'unavailable', status: 429 },
      },
      {
        provider: 'anthropic',
        reply: { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } },
        code: 'ai_gateway_unreachable',
        details: { reason: 'unavailable', status: 529 },
      },
      {
        provider: 'gemini',
        reply: { status: 200, body: 'not a list' },
        code: 'ai_gateway_bad_response',
        details: { reason: 'missing_data' },
      },
    ];
    for (const c of cases) {
      fake.replies[c.provider] = c.reply;
      const r = await s.client.ai.testProvider(c.provider);
      expect(r).toMatchObject({
        provider: c.provider,
        ok: false,
        model_count: null,
        text_model_listed: null,
      });
      expect(r.error?.code).toBe(c.code);
      expect(r.error?.details).toEqual(c.details);
      expect(r.latency_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(r)).not.toContain(KEYS[c.provider]);
    }
    for (const key of Object.values(KEYS)) expect(logs.join('\n')).not.toContain(key);
  });

  it('reports timeouts and refused connections', async () => {
    const { s, fake } = await start({ timeoutMs: 200 });
    await storeKeys(s);
    fake.replies.anthropic = 'hang';
    const slow = await s.client.ai.testProvider('anthropic');
    expect(slow.ok).toBe(false);
    expect(slow.error).toMatchObject({
      code: 'ai_gateway_unreachable',
      details: { reason: 'timeout' },
    });
    expect(slow.latency_ms).toBeGreaterThanOrEqual(150);

    await fake.stop();
    const down = await s.client.ai.testProvider('openai');
    expect(down.error).toMatchObject({
      code: 'ai_gateway_unreachable',
      details: { reason: 'connection', detail: 'ECONNREFUSED' },
    });
  });

  it('refreshes the New API model list cache', async () => {
    const { s, fake } = await start();
    await storeKeys(s);
    await s.client.ai.testProvider('new-api');
    const listed = await s.client.ai.newApiModels();
    expect(listed.models.map((m) => m.id)).toEqual(['gpt-image-2']);
    expect(fake.seen.filter((r) => r.provider === 'new-api')).toHaveLength(1);
  });

  it('is 409 without a key and 403 for agent tokens; nothing is sent', async () => {
    const { s, fake } = await start();
    for (const p of ['gemini', 'anthropic', 'openai', 'new-api'] as const) {
      const err = await apiError(s.client.ai.testProvider(p));
      expect(err.status).toBe(409);
      expect(err.body?.error.code).toBe('ai_key_missing');
    }
    await storeKeys(s);
    const agent = s.tokens.create({ name: 'agent', scopes: ['read', 'import', 'write'] });
    const asAgent = createClient({ baseUrl: s.baseUrl, token: agent.secret });
    expect((await apiError(asAgent.ai.testProvider('openai'))).status).toBe(403);
    expect(fake.seen).toHaveLength(0);
  });
});
