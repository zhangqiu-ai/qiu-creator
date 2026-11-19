import { ApiError } from '@qiu-creator/api-client';
import {
  AI_NOTICE_VERSION,
  AI_PRICE_TABLE,
  costUsd,
  type AiJobRecord,
  type AiProvider,
  type CreateAiJobRequest,
} from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { KeychainSecretStore } from '../src/ai/secret-store.js';
import { fail, FakeAiServer, ok } from './fake-ai.js';
import { authHeaders, startTestServer, type StartOptions, type TestServer } from './helpers.js';

const KEYS: Record<Exclude<AiProvider, 'new-api'>, string> = {
  anthropic: 'sk-ant-fake-key-0123456789',
  openai: 'sk-proj-fake-key-0123456789',
  gemini: 'AIzaFakeKey0123456789abcdef',
};

const servers: TestServer[] = [];
const fakes: FakeAiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function start(
  extra: StartOptions['ai'] = {},
): Promise<{ s: TestServer; fake: FakeAiServer }> {
  const fake = new FakeAiServer();
  await fake.start();
  fakes.push(fake);
  const s = await startTestServer({
    ai: { baseUrls: fake.baseUrls(), retryBaseMs: 10, pollMs: 10, timeoutMs: 2000, ...extra },
  });
  servers.push(s);
  return { s, fake };
}

/** Key + consent: the provider is ready to send. */
async function ready(s: TestServer, provider: keyof typeof KEYS): Promise<void> {
  await s.client.ai.setKey(provider, KEYS[provider]);
  await s.client.ai.consent(provider, AI_NOTICE_VERSION);
}

function job(provider: AiProvider, extra: Partial<CreateAiJobRequest> = {}): CreateAiJobRequest {
  return {
    provider,
    action: 'suggest_title',
    input: { system: '你是編輯', prompt: '幫這篇京都遊記想一個標題', max_output_tokens: 256 },
    ...extra,
  };
}

async function finished(s: TestServer, id: string): Promise<AiJobRecord> {
  await s.ai.drain();
  return s.client.ai.job(id);
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('New API gateway', () => {
  const baseUrl = 'https://relay.example.test/v1';
  const apiKey = 'relay_dummy_key_123';
  const jobRequest = job('new-api', {
    input: {
      system: '你是編輯',
      prompt: '幫這篇遊記想一個標題',
      max_output_tokens: 256,
      json_schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    },
  });

  it('validates the endpoint, keeps credentials private, and submits structured chat completions', async () => {
    const { s, fake } = await start();
    const ai = s.client.ai;
    const invalid = [
      undefined,
      'http://relay.example.test/v1',
      'https://user:password@relay.example.test/v1',
      'https://relay.example.test/v1?key=not-a-real-key',
      'https://relay.example.test/v1#fragment',
      'https://relay.example.test/v1/v1/',
      'https://relay.example.test/v1/chat/completions',
    ];
    for (const url of invalid) {
      expect((await apiError(ai.setKey('new-api', apiKey, url))).status).toBe(400);
    }
    expect((await apiError(ai.setKey('openai', apiKey, baseUrl))).status).toBe(400);
    await ready(s, 'openai');
    const configured = await ai.setKey('new-api', apiKey, baseUrl + '/');
    expect(configured).toMatchObject({
      ready: false,
      key_configured: true,
      consent: null,
      text_model: 'gpt-4o-mini',
    });
    const providers = await ai.providers();
    expect(JSON.stringify(providers)).not.toContain(apiKey);
    expect(JSON.stringify(providers)).not.toContain(baseUrl);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM ai_providers').all())).not.toContain(baseUrl);
    expect((await apiError(ai.submit(jobRequest))).code).toBe('ai_consent_required');
    expect((await apiError(ai.consent('new-api', configured.notice.version))).status).toBe(409);
    const enabled = await ai.consent(
      'new-api',
      configured.notice.version,
      configured.notice.credential_id,
    );
    expect(enabled.ready).toBe(true);
    expect(providers.items.find((p) => p.provider === 'openai')?.ready).toBe(true);

    const result = { title: '秋天的京都' };
    fake.script('new-api', ok('new-api', JSON.stringify(result), 'gpt-4o-mini'));
    const { job: submitted } = await ai.submit(jobRequest);
    expect(await finished(s, submitted.id)).toMatchObject({
      status: 'succeeded',
      result: { json: result },
      usage: { input_tokens: 1200, output_tokens: 300 },
      cost_usd: null,
    });
    expect(fake.for('new-api')).toHaveLength(1);
    expect(fake.for('openai')).toHaveLength(0);
    expect(fake.for('new-api')[0]).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: 'gpt-4o-mini',
        max_completion_tokens: 256,
        messages: [
          { role: 'system', content: jobRequest.input.system },
          { role: 'user', content: jobRequest.input.prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { strict: true, schema: jobRequest.input.json_schema },
        },
      },
    });
  });

  it('requires fresh consent and an explicit retry before sending a queued job to a replacement URL', async () => {
    const { s, fake } = await start({ start: false });
    const ai = s.client.ai;
    const a = await ai.setKey('new-api', apiKey, baseUrl);
    await ai.consent('new-api', a.notice.version, a.notice.credential_id);
    const { job: queued } = await ai.submit(job('new-api'));
    const replacementKey = 'relay_dummy_key_456';
    const b = await ai.setKey('new-api', replacementKey, 'https://next.example.test/v1');
    expect(b).toMatchObject({ ready: false, consent: null });
    expect(
      (await apiError(ai.consent('new-api', a.notice.version, a.notice.credential_id))).status,
    ).toBe(409);
    await ai.consent('new-api', b.notice.version, b.notice.credential_id);

    s.ai.start();
    expect(await finished(s, queued.id)).toMatchObject({
      status: 'failed',
      error_code: 'consent_required',
    });
    expect(fake.for('new-api')).toHaveLength(0);
    await ai.retry(queued.id);
    expect(await finished(s, queued.id)).toMatchObject({ status: 'succeeded' });
    expect(fake.for('new-api')[0]?.headers.authorization).toBe(`Bearer ${replacementKey}`);
  });

  it('does not retain upstream error text', async () => {
    const { s, fake } = await start();
    const ai = s.client.ai;
    const configured = await ai.setKey('new-api', apiKey, baseUrl);
    await ai.consent('new-api', configured.notice.version, configured.notice.credential_id);
    fake.script('new-api', fail('new-api', 400, `${baseUrl} ${apiKey} ${jobRequest.input.prompt}`));
    const { job: submitted } = await ai.submit(jobRequest);
    const failure = await finished(s, submitted.id);
    expect(failure).toMatchObject({ status: 'failed', error_code: 'bad_request' });
    expect(failure.error).not.toContain(baseUrl);
    expect(failure.error).not.toContain(apiKey);
    expect(failure.error).not.toContain(jobRequest.input.prompt);
  });
});

