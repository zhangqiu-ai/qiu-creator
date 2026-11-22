import { afterEach, describe, expect, it } from 'vitest';
import { fallbackDetail } from '../src/renderer/AiChoices.js';
import { setLocale } from '../src/renderer/i18n.js';

/** QC-082: what the model menu says when a provider's list failed. */
describe('fallbackDetail', () => {
  afterEach(() => {
    setLocale('zh-Hant');
  });
  const now = new Date('2026-11-22T10:00:00Z');

  it('names a known reason and, for a cached list, when it was read', () => {
    setLocale('zh-Hant');
    expect(
      fallbackDetail({ reason: 'unavailable', fallback: 'configured', cached_at: null }, now),
    ).toBe('服務暫時無法使用');
    const cached = fallbackDetail(
      { reason: 'timeout', fallback: 'cache', cached_at: '2026-11-22T09:57:00Z' },
      now,
    );
    expect(cached.startsWith('逾時 · 清單快取於 ')).toBe(true);
  });

  it('shows an unknown reason as sent, and nothing when there is nothing to say', () => {
    setLocale('en');
    expect(fallbackDetail({ reason: 'tls', fallback: 'configured', cached_at: null }, now)).toBe(
      'tls',
    );
    expect(fallbackDetail({ reason: null, fallback: 'configured', cached_at: null }, now)).toBe('');
    expect(fallbackDetail({ reason: 'quota', fallback: 'configured', cached_at: null }, now)).toBe(
      'out of quota',
    );
  });
});
