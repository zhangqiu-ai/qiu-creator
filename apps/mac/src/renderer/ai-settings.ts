import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { notifyAiStatusChanged } from './ai-status.js';
import { codeText, t } from './i18n.js';
import { isRestoring, restoringText } from './restoring.js';
import {
  AI_DEFAULT_MODELS,
  AI_PRICE_TABLE,
  type AiDefaults,
  type AiProvider,
  type AiProviderModelsResponse,
  type AiProviderStatus,
  type AiProviderTestResponse,
  type AiSettings,
  type AiUsageResponse,
} from '@qiu-creator/contracts';

export const SETTINGS_ORDER: readonly AiProvider[] = ['gemini', 'anthropic', 'openai', 'new-api'];

export const PROVIDER_USE: Readonly<Record<AiProvider, string>> = {
  get gemini() {
    return t('serviceSettings.aiUseGemini');
  },
  get anthropic() {
    return t('serviceSettings.aiUseText');
  },
  get openai() {
    return t('serviceSettings.aiUseText');
  },
  get 'new-api'() {
    return t('serviceSettings.aiUseText');
  },
};

const MODEL_PREFIX: Readonly<Record<Exclude<AiProvider, 'new-api'>, string>> = {
  gemini: 'gemini-',
  anthropic: 'claude-',
  openai: 'gpt-',
};

/** Built-in model suggestions, plus the current model if it is custom. */
export function modelOptions(provider: AiProvider, current: string | null): string[] {
  const known =
    provider === 'new-api'
      ? [AI_DEFAULT_MODELS[provider].text]
      : Object.keys(AI_PRICE_TABLE).filter((m) => m.startsWith(MODEL_PREFIX[provider]));
  if (current !== null && current !== '' && !known.includes(current)) known.unshift(current);
  return known;
}

export type KeyState = 'none' | 'needs_consent' | 'ready';

export function keyState(p: AiProviderStatus): KeyState {
  if (!p.key_configured) return 'none';
  return p.ready ? 'ready' : 'needs_consent';
}

/**
 * 測試連線 of one provider in this window (QC-057). The service also keeps the
 * last result (`last_test`, without details) across restarts.
 */
export type ProviderTest =
  | { status: 'running'; seq: number }
  | { status: 'done'; result: AiProviderTestResponse }
  /** The request itself failed (no key, service down): not a provider verdict. */
  | { status: 'error'; message: string };

/** What a provider row and the test card say (QC-057, PT-20261121-002 「AI 連線狀態全覽」). */
export type ProviderState =
  | 'none'
  | 'consent'
  | 'untested'
  | 'running'
  | 'ok'
  | 'bad_key'
  | 'unreachable'
  | 'quota'
  | 'rate_limited';

/** The error code and reason of the newest finished test, from this window or the service. */
export function lastVerdict(
  p: Pick<AiProviderStatus, 'last_test'>,
  test: ProviderTest | undefined,
): { ok: boolean; code: string | null; reason: string | null; at: string } | null {
  if (test?.status === 'done') {
    const r = test.result;
    const reason = r.error?.details?.['reason'];
    return {
      ok: r.ok,
      code: r.error?.code ?? null,
      reason: typeof reason === 'string' ? reason : null,
      at: r.tested_at,
    };
  }
  const last = p.last_test ?? null;
  if (last === null) return null;
  return { ok: last.status === 'ok', code: last.error_code, reason: last.reason, at: last.at };
}

/**
 * The state a provider shows: no key, a running test, a failed test (by its
 * cause), an unconfirmed notice, then a passed test or 未測試. A failure
 * comes before the notice because it is what stops the provider working.
 */
export function providerState(
  p: Pick<AiProviderStatus, 'key_configured' | 'consent' | 'last_test'>,
  test: ProviderTest | undefined,
): ProviderState {
  if (!p.key_configured) return 'none';
  if (test?.status === 'running') return 'running';
  const v = lastVerdict(p, test);
  if (v !== null && !v.ok) {
    if (v.code === 'ai_key_invalid') return 'bad_key';
    if (v.reason === 'quota') return 'quota';
    if (v.reason === 'rate_limited') return 'rate_limited';
    return 'unreachable';
  }
  if (p.consent === null) return 'consent';
  return v?.ok === true ? 'ok' : 'untested';
}

/** Tone of a provider state: dots, chips and the 設定 category dot. */
export function stateTone(state: ProviderState): 'ok' | 'warn' | 'bad' | 'none' | 'run' {
  switch (state) {
    case 'ok':
      return 'ok';
    case 'bad_key':
    case 'unreachable':
      return 'bad';
    case 'consent':
    case 'quota':
    case 'rate_limited':
      return 'warn';
    case 'running':
      return 'run';
    default:
      return 'none';
  }
}

