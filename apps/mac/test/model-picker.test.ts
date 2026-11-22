import { ApiError } from '@qiu-creator/api-client';
import { suggestNewApiBaseUrl, type AiRelayModel } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import { setLocale } from '../src/renderer/i18n.js';
import { describeModelListError, findModel, visibleModels } from '../src/renderer/model-list.js';

/** QC-054: the New API model picker's list rules and error wording. */

const MODELS: AiRelayModel[] = [
  { id: 'claude-sonnet-5-5', kind: 'chat', priced: false },
  { id: 'gpt-4o-mini', kind: 'chat', priced: true },
  { id: 'gpt-image-2', kind: 'image', priced: false },
  { id: 'my-custom-alias', kind: 'unknown', priced: false },
  { id: 'text-embedding-3', kind: 'unknown', priced: false },
];

function apiError(status: number, code: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(
    status,
    {
      error: { code, message: 'server text', ...(details === undefined ? {} : { details }) },
    } as never,
    'server text',
  );
}

describe('model list (QC-054)', () => {
  it('lists chat models by default, everything with 顯示全部, and filters by what was typed', () => {
    expect(
      visibleModels(MODELS, { query: '', showAll: false, current: '' }).map((m) => m.id),
    ).toEqual(['claude-sonnet-5-5', 'gpt-4o-mini']);
    expect(visibleModels(MODELS, { query: '', showAll: true, current: '' })).toHaveLength(5);
    expect(
      visibleModels(MODELS, { query: 'GPT', showAll: true, current: '' }).map((m) => m.id),
    ).toEqual(['gpt-4o-mini', 'gpt-image-2']);
  });

  it('always keeps the model in use, even a custom name that is not classed as chat', () => {
    expect(
      visibleModels(MODELS, { query: '', showAll: false, current: 'my-custom-alias' }).map(
        (m) => m.id,
      ),
    ).toEqual(['claude-sonnet-5-5', 'gpt-4o-mini', 'my-custom-alias']);
  });

  it('knows whether a typed model is in the list (trimmed) and whether it has a price', () => {
    expect(findModel(MODELS, ' gpt-4o-mini ')?.priced).toBe(true);
    expect(findModel(MODELS, 'claude-sonnet-5-5')?.priced).toBe(false);
    expect(findModel(MODELS, 'gone-model')).toBeNull();
  });
});

describe('model list errors (QC-054)', () => {
  it('explains each relay failure in the interface language, with the details as technical text', () => {
    setLocale('zh-Hant');
    expect(describeModelListError(apiError(409, 'ai_key_missing')).message).toContain(
      '先設定 New API',
    );
    const invalid = describeModelListError(apiError(502, 'ai_key_invalid', { status: 401 }));
    expect(invalid.message).toContain('HTTP 401');
    expect(invalid.technical).toBe('ai_key_invalid · status=401');
    expect(
      describeModelListError(apiError(502, 'ai_gateway_unreachable', { reason: 'dns' })).message,
    ).toContain('找不到這個網域');
    const down = describeModelListError(
      apiError(502, 'ai_gateway_unreachable', {
        reason: 'connection',
        detail: 'ECONNREFUSED',
      }),
    );
    expect(down.message).toContain('連線被拒絕');
    expect(down.technical).toContain('detail=ECONNREFUSED');
    expect(
      describeModelListError(
        apiError(502, 'ai_gateway_bad_response', { reason: 'unexpected_status', status: 404 }),
      ).message,
    ).toContain('HTTP 404');
    expect(
      describeModelListError(
        apiError(502, 'ai_gateway_unreachable', { reason: 'quota', status: 402 }),
      ).message,
    ).toContain('額度不足');
    // An unknown reason falls back to the error code's own text, never the server's English.
    const odd = describeModelListError(apiError(502, 'ai_gateway_bad_response', { reason: 'new' }));
    expect(odd.message).not.toContain('server text');
  });

  it('a request that never reached the service says the service is down', () => {
    setLocale('en');
    expect(describeModelListError(new TypeError('fetch failed')).technical).toBeNull();
    setLocale('zh-Hant');
  });
});

describe('Base URL suggestion used before saving (QC-054)', () => {
  it('offers /v1 for a bare host or a pasted endpoint, and nothing for a non-HTTPS URL', () => {
    expect(suggestNewApiBaseUrl('https://relay.example')).toBe('https://relay.example/v1');
    expect(suggestNewApiBaseUrl('https://relay.example/v1/chat/completions')).toBe(
      'https://relay.example/v1',
    );
    expect(suggestNewApiBaseUrl('https://relay.example/v1')).toBeNull();
    expect(suggestNewApiBaseUrl('http://relay.example')).toBeNull();
  });
});
