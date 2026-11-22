import type { AiProviderStatus } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
import {
  lastVerdict,
  providerState,
  type ProviderState,
  type ProviderTest,
} from './ai-settings.js';
import { t } from './i18n.js';

/**
 * What the 測試連線 card shows (QC-057, PT-20261121-002 「AI 連線狀態全覽」):
 * the verdict, what it means, the next step, the numbers of a passed test,
 * and a technical line (code, HTTP status, reason) that never holds the key.
 * Pure, so every state is unit tested.
 */

export type TestAction = 'retry' | 'replace_key' | 'check_url';

export interface TestView {
  tone: 'none' | 'run' | 'ok' | 'bad' | 'warn';
  title: string;
  desc: string;
  actions: TestAction[];
  /** A passed test: latency, models, when. */
  metrics: { latencyMs: number; models: number | null; at: string } | null;
  /** When the configured text model is missing from a passed test's list. */
  notListed: string | null;
  /** The failure's code and details, for 技術詳情 (copyable). */
  tech: string | null;
  /** When a failed test ran. */
  at: string | null;
}

export const STATE_LABEL: Readonly<Record<ProviderState, MessageKey>> = {
  none: 'aiServices.stNone',
  consent: 'aiServices.stConsent',
  untested: 'aiServices.stUntested',
  running: 'aiServices.stRunning',
  ok: 'aiServices.stOk',
  bad_key: 'aiServices.stBadKey',
  unreachable: 'aiServices.stUnreachable',
  quota: 'aiServices.stQuota',
  rate_limited: 'aiServices.stRateLimited',
};

const NET_REASON: Readonly<Record<string, MessageKey>> = {
  timeout: 'aiServices.netTimeout',
  dns: 'aiServices.netDns',
  tls: 'aiServices.netTls',
  connection: 'aiServices.netConnection',
  unavailable: 'aiServices.netUnavailable',
};

/** `ai_key_invalid · HTTP 401 · reason=dns · detail=ENOTFOUND`, from what the test left. */
export function techLine(
  code: string | null,
  details: Readonly<Record<string, unknown>> | null,
  reason: string | null,
): string {
  const parts: string[] = [code ?? 'error'];
  const d = details ?? {};
  if (typeof d['status'] === 'number') parts.push(`HTTP ${String(d['status'])}`);
  const why = typeof d['reason'] === 'string' ? d['reason'] : reason;
  if (why !== null) parts.push(`reason=${why}`);
  for (const [k, v] of Object.entries(d)) {
    if (k === 'status' || k === 'reason') continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(' · ');
}

export function testView(
  p: Pick<AiProviderStatus, 'provider' | 'key_configured' | 'consent' | 'last_test' | 'text_model'>,
  test: ProviderTest | undefined,
  company: string,
): TestView {
  const base: TestView = {
    tone: 'none',
    title: '',
    desc: '',
    actions: [],
    metrics: null,
    notListed: null,
    tech: null,
    at: null,
  };
  if (!p.key_configured) {
    return { ...base, title: t('aiServices.testNoKey'), desc: t('aiServices.testNoKeyD') };
  }
  if (test?.status === 'running') {
    return {
      ...base,
      tone: 'run',
      title: t('aiServices.testRun', { co: company }),
      desc: t('aiServices.testRunD'),
    };
  }
  if (test?.status === 'error') {
    return {
      ...base,
      tone: 'bad',
      title: t('aiServices.requestFailed', { reason: test.message }),
      actions: ['retry'],
    };
  }
  const v = lastVerdict(p, test);
  if (v === null) {
    return { ...base, title: t('aiServices.testNone'), desc: t('aiServices.testNoneD') };
  }
  const result = test?.status === 'done' ? test.result : null;
  if (v.ok) {
    const last = p.last_test ?? null;
    return {
      ...base,
      tone: 'ok',
      title: t('aiServices.okT'),
      desc: t('aiServices.okD'),
      metrics: {
        latencyMs: result?.latency_ms ?? last?.latency_ms ?? 0,
        models: result?.model_count ?? last?.model_count ?? null,
        at: v.at,
      },
      notListed:
        result?.text_model_listed === false
          ? t('aiServices.modelNotListed', { model: p.text_model })
          : null,
    };
  }
  const state = providerState(p, test);
  const details = result?.error?.details ?? null;
  const failed = { ...base, tech: techLine(v.code, details, v.reason), at: v.at };
  switch (state) {
    case 'bad_key':
      return {
        ...failed,
        tone: 'bad',
        title: t('aiServices.badKeyT'),
        desc: t('aiServices.badKeyD', { co: company }),
        actions: ['replace_key'],
      };
    case 'quota':
      return {
        ...failed,
        tone: 'warn',
        title: t('aiServices.quotaT'),
        desc: t('aiServices.quotaD'),
        actions: ['retry'],
      };
    case 'rate_limited':
      return {
        ...failed,
        tone: 'warn',
        title: t('aiServices.limitedT'),
        desc: t('aiServices.limitedD'),
        actions: ['retry'],
      };
    default: {
      const reasonKey = v.reason === null ? undefined : NET_REASON[v.reason];
      return {
        ...failed,
        tone: 'bad',
        title: t('aiServices.netT', { co: company }),
        desc:
          v.code === 'ai_gateway_bad_response'
            ? t('aiServices.netBadResponse')
            : t(reasonKey ?? 'aiServices.netConnection'),
        actions: p.provider === 'new-api' ? ['retry', 'check_url'] : ['retry'],
      };
    }
  }
}