describe('access, keys and consent', () => {
  it('every AI route is owner-only, even for reads', async () => {
    const { s } = await start();
    const agent = s.tokens.create({ name: 'all', scopes: ['read', 'import', 'write'] });
    const h = { authorization: `Bearer ${agent.secret}`, 'content-type': 'application/json' };
    const base = `${s.baseUrl}/api/v1/ai`;
    const calls: [string, string, unknown?][] = [
      ['GET', '/providers'],
      ['GET', '/settings'],
      ['GET', '/jobs'],
      ['GET', '/usage'],
      ['PUT', '/providers/openai/key', { api_key: 'sk-whatever-123' }],
      ['POST', '/providers/openai/consent', { notice_version: 1 }],
      ['POST', '/estimate', job('openai')],
      ['POST', '/jobs', job('openai')],
    ];
    for (const [method, path, body] of calls) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: h,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('stores keys write-only: no response ever contains the key', async () => {
    const { s } = await start();
    const bodies: string[] = [];
    const record = async (res: Response): Promise<void> => {
      bodies.push(await res.text());
    };
    const put = (provider: string, key: string) =>
      fetch(`${s.baseUrl}/api/v1/ai/providers/${provider}/key`, {
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ api_key: key }),
      });
    const res = await put('openai', KEYS.openai);
    expect(res.status).toBe(200);
    await record(res);
    await record(await fetch(`${s.baseUrl}/api/v1/ai/providers`, { headers: authHeaders() }));
    // Invalid keys are rejected without echoing the input.
    const bad = await put('openai', 'sk-has a space-secretvalue');
    expect(bad.status).toBe(400);
    await record(bad);
    const tooLong = await put('gemini', `AIza${'x'.repeat(600)}`);
    expect(tooLong.status).toBe(400);
    await record(tooLong);
    for (const b of bodies) {
      expect(b).not.toContain(KEYS.openai);
      expect(b).not.toContain('secretvalue');
      expect(b).not.toContain('x'.repeat(50));
    }
    const status = (await s.client.ai.providers()).items.find((p) => p.provider === 'openai');
    expect(status).toMatchObject({ key_configured: true, ready: false, consent: null });
    expect(status?.key_updated_at).not.toBeNull();
    const removed = await s.client.ai.deleteKey('openai');
    expect(removed.key_configured).toBe(false);
  });

  it('refuses to queue without a key or without the current notice confirmed', async () => {
    const { s, fake } = await start();
    expect((await apiError(s.client.ai.submit(job('gemini')))).code).toBe('ai_key_missing');
    await s.client.ai.setKey('gemini', KEYS.gemini);
    const noConsent = await apiError(s.client.ai.submit(job('gemini')));
    expect(noConsent.status).toBe(409);
    expect(noConsent.code).toBe('ai_consent_required');
    const stale = await apiError(s.client.ai.consent('gemini', AI_NOTICE_VERSION + 1));
    expect(stale.code).toBe('ai_consent_required');
    const status = (await s.client.ai.providers()).items.find((p) => p.provider === 'gemini');
    expect(status?.notice.text).toContain('Google');
    const confirmed = await s.client.ai.consent('gemini', AI_NOTICE_VERSION);
    expect(confirmed).toMatchObject({ ready: true, consent: { version: AI_NOTICE_VERSION } });
    expect((await s.client.ai.submit(job('gemini'))).job.status).toBe('queued');
    // Consent is per provider.
    await s.client.ai.setKey('openai', KEYS.openai);
    expect((await apiError(s.client.ai.submit(job('openai')))).code).toBe('ai_consent_required');
    await s.ai.drain();
    expect(fake.for('openai')).toHaveLength(0);
  });

  it('a queued job never sends once consent is withdrawn or the key is deleted', async () => {
    const { s, fake } = await start({ start: false });
    await ready(s, 'anthropic');
    const a = (await s.client.ai.submit(job('anthropic'))).job;
    await s.client.ai.withdrawConsent('anthropic');
    s.ai.start();
    expect(await finished(s, a.id)).toMatchObject({
      status: 'failed',
      error_code: 'consent_required',
    });

    await s.ai.stop();
    await s.client.ai.consent('anthropic', AI_NOTICE_VERSION);
    const b = (await s.client.ai.submit(job('anthropic'))).job;
    await s.client.ai.deleteKey('anthropic');
    s.ai.start();
    expect(await finished(s, b.id)).toMatchObject({ status: 'failed', error_code: 'missing_key' });
    expect(fake.seen).toHaveLength(0);
  });

  it('never uses the real Keychain under the test runner', async () => {
    const store = new KeychainSecretStore();
    await expect(store.set('openai', 'sk-never-stored-123')).rejects.toThrow(
      /must not be used in tests/,
    );
    await expect(store.get('openai')).rejects.toThrow(/must not be used in tests/);
    await expect(store.delete('openai')).rejects.toThrow(/must not be used in tests/);
  });
});

