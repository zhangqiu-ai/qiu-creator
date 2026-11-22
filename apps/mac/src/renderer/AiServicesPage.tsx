import {
  AI_DEFAULT_MODELS,
  AI_PRICE_TABLE,
  PatchAiProviderRequestSchema,
  SetAiKeyRequestSchema,
  suggestNewApiBaseUrl,
  type AiProvider,
  type AiProviderModelsResponse,
  type AiProviderStatus,
} from '@qiu-creator/contracts';
import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import {
  formatUsd,
  lastVerdict,
  modelOptions,
  PROVIDER_USE,
  providerState,
  stateTone,
  type AiSettingsState,
  type AiSettingsStore,
  type ProviderState,
} from './ai-settings.js';
import { STATE_LABEL, testView, type TestAction } from './ai-test-view.js';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
import { currentLocale, t } from './i18n.js';
import { Icon } from './Icon.js';
import { ModelCombobox } from './ModelCombobox.js';
import { budgetWarningText, companyText, noticeText } from './server-text.js';
import { useToast } from './toasts.js';

/**
 * 設定 → AI 服務 v4 (QC-057, PT-20261121-002): four tabs instead of one long
 * card — 供應商 (list and detail side by side, with 測試連線), 用途 (default
 * provider per task), 用量 (this month and the reminder) and 隱私 (where
 * content goes). Models are set only in a provider's detail; 用途 picks
 * providers, so one model is never set in two places.
 */

export type AiTab = 'providers' | 'use' | 'usage' | 'privacy';
const TABS: readonly {
  key: AiTab;
  label:
    | 'aiServices.tabProviders'
    | 'aiServices.tabUse'
    | 'aiServices.tabUsage'
    | 'aiServices.tabPrivacy';
}[] = [
  { key: 'providers', label: 'aiServices.tabProviders' },
  { key: 'use', label: 'aiServices.tabUse' },
  { key: 'usage', label: 'aiServices.tabUsage' },
  { key: 'privacy', label: 'aiServices.tabPrivacy' },
];

const ABBR: Readonly<Record<AiProvider, string>> = {
  gemini: 'Ge',
  anthropic: 'Cl',
  openai: 'GP',
  'new-api': 'NA',
};

/** Where a provider's content goes: the company, or the New API relay's host. */
export function destination(p: AiProviderStatus): string {
  if (p.provider !== 'new-api') return companyText(p);
  const host = p.base_url_host ?? null;
  return host === null ? t('aiServices.relayUnknown') : t('aiServices.relay', { host });
}

/** The 設定 category dot for AI 服務: red for a broken provider, yellow for one needing attention. */
export function aiNavTone(s: Pick<AiSettingsState, 'providers' | 'tests'>): 'bad' | 'warn' | null {
  let tone: 'bad' | 'warn' | null = null;
  for (const p of s.providers ?? []) {
    const st = stateTone(providerState(p, s.tests[p.provider]));
    if (st === 'bad') return 'bad';
    if (st === 'warn') tone = 'warn';
  }
  return tone;
}

/** A test-based state carries when it was found: 「連線正常 · 2 分鐘前」. */
const TIMED: ReadonlySet<ProviderState> = new Set([
  'ok',
  'bad_key',
  'unreachable',
  'quota',
  'rate_limited',
]);

function StateChip({ state, at = null }: { state: ProviderState; at?: string | null }) {
  return (
    <span className={`set-st set-st--${stateTone(state)}`}>
      <i aria-hidden="true" />
      {t(STATE_LABEL[state])}
      {at !== null && TIMED.has(state) && ` · ${formatWhen(at)}`}
    </span>
  );
}

