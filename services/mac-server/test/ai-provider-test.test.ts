import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, createClient } from '@qiu-creator/api-client';
import { AI_TEST_TIMEOUT_MS, type AiProvider } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/ai/secret-store.js';
import { classifyTooManyRequests, effectiveTimeout } from '../src/ai/providers/relay-models.js';
import { makeTempHome, startTestServer, type StartOptions, type TestServer } from './helpers.js';

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
        // QC-057 follow-up: Gemini's per-minute limit, with the misleading "billing" hint.
        reply: { status: 429, body: GEMINI_PER_MINUTE },
        code: 'ai_gateway_unreachable',
        details: { reason: 'rate_limited', status: 429 },
      },
      {
        provider: 'gemini',
        reply: { status: 429, body: GEMINI_BILLING_DISABLED },
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
        details: { reason: 'rate_limited', status: 429 },
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

/** Gemini 429 bodies in the shape of the Gemini API (google.rpc details); made up for tests. */
const GEMINI_PER_MINUTE = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { location: 'global', model: 'gemini-3.8-flash' },
            quotaValue: '10',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
    ],
  },
};

const GEMINI_BILLING_DISABLED = {
  error: {
    code: 429,
    message: 'Billing is not enabled for this project.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'BILLING_DISABLED',
        domain: 'googleapis.com',
      },
    ],
  },
};

describe('429: quota or rate limited (QC-057 follow-up)', () => {
  const violation = (quotaId: string, quotaMetric = 'generativelanguage.googleapis.com/x') =>
    JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota, please check your plan and billing details.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaMetric, quotaId }],
          },
        ],
      },
    });

  it('treats Gemini per-minute, per-day, request and token limits as rate limits', () => {
    expect(classifyTooManyRequests(JSON.stringify(GEMINI_PER_MINUTE))).toBe('rate_limited');
    expect(
      classifyTooManyRequests(violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier')),
    ).toBe('rate_limited');
    expect(
      classifyTooManyRequests(
        violation(
          'GenerateContentInputTokensPerModelPerMinute-FreeTier',
          'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
        ),
      ),
    ).toBe('rate_limited');
  });

  it('treats only explicit Gemini billing or credit exhaustion as quota', () => {
    expect(classifyTooManyRequests(JSON.stringify(GEMINI_BILLING_DISABLED))).toBe('quota');
    expect(classifyTooManyRequests(violation('PrepaymentCreditsPerProject'))).toBe('quota');
    expect(
      classifyTooManyRequests(
        JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Your prepayment credits are depleted. Please add credits to continue.',
          },
        }),
      ),
    ).toBe('quota');
  });

  it('defaults to rate limited when Gemini gives no usable detail', () => {
    for (const body of [
      { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } },
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Resource has been exhausted (e.g. check quota).',
        },
      },
      { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: 'not a list' } },
    ]) {
      expect(classifyTooManyRequests(JSON.stringify(body))).toBe('rate_limited');
    }
  });

  it('uses error codes, then explicit wording, for OpenAI-compatible and other providers', () => {
    const openai = (code: string, type = 'x', message = 'x') =>
      JSON.stringify({ error: { code, type, message } });
    expect(classifyTooManyRequests(openai('insufficient_quota'))).toBe('quota');
    expect(classifyTooManyRequests(openai('billing_hard_limit_reached'))).toBe('quota');
    expect(
      classifyTooManyRequests(openai('rate_limit_exceeded', 'requests', 'check your billing plan')),
    ).toBe('rate_limited');
    expect(classifyTooManyRequests(JSON.stringify({ error: { type: 'tokens' } }))).toBe(
      'rate_limited',
    );
    expect(
      classifyTooManyRequests(
        JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }),
      ),
    ).toBe('rate_limited');
    // New API relays often answer in Chinese.
    expect(
      classifyTooManyRequests(
        JSON.stringify({ error: { message: '用户额度不足，剩余额度：$0.00' } }),
      ),
    ).toBe('quota');
    expect(
      classifyTooManyRequests(JSON.stringify({ error: { message: '请求过于频繁，请稍后再试' } })),
    ).toBe('rate_limited');
    expect(classifyTooManyRequests('当前分组上游负载已饱和')).toBe('rate_limited');
    expect(classifyTooManyRequests('余额不足')).toBe('quota');
    expect(classifyTooManyRequests('')).toBe('rate_limited');
  });
});

