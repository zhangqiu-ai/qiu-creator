import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, createClient } from '@qiu-creator/api-client';
import { afterEach, describe, expect, it } from 'vitest';
import { networkReason } from '../src/ai/providers/relay-models.js';
import { authHeaders, startTestServer, type StartOptions, type TestServer } from './helpers.js';

/**
 * QC-054: the New API model list. Every relay here is a local fake HTTP
 * server; nothing reaches a real relay. The stored Base URL is an
 * `https://….test` address that is never contacted: the adapter's base URL
 * override points at the fake.
 */

const API_KEY = 'sk-relay-fake-key-0123456789abcdef';
const STORED_BASE = 'https://relay.example.test/v1';

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A fake OpenAI-compatible relay; `handler` answers every request. */
class FakeRelay {
  readonly seen: Seen[] = [];
  handler: Handler = (_req, res) => {
    json(res, 200, { object: 'list', data: [] });
  };
  private server: http.Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
      });
      this.handler(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}/v1`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    this.server = undefined;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const servers: TestServer[] = [];
const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const r of relays.splice(0)) await r.stop();
});

async function start(
  options: { timeoutMs?: number; now?: () => Date; logs?: string[]; withKey?: boolean } = {},
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
    ai: {
      baseUrls: { 'new-api': relay.baseUrl },
      timeoutMs: options.timeoutMs ?? 2000,
      start: false,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  });
  servers.push(s);
  if (options.withKey !== false) await s.client.ai.setKey('new-api', API_KEY, STORED_BASE);
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

describe('New API model list (QC-054)', () => {
  it('asks the relay with the stored key and returns sorted, classified, deduplicated models', async () => {
    const { s, relay } = await start();
    relay.handler = (_req, res) => {
      json(res, 200, {
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
          { id: 'gpt-image-2', object: 'model' },
          { id: 'claude-sonnet-5-5' },
          { id: 'my-custom-relay-model' },
          { id: 'text-embedding-3-small' },
          { id: 'gpt-4o-mini' },
          { id: 42 },
          { name: 'no id' },
        ],
      });
    };
    await s.client.ai.patchSettings({
      price_overrides: { 'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 } },
    });

    const res = await s.client.ai.newApiModels();
    expect(res.provider).toBe('new-api');
    expect(res.models).toEqual([
      { id: 'claude-sonnet-5-5', kind: 'chat', priced: false },
      { id: 'gpt-4o-mini', kind: 'chat', priced: true },
      { id: 'gpt-image-2', kind: 'image', priced: false },
      { id: 'my-custom-relay-model', kind: 'unknown', priced: false },
      { id: 'text-embedding-3-small', kind: 'unknown', priced: false },
    ]);
    expect(Number.isNaN(Date.parse(res.fetched_at))).toBe(false);
    expect(relay.seen).toEqual([
      { method: 'GET', path: '/v1/models', authorization: `Bearer ${API_KEY}` },
    ]);
    expect(JSON.stringify(res)).not.toContain(API_KEY);
  });

  it('caches for 10 minutes per credential; refresh=1 and a new key ask again', async () => {
    let now = new Date('2026-11-21T10:00:00.000Z');
    const { s, relay } = await start({ now: () => now });
    let calls = 0;
    relay.handler = (_req, res) => {
      calls++;
      json(res, 200, { data: [{ id: `model-${String(calls)}` }] });
    };

    const first = await s.client.ai.newApiModels();
    expect(first.models.map((m) => m.id)).toEqual(['model-1']);
    now = new Date('2026-11-21T10:09:59.000Z');
    const cached = await s.client.ai.newApiModels();
    expect(cached).toEqual(first);
    expect(relay.seen).toHaveLength(1);

    const refreshed = await s.client.ai.newApiModels({ refresh: true });
    expect(refreshed.models.map((m) => m.id)).toEqual(['model-2']);
    expect(refreshed.fetched_at).toBe('2026-11-21T10:09:59.000Z');

    now = new Date('2026-11-21T10:20:00.000Z');
    expect((await s.client.ai.newApiModels()).models.map((m) => m.id)).toEqual(['model-3']);

    await s.client.ai.setKey('new-api', 'sk-relay-another-key-987654321', STORED_BASE);
    expect((await s.client.ai.newApiModels()).models.map((m) => m.id)).toEqual(['model-4']);
    expect(relay.seen.at(-1)?.authorization).toBe('Bearer sk-relay-another-key-987654321');

    // `priced` follows the current overrides, also from the cache.
    await s.client.ai.patchSettings({
      price_overrides: { 'model-4': { input_per_mtok: 1, output_per_mtok: 2 } },
    });
    expect((await s.client.ai.newApiModels()).models).toEqual([
      { id: 'model-4', kind: 'unknown', priced: true },
    ]);
    expect(relay.seen).toHaveLength(4);
  });

  it('shares one relay call between concurrent requests', async () => {
    const { s, relay } = await start();
    relay.handler = (_req, res) => {
      setTimeout(() => {
        json(res, 200, { data: [{ id: 'gpt-4o' }] });
      }, 100).unref();
    };
    const [a, b] = await Promise.all([
      s.client.ai.newApiModels({ refresh: true }),
      s.client.ai.newApiModels({ refresh: true }),
    ]);
    expect(a.models).toEqual(b.models);
    expect(relay.seen).toHaveLength(1);
  });

  it('needs a stored key; other providers are 400; agent tokens are 403', async () => {
    const { s, relay } = await start({ withKey: false });
    const missing = await apiError(s.client.ai.newApiModels());
    expect(missing.status).toBe(409);
    expect(missing.body?.error.code).toBe('ai_key_missing');

    const other = await fetch(`${s.baseUrl}/api/v1/ai/providers/openai/models`, {
      headers: authHeaders(),
    });
    expect(other.status).toBe(400);

    await s.client.ai.setKey('new-api', API_KEY, STORED_BASE);
    const agent = s.tokens.create({ name: 'agent', scopes: ['read', 'import', 'write'] });
    const asAgent = createClient({ baseUrl: s.baseUrl, token: agent.secret });
    expect((await apiError(asAgent.ai.newApiModels())).status).toBe(403);
    expect(relay.seen).toHaveLength(0);
  });

  describe('errors', () => {
    const cases: {
      name: string;
      handler: Handler;
      code: string;
      details: Record<string, unknown>;
    }[] = [
      {
        name: '401 → key invalid',
        handler: (_q, r) => {
          json(r, 401, { error: { message: `bad key ${API_KEY}` } });
        },
        code: 'ai_key_invalid',
        details: { status: 401 },
      },
      {
        name: '403 → key invalid',
        handler: (_q, r) => {
          json(r, 403, { error: { message: 'forbidden' } });
        },
        code: 'ai_key_invalid',
        details: { status: 403 },
      },
      {
        name: '503 → unavailable',
        handler: (_q, r) => {
          json(r, 503, {});
        },
        code: 'ai_gateway_unreachable',
        details: { reason: 'unavailable', status: 503 },
      },
      {
        name: '429 → unavailable',
        handler: (_q, r) => {
          json(r, 429, {});
        },
        code: 'ai_gateway_unreachable',
        details: { reason: 'unavailable', status: 429 },
      },
      {
        name: '404 → unexpected status',
        handler: (_q, r) => {
          json(r, 404, { error: 'no such route' });
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'unexpected_status', status: 404 },
      },
      {
        name: 'HTML → not JSON',
        handler: (_q, r) => {
          r.writeHead(200, { 'content-type': 'text/html' });
          r.end('<html>login</html>');
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'not_json' },
      },
      {
        name: 'no data array',
        handler: (_q, r) => {
          json(r, 200, { models: ['gpt-4o'] });
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'missing_data' },
      },
      {
        name: 'data without ids',
        handler: (_q, r) => {
          json(r, 200, { data: [{ name: 'x' }, 'y'] });
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'missing_data' },
      },
      {
        name: 'too large (declared)',
        handler: (_q, r) => {
          r.writeHead(200, {
            'content-type': 'application/json',
            'content-length': String(3 * 1024 * 1024),
          });
          r.end();
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'too_large' },
      },
      {
        name: 'too large (streamed)',
        handler: (_q, r) => {
          r.writeHead(200, { 'content-type': 'application/json' });
          const chunk = 'x'.repeat(256 * 1024);
          for (let i = 0; i < 10; i++) r.write(chunk);
          r.end();
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'too_large' },
      },
      {
        name: 'redirect → not followed',
        handler: (q, r) => {
          if (q.url === '/v1/models') {
            r.writeHead(302, { location: '/elsewhere/models' });
            r.end();
          } else json(r, 200, { data: [{ id: 'leaked' }] });
        },
        code: 'ai_gateway_bad_response',
        details: { reason: 'redirect', status: 302 },
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const logs: string[] = [];
        const { s, relay } = await start({ logs });
        relay.handler = c.handler;
        const err = await apiError(s.client.ai.newApiModels());
        expect(err.status).toBe(502);
        expect(err.body?.error.code).toBe(c.code);
        expect(err.body?.error.details).toEqual(c.details);
        expect(JSON.stringify(err.body)).not.toContain(API_KEY);
        expect(JSON.stringify(err.body)).not.toContain('relay.example.test');
        expect(relay.seen).toHaveLength(1);
        expect(logs.join('\n')).not.toContain(API_KEY);
        // Failures are not cached: the next call asks again.
        relay.handler = (_q, r) => {
          json(r, 200, { data: [{ id: 'gpt-4o' }] });
        };
        expect((await s.client.ai.newApiModels()).models.map((m) => m.id)).toEqual(['gpt-4o']);
      });
    }

    it('timeout', async () => {
      const { s, relay } = await start({ timeoutMs: 200 });
      relay.handler = (_q, r) => {
        setTimeout(() => {
          json(r, 200, { data: [] });
        }, 2000).unref();
      };
      const err = await apiError(s.client.ai.newApiModels());
      expect(err.body?.error).toMatchObject({
        code: 'ai_gateway_unreachable',
        details: { reason: 'timeout' },
      });
    });

    it('connection refused', async () => {
      const { s, relay } = await start();
      await relay.stop();
      const err = await apiError(s.client.ai.newApiModels());
      expect(err.body?.error).toMatchObject({
        code: 'ai_gateway_unreachable',
        details: { reason: 'connection', detail: 'ECONNREFUSED' },
      });
    });

    it('classifies DNS and TLS failures from the error codes Node reports', () => {
      const wrapped = (code: string): Error =>
        new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
      expect(networkReason(wrapped('ENOTFOUND'))).toBe('dns');
      expect(networkReason(wrapped('EAI_AGAIN'))).toBe('dns');
      expect(networkReason(wrapped('CERT_HAS_EXPIRED'))).toBe('tls');
      expect(networkReason(wrapped('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe('tls');
      expect(networkReason(wrapped('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('tls');
      expect(networkReason(wrapped('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls');
      expect(networkReason(wrapped('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
      expect(networkReason(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(
        'timeout',
      );
      expect(networkReason(wrapped('ECONNRESET'))).toBe('connection');
      expect(networkReason(new Error('?'))).toBe('connection');
    });
  });
});

describe('New API Base URL without /v1 (QC-054)', () => {
  it('rejects it with the corrected URL as a suggestion; nothing is saved', async () => {
    const { s } = await start({ withKey: false });
    for (const [input, suggested] of [
      ['https://relay.example.test', 'https://relay.example.test/v1'],
      ['https://relay.example.test/', 'https://relay.example.test/v1'],
      ['https://relay.example.test/api', 'https://relay.example.test/api/v1'],
      ['https://relay.example.test/v1/chat/completions', 'https://relay.example.test/v1'],
    ] as const) {
      const res = await fetch(`${s.baseUrl}/api/v1/ai/providers/new-api/key`, {
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ api_key: API_KEY, base_url: input }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: {
          code: string;
          details: { issues: { instancePath: string; params?: { params?: unknown } }[] };
        };
      };
      expect(body.error.code).toBe('validation_error');
      // fastify-type-provider-zod keeps zod's own `params` inside each issue's `params`.
      const issue = body.error.details.issues.find((i) => i.instancePath === '/base_url');
      expect(issue?.params?.params).toEqual({ suggested_base_url: suggested });
    }
    // Plain HTTP is never "fixed".
    const http1 = await fetch(`${s.baseUrl}/api/v1/ai/providers/new-api/key`, {
      method: 'PUT',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ api_key: API_KEY, base_url: 'http://relay.example.test/v1' }),
    });
    expect(http1.status).toBe(400);
    const issues = (
      (await http1.json()) as {
        error: { details: { issues: { params?: { params?: unknown } }[] } };
      }
    ).error.details.issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.params?.params === undefined)).toBe(true);
    expect(
      (await s.client.ai.providers()).items.find((p) => p.provider === 'new-api'),
    ).toMatchObject({ key_configured: false });
  });
});
