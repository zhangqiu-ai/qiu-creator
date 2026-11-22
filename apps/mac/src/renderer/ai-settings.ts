import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { notifyAiStatusChanged } from './ai-status.js';
import { codeText, t } from './i18n.js';
import { isRestoring, restoringText } from './restoring.js';
import {
  AI_DEFAULT_MODELS,
  AI_PRICE_TABLE,
  type AiProvider,
  type AiProviderStatus,
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

export interface AiSettingsState {
  providers: AiProviderStatus[] | null;
  settings: AiSettings | null;
  usage: AiUsageResponse | null;
  loadFailed: boolean;
  /** Provider whose request is in flight. */
  busy: AiProvider | 'budget' | null;
  /** Last error, shown on the row it belongs to. */
  error: { target: AiProvider | 'budget'; message: string } | null;
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
  };
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
      const [providers, settings, usage] = await Promise.all([
        this.client.ai.providers(),
        this.client.ai.settings(),
        this.client.ai.usage(),
      ]);
      this.set({
        providers: sortProviders(providers.items),
        settings,
        usage,
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

  private async run(target: AiProvider | 'budget', action: () => Promise<void>): Promise<boolean> {
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