export interface AiSettingsState {
  providers: AiProviderStatus[] | null;
  settings: AiSettings | null;
  usage: AiUsageResponse | null;
  loadFailed: boolean;
  /** Provider whose request is in flight. */
  busy: AiProvider | 'budget' | 'defaults' | null;
  /** Last error, shown on the row it belongs to. */
  error: { target: AiProvider | 'budget' | 'defaults'; message: string } | null;
  /** 測試連線 in this window, by provider (QC-057). */
  tests: Partial<Record<AiProvider, ProviderTest>>;
  /** Default provider per task (用途, QC-057); null until loaded or when it failed. */
  defaults: AiDefaults | null;
}

function messageOf(err: unknown): string {
  if (isRestoring(err)) return restoringText();
  if (err instanceof ApiError) {
    if (err.status === 400) return t('serviceSettings.aiBadFormat');
    if (err.code === 'ai_consent_required') return t('serviceSettings.aiConsentChanged');
    return codeText(err.code);
  }
  return t('common.cannotConnect');
}

/**
 * 設定 → AI 服務 (QC-025). Keys go straight to the server, which stores them
 * in the Mac's Keychain; nothing here keeps, logs or persists a key, and no
 * API ever returns one.
 */
export class AiSettingsStore {
  private state: AiSettingsState = {
    providers: null,
    settings: null,
    usage: null,
    loadFailed: false,
    busy: null,
    error: null,
    tests: {},
    defaults: null,
  };
  private testSeq = 0;
  private readonly listeners = new Set<(s: AiSettingsState) => void>();

  constructor(private readonly client: CreatorHubClient) {}

  get snapshot(): AiSettingsState {
    return this.state;
  }