describe('provider adapters against local fake servers', () => {
  it('Claude: Messages API shape, key header, usage and estimated cost', async () => {
    const { s, fake } = await start();
    await ready(s, 'anthropic');
    fake.script('anthropic', ok('anthropic', '京都紅葉散步', 'claude-opus-5-5'));
    const { job: queued } = await s.client.ai.submit(job('anthropic'));
    expect(queued).toMatchObject({ model: 'claude-opus-5-5', status: 'queued' });
    const done = await finished(s, queued.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { text: '京都紅葉散步' },
      usage: { input_tokens: 1200, output_tokens: 300 },
      attempts: 1,
    });
    const price = AI_PRICE_TABLE['claude-opus-5-5'];
    if (price === undefined) throw new Error('price missing');
    expect(done.cost_usd).toBeCloseTo(costUsd(price, 1200, 300), 10);
    const [req] = fake.for('anthropic');
    expect(req?.path).toBe('/v1/messages');
    // @anthropic-ai/sdk 1.x sends the API key as a bearer token.
    expect(req?.headers['authorization']).toBe(`Bearer ${KEYS.anthropic}`);
    expect(req?.headers['anthropic-version']).toBeDefined();
    expect(req?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req?.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 256,
      system: '你是編輯',
      messages: [{ role: 'user', content: '幫這篇京都遊記想一個標題' }],
      fallbacks: 'default',
    });
  });

  it('GPT: Responses API shape, bearer key, store=false', async () => {
    const { s, fake } = await start();
    await ready(s, 'openai');
    fake.script('openai', ok('openai', '秋天的京都', 'gpt-5.5'));
    const { job: queued } = await s.client.ai.submit(job('openai'));
    const done = await finished(s, queued.id);
    expect(done).toMatchObject({ status: 'succeeded', result: { text: '秋天的京都' } });
    const [req] = fake.for('openai');
    expect(req?.path).toBe('/v1/responses');
    expect(req?.headers['authorization']).toBe(`Bearer ${KEYS.openai}`);
    expect(req?.body).toMatchObject({
      model: 'gpt-5.5',
      input: '幫這篇京都遊記想一個標題',
      instructions: '你是編輯',
      max_output_tokens: 256,
      store: false,
    });
  });

  it('Gemini: generateContent shape, x-goog-api-key, thinking tokens billed as output', async () => {
    const { s, fake } = await start();
    await ready(s, 'gemini');
    fake.script('gemini', ok('gemini', '紅葉季的京都', 'gemini-3.8-flash'));
    const { job: queued } = await s.client.ai.submit(job('gemini'));
    const done = await finished(s, queued.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { text: '紅葉季的京都' },
      usage: { input_tokens: 1200, output_tokens: 300 },
    });
    const [req] = fake.for('gemini');
    expect(req?.path).toBe('/v1/models/gemini-3.8-flash:generateContent');
    expect(req?.headers['x-goog-api-key']).toBe(KEYS.gemini);
    expect(req?.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: '幫這篇京都遊記想一個標題' }] }],
      systemInstruction: { parts: [{ text: '你是編輯' }] },
      generationConfig: { maxOutputTokens: 256 },
    });
  });

  it('structured output uses each provider’s native JSON mode and parses the result', async () => {
    const { s, fake } = await start();
    const schema = {
      type: 'object',
      properties: { titles: { type: 'array', items: { type: 'string' } } },
      required: ['titles'],
      additionalProperties: false,
    };
    const answer = JSON.stringify({ titles: ['甲', '乙'] });
    for (const p of ['anthropic', 'openai', 'gemini'] as const) {
      await ready(s, p);
      fake.script(p, ok(p, answer));
      const { job: queued } = await s.client.ai.submit(
        job(p, { input: { prompt: 'x', json_schema: schema, max_output_tokens: 128 } }),
      );
      expect((await finished(s, queued.id)).result).toEqual({
        text: answer,
        json: { titles: ['甲', '乙'] },
      });
    }
    expect(fake.for('anthropic')[0]?.body['output_config']).toEqual({
      format: { type: 'json_schema', schema },
    });
    expect(fake.for('openai')[0]?.body['text']).toEqual({
      format: { type: 'json_schema', name: 'result', schema, strict: true },
    });
    expect(fake.for('gemini')[0]?.body['generationConfig']).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    });

    fake.script('openai', ok('openai', '{"titles": ["cut off'));
    const { job: broken } = await s.client.ai.submit(
      job('openai', { input: { prompt: 'x', json_schema: schema, max_output_tokens: 128 } }),
    );
    const failed = await finished(s, broken.id);
    expect(failed).toMatchObject({ status: 'failed', error_code: 'invalid_output' });
    // The tokens were spent, so they still count.
    expect(failed.usage).not.toBeNull();
  });
});

