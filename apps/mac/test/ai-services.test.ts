import type { AiProviderStatus, AiProviderTestResponse } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAiServer } from '../../../services/mac-server/test/fake-ai.js';
import { startTestServer, type TestServer } from '../../../services/mac-server/test/helpers.js';
import { aiNavTone, destination } from '../src/renderer/AiServicesPage.js';
import { AiSettingsStore, providerState, stateTone } from '../src/renderer/ai-settings.js';
import { techLine, testView } from '../src/renderer/ai-test-view.js';
import { setLocale } from '../src/renderer/i18n.js';

/** QC-057 設定 v4 → AI 服務: provider states, the 測試連線 card, and the store against a real service. */

type P = Pick<
  AiProviderStatus,
  'provider' | 'key_configured' | 'consent' | 'last_test' | 'text_model'
>;
const base: P = {
  provider: 'openai',
  key_configured: true,
  consent: { version: 1, at: '2026-11-21T10:00:00.000Z' },
  last_test: null,
  text_model: 'gpt-5.5',
};
const result = (over: Partial<AiProviderTestResponse>): AiProviderTestResponse => ({
  provider: 'openai',
  ok: true,
  latency_ms: 120,
  model_count: 42,
  text_model_listed: true,
  error: null,
  tested_at: '2026-11-21T10:05:00.000Z',
  ...over,
});
const failed = (
  code: 'ai_key_invalid' | 'ai_gateway_unreachable' | 'ai_gateway_bad_response',
  details: Record<string, unknown>,
) =>
  result({
    ok: false,
    model_count: null,
    text_model_listed: null,
    error: { code, message: 'server text', details },
  });

describe('provider state (QC-057)', () => {
  it('orders no key, a running test, a failure, the notice, then passed or untested', () => {
    expect(providerState({ ...base, key_configured: false }, undefined)).toBe('none');
    expect(providerState(base, { status: 'running', seq: 1 })).toBe('running');
    expect(providerState(base, undefined)).toBe('untested');
    expect(providerState(base, { status: 'done', result: result({}) })).toBe('ok');
    // A key that works but whose notice is unconfirmed still needs that confirmation.
    expect(providerState({ ...base, consent: null }, { status: 'done', result: result({}) })).toBe(
      'consent',
    );
    // A broken key is the bigger problem, even before the notice.
    const bad = { status: 'done' as const, result: failed('ai_key_invalid', { status: 401 }) };
    expect(providerState({ ...base, consent: null }, bad)).toBe('bad_key');
    const quota = failed('ai_gateway_unreachable', { reason: 'quota', status: 402 });
    expect(providerState(base, { status: 'done', result: quota })).toBe('quota');
    const limited = failed('ai_gateway_unreachable', { reason: 'rate_limited', status: 429 });
    expect(providerState(base, { status: 'done', result: limited })).toBe('rate_limited');
    const dns = failed('ai_gateway_unreachable', { reason: 'dns' });
    expect(providerState(base, { status: 'done', result: dns })).toBe('unreachable');
  });

  it('reads the service’s last_test when this window has not tested', () => {
    const last = {
      status: 'failed' as const,
      at: '2026-11-21T09:00:00.000Z',
      latency_ms: 900,
      model_count: null,
      error_code: 'ai_gateway_unreachable' as const,
      reason: 'quota',
    };
    expect(providerState({ ...base, last_test: last }, undefined)).toBe('quota');
    expect(
      providerState(
        {
          ...base,
          last_test: { ...last, status: 'ok', error_code: null, reason: null, model_count: 3 },
        },
        undefined,
      ),
    ).toBe('ok');
  });

  it('colours the AI 服務 category: red for a broken provider, yellow for one needing attention', () => {
    const ok: AiProviderStatus[] = [];
    expect(aiNavTone({ providers: ok, tests: {} })).toBeNull();
    const p = { ...base, name: 'GPT', company: 'OpenAI' } as AiProviderStatus;
    expect(aiNavTone({ providers: [{ ...p, consent: null }], tests: {} })).toBe('warn');
    expect(
      aiNavTone({
        providers: [{ ...p, consent: null }],
        tests: { openai: { status: 'done', result: failed('ai_key_invalid', { status: 403 }) } },
      }),
    ).toBe('bad');
    expect(stateTone('running')).toBe('run');
  });
});