  subscribe(listener: (s: AiSettingsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<AiSettingsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  async load(): Promise<void> {
    try {
      const [providers, settings, usage, defaults] = await Promise.all([
        this.client.ai.providers(),
        this.client.ai.settings(),
        this.client.ai.usage(),
        this.client.ai.defaults().catch(() => null),
      ]);
      this.set({
        providers: sortProviders(providers.items),
        settings,
        usage,
        defaults,
        loadFailed: false,
      });
    } catch {
      this.set({ loadFailed: true });
    }
  }

  private replace(status: AiProviderStatus): void {
    const list = (this.state.providers ?? []).filter((p) => p.provider !== status.provider);
    this.set({ providers: sortProviders([...list, status]) });
    // Open video panels read the status again (QC-055).
    notifyAiStatusChanged();
  }

  private async run(
    target: AiProvider | 'budget' | 'defaults',
    action: () => Promise<void>,
  ): Promise<boolean> {
    this.set({ busy: target, error: null });
    try {
      await action();
      this.set({ busy: null });
      return true;
    } catch (err) {
      this.set({ busy: null, error: { target, message: messageOf(err) } });
      return false;
    }
  }

  /**
   * The caller clears credential inputs when submitting. Credentials are never
   * stored in the settings state or repeated in save errors.
   */
  async saveKey(provider: AiProvider, apiKey: string, baseUrl?: string): Promise<boolean> {
    const key = apiKey.trim();
    if (key === '') {
      this.set({ error: { target: provider, message: t('serviceSettings.aiKeyRequired') } });
      return false;
    }
    this.set({ busy: provider, error: null });
    try {
      this.replace(await this.client.ai.setKey(provider, key, baseUrl));
      // A new key (or Base URL) is untested again; the service clears `last_test` too.
      this.cancelTest(provider);
      this.set({ busy: null });
      return true;
    } catch (err) {
      const message =
        provider === 'new-api'
          ? newApiSaveError(err)
          : t('serviceSettings.aiKeySaveFailed', {
              reason: redactKey(messageOf(err), key),
            });
      this.set({ busy: null, error: { target: provider, message } });
      return false;
    }
  }

  deleteKey(provider: AiProvider): Promise<boolean> {
    return this.run(provider, async () => {
      this.replace(await this.client.ai.deleteKey(provider));
      this.cancelTest(provider);
    });
  }

  /** 我已了解，啟用: confirm the notice version that was shown. */
  consent(provider: AiProvider, noticeVersion: number, credentialId?: string): Promise<boolean> {
    return this.run(provider, async () => {
      try {
        this.replace(await this.client.ai.consent(provider, noticeVersion, credentialId));
      } catch (err) {
        if (
          provider === 'new-api' &&
          err instanceof ApiError &&
          err.code === 'ai_consent_required'
        ) {
          const latest = await this.client.ai.providers().catch(() => null);
          const status = latest?.items.find((item) => item.provider === provider);
          if (status !== undefined) this.replace(status);
        }
        throw err;
      }
    });
  }

  withdrawConsent(provider: AiProvider): Promise<boolean> {
    return this.run(provider, async () => {
      this.replace(await this.client.ai.withdrawConsent(provider));
    });
  }

  /**
   * The models the New API relay offers to the stored key (QC-054). This goes
   * to the user's relay, so call it only when the user opens the list or
   * presses 重新整理; the service caches it for 10 minutes unless `refresh`.
   */
  newApiModels(refresh: boolean): Promise<AiProviderModelsResponse> {
    return this.client.ai.newApiModels({ refresh });
  }

  setModel(provider: AiProvider, kind: 'text' | 'video', model: string): Promise<boolean> {
    return this.run(provider, async () => {
      this.replace(
        await this.client.ai.patchProvider(
          provider,
          kind === 'text' ? { text_model: model } : { video_model: model },
        ),
      );
    });
  }

  /**
   * 測試連線 (QC-057): only when the user presses it. The service asks the
   * provider's free list-models endpoint with the Keychain key; no content
   * is sent and nothing is charged, so the notice need not be confirmed.
   * 取消 stops waiting (the service finishes within its own 10 s limit).
   */
  async test(provider: AiProvider): Promise<void> {
    const seq = ++this.testSeq;
    this.setTest(provider, { status: 'running', seq });
    try {
      const result = await this.client.ai.testProvider(provider);
      if (!this.isRunning(provider, seq)) return;
      this.setTest(provider, { status: 'done', result });
      // The service saved it as `last_test`; the list shows it from there too.
      const { items } = await this.client.ai.providers();
      this.set({ providers: sortProviders(items) });
    } catch (err) {
      if (!this.isRunning(provider, seq)) return;
      this.setTest(provider, { status: 'error', message: messageOf(err) });
    }
  }

  cancelTest(provider: AiProvider): void {
    const tests = Object.fromEntries(
      Object.entries(this.state.tests).filter(([k]) => k !== provider),
    ) as AiSettingsState['tests'];
    this.set({ tests });
  }

  private isRunning(provider: AiProvider, seq: number): boolean {
    const now = this.state.tests[provider];
    return now?.status === 'running' && now.seq === seq;
  }

  private setTest(provider: AiProvider, test: ProviderTest): void {
    this.set({ tests: { ...this.state.tests, [provider]: test } });
  }

  /** 用途: the default provider of one task; null goes back to the app's own choice. */
  setDefault(task: 'rewrite' | 'title', provider: AiProvider | null): Promise<boolean> {
    const current = this.state.defaults ?? { rewrite: null, title: null, video: null };
    return this.run('defaults', async () => {
      const defaults = await this.client.ai.putDefaults({ ...current, [task]: provider });
      this.set({ defaults });
      notifyAiStatusChanged();
    });
  }

  /** 每月提醒金額: null turns the reminder off. */
  setBudget(usd: number | null): Promise<boolean> {
    if (usd !== null && (!Number.isFinite(usd) || usd < 0)) {
      this.set({ error: { target: 'budget', message: t('serviceSettings.aiBudgetInvalid') } });
      return Promise.resolve(false);
    }
    return this.run('budget', async () => {
      const settings = await this.client.ai.patchSettings({ monthly_budget_usd: usd });
      const usage = await this.client.ai.usage();
      this.set({ settings, usage });
    });
  }
}

function newApiSaveError(err: unknown): string {
  if (isRestoring(err)) return restoringText();
  if (err instanceof ApiError && err.status === 400) {
    return t('serviceSettings.aiNewApiSaveBadFormat');
  }
  return t('serviceSettings.aiNewApiSaveFailed');
}

/** Remove every occurrence of the key (and its longer fragments) from a message. */
export function redactKey(message: string, key: string): string {
  if (key.length < 4) return message;
  let out = message.split(key).join('••••');
  // Also hide partial echoes such as a truncated key in a server message.
  for (let len = key.length - 1; len >= 8; len--) {
    for (let i = 0; i + len <= key.length; i++) {
      const part = key.slice(i, i + len);
      if (out.includes(part)) out = out.split(part).join('••••');
    }
  }
  return out;
}

function sortProviders(items: readonly AiProviderStatus[]): AiProviderStatus[] {
  return [...items].sort(
    (a, b) => SETTINGS_ORDER.indexOf(a.provider) - SETTINGS_ORDER.indexOf(b.provider),
  );
}

/** USD with two decimals, as the prototype shows costs. */
export function formatUsd(usd: number | null): string {
  if (usd === null) return '—';
  // Small amounts (cheap models, low budgets) would otherwise all read $0.00 or $0.01.
  if (usd > 0 && usd < 0.01) return `$${String(Number(usd.toPrecision(2)))}`;
  return `$${usd.toFixed(2)}`;
}