export function AiServicesPage({
  store,
  s,
  headingRef,
  initialProvider = null,
}: {
  store: AiSettingsStore;
  s: AiSettingsState;
  headingRef?: Ref<HTMLHeadingElement>;
  initialProvider?: AiProvider | null;
}) {
  const [tab, setTab] = useState<AiTab>('providers');
  const [picked, setPicked] = useState<AiProvider | null>(initialProvider);
  const tabRefs = useRef(new Map<AiTab, HTMLButtonElement>());

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.findIndex((x) => x.key === tab);
    const next =
      e.key === 'Home'
        ? TABS[0]
        : e.key === 'End'
          ? TABS.at(-1)
          : TABS[(i + step + TABS.length) % TABS.length];
    if (next === undefined) return;
    setTab(next.key);
    tabRefs.current.get(next.key)?.focus();
  };

  const providers = s.providers;
  const current =
    providers === null
      ? null
      : (providers.find((p) => p.provider === picked) ??
        providers.find((p) => p.key_configured) ??
        providers[0] ??
        null);

  return (
    <>
      <header className="set-h">
        <h1 id="set-ai" className="set-h__title" ref={headingRef} tabIndex={-1}>
          {t('serviceSettings.aiTitle')}
        </h1>
        <div className="set-h__r">
          <div
            className="set-tabs"
            role="tablist"
            aria-label={t('serviceSettings.aiTitle')}
            onKeyDown={onTabKey}
          >
            {TABS.map((x) => (
              <button
                key={x.key}
                ref={(el) => {
                  if (el === null) tabRefs.current.delete(x.key);
                  else tabRefs.current.set(x.key, el);
                }}
                type="button"
                role="tab"
                id={`ai-tab-${x.key}`}
                aria-selected={tab === x.key}
                aria-controls={`ai-panel-${x.key}`}
                tabIndex={tab === x.key ? 0 : -1}
                onClick={() => {
                  setTab(x.key);
                }}
              >
                {t(x.label)}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div
        role="tabpanel"
        id={`ai-panel-${tab}`}
        aria-labelledby={`ai-tab-${tab}`}
        className="set-panel"
      >
        {s.loadFailed ? (
          <div className="set-list">
            <div className="set-row">
              <span className="set-row__k muted">{t('serviceSettings.aiLoadFailed')}</span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  void store.load();
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          </div>
        ) : providers === null || current === null ? (
          <div className="set-list" aria-busy="true">
            <div className="set-row">
              <span className="skel skel--line" style={{ width: '60%' }} />
            </div>
          </div>
        ) : tab === 'providers' ? (
          <Providers
            store={store}
            s={s}
            providers={providers}
            current={current}
            onPick={setPicked}
          />
        ) : tab === 'use' ? (
          <UsePanel
            store={store}
            s={s}
            providers={providers}
            onSetup={() => {
              setTab('providers');
            }}
          />
        ) : tab === 'usage' ? (
          <UsagePanel store={store} s={s} />
        ) : (
          <PrivacyPanel
            s={s}
            providers={providers}
            onManage={(p) => {
              setPicked(p);
              setTab('providers');
            }}
          />
        )}
      </div>
    </>
  );
}

// ---- 供應商 ---------------------------------------------------------------------------------

function Providers({
  store,
  s,
  providers,
  current,
  onPick,
}: {
  store: AiSettingsStore;
  s: AiSettingsState;
  providers: readonly AiProviderStatus[];
  current: AiProviderStatus;
  onPick: (p: AiProvider) => void;
}) {
  return (
    <div className="set-md">
      <section className="set-md__list" aria-label={t('aiServices.tabProviders')}>
        <div className="set-list" role="list">
          {providers.map((p) => {
            const state = providerState(p, s.tests[p.provider]);
            const on = p.provider === current.provider;
            return (
              <button
                key={p.provider}
                type="button"
                role="listitem"
                className="set-pv"
                aria-current={on ? 'true' : undefined}
                data-provider={p.provider}
                onClick={() => {
                  onPick(p.provider);
                }}
              >
                <span className="set-pi" aria-hidden="true">
                  {ABBR[p.provider]}
                </span>
                <span className="set-pv__t">
                  <b>{p.name}</b>
                  <span>{PROVIDER_USE[p.provider]}</span>
                </span>
                <StateChip state={state} at={lastVerdict(p, s.tests[p.provider])?.at ?? null} />
              </button>
            );
          })}
          <button type="button" className="set-pv" disabled>
            <span className="set-pi" aria-hidden="true">
              <Icon name="server" size={14} />
            </span>
            <span className="set-pv__t">
              <b>{t('aiServices.local')}</b>
              <span>{t('aiServices.later')}</span>
            </span>
          </button>
        </div>
        <p className="set-fn">{t('serviceSettings.aiNote')}</p>
      </section>
      <ProviderDetail key={current.provider} store={store} s={s} p={current} />
    </div>
  );
}

function ProviderDetail({
  store,
  s,
  p,
}: {
  store: AiSettingsStore;
  s: AiSettingsState;
  p: AiProviderStatus;
}) {
  const isRelay = p.provider === 'new-api';
  const busy = s.busy === p.provider;
  const test = s.tests[p.provider];
  const co = isRelay ? destination(p) : companyText(p);
  const view = testView(p, test, co);
  const error = s.error?.target === p.provider ? s.error.message : null;
  const [editing, setEditing] = useState(!p.key_configured);
  const [confirm, setConfirm] = useState<'delete' | 'withdraw' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const baseInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);
  useToast(
    toast === null
      ? null
      : {
          message: toast,
          tone: 'ok',
          onClose: () => {
            setToast(null);
          },
        },
  );

  const act = (a: TestAction) => {
    if (a === 'retry') void store.test(p.provider);
    else {
      setEditing(true);
      requestAnimationFrame(() => {
        (a === 'check_url' ? baseInput.current : keyInput.current)?.focus();
      });
    }
  };

  const running = test?.status === 'running';
  return (
    <section className="set-md__detail" aria-labelledby="ai-detail-h">
      <div className="set-ph">
        <span className="set-pi set-pi--lg" aria-hidden="true">
          {ABBR[p.provider]}
        </span>
        <div className="set-ph__t">
          <h2 id="ai-detail-h">{p.name}</h2>
          <span className="faint">{t('aiServices.sendTo', { co })}</span>
        </div>
        {running ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              store.cancelTest(p.provider);
            }}
          >
            {t('common.cancel')}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={!p.key_configured || busy}
            aria-describedby="ai-test-result"
            onClick={() => {
              void store.test(p.provider);
            }}
          >
            <Icon name="pulse" size={14} />
            {t('aiServices.test')}
          </button>
        )}
      </div>

      <div
        id="ai-test-result"
        className={`set-test set-test--${view.tone}`}
        role="status"
        aria-live="polite"
      >
        <div className="set-test__row">
          <span className="set-test__ic" aria-hidden="true">
            {view.tone === 'run' ? (
              <span className="set-spin" />
            ) : (
              <Icon
                name={view.tone === 'ok' ? 'check' : view.tone === 'none' ? 'pulse' : 'alert'}
                size={14}
              />
            )}
          </span>
          <div className="set-test__tx">
            <b>{view.title}</b>
            {view.desc !== '' && (
              <span>
                {view.desc}
                {view.at !== null && <span className="set-test__at">{formatWhen(view.at)}</span>}
              </span>
            )}
          </div>
          {view.actions.map((a) => (
            <button
              key={a}
              type="button"
              className={a === 'retry' ? 'btn btn--small' : 'btn btn--small btn--ghost'}
              onClick={() => {
                act(a);
              }}
            >
              {a === 'retry'
                ? t('common.retry')
                : a === 'replace_key'
                  ? t('aiServices.replaceKey')
                  : t('aiServices.checkUrl')}
            </button>
          ))}
        </div>
        {view.metrics !== null && (
          <dl className="set-test__ms">
            <div>
              <dt>{t('aiServices.latency')}</dt>
              <dd>{`${String(view.metrics.latencyMs)} ms`}</dd>
            </div>
            <div>
              <dt>{t('aiServices.models')}</dt>
              <dd>{view.metrics.models ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('aiServices.testedAt')}</dt>
              <dd className="set-test__when">{formatWhen(view.metrics.at)}</dd>
            </div>
          </dl>
        )}
        {view.notListed !== null && <p className="set-test__note">{view.notListed}</p>}
        {view.tech !== null && (
          <div className="set-test__tech">
            <span>{t('aiServices.tech')}</span>
            <code>{view.tech}</code>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                const text = view.tech;
                if (text !== null) void window.creatorhub?.copyText(text);
                setToast(t('common.copied'));
              }}
            >
              {t('common.copy')}
            </button>
          </div>
        )}
      </div>

      <section className="set-g" aria-labelledby="ai-g-conn">
        <h3 className="set-g__t" id="ai-g-conn">
          {t('aiServices.gConn')}
        </h3>
        <KeyForm
          store={store}
          p={p}
          busy={busy}
          editing={editing}
          onEditing={setEditing}
          keyInput={keyInput}
          baseInput={baseInput}
          onAskDelete={() => {
            setConfirm('delete');
          }}
          onSaved={() => {
            setToast(t('serviceSettings.aiKeySet'));
          }}
        />
        {error !== null && (
          <p className="set-err" role="alert">
            {error}
          </p>
        )}
      </section>

      {p.key_configured && (
        <section className="set-g" aria-labelledby="ai-g-models">
          <h3 className="set-g__t" id="ai-g-models">
            {t('aiServices.gModels')}
          </h3>
          <div className="set-list">
            <div className="set-row set-row--top">
              <ModelField store={store} p={p} kind="text" busy={busy} />
            </div>
            {p.video_model !== null && (
              <div className="set-row set-row--top">
                <ModelField store={store} p={p} kind="video" busy={busy} />
              </div>
            )}
          </div>
        </section>
      )}

      {p.key_configured && (
        <section className="set-g" aria-labelledby="ai-g-consent">
          <h3 className="set-g__t" id="ai-g-consent">
            {t('aiServices.gConsent')}
          </h3>
          {p.consent !== null ? (
            <div className="set-list">
              <div className="set-row">
                <div className="set-row__k">
                  <b>{t('aiServices.consentLine', { when: formatWhen(p.consent.at) })}</b>
                  <span>{t('aiServices.sendTo', { co })}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={busy}
                  onClick={() => {
                    setConfirm('withdraw');
                  }}
                >
                  {t('serviceSettings.aiWithdraw')}
                </button>
              </div>
            </div>
          ) : (
            <div
              className="set-notice"
              role="group"
              aria-label={t('serviceSettings.aiNoticeLabel', { name: p.name })}
            >
              <b>
                {t(isRelay ? 'serviceSettings.aiNoticeAgain' : 'serviceSettings.aiNoticeFirst', {
                  company: companyText(p),
                })}
              </b>
              <p>{noticeText(p.notice)}</p>
              <div>
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  disabled={busy}
                  onClick={() => {
                    void store
                      .consent(
                        p.provider,
                        p.notice.version,
                        isRelay ? p.notice.credential_id : undefined,
                      )
                      .then((ok) => {
                        if (ok) setToast(t('serviceSettings.aiKeychainReady'));
                      });
                  }}
                >
                  {t('serviceSettings.aiConsentAction')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {confirm === 'withdraw' && (
        <Dialog
          title={t('serviceSettings.aiWithdrawTitle', { name: p.name })}
          onClose={() => {
            setConfirm(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setConfirm(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setConfirm(null);
                  void store.withdrawConsent(p.provider);
                }}
              >
                {t('serviceSettings.aiWithdrawAction')}
              </button>
            </>
          }
        >
          <div className="form">
            <p>{t('serviceSettings.aiWithdrawBody', { company: companyText(p) })}</p>
            <p className="muted">{t('serviceSettings.aiWithdrawNote', { name: p.name })}</p>
          </div>
        </Dialog>
      )}
      {confirm === 'delete' && (
        <Dialog
          title={t('serviceSettings.aiDeleteTitle', { name: p.name })}
          onClose={() => {
            setConfirm(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setConfirm(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--danger-solid"
                onClick={() => {
                  setConfirm(null);
                  void store.deleteKey(p.provider).then((ok) => {
                    if (ok) setEditing(true);
                  });
                }}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          <div className="form">
            <p>
              {isRelay
                ? t('serviceSettings.aiDeleteBodyNewApi')
                : t('serviceSettings.aiDeleteBody', { name: p.name })}
            </p>
            <p className="muted">{t('serviceSettings.aiDeleteNote')}</p>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/**
 * 連線: the Base URL (New API, shown in full: it is not a secret) and the key
 * (never shown). Saved: 已設定 · when, 更換, 刪除. Not saved or replacing: a
 * password field and 存到鑰匙圈; a Base URL missing /v1 gets a one-click fix.
 */
function KeyForm({
  store,
  p,
  busy,
  editing,
  onEditing,
  keyInput,
  baseInput,
  onAskDelete,
  onSaved,
}: {
  store: AiSettingsStore;
  p: AiProviderStatus;
  busy: boolean;
  editing: boolean;
  onEditing: (editing: boolean) => void;
  keyInput: Ref<HTMLInputElement>;
  baseInput: Ref<HTMLInputElement>;
  onAskDelete: () => void;
  onSaved: () => void;
}) {
  const isRelay = p.provider === 'new-api';
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? '');
  const [baseError, setBaseError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const keyId = `ai-key-${p.provider}`;
  const baseId = 'ai-base-url-new-api';

  const reset = () => {
    setKey('');
    setBaseUrl(p.base_url ?? '');
    setBaseError(null);
    setSuggested(null);
  };

  const save = () => {
    if (busy) return;
    const url = isRelay ? baseUrl.trim() : undefined;
    if (url === '') {
      setBaseError(t('serviceSettings.aiBaseUrlRequired'));
      return;
    }
    if (url !== undefined && !SetAiKeyRequestSchema.shape.base_url.safeParse(url).success) {
      setBaseError(t('serviceSettings.aiBaseUrlInvalid'));
      setSuggested(suggestNewApiBaseUrl(url));
      return;
    }
    const typed = key;
    setKey('');
    void store.saveKey(p.provider, typed, url).then((ok) => {
      if (ok) {
        onEditing(false);
        onSaved();
      }
    });
  };

  if (!editing && p.key_configured) {
    return (
      <div className="set-list">
        {isRelay && (
          <div className="set-row">
            <div className="set-row__k">
              <b>Base URL</b>
              <span className="mono">{p.base_url ?? '—'}</span>
            </div>
          </div>
        )}
        <div className="set-row">
          <div className="set-row__k">
            <b>{t('serviceSettings.aiKeyLabel', { name: p.name })}</b>
            <span>
              {p.key_updated_at === null
                ? t('serviceSettings.aiKeySet')
                : t('aiServices.keyLine', { when: formatWhen(p.key_updated_at) })}
            </span>
          </div>
          <div className="set-row__acts">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy}
              onClick={() => {
                reset();
                onEditing(true);
              }}
            >
              {t('serviceSettings.aiReplace')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small btn--danger"
              disabled={busy}
              onClick={onAskDelete}
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      className="set-list"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {isRelay && (
        <div className="set-row set-row--top">
          <div className="set-field">
            <label className="set-field__l" htmlFor={baseId}>
              New API Base URL
            </label>
            <input
              ref={baseInput}
              id={baseId}
              className="input mono"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://relay.example.com/v1"
              aria-describedby={`${baseId}-hint${baseError === null ? '' : ` ${baseId}-error`}`}
              aria-invalid={baseError !== null}
              disabled={busy}
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setBaseError(null);
                setSuggested(null);
              }}
              onBlur={(e) => {
                setSuggested(suggestNewApiBaseUrl(e.target.value));
              }}
            />
            <span className="set-field__hint" id={`${baseId}-hint`}>
              {t('aiServices.baseUrlHint')}
            </span>
            {baseError !== null && (
              <span className="set-err" id={`${baseId}-error`} role="alert">
                {baseError}
              </span>
            )}
            {suggested !== null && (
              <span className="ai-set__suggest" role="status">
                <span>{t('modelPicker.baseUrlSuggest', { url: suggested })}</span>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setBaseUrl(suggested);
                    setSuggested(null);
                    setBaseError(null);
                  }}
                >
                  {t('modelPicker.baseUrlUseSuggested')}
                </button>
              </span>
            )}
          </div>
        </div>
      )}
      <div className="set-row set-row--top">
        <div className="set-field">
          <label className="set-field__l" htmlFor={keyId}>
            {t('serviceSettings.aiKeyLabel', { name: p.name })}
          </label>
          <div className="set-field__line">
            <input
              ref={keyInput}
              id={keyId}
              className="input mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('serviceSettings.aiKeyLabel', { name: p.name })}
              disabled={busy}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
              }}
            />
            <button
              type="submit"
              className="btn btn--primary btn--small"
              disabled={busy || key.trim() === ''}
            >
              {t('serviceSettings.aiSaveToKeychain')}
            </button>
            {p.key_configured && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  reset();
                  onEditing(false);
                }}
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

/** A built-in list for Gemini, Claude and GPT (their online lists are a later task). */
function builtinModels(p: AiProviderStatus, kind: 'text' | 'video'): AiProviderModelsResponse {
  const current = kind === 'text' ? p.text_model : p.video_model;
  return {
    provider: p.provider,
    models: modelOptions(p.provider, current).map((id) => ({
      id,
      kind: 'chat',
      priced: id in AI_PRICE_TABLE,
    })),
    fetched_at: new Date().toISOString(),
  };
}

function ModelField({
  store,
  p,
  kind,
  busy,
}: {
  store: AiSettingsStore;
  p: AiProviderStatus;
  kind: 'text' | 'video';
  busy: boolean;
}) {
  const isRelay = p.provider === 'new-api';
  const saved = (kind === 'text' ? p.text_model : p.video_model) ?? '';
  return (
    <ModelCombobox
      id={`ai-${kind}-model-${p.provider}`}
      label={kind === 'text' ? t('serviceSettings.aiTextModel') : t('serviceSettings.aiVideoModel')}
      hint={
        isRelay
          ? t('serviceSettings.aiNewApiModelHint', { model: AI_DEFAULT_MODELS['new-api'].text })
          : ''
      }
      saved={saved}
      busy={busy}
      builtin={!isRelay}
      load={(refresh) =>
        isRelay ? store.newApiModels(refresh) : Promise.resolve(builtinModels(p, kind))
      }
      onSave={(next) => store.setModel(p.provider, kind, next)}
      validate={(next) => {
        const parsed = PatchAiProviderRequestSchema.safeParse(
          kind === 'text' ? { text_model: next } : { video_model: next },
        );
        return parsed.success;
      }}
      invalidMessage={t('serviceSettings.aiModelInvalid')}
    />
  );
}

// ---- 用途 ---------------------------------------------------------------------------------

function UsePanel({
  store,
  s,
  providers,
  onSetup,
}: {
  store: AiSettingsStore;
  s: AiSettingsState;
  providers: readonly AiProviderStatus[];
  onSetup: () => void;
}) {
  const defaults = s.defaults;
  const ready = providers.filter((p) => p.key_configured);
  const gemini = providers.find((p) => p.provider === 'gemini') ?? null;
  const busy = s.busy === 'defaults';
  const error = s.error?.target === 'defaults' ? s.error.message : null;
  const row = (task: 'rewrite' | 'title') => {
    const chosen = defaults?.[task] ?? null;
    const p = chosen === null ? null : (providers.find((x) => x.provider === chosen) ?? null);
    const id = `ai-default-${task}`;
    return (
      <div className="set-row" key={task}>
        <div className="set-row__k">
          <label htmlFor={id}>
            <b>{t(task === 'rewrite' ? 'aiServices.taskRewrite' : 'aiServices.taskTitle')}</b>
          </label>
          <span className="mono">{p?.text_model ?? '—'}</span>
        </div>
        {p !== null && <StateChip state={providerState(p, s.tests[p.provider])} />}
        <select
          id={id}
          className="select set-use__sel"
          value={chosen ?? ''}
          disabled={busy || defaults === null}
          onChange={(e) => {
            const v = e.target.value;
            void store.setDefault(task, v === '' ? null : (v as AiProvider));
          }}
        >
          <option value="">{t('aiServices.auto')}</option>
          {providers.map((x) => (
            <option key={x.provider} value={x.provider}>
              {`${x.name} · ${t(STATE_LABEL[providerState(x, s.tests[x.provider])])}`}
            </option>
          ))}
        </select>
      </div>
    );
  };
  return (
    <section className="set-g" aria-labelledby="ai-g-use">
      <h2 className="set-g__t" id="ai-g-use">
        {t('aiServices.defProv')}
      </h2>
      <div className="set-list">
        {row('rewrite')}
        {row('title')}
        <div className="set-row">
          <div className="set-row__k">
            <b>{t('aiServices.taskVideo')}</b>
            <span className="mono">{gemini?.video_model ?? '—'}</span>
          </div>
          {gemini !== null && <StateChip state={providerState(gemini, s.tests.gemini)} />}
          <span className="set-row__v">{t('aiServices.onlyGemini')}</span>
        </div>
      </div>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
      <p className="set-fn">{t('aiServices.useFoot')}</p>
      {ready.length === 0 && (
        <div className="set-empty">
          <span className="faint">{t('aiServices.useEmpty')}</span>
          <button type="button" className="btn btn--primary btn--small" onClick={onSetup}>
            {t('aiServices.setupProv')}
          </button>
        </div>
      )}
    </section>
  );
}

// ---- 用量 ---------------------------------------------------------------------------------

function UsagePanel({ store, s }: { store: AiSettingsStore; s: AiSettingsState }) {
  const usage = s.usage;
  const budget = usage?.budget ?? null;
  const spent = budget?.spent_usd ?? 0;
  const limit = budget?.budget_usd ?? null;
  const pct = limit === null || limit <= 0 ? 0 : Math.min(100, Math.round((spent / limit) * 100));
  const rows = usage?.by_provider ?? [];
  const max = Math.max(0, ...rows.map((r) => r.cost_usd));
  const month = new Intl.DateTimeFormat(currentLocale(), { month: 'long' }).format(new Date());
  const warning = budget === null ? null : budgetWarningText(budget);
  return (
    <>
      <section className="set-g" aria-labelledby="ai-g-month">
        <h2 className="set-g__t" id="ai-g-month">
          {month}
          <span className="set-g__r">{t('aiServices.est')}</span>
        </h2>
        <div className="set-list">
          <div className="set-big">
            <b>{formatUsd(spent)}</b>
            <span className="faint">
              {limit === null
                ? t('aiServices.noBudget')
                : t('aiServices.ofBudget', { budget: formatUsd(limit) })}
            </span>
          </div>
          {limit !== null && (
            <div
              className={pct >= 100 ? 'set-meter set-meter--over' : 'set-meter'}
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={t('aiServices.meter')}
            >
              <span style={{ width: `${String(pct)}%` }} />
            </div>
          )}
          {warning !== null && (
            <p className="set-row set-warn" role="status">
              <Icon name="alert" size={14} />
              {warning}
            </p>
          )}
          {rows.length === 0 ? (
            <div className="set-row">
              <span className="faint">{t('aiServices.noUsage')}</span>
            </div>
          ) : (
            rows.map((r) => (
              <div className="set-row" key={r.provider}>
                <div className="set-row__k">
                  <b>{s.providers?.find((p) => p.provider === r.provider)?.name ?? r.provider}</b>
                  <span>
                    {t('aiServices.runs', { count: r.jobs })}
                    {r.unpriced_jobs > 0 &&
                      ` · ${t('aiServices.unpricedRuns', { count: r.unpriced_jobs })}`}
                  </span>
                </div>
                <span className="set-bar" aria-hidden="true">
                  <span style={{ width: `${String(max > 0 ? (r.cost_usd / max) * 100 : 0)}%` }} />
                </span>
                <span className="set-row__v num set-usage__amt">
                  {/* Unpriced runs are not in the amount: never claim US$0.00 for them. */}
                  {r.cost_usd === 0 && r.unpriced_jobs > 0
                    ? t('aiServices.noEst')
                    : formatUsd(r.cost_usd)}
                </span>
              </div>
            ))
          )}
        </div>
        <p className="set-fn">{t('aiServices.usageFoot')}</p>
      </section>
      <BudgetGroup store={store} s={s} />
    </>
  );
}

function BudgetGroup({ store, s }: { store: AiSettingsStore; s: AiSettingsState }) {
  const saved = s.settings?.monthly_budget_usd ?? null;
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(saved === null ? '' : String(saved));
  }, [saved]);
  const error = s.error?.target === 'budget' ? s.error.message : null;
  const busy = s.busy === 'budget';
  const changed = value.trim() !== (saved === null ? '' : String(saved));
  return (
    <section className="set-g" aria-labelledby="ai-g-remind">
      <h2 className="set-g__t" id="ai-g-remind">
        {t('aiServices.gRemind')}
      </h2>
      <form
        className="set-list"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          void store.setBudget(v === '' ? null : Number(v));
        }}
      >
        <div className="set-row">
          <div className="set-row__k">
            <label htmlFor="ai-budget">
              <b>{t('serviceSettings.aiBudgetLabel')}</b>
            </label>
            <span>{t('aiServices.budgetD')}</span>
          </div>
          <span className="ai-budget__field">
            <span aria-hidden="true">US$</span>
            <input
              id="ai-budget"
              className="input ai-budget__input"
              inputMode="decimal"
              placeholder={t('serviceSettings.aiBudgetPlaceholder')}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
              }}
            />
          </span>
          <button type="submit" className="btn btn--small" disabled={busy || !changed}>
            {t('common.save')}
          </button>
          {saved !== null && (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy}
              onClick={() => {
                void store.setBudget(null);
              }}
            >
              {t('serviceSettings.aiClear')}
            </button>
          )}
        </div>
      </form>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ---- 隱私 ---------------------------------------------------------------------------------

function PrivacyPanel({
  s,
  providers,
  onManage,
}: {
  s: AiSettingsState;
  providers: readonly AiProviderStatus[];
  onManage: (p: AiProvider) => void;
}) {
  return (
    <>
      <section className="set-g" aria-labelledby="ai-g-send">
        <h2 className="set-g__t" id="ai-g-send">
          {t('aiServices.gSendTo')}
        </h2>
        <div className="set-list">
          {providers.map((p) => {
            const state = providerState(p, s.tests[p.provider]);
            return (
              <div className="set-row" key={p.provider} data-provider={p.provider}>
                <span className="set-pi" aria-hidden="true">
                  {ABBR[p.provider]}
                </span>
                <div className="set-row__k">
                  <b>{p.name}</b>
                  <span>{destination(p)}</span>
                </div>
                {!p.key_configured ? (
                  <StateChip state={state} />
                ) : (
                  <span className={`set-st set-st--${p.consent === null ? 'warn' : 'ok'}`}>
                    <i aria-hidden="true" />
                    {t(p.consent === null ? 'aiServices.notConsented' : 'aiServices.consented')}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  aria-label={`${t('aiServices.manage')} ${p.name}`}
                  onClick={() => {
                    onManage(p.provider);
                  }}
                >
                  {t('aiServices.manage')}
                </button>
              </div>
            );
          })}
        </div>
        <p className="set-fn">{t('aiServices.privFoot')}</p>
      </section>
      <section className="set-g" aria-labelledby="ai-g-local">
        <h2 className="set-g__t" id="ai-g-local">
          {t('aiServices.gLocal')}
        </h2>
        <div className="set-list">
          <div className="set-row set-row--dim">
            <div className="set-row__k">
              <label htmlFor="sw-local">
                <b>{t('aiServices.localOnly')}</b>
              </label>
              <span>{t('aiServices.later')}</span>
            </div>
            <input id="sw-local" className="sw" type="checkbox" role="switch" disabled />
          </div>
        </div>
      </section>
    </>
  );
}