describe('測試連線 card (QC-057)', () => {
  it('shows each state with its next step and never the key', () => {
    setLocale('zh-Hant');
    expect(testView({ ...base, key_configured: false }, undefined, 'OpenAI').title).toBe(
      '先存入金鑰',
    );
    expect(testView(base, undefined, 'OpenAI').title).toBe('尚未測試');
    expect(testView(base, { status: 'running', seq: 1 }, 'OpenAI').title).toBe('正在連線 OpenAI');

    const ok = testView(base, { status: 'done', result: result({}) }, 'OpenAI');
    expect(ok).toMatchObject({ tone: 'ok', metrics: { latencyMs: 120, models: 42 } });
    expect(ok.desc).toContain('額度是否足夠');
    const notListed = testView(
      base,
      { status: 'done', result: result({ text_model_listed: false }) },
      'OpenAI',
    );
    expect(notListed.notListed).toContain('gpt-5.5');

    const badKey = testView(
      base,
      { status: 'done', result: failed('ai_key_invalid', { status: 401 }) },
      'OpenAI',
    );
    expect(badKey).toMatchObject({ tone: 'bad', actions: ['replace_key'] });
    expect(badKey.tech).toBe('ai_key_invalid · HTTP 401');

    const relayDown = testView(
      { ...base, provider: 'new-api' },
      {
        status: 'done',
        result: failed('ai_gateway_unreachable', { reason: 'connection', detail: 'ECONNREFUSED' }),
      },
      '你的中轉站',
    );
    expect(relayDown.actions).toEqual(['retry', 'check_url']);
    expect(relayDown.desc).toContain('連線被拒絕');
    expect(relayDown.tech).toBe('ai_gateway_unreachable · reason=connection · detail=ECONNREFUSED');

    const quota = testView(
      base,
      {
        status: 'done',
        result: failed('ai_gateway_unreachable', { reason: 'quota', status: 402 }),
      },
      'OpenAI',
    );
    expect(quota).toMatchObject({ tone: 'warn', title: '額度不足', actions: ['retry'] });

    expect(testView(base, { status: 'error', message: '服務沒有回應' }, 'OpenAI').title).toContain(
      '服務沒有回應',
    );
  });

  it('builds the technical line from code, status, reason and the rest', () => {
    expect(techLine('ai_gateway_bad_response', { reason: 'not_json' }, null)).toBe(
      'ai_gateway_bad_response · reason=not_json',
    );
    expect(techLine('ai_gateway_unreachable', null, 'timeout')).toBe(
      'ai_gateway_unreachable · reason=timeout',
    );
  });

  it('says where content goes; New API names its relay host', () => {
    const p = {
      ...base,
      name: 'New API',
      company: 'relay',
      provider: 'new-api',
    } as AiProviderStatus;
    expect(destination({ ...p, base_url_host: 'relay.example.test' })).toBe(
      '你的中轉站 relay.example.test',
    );
    expect(destination({ ...p, base_url_host: null })).toBe('你的中轉站');
  });
});

// ---- Against a real mac-server; every provider is the local fake AI server ----

const servers: TestServer[] = [];
const fakes: FakeAiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function start(): Promise<{ s: TestServer; upstream: FakeAiServer }> {
  const upstream = new FakeAiServer();
  await upstream.start();
  fakes.push(upstream);
  const s = await startTestServer({
    ai: { baseUrls: upstream.baseUrls(), timeoutMs: 2000, start: false },
  });
  servers.push(s);
  return { s, upstream };
}

describe('AiSettingsStore: 測試連線 and 用途 (QC-057)', () => {
  it('tests only when asked, keeps the result as last_test, and a new key starts untested', async () => {
    const { s, upstream } = await start();
    await s.client.ai.setKey('openai', 'sk-fake-qc057-store');
    const store = new AiSettingsStore(s.client);
    await store.load();
    expect(upstream.modelRequests).toBe(0);

    upstream.modelsReply = {
      body: { object: 'list', data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }] },
    };
    await store.test('openai');
    const t1 = store.snapshot.tests.openai;
    expect(t1?.status === 'done' && t1.result.ok).toBe(true);
    expect(upstream.modelRequests).toBe(1);
    const openai = store.snapshot.providers?.find((p) => p.provider === 'openai');
    expect(openai?.last_test).toMatchObject({ status: 'ok', model_count: 2 });

    // A second store (after a restart) still knows the last result.
    const again = new AiSettingsStore(s.client);
    await again.load();
    const p = again.snapshot.providers?.find((x) => x.provider === 'openai');
    if (p === undefined) throw new Error('no openai');
    expect(providerState(p, undefined)).toBe('consent');

    expect(await store.saveKey('openai', 'sk-fake-qc057-other')).toBe(true);
    expect(store.snapshot.tests.openai).toBeUndefined();
    const fresh = store.snapshot.providers?.find((x) => x.provider === 'openai');
    expect(fresh?.last_test ?? null).toBeNull();
  });

  it('取消 drops a running test’s answer', async () => {
    const { s, upstream } = await start();
    await s.client.ai.setKey('openai', 'sk-fake-qc057-cancel');
    const store = new AiSettingsStore(s.client);
    await store.load();
    upstream.modelsReply = { body: { object: 'list', data: [{ id: 'gpt-5.5' }] }, delayMs: 200 };
    const running = store.test('openai');
    expect(store.snapshot.tests.openai?.status).toBe('running');
    store.cancelTest('openai');
    await running;
    expect(store.snapshot.tests.openai).toBeUndefined();
  });

  it('a missing key is a request error, not a provider verdict', async () => {
    const { s } = await start();
    const store = new AiSettingsStore(s.client);
    await store.load();
    await store.test('anthropic');
    expect(store.snapshot.tests.anthropic?.status).toBe('error');
  });

  it('saves the default provider of a task', async () => {
    const { s } = await start();
    const store = new AiSettingsStore(s.client);
    await store.load();
    expect(store.snapshot.defaults).toEqual({ rewrite: null, title: null, video: null });
    expect(await store.setDefault('rewrite', 'anthropic')).toBe(true);
    expect(await store.setDefault('title', 'new-api')).toBe(true);
    expect(await s.client.ai.defaults()).toEqual({
      rewrite: 'anthropic',
      title: 'new-api',
      video: null,
    });
    expect(await store.setDefault('rewrite', null)).toBe(true);
    expect((await s.client.ai.defaults()).rewrite).toBeNull();
  });
});
