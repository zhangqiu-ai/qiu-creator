import {
  aiConsentNotice,
  type AiBudgetStatus,
  type AiProviderStatus,
} from '@qiu-creator/contracts';
import { catalog, placeholders, type Locale } from '@qiu-creator/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/renderer/i18n.js';
import {
  backupReasonText,
  budgetWarningText,
  companyText,
  noticeText,
  redactSecrets,
} from '../src/renderer/server-text.js';
import { TechnicalDetails } from '../src/renderer/TechnicalDetails.js';

/** QC-043: text the service used to send in 繁體 is built here in the interface language. */

const LOCALES: Locale[] = ['zh-Hant', 'zh-Hans', 'en'];
afterEach(() => {
  setLocale('zh-Hant');
});

function notice(
  provider: AiProviderStatus['provider'],
  extra: Partial<AiProviderStatus['notice']> = {},
): AiProviderStatus['notice'] {
  const relay = provider === 'new-api';
  return {
    version: 1,
    text: aiConsentNotice(provider),
    template: relay ? 'relay' : 'cloud_provider',
    params: relay
      ? { name: 'New API', company: '你設定的 New API 中轉站' }
      : { name: 'Claude', company: 'Anthropic' },
    ...extra,
  };
}

const BUDGET: AiBudgetStatus = {
  month: '2026-11',
  spent_usd: 12.5,
  budget_usd: 10,
  projected_usd: 13.25,
  over_budget: true,
  warning: '本月 AI 費用估算 13.25 美元，已超過你設定的提醒金額 10.00 美元。任務仍會送出。',
};

describe('first-use notice', () => {
  it('in 繁體 is exactly the text the service records consent for', () => {
    expect(noticeText(notice('anthropic'))).toBe(aiConsentNotice('anthropic'));
    expect(noticeText(notice('new-api'))).toBe(aiConsentNotice('new-api'));
  });

  it('follows the interface language with the same parts in every language', () => {
    const texts = LOCALES.map((l) => {
      setLocale(l);
      return noticeText(notice('anthropic'));
    });
    expect(new Set(texts).size).toBe(3);
    expect(texts[1]).toContain('Anthropic');
    expect(texts[1]).toContain('服务器');
    expect(texts[2]).toMatch(/^When you use Claude, .* Anthropic’s servers/);
    // Equivalent wording: the same paragraphs and placeholders in every language.
    for (const key of ['noticeCloudProvider', 'noticeRelay'] as const) {
      const per = LOCALES.map((l) => catalog.ai[l][key]);
      expect(new Set(per.map((m) => placeholders(m).join()))).toHaveProperty('size', 1);
      expect(
        new Set(per.map((m) => (typeof m === 'string' ? m : m.other).split('\n').length)),
      ).toHaveProperty('size', 1);
    }
  });

  it('falls back to the service text from an older service', () => {
    setLocale('en');
    const old = notice('gemini', { template: undefined, params: undefined });
    expect(noticeText(old)).toBe(aiConsentNotice('gemini'));
  });

  it('names the New API relay in the interface language', () => {
    const relay = { provider: 'new-api', company: '你設定的 New API 中轉站' } as AiProviderStatus;
    const claude = { provider: 'anthropic', company: 'Anthropic' } as AiProviderStatus;
    setLocale('en');
    expect(companyText(relay)).toBe('your New API relay');
    expect(companyText(claude)).toBe('Anthropic');
    setLocale('zh-Hans');
    expect(companyText(relay)).toBe('你设置的 New API 中转站');
  });
});

describe('budget reminder', () => {
  it('is built from the numbers in each language, and absent under budget', () => {
    setLocale('zh-Hant');
    expect(budgetWarningText(BUDGET)).toBe(BUDGET.warning);
    setLocale('zh-Hans');
    expect(budgetWarningText(BUDGET)).toBe(
      '本月 AI 费用估算 13.25 美元，已超过你设置的提醒金额 10.00 美元。任务仍会发送。',
    );
    setLocale('en');
    expect(budgetWarningText(BUDGET)).toBe(
      'Estimated AI spend this month is $13.25, over the $10.00 reminder you set. Jobs are still sent.',
    );
    expect(budgetWarningText({ ...BUDGET, projected_usd: null })).toContain('$12.50');
    expect(budgetWarningText({ ...BUDGET, over_budget: false, warning: null })).toBeNull();
  });
});

describe('backup failure reasons', () => {
  it('reads every reason in each language and treats unknown ones as unknown', () => {
    setLocale('en');
    expect(backupReasonText('disk_full')).toBe('The disk is full.');
    expect(backupReasonText('permission_denied')).toBe(
      'No permission to write to the backup folder.',
    );
    expect(backupReasonText('something_new')).toBe('An unknown error occurred.');
    expect(backupReasonText(null)).toBe('An unknown error occurred.');
    setLocale('zh-Hans');
    expect(backupReasonText('disk_full')).toBe('磁盘空间不足。');
  });
});

describe('technical details', () => {
  it('collapses by default, uses the interface language and removes keys', () => {
    for (const [locale, label] of [
      ['zh-Hant', '技術細節'],
      ['zh-Hans', '技术细节'],
      ['en', 'Technical details'],
    ] as const) {
      setLocale(locale);
      const html = renderToStaticMarkup(
        createElement(TechnicalDetails, {
          text: 'HTTP 401: invalid x-api-key: sk-ant-fake-key-0123456789 Bearer abc.def key=AIzaSyFakeFake',
        }),
      );
      expect(html).toMatch(/^<details class="tech-details">/);
      expect(html).not.toContain(' open');
      expect(html).toContain(`<summary>${label}</summary>`);
      expect(html).toContain('HTTP 401: invalid');
      expect(html).not.toMatch(/sk-ant|abc\.def|AIzaSy/);
    }
    expect(renderToStaticMarkup(createElement(TechnicalDetails, { text: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(TechnicalDetails, { text: '  ' }))).toBe('');
  });

  it('keeps ordinary technical text as it is', () => {
    expect(redactSecrets('ENOSPC: no space left on device, write')).toBe(
      'ENOSPC: no space left on device, write',
    );
    expect(redactSecrets('token=abc123 rest')).toBe('[REDACTED] rest');
  });
});