describe('failures, retries and cancellation', () => {
  it('classifies failures; only rate limits, timeouts and outages are retried', async () => {
    const { s, fake } = await start({ timeoutMs: 300 });
    for (const p of ['anthropic', 'openai', 'gemini'] as const) await ready(s, p);

    fake.script('anthropic', fail('anthropic', 401));
    const invalid = await finished(s, (await s.client.ai.submit(job('anthropic'))).job.id);
    expect(invalid).toMatchObject({ status: 'failed', error_code: 'invalid_key', attempts: 1 });
    expect(invalid.error).toContain('金鑰');

    fake.script('openai', fail('openai', 429), ok('openai', '第二次成功'));
    const limited = await finished(s, (await s.client.ai.submit(job('openai'))).job.id);
    expect(limited).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      result: { text: '第二次成功' },
    });

    fake.script(
      'anthropic',
      fail('anthropic', 529),
      fail('anthropic', 529),
      fail('anthropic', 529),
    );
    const down = await finished(s, (await s.client.ai.submit(job('anthropic'))).job.id);
    expect(down).toMatchObject({
      status: 'failed',
      error_code: 'provider_unavailable',
      attempts: 3,
    });

    fake.script(
      'gemini',
      { delayMs: 2000, body: ok('gemini', 'late').body },
      ok('gemini', 'on time'),
    );
    const slow = await finished(s, (await s.client.ai.submit(job('gemini'))).job.id);
    expect(slow).toMatchObject({ status: 'succeeded', attempts: 2, result: { text: 'on time' } });

    fake.script('gemini', fail('gemini', 404, 'models/nope is not found'));
    const badModel = await finished(
      s,
      (await s.client.ai.submit(job('gemini', { model: 'nope' }))).job.id,
    );
    expect(badModel).toMatchObject({ status: 'failed', error_code: 'bad_request', attempts: 1 });
  });

  it('reports refusals and safety blocks as content_blocked, without retrying', async () => {
    const { s, fake } = await start();
    for (const p of ['anthropic', 'openai', 'gemini'] as const) await ready(s, p);
    const refusal = ok('anthropic', '');
    fake.script('anthropic', {
      body: {
        ...(refusal.body as object),
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      },
    });
    fake.script('openai', {
      body: {
        ...(ok('openai', '').body as object),
        output: [
          {
            type: 'message',
            id: 'm',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'I can’t help with that.' }],
          },
        ],
      },
    });
    fake.script('gemini', {
      body: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 10 } },
    });
    for (const p of ['anthropic', 'openai', 'gemini'] as const) {
      const r = await finished(s, (await s.client.ai.submit(job(p))).job.id);
      expect(r, p).toMatchObject({ status: 'failed', error_code: 'content_blocked', attempts: 1 });
    }
  });

  it('never stores the key in an error message, even if the provider echoes it', async () => {
    const { s, fake } = await start();
    await ready(s, 'anthropic');
    fake.script(
      'anthropic',
      fail('anthropic', 400, `bad header x-api-key: ${KEYS.anthropic} rejected`),
    );
    const r = await finished(s, (await s.client.ai.submit(job('anthropic'))).job.id);
    expect(r.error_code).toBe('bad_request');
    expect(r.error).not.toContain(KEYS.anthropic);
    expect(r.error).toContain('[REDACTED]');
    const listing = await fetch(`${s.baseUrl}/api/v1/ai/jobs`, { headers: authHeaders() });
    expect(await listing.text()).not.toContain(KEYS.anthropic);
  });

  it('cancels queued and running jobs, aborting the provider call; retry re-runs', async () => {
    const { s, fake } = await start({ start: false });
    await ready(s, 'openai');
    const queued = (await s.client.ai.submit(job('openai'))).job;
    expect((await s.client.ai.cancel(queued.id)).status).toBe('cancelled');

    fake.script('openai', { delayMs: 5000, body: ok('openai', 'too late').body });
    const running = (await s.client.ai.submit(job('openai'))).job;
    s.ai.start();
    for (let i = 0; i < 200 && fake.for('openai').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await s.client.ai.job(running.id)).status).toBe('running');
    const cancelled = await s.client.ai.cancel(running.id);
    expect(cancelled.status).toBe('cancelled');
    await s.ai.drain();
    for (let i = 0; i < 200 && fake.aborted.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.aborted).toHaveLength(1);
    expect((await s.client.ai.job(running.id)).status).toBe('cancelled');
    expect((await apiError(s.client.ai.cancel(running.id))).code).toBe('job_not_cancellable');

    fake.script('openai', ok('openai', 'retried'));
    const again = await s.client.ai.retry(running.id);
    expect(again.status).toBe('queued');
    expect(await finished(s, running.id)).toMatchObject({
      status: 'succeeded',
      result: { text: 'retried' },
    });
    expect((await apiError(s.client.ai.retry(running.id))).code).toBe('job_not_retryable');
  });

  it('re-queues jobs left running by a restart', async () => {
    const { s, fake } = await start({ start: false });
    await ready(s, 'gemini');
    const j = (await s.client.ai.submit(job('gemini'))).job;
    s.db.prepare("UPDATE ai_jobs SET status = 'running' WHERE id = ?").run(j.id);
    s.ai.start();
    expect((await finished(s, j.id)).status).toBe('succeeded');
    expect(fake.for('gemini')).toHaveLength(1);
  });

  it('Idempotency-Key returns the same job instead of queueing another', async () => {
    const { s } = await start({ start: false });
    await ready(s, 'gemini');
    const a = await s.client.ai.submit(job('gemini'), { idempotencyKey: 'title-key-1' });
    const res = await fetch(`${s.baseUrl}/api/v1/ai/jobs`, {
      method: 'POST',
      headers: authHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'title-key-1',
      }),
      body: JSON.stringify(job('gemini')),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('idempotent-replayed')).toBe('true');
    expect(((await res.json()) as { job: { id: string } }).job.id).toBe(a.job.id);
    expect((await s.client.ai.jobs()).total).toBe(1);
  });
});

