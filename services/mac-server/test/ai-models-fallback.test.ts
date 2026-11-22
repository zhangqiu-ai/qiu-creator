import { AI_MODELS_CACHE_SECONDS, AI_NOTICE_VERSION } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAiServer } from './fake-ai.js';
import { startTestServer, type TestServer } from './helpers.js';

/**
 * QC-082: the toolbar's model menu keeps New API when its relay list cannot
 * be read. Fake relay only; temporary home; injectable clock.
 */

const KEY = 'sk-relay-fallback-0123456789';
const STORED_BASE = 'https://relay.invalid/v1';

const servers: TestServer[] = [];
const fakes: FakeAiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function start() {
  const fake = new FakeAiServer();
  await fake.start();
  fakes.push(fake);
  const clock = { now: new Date('2026-11-22T08:00:00Z') };
  const s = await startTestServer({
    ai: { baseUrls: fake.baseUrls(), timeoutMs: 2000, start: false, now: () => clock.now },
  });
  servers.push(s);
  const status = await s.client.ai.setKey('new-api', KEY, STORED_BASE);
  await s.client.ai.consent('new-api', AI_NOTICE_VERSION, status.notice.credential_id ?? '');
  return { s, fake, clock };
}

const later = (clock: { now: Date }): void => {
  clock.now = new Date(clock.now.getTime() + (AI_MODELS_CACHE_SECONDS + 1) * 1000);
};

describe('model menu fallback (QC-082)', () => {
  it('lists the relay’s models while it answers', async () => {
    const { s, fake } = await start();
    fake.modelsReply = { body: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-image-1' }] } };
    const chat = await s.client.ai.models('chat');
    expect(chat.errors).toEqual([]);
    expect(chat.items).toEqual([
      { provider: 'new-api', model: 'gpt-4o-mini', kind: 'chat', default: true, source: 'list' },
    ]);
    expect((await s.client.ai.models('image')).items).toEqual([
      { provider: 'new-api', model: 'gpt-image-1', kind: 'image', default: false, source: 'list' },
    ]);
  });

  it('falls back to the last list read when reading it again fails', async () => {
    const { s, fake, clock } = await start();
    fake.modelsReply = { body: { data: [{ id: 'gpt-4o-mini' }, { id: 'claude-x' }] } };
    await s.client.ai.models('chat');
    later(clock);
    fake.modelsReply = { status: 503, body: { error: { message: 'down' } } };
    const chat = await s.client.ai.models('chat');
    expect(chat.items.map((i) => [i.model, i.source])).toEqual([
      ['claude-x', 'cache'],
      ['gpt-4o-mini', 'cache'],
    ]);
    expect(chat.errors).toEqual([
      {
        provider: 'new-api',
        code: 'ai_gateway_unreachable',
        reason: 'unavailable',
        fallback: 'cache',
        cached_at: '2026-11-22T08:00:00.000Z',
      },
    ]);
  });

  it('falls back to the stored models when there is no list at all', async () => {
    const { s, fake } = await start();
    await s.client.ai.patchProvider('new-api', { text_model: 'my-relay-chat' });
    await s.client.ai.patchPreferences({
      last_models: {
        image: { provider: 'new-api', model: 'gpt-image-1' },
        rewrite: { provider: 'new-api', model: 'deepseek-chat' },
        suggestions: { provider: 'openai', model: 'gpt-5.5' },
      },
    });
    fake.modelsReply = { status: 401, body: { error: { message: 'bad key' } } };
    const chat = await s.client.ai.models('chat');
    expect(chat.items).toEqual([
      {
        provider: 'new-api',
        model: 'my-relay-chat',
        kind: 'unknown',
        default: true,
        source: 'configured',
      },
      {
        provider: 'new-api',
        model: 'deepseek-chat',
        kind: 'chat',
        default: false,
        source: 'configured',
      },
    ]);
    expect(chat.errors).toEqual([
      {
        provider: 'new-api',
        code: 'ai_key_invalid',
        reason: null,
        fallback: 'configured',
        cached_at: null,
      },
    ]);
    const image = await s.client.ai.models('image');
    expect(image.items.map((i) => [i.model, i.source])).toEqual([['gpt-image-1', 'configured']]);
    expect(image.errors[0]?.fallback).toBe('configured');
  });

  it('says when there is nothing to fall back on', async () => {
    const { s, fake } = await start();
    fake.modelsReply = null; // the relay has no model list (404)
    const image = await s.client.ai.models('image');
    expect(image.items).toEqual([]);
    expect(image.errors).toEqual([
      expect.objectContaining({ provider: 'new-api', fallback: 'none', cached_at: null }),
    ]);
  });
});
