import { describe, expect, it } from 'vitest';
import {
  AI_DEFAULT_MODELS,
  AI_PRICE_TABLE,
  AiProviderSchema,
  aiConsentNotice,
  costUsd,
  CreateAiJobRequestSchema,
  estimateTokens,
  SetAiKeyRequestSchema,
} from '../src/index.js';

describe('AI contracts', () => {
  it('covers the three providers decided on 2026-11-17, video on Gemini only', () => {
    expect(AiProviderSchema.options).toEqual(['gemini', 'anthropic', 'openai']);
    expect(AI_DEFAULT_MODELS.gemini.video).not.toBeNull();
    expect(AI_DEFAULT_MODELS.anthropic.video).toBeNull();
    expect(AI_DEFAULT_MODELS.openai.video).toBeNull();
    for (const p of AiProviderSchema.options) {
      expect(AI_PRICE_TABLE[AI_DEFAULT_MODELS[p].text], p).toBeDefined();
    }
  });

  it('names the receiving company in each notice', () => {
    expect(aiConsentNotice('gemini')).toContain('Google');
    expect(aiConsentNotice('anthropic')).toContain('Anthropic');
    expect(aiConsentNotice('openai')).toContain('OpenAI');
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