describe('last_test (QC-057)', () => {
  it('is kept across restarts, never holds key material, and is cleared when the key changes', async () => {
    const fake = new FakeProviders();
    await fake.start();
    fakes.push(fake);
    const home = makeTempHome();
    const secrets = new MemorySecretStore();
    let now = new Date('2026-11-21T12:00:00.000Z');
    const boot = async (): Promise<TestServer> => {
      const s = await startTestServer({
        home,
        ai: {
          baseUrls: fake.baseUrls(),
          timeoutMs: 2000,
          start: false,
          secrets,
          now: () => now,
        },
      });
      servers.push(s);
      return s;
    };
    try {
      const s1 = await boot();
      await storeKeys(s1);
      const statusOf = async (s: TestServer, p: AiProvider) =>
        (await s.client.ai.providers()).items.find((i) => i.provider === p);
      expect((await statusOf(s1, 'openai'))?.last_test).toBeNull();

      now = new Date('2026-11-21T12:01:00.000Z');
      const okResult = await s1.client.ai.testProvider('openai');
      fake.replies.anthropic = { status: 401, body: { error: { type: 'authentication_error' } } };
      await s1.client.ai.testProvider('anthropic');
      fake.replies['new-api'] = { status: 429, body: { error: { code: 'rate_limit_exceeded' } } };
      await s1.client.ai.testProvider('new-api');

      await s1.close();
      servers.splice(servers.indexOf(s1), 1);
      const s2 = await boot();
      expect((await statusOf(s2, 'openai'))?.last_test).toEqual({
        status: 'ok',
        at: '2026-11-21T12:01:00.000Z',
        latency_ms: okResult.latency_ms,
        model_count: 3,
        error_code: null,
        reason: null,
      });
      expect((await statusOf(s2, 'anthropic'))?.last_test).toMatchObject({
        status: 'failed',
        model_count: null,
        error_code: 'ai_key_invalid',
        reason: null,
      });
      expect((await statusOf(s2, 'new-api'))?.last_test).toMatchObject({
        status: 'failed',
        error_code: 'ai_gateway_unreachable',
        reason: 'rate_limited',
      });
      expect((await statusOf(s2, 'gemini'))?.last_test).toBeNull();
      // Base URL comes back from the Keychain credential after the restart.
      expect(await statusOf(s2, 'new-api')).toMatchObject({
        base_url: 'https://relay.example.test/v1',
        base_url_host: 'relay.example.test',
      });

      const stored = JSON.stringify(s2.db.prepare('SELECT * FROM app_settings').all());
      for (const key of Object.values(KEYS)) expect(stored).not.toContain(key);

      // A new key, a new Base URL or deleting the key: the old result no longer applies.
      now = new Date('2026-11-21T12:05:00.000Z');
      await s2.client.ai.setKey('openai', 'sk-proj-another-key-987654321');
      await s2.client.ai.setKey('new-api', KEYS['new-api'], 'https://other.example.test/v1');
      await s2.client.ai.deleteKey('anthropic');
      for (const p of ['openai', 'new-api', 'anthropic'] as const) {
        expect((await statusOf(s2, p))?.last_test).toBeNull();
      }
      expect(await statusOf(s2, 'new-api')).toMatchObject({
        base_url: 'https://other.example.test/v1',
        base_url_host: 'other.example.test',
      });
      await s2.client.ai.deleteKey('new-api');
      expect(await statusOf(s2, 'new-api')).toMatchObject({ base_url: null, base_url_host: null });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('caps the test at 10 seconds even when the adapter allows longer', () => {
    expect(AI_TEST_TIMEOUT_MS).toBe(10_000);
    expect(effectiveTimeout(120_000, AI_TEST_TIMEOUT_MS)).toBe(10_000);
    expect(effectiveTimeout(2_000, AI_TEST_TIMEOUT_MS)).toBe(2_000);
    expect(effectiveTimeout(120_000, undefined)).toBe(120_000);
  });
});