describe('estimates, budget reminder and usage', () => {
  it('estimates before sending, warns over the monthly amount but never blocks', async () => {
    const { s, fake } = await start();
    await ready(s, 'anthropic');
    const est = await s.client.ai.estimate(job('anthropic'));
    expect(est.estimate).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      max_output_tokens: 256,
      estimated: true,
    });
    expect(est.estimate.input_tokens).toBeGreaterThan(20);
    expect(est.estimate.max_cost_usd).toBeGreaterThan(0);
    expect(est.budget).toMatchObject({ budget_usd: null, over_budget: false, warning: null });

    await s.client.ai.patchSettings({ monthly_budget_usd: 0.01 });
    fake.script(
      'anthropic',
      ok('anthropic', 'a', 'claude-opus-5-5'),
      ok('anthropic', 'b', 'claude-opus-5-5'),
    );
    const first = await s.client.ai.submit(job('anthropic'));
    expect(first.budget.over_budget).toBe(false);
    await s.ai.drain();
    // 1200 in / 300 out on Opus 5.5 ≈ $0.0108: the month is now over $0.01.
    const second = await s.client.ai.submit(job('anthropic'));
    expect(second.budget).toMatchObject({ over_budget: true, budget_usd: 0.01 });
    expect(second.budget.warning).toContain('仍會送出');
    expect(second.job.status).toBe('queued');
    expect((await finished(s, second.job.id)).status).toBe('succeeded');

    const usage = await s.client.ai.usage();
    expect(usage.by_provider).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        jobs: 2,
        input_tokens: 2400,
        output_tokens: 600,
      }),
    ]);
    expect(usage.budget.spent_usd).toBeCloseTo(2 * 0.0108, 10);
    expect((await s.client.ai.usage('2020-01')).by_provider).toEqual([]);
  });

  it('price overrides apply; unknown models have no price but still run', async () => {
    const { s, fake } = await start();
    await ready(s, 'openai');
    await s.client.ai.patchSettings({
      price_overrides: { 'my-model': { input_per_mtok: 1, output_per_mtok: 2 } },
    });
    expect(
      (await s.client.ai.estimate(job('openai', { model: 'my-model' }))).estimate.price,
    ).toEqual({
      input_per_mtok: 1,
      output_per_mtok: 2,
    });
    const unknown = await s.client.ai.estimate(job('openai', { model: 'mystery-1' }));
    expect(unknown.estimate).toMatchObject({ price: null, max_cost_usd: null });
    fake.script('openai', ok('openai', 'ok', 'mystery-1'));
    const r = await finished(
      s,
      (await s.client.ai.submit(job('openai', { model: 'mystery-1' }))).job.id,
    );
    expect(r).toMatchObject({ status: 'succeeded', cost_usd: null });
  });

  it('per-provider models are configurable; video model is Gemini only', async () => {
    const { s, fake } = await start();
    await ready(s, 'anthropic');
    const p = await s.client.ai.patchProvider('anthropic', { text_model: 'claude-sonnet-5-5' });
    expect(p.text_model).toBe('claude-sonnet-5-5');
    expect(
      (await apiError(s.client.ai.patchProvider('anthropic', { video_model: 'x' }))).status,
    ).toBe(400);
    expect(
      (await s.client.ai.patchProvider('gemini', { video_model: 'gemini-4-hydrogen' })).video_model,
    ).toBe('gemini-4-hydrogen');
    await finished(s, (await s.client.ai.submit(job('anthropic'))).job.id);
    expect(fake.for('anthropic')[0]?.body['model']).toBe('claude-sonnet-5-5');
  });

  it('publishes ai_job events with status and provider only', async () => {
    const { s } = await start();
    await ready(s, 'gemini');
    const j = (await s.client.ai.submit(job('gemini'))).job;
    await s.ai.drain();
    const events = s.feed.since(0).filter((e) => e.entity_id === j.id);
    expect(events.map((e) => e.action)).toEqual([
      'ai_job.queued',
      'ai_job.running',
      'ai_job.succeeded',
    ]);
    for (const e of events) expect(Object.keys(e.data).sort()).toEqual(['provider', 'status']);
  });
});
