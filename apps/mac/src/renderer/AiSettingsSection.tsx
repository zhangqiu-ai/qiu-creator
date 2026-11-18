import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { AiProviderStatus } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type Ref } from 'react';
import { AiSettingsStore, formatUsd, keyState, modelOptions, PROVIDER_USE } from './ai-settings.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
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
        AI 服務
      </h2>
      <div className="card">
        <div className="ln ln--dim">
          <div className="ln__main">
            <label className="ln__k" htmlFor="sw-local">
              僅本地模型
            </label>
            <span className="ln__v">本地模型延後提供</span>
          </div>
          <input id="sw-local" className="sw" type="checkbox" role="switch" disabled />
        </div>
        {s.loadFailed ? (
          <div className="ln">
            <span className="ln__main muted">無法載入 AI 設定</span>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void store.load();
              }}
            >
              重試
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
            <span className="ln__k">本地模型</span>
            <span className="ln__v">延後提供</span>
          </div>
          <Chip>未啟用</Chip>
        </div>
      </div>
      <BudgetCard store={store} />
      <p className="settings__note faint">
        金鑰只存在這台 Mac 的鑰匙圈，存好後不會再顯示，也不會傳到 iPhone／iPad。
      </p>
    </section>
  );
}

function ProviderRow({ store, p }: { store: AiSettingsStore; p: AiProviderStatus }) {
  const s = store.snapshot;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = keyState(p);
  const busy = s.busy === p.provider;
  const error = s.error?.target === p.provider ? s.error.message : null;
  const inputId = `ai-key-${p.provider}`;

  const save = () => {
    const value = key;
    // Never keep the key in this window longer than the request.
    setKey('');
    void store.saveKey(p.provider, value).then((ok) => {
      if (ok) setEditing(false);
    });
  };

  return (
    <div className="ai-set" data-provider={p.provider}>
      <div className="ln">
        <div className="ln__main">
          <span className="ln__k">{p.name}</span>
          <span className="ln__v">
            {PROVIDER_USE[p.provider]} · 送到 {p.company}
          </span>
        </div>
        <span role="status">
          {state === 'ready' ? (
            <Chip tone="ok">
              <Icon name="key" size={12} />
              鑰匙圈 · 已啟用
            </Chip>
          ) : state === 'needs_consent' ? (
            <Chip tone="warn">待確認告知</Chip>
          ) : (
            <Chip>未設定</Chip>
          )}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          aria-expanded={editing}
          aria-controls={inputId}
          disabled={busy}
          onClick={() => {
            setEditing((v) => !v);
            setKey('');
          }}
        >
          {p.key_configured ? '更換' : '新增'}
        </button>
      </div>

      {editing && (
        <form
          className="ln ai-set__form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="visually-hidden" htmlFor={inputId}>
            {p.name} API 金鑰
          </label>
          <input
            id={inputId}
            className="input ai-set__key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${p.name} API 金鑰`}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
            }}
          />
          <button
            type="submit"
            className="btn btn--primary btn--small"
            disabled={busy || key === ''}
          >
            存到鑰匙圈
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              setKey('');
              setEditing(false);
            }}
          >
            取消
          </button>
        </form>
      )}

      {p.key_configured && (
        <div className="ln ai-set__detail">
          <div className="ln__main">
            <span className="ln__v">
              已設定
              {p.key_updated_at !== null && ` · ${formatWhen(p.key_updated_at)}存入`}
              {p.consent !== null && ` · ${formatWhen(p.consent.at)}確認告知`}
            </span>
            <div className="ai-set__models">
              <ModelSelect store={store} p={p} kind="text" />
              {p.video_model !== null && <ModelSelect store={store} p={p} kind="video" />}
            </div>
          </div>
          <div className="ln__actions">
            {p.consent !== null && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={busy}
                onClick={() => {
                  void store.withdrawConsent(p.provider);
                }}
              >
                撤回確認
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
              刪除金鑰
            </button>
          </div>
        </div>
      )}

      {state === 'needs_consent' && (
        <div className="ai-set__notice" role="group" aria-label={`${p.name} 使用告知`}>
          <span className="ai-set__notice-title">
            <Icon name="alert" />
            首次使用前請確認：內容會送到 {p.company}
          </span>
          <p className="ai-set__notice-text">{p.notice.text}</p>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={busy}
            onClick={() => {
              void store.consent(p.provider, p.notice.version);
            }}
          >
            我已了解，啟用
          </button>
        </div>
      )}

      {error !== null && (
        <p className="ln ln__err" role="alert">
          {error}
        </p>
      )}

      {confirmDelete && (
        <Dialog
          title={`刪除 ${p.name} 金鑰？`}
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
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger-solid"
                onClick={() => {
                  setConfirmDelete(false);
                  void store.deleteKey(p.provider);
                }}
              >
                刪除
              </button>
            </>
          }
        >
          <div className="form">
            <p>從鑰匙圈移除這個金鑰。之後使用 {p.name} 需要重新輸入。</p>
            <p className="muted">已排隊、尚未送出的任務會直接失敗，不會送出。</p>
          </div>
        </Dialog>
      )}
    </div>
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
      <span className="faint">{kind === 'text' ? '文字模型' : '視頻模型'}</span>
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
            每月提醒金額
          </label>
          <span className="ln__v">
            本月 {formatUsd(budget?.spent_usd ?? null)}（估算）
            {saved === null ? ' · 未設定提醒' : ` · 超過 ${formatUsd(saved)} 時提醒，不會擋下任務`}
          </span>
          {budget?.over_budget === true && budget.warning !== null && (
            <span className="ai-budget__warn" role="status">
              {budget.warning}
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
            placeholder="未設定"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </span>
        <button type="submit" className="btn btn--small" disabled={busy || !changed}>
          儲存
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
            清除
          </button>
        )}
      </form>
    </div>
  );
}
