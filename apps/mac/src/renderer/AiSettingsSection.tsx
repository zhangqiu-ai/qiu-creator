import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  AI_DEFAULT_MODELS,
  PatchAiProviderRequestSchema,
  SetAiKeyRequestSchema,
  suggestNewApiBaseUrl,
  type AiProviderStatus,
} from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type Ref } from 'react';
import { ModelCombobox } from './ModelCombobox.js';
import { AiSettingsStore, formatUsd, keyState, modelOptions, PROVIDER_USE } from './ai-settings.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
import { t } from './i18n.js';
import { budgetWarningText, companyText, noticeText } from './server-text.js';
import { Icon } from './Icon.js';

/**
 * 設定 → AI 服務 (QC-025, prototype board MacSettings plus the director-approved
 * additions): Keychain keys (write-only, never shown), first-use notice,
 * models, and the monthly reminder.
 */
export function AiSettingsSection({
  client,
  headingRef,
}: {
  client: CreatorHubClient;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const store = useMemo(() => new AiSettingsStore(client), [client]);
  const s = useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
  useEffect(() => {
    void store.load();
  }, [store]);

  return (
    <section className="settings__sec" aria-labelledby="set-ai">
      <h2 id="set-ai" className="settings__h" ref={headingRef} tabIndex={-1}>
        {t('serviceSettings.aiTitle')}
      </h2>
      <p className="settings__sub">{t('serviceSettings.aiSub')}</p>
      <div className="card">
        <div className="ln ln--dim">
          <div className="ln__main">
            <label className="ln__k" htmlFor="sw-local">
              {t('serviceSettings.aiLocalOnly')}
            </label>
            <span className="ln__v">{t('serviceSettings.aiLocalLater')}</span>
          </div>
          <input id="sw-local" className="sw" type="checkbox" role="switch" disabled />
        </div>
        {s.loadFailed ? (
          <div className="ln">
            <span className="ln__main muted">{t('serviceSettings.aiLoadFailed')}</span>
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
        ) : s.providers === null ? (
          <div className="ln" aria-busy="true">
            <span className="skel skel--line" style={{ width: '60%' }} />
          </div>
        ) : (
          s.providers.map((p) => <ProviderRow key={p.provider} store={store} p={p} />)
        )}
        <div className="ln ln--dim">
          <div className="ln__main">
            <span className="ln__k">{t('serviceSettings.aiLocalModels')}</span>
            <span className="ln__v">{t('serviceSettings.aiLater')}</span>
          </div>
          <Chip>{t('serviceSettings.aiNotEnabled')}</Chip>
        </div>
      </div>
      <BudgetCard store={store} />
      <p className="settings__note faint">{t('serviceSettings.aiNote')}</p>
    </section>
  );
}

function ProviderRow({ store, p }: { store: AiSettingsStore; p: AiProviderStatus }) {
  const s = store.snapshot;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  /** A corrected Base URL to offer before saving (QC-054), e.g. with /v1 added. */
  const [suggested, setSuggested] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const isNewApi = p.provider === 'new-api';
  const state = keyState(p);
  const busy = s.busy === p.provider;
  const error = s.error?.target === p.provider ? s.error.message : null;
  const inputId = `ai-key-${p.provider}`;
  const formId = `ai-key-form-${p.provider}`;
  const baseUrlId = 'ai-base-url-new-api';

  const clearCredentials = () => {
    setKey('');
    setBaseUrl('');
    setBaseUrlError(null);
    setSuggested(null);
  };

  const save = () => {
    if (busy) return;
    const url = isNewApi ? baseUrl.trim() : undefined;
    if (url === '') {
      setBaseUrlError(t('serviceSettings.aiBaseUrlRequired'));
      return;
    }
    if (url !== undefined && !SetAiKeyRequestSchema.shape.base_url.safeParse(url).success) {
      setBaseUrlError(t('serviceSettings.aiBaseUrlInvalid'));
      // Missing /v1 (or a pasted endpoint): offer the fixed URL; it is never changed silently.
      setSuggested(suggestNewApiBaseUrl(url));
      return;
    }
    clearCredentials();
    void store.saveKey(p.provider, key, url).then((ok) => {
      if (ok) setEditing(false);
    });
  };

  return (
    <div className="ai-set" data-provider={p.provider} role="group" aria-label={p.name}>
      <div className="ln">
        <div className="ln__main">
          <span className="ln__k">{p.name}</span>
          <span className="ln__v">
            {t('serviceSettings.aiProviderMeta', {
              use: PROVIDER_USE[p.provider],
              company: companyText(p),
            })}
          </span>
        </div>
        <span role="status">
          {state === 'ready' ? (
            <Chip tone="ok">
              <Icon name="key" size={12} />
              {t('serviceSettings.aiKeychainReady')}
            </Chip>
          ) : state === 'needs_consent' ? (
            <Chip tone="warn">{t('serviceSettings.aiNeedsConsent')}</Chip>
          ) : (
            <Chip>{t('serviceSettings.aiKeyNone')}</Chip>
          )}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          aria-expanded={editing}
          aria-controls={formId}
          disabled={busy}
          onClick={() => {
            setEditing((v) => !v);
            clearCredentials();
          }}
        >
          {p.key_configured ? t('serviceSettings.aiReplace') : t('serviceSettings.add')}
        </button>
      </div>

      {editing && (
        <form
          id={formId}
          className="ln ai-set__form"
          noValidate={isNewApi}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {isNewApi && (
            <div className="field ai-set__base-url">
              <label className="field__label" htmlFor={baseUrlId}>
                New API Base URL
              </label>
              <input
                id={baseUrlId}
                className="input"
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://relay.example.com/v1"
                aria-describedby={`${baseUrlId}-hint${baseUrlError === null ? '' : ` ${baseUrlId}-error`}`}
                aria-invalid={baseUrlError !== null}
                required
                disabled={busy}
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setBaseUrlError(null);
                  setSuggested(null);
                }}
                onBlur={(e) => {
                  setSuggested(suggestNewApiBaseUrl(e.target.value));
                }}
              />
              <span className="ai-set__hint faint" id={`${baseUrlId}-hint`}>
                {t('serviceSettings.aiBaseUrlHint')}
              </span>
              {baseUrlError !== null && (
                <span className="ln__err" id={`${baseUrlId}-error`} role="alert">
                  {baseUrlError}
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
                      setBaseUrlError(null);
                    }}
                  >
                    {t('modelPicker.baseUrlUseSuggested')}
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="field ai-set__key">
            <label className={isNewApi ? 'field__label' : 'visually-hidden'} htmlFor={inputId}>
              {t('serviceSettings.aiKeyLabel', { name: p.name })}
            </label>
            <input
              id={inputId}
              className="input"
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
          </div>
          <button
            type="submit"
            className="btn btn--primary btn--small"
            disabled={busy || key.trim() === ''}
          >
            {t('serviceSettings.aiSaveToKeychain')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              clearCredentials();
              setEditing(false);
            }}
          >
            {t('common.cancel')}
          </button>
        </form>
      )}

      {p.key_configured && (
        <div className={`ln ai-set__detail${isNewApi ? ' ai-set__detail--new-api' : ''}`}>
          <div className="ln__main">
            <span className="ln__v">
              {t('serviceSettings.aiKeySet')}
              {p.key_updated_at !== null &&
                ` · ${t('serviceSettings.aiKeyStoredAt', { when: formatWhen(p.key_updated_at) })}`}
              {p.consent !== null &&
                ` · ${t('serviceSettings.aiConsentAt', { when: formatWhen(p.consent.at) })}`}
            </span>
            <div className="ai-set__models">
              {p.provider === 'new-api' ? (
                <NewApiModelForm store={store} model={p.text_model} busy={busy} />
              ) : (
                <>
                  <ModelSelect store={store} p={p} kind="text" />
                  {p.video_model !== null && <ModelSelect store={store} p={p} kind="video" />}
                </>
              )}
            </div>
          </div>
          <div className="ln__actions">
            {p.consent !== null && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={busy}
                onClick={() => {
                  setConfirmWithdraw(true);
                }}
              >
                {t('serviceSettings.aiWithdraw')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              {t('serviceSettings.aiDeleteKey')}
            </button>
          </div>
        </div>
      )}

      {state === 'needs_consent' && (
        <div
          className="ai-set__notice"
          role="group"
          aria-label={t('serviceSettings.aiNoticeLabel', { name: p.name })}
        >
          <span className="ai-set__notice-title">
            <Icon name="alert" />
            {t(isNewApi ? 'serviceSettings.aiNoticeAgain' : 'serviceSettings.aiNoticeFirst', {
              company: companyText(p),
            })}
          </span>
          <p className="ai-set__notice-text">{noticeText(p.notice)}</p>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={busy}
            onClick={() => {
              void store.consent(
                p.provider,
                p.notice.version,
                isNewApi ? p.notice.credential_id : undefined,
              );
            }}
          >
            {t('serviceSettings.aiConsentAction')}
          </button>
        </div>
      )}

      {error !== null && (
        <p className="ln ln__err" role="alert">
          {error}
        </p>
      )}

      {confirmWithdraw && (
        <Dialog
          title={t('serviceSettings.aiWithdrawTitle', { name: p.name })}
          onClose={() => {
            setConfirmWithdraw(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setConfirmWithdraw(false);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setConfirmWithdraw(false);
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

      {confirmDelete && (
        <Dialog
          title={t('serviceSettings.aiDeleteTitle', { name: p.name })}
          onClose={() => {
            setConfirmDelete(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setConfirmDelete(false);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--danger-solid"
                onClick={() => {
                  setConfirmDelete(false);
                  void store.deleteKey(p.provider);
                }}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          <div className="form">
            <p>
              {isNewApi
                ? t('serviceSettings.aiDeleteBodyNewApi')
                : t('serviceSettings.aiDeleteBody', { name: p.name })}
            </p>
            <p className="muted">{t('serviceSettings.aiDeleteNote')}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** New API's text model: picked from the relay's list, or typed (QC-054). */
function NewApiModelForm({
  store,
  model,
  busy,
}: {
  store: AiSettingsStore;
  model: string;
  busy: boolean;
}) {
  return (
    <ModelCombobox
      id="ai-text-model-new-api"
      label={t('serviceSettings.aiNewApiModelLabel')}
      hint={t('serviceSettings.aiNewApiModelHint', { model: AI_DEFAULT_MODELS['new-api'].text })}
      saved={model}
      busy={busy}
      load={(refresh) => store.newApiModels(refresh)}
      onSave={(next) => store.setModel('new-api', 'text', next)}
      validate={(next) => {
        const parsed = PatchAiProviderRequestSchema.safeParse({ text_model: next });
        return parsed.success && parsed.data.text_model !== undefined;
      }}
      invalidMessage={t('serviceSettings.aiModelInvalid')}
    />
  );
}

function ModelSelect({
  store,
  p,
  kind,
}: {
  store: AiSettingsStore;
  p: AiProviderStatus;
  kind: 'text' | 'video';
}) {
  const current = kind === 'text' ? p.text_model : p.video_model;
  const options = modelOptions(p.provider, current);
  return (
    <label className="ai-set__model">
      <span className="faint">
        {kind === 'text' ? t('serviceSettings.aiTextModel') : t('serviceSettings.aiVideoModel')}
      </span>
      <select
        className="select"
        value={current ?? ''}
        disabled={store.snapshot.busy === p.provider}
        onChange={(e) => {
          void store.setModel(p.provider, kind, e.target.value);
        }}
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}

function BudgetCard({ store }: { store: AiSettingsStore }) {
  const s = store.snapshot;
  const saved = s.settings?.monthly_budget_usd ?? null;
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(saved === null ? '' : String(saved));
  }, [saved]);
  const budget = s.usage?.budget ?? null;
  const error = s.error?.target === 'budget' ? s.error.message : null;
  const busy = s.busy === 'budget';
  const changed = value.trim() !== (saved === null ? '' : String(saved));
  return (
    <div className="card ai-budget">
      <form
        className="ln"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          void store.setBudget(v === '' ? null : Number(v));
        }}
      >
        <div className="ln__main">
          <label className="ln__k" htmlFor="ai-budget">
            {t('serviceSettings.aiBudgetLabel')}
          </label>
          <span className="ln__v">
            {saved === null
              ? t('serviceSettings.aiBudgetNoReminder', {
                  spent: formatUsd(budget?.spent_usd ?? null),
                })
              : t('serviceSettings.aiBudgetReminder', {
                  spent: formatUsd(budget?.spent_usd ?? null),
                  amount: formatUsd(saved),
                })}
          </span>
          {budget !== null && budgetWarningText(budget) !== null && (
            <span className="ai-budget__warn" role="status">
              {budgetWarningText(budget)}
            </span>
          )}
          {error !== null && (
            <span className="ln__err" role="alert">
              {error}
            </span>
          )}
        </div>
        <span className="ai-budget__field">
          <span aria-hidden="true">$</span>
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
      </form>
    </div>
  );
}
