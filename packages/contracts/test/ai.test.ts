import { describe, expect, it } from 'vitest';
import {
  AI_DEFAULT_MODELS,
  AI_PRICE_TABLE,
  AiFailureCodeSchema,
  AiProviderSchema,
  AiProviderStatusSchema,
  aiConsentNotice,
  aiNoticeTemplate,
  BackupFailureReasonSchema,
  ListBackupsResponseSchema,
  costUsd,
  CreateAiJobRequestSchema,
  estimateTokens,
  SetAiKeyRequestSchema,
  classifyModelKind,
  suggestNewApiBaseUrl,
  type AiModelKind,
} from '../src/index.js';

describe('AI contracts', () => {
  it('covers each supported provider, with video on Gemini only', () => {
    expect(AiProviderSchema.options).toEqual(['gemini', 'anthropic', 'openai', 'new-api']);
    expect(AI_DEFAULT_MODELS.gemini.video).not.toBeNull();
    expect(AI_DEFAULT_MODELS.anthropic.video).toBeNull();
    expect(AI_DEFAULT_MODELS.openai.video).toBeNull();
    expect(AI_DEFAULT_MODELS['new-api']).toEqual({ text: 'gpt-4o-mini', video: null });
    for (const p of ['gemini', 'anthropic', 'openai'] as const) {
      expect(AI_PRICE_TABLE[AI_DEFAULT_MODELS[p].text], p).toBeDefined();
    }
  });

  it('names the receiving company in each notice', () => {
    expect(aiConsentNotice('gemini')).toContain('Google');
    expect(aiConsentNotice('anthropic')).toContain('Anthropic');
    expect(aiConsentNotice('openai')).toContain('OpenAI');
    expect(aiConsentNotice('new-api')).toContain('中轉站');
  });

  it('estimates CJK at ~1 token per character and other text at ~4 characters per token', () => {
    expect(estimateTokens('京都秋天')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('京都 trip')).toBe(2 + 2);
    expect(estimateTokens('')).toBe(0);
  });

  it('prices per million tokens', () => {
    expect(costUsd({ input_per_mtok: 4, output_per_mtok: 20 }, 1_000_000, 500_000)).toBe(14);
  });

  it('validates keys and job input', () => {
    expect(SetAiKeyRequestSchema.safeParse({ api_key: 'short' }).success).toBe(false);
    expect(SetAiKeyRequestSchema.safeParse({ api_key: 'sk-has space-123' }).success).toBe(false);
    expect(SetAiKeyRequestSchema.safeParse({ api_key: 'sk-ok-1234567890' }).success).toBe(true);
    const job = CreateAiJobRequestSchema.parse({
      provider: 'gemini',
      action: 'rewrite',
      input: { prompt: 'x' },
    });
    expect(job.input.max_output_tokens).toBe(2048);
    expect(
      CreateAiJobRequestSchema.safeParse({
        provider: 'local',
        action: 'rewrite',
        input: { prompt: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('server text as codes (QC-043)', () => {
  const status = {
    provider: 'anthropic',
    name: 'Claude',
    company: 'Anthropic',
    key_configured: true,
    key_updated_at: null,
    text_model: 'claude-opus-5-5',
    video_model: null,
    notice: { version: 1, text: '…' },
    consent: null,
    ready: false,
  };

  it('names a notice template per provider; older services without one still parse', () => {
    expect(aiNoticeTemplate('gemini')).toEqual({
      template: 'cloud_provider',
      params: { name: 'Gemini', company: 'Google' },
    });
    expect(aiNoticeTemplate('new-api').template).toBe('relay');
    expect(AiProviderStatusSchema.parse(status).notice.template).toBeUndefined();
    const withTemplate = {
      ...status,
      notice: { ...status.notice, ...aiNoticeTemplate('anthropic') },
    };
    expect(AiProviderStatusSchema.parse(withTemplate).notice).toMatchObject({
      template: 'cloud_provider',
      params: { name: 'Claude', company: 'Anthropic' },
    });
    expect(() =>
      AiProviderStatusSchema.parse({ ...status, notice: { ...status.notice, template: 'other' } }),
    ).toThrow();
  });

  it('adds the credential_changed failure code and backup failure reasons', () => {
    expect(AiFailureCodeSchema.options).toContain('credential_changed');
    expect(BackupFailureReasonSchema.options).toEqual([
      'disk_full',
      'permission_denied',
      'integrity_failed',
      'io_error',
      'unknown',
    ]);
    const list = {
      backups: [],
      retention_per_kind: 14,
      directory: '/tmp/b',
      last_daily_at: null,
      next_daily_at: '2026-11-21T00:00:00.000Z',
      last_error: 'EACCES: permission denied',
    };
    expect(ListBackupsResponseSchema.parse(list).last_error_reason).toBeUndefined();
    expect(
      ListBackupsResponseSchema.parse({ ...list, last_error_reason: 'permission_denied' })
        .last_error_reason,
    ).toBe('permission_denied');
    expect(() =>
      ListBackupsResponseSchema.parse({ ...list, last_error_reason: 'cosmic_rays' }),
    ).toThrow();
  });
});

describe('New API model list helpers (QC-054)', () => {
  it('classifies model ids conservatively', () => {
    const cases: [string, AiModelKind][] = [
      ['gpt-4o-mini', 'chat'],
      ['gpt-5.5', 'chat'],
      ['o3-mini', 'chat'],
      ['claude-sonnet-5-5', 'chat'],
      ['gemini-3.8-flash', 'chat'],
      ['deepseek-chat', 'chat'],
      ['qwen-max', 'chat'],
      ['openai/gpt-4o', 'chat'],
      ['gpt-image-2', 'image'],
      ['dall-e-3', 'image'],
      ['flux-1.1-pro', 'image'],
      ['gemini-2.5-flash-image', 'image'],
      ['tts-1', 'unknown'],
      ['whisper-1', 'unknown'],
      ['gpt-4o-mini-tts', 'unknown'],
      ['text-embedding-3-small', 'unknown'],
      ['gpt-4o-realtime-preview', 'unknown'],
      ['omni-moderation-latest', 'unknown'],
      ['my-relay-special', 'unknown'],
      ['o1x', 'unknown'],
    ];
    for (const [id, kind] of cases) expect([id, classifyModelKind(id)]).toEqual([id, kind]);
  });

  it('suggests a Base URL only when /v1 is missing or followed by more', () => {
    expect(suggestNewApiBaseUrl('https://relay.example')).toBe('https://relay.example/v1');
    expect(suggestNewApiBaseUrl(' https://relay.example/ ')).toBe('https://relay.example/v1');
    expect(suggestNewApiBaseUrl('https://relay.example:8443/api')).toBe(
      'https://relay.example:8443/api/v1',
    );
    expect(suggestNewApiBaseUrl('https://relay.example/v1/chat/completions')).toBe(
      'https://relay.example/v1',
    );
    expect(suggestNewApiBaseUrl('https://relay.example/v1')).toBeNull();
    expect(suggestNewApiBaseUrl('https://relay.example/v1/')).toBeNull();
    expect(suggestNewApiBaseUrl('http://relay.example')).toBeNull();
    expect(suggestNewApiBaseUrl('https://user:pw@relay.example')).toBeNull();
    expect(suggestNewApiBaseUrl('https://relay.example?x=1')).toBeNull();
    expect(suggestNewApiBaseUrl('not a url')).toBeNull();
    // Every suggestion passes the strict schema it was made for.
    const parsed = SetAiKeyRequestSchema.parse({
      api_key: 'sk-relay-fake-0123',
      base_url: suggestNewApiBaseUrl('https://relay.example/api'),
    });
    expect(parsed.base_url).toBe('https://relay.example/api/v1');
  });
});
