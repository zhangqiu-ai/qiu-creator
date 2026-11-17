import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { ApiToken, TokenScope } from '@qiu-creator/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
import { Icon } from './Icon.js';

export const SCOPE_LABEL: Readonly<Record<TokenScope, string>> = {
  read: '讀取',
  import: '匯入',
  write: '寫入',
};

const SCOPE_HINT: Readonly<Record<TokenScope, string>> = {
  read: '讀取作品、素材、任務與變更事件',
  import: '建立作品、上傳素材、URL 匯入、重試任務',
  write: '修改作品內容與素材關聯',
};

const SCOPES: readonly TokenScope[] = ['read', 'import', 'write'];

/** Active tokens first (newest first), then revoked ones. */
export function sortTokens(tokens: readonly ApiToken[]): ApiToken[] {
  return [...tokens].sort((a, b) => {
    const ra = a.revoked_at === null ? 0 : 1;
    const rb = b.revoked_at === null ? 0 : 1;
    return ra !== rb ? ra - rb : b.created_at.localeCompare(a.created_at);
  });
}

/**
 * Agent 權杖 (MacImports board, right column). The secret is shown once,
 * right after creation, and never again; revoking asks first.
 */
export function TokensPanel({ client }: { client: CreatorHubClient }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const load = useCallback(() => {
    client.tokens
      .list()
      .then((res) => {
        setFailed(false);
        setTokens(sortTokens(res.items));
      })
      .catch(() => {
        setFailed(true);
      });
  }, [client]);
  useEffect(load, [load]);

  return (
    <section className="card side-card" aria-labelledby="tokens-title">
      <div className="side-card__head">
        <h2 id="tokens-title" className="side-card__title">
          Agent 權杖
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Icon name="plus" size={14} />
          新增
        </button>
      </div>
      {failed ? (
        <div className="side-card__row">
          <span className="muted">無法載入權杖</span>
          <button type="button" className="btn btn--small" onClick={load}>
            重試
          </button>
        </div>
      ) : tokens === null ? (
        <div className="side-card__row" aria-busy="true">
          <span className="skel skel--line" style={{ width: '70%' }} />
        </div>
      ) : tokens.length === 0 ? (
        <p className="side-card__empty muted">
          還沒有權杖。外部 Agent（如 Claude Code）要用權杖呼叫本機 API。
        </p>
      ) : (
        <ul className="tokens">
          {tokens.map((t) => (
            <li key={t.id} className="token">
              <Icon name="key" />
              <div className="token__main">
                <span className="token__name">{t.name}</span>
                <span className="faint token__meta">
                  <span className="mono">{t.prefix}…</span>
                  {' · '}
                  {SCOPES.filter((s) => t.scopes.includes(s))
                    .map((s) => SCOPE_LABEL[s])
                    .join('、')}
                  {' · '}
                  {t.revoked_at !== null
                    ? `${formatWhen(t.revoked_at)} 撤銷`
                    : t.last_used_at === null
                      ? '未使用'
                      : `${formatWhen(t.last_used_at)} 使用`}
                </span>
              </div>
              {t.revoked_at === null ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--small btn--danger"
                  aria-label={`撤銷 ${t.name}`}
                  onClick={() => {
                    setRevoking(t);
                  }}
                >
                  撤銷
                </button>
              ) : (
                <Chip>已撤銷</Chip>
              )}
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateTokenDialog
          client={client}
          onClose={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {revoking !== null && (
        <RevokeDialog
          client={client}
          token={revoking}
          onClose={() => {
            setRevoking(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function CreateTokenDialog({ client, onClose }: { client: CreatorHubClient; onClose: () => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<TokenScope>>(new Set(['read', 'import']));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = () => {
    if (busy) return;
    if (name.trim() === '') {
      setError('請輸入名稱');
      return;
    }
    if (scopes.size === 0) {
      setError('至少選一項權限');
      return;
    }
    setBusy(true);
    setError(null);
    client.tokens
      .create({ name: name.trim(), scopes: SCOPES.filter((s) => scopes.has(s)) })
      .then((res) => {
        setSecret(res.secret);
      })
      .catch(() => {
        setBusy(false);
        setError('建立失敗，請確認本機服務是否運行');
      });
  };

  if (secret !== null) {
    return (
      <Dialog
        title="權杖已建立"
        onClose={onClose}
        closable={false}
        footer={
          <button type="button" className="btn btn--primary dialog__primary" onClick={onClose}>
            完成
          </button>
        }
      >
        <div className="form">
          <p className="field__warn" role="status">
            這是唯一一次顯示完整權杖。關閉後無法再查看，遺失了只能撤銷再建立新的。
          </p>
          <div className="secret">
            <code className="mono secret__value" data-autofocus tabIndex={0}>
              {secret}
            </code>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void window.creatorhub?.copyText(secret).then(() => {
                  setCopied(true);
                });
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? '已複製' : '複製'}
            </button>
          </div>
          <p className="faint">
            Agent 呼叫時帶上標頭 <span className="mono">Authorization: Bearer &lt;權杖&gt;</span>
            ；建立作品與匯入要另帶 <span className="mono">Idempotency-Key</span>。
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="新增 Agent 權杖"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost dialog__primary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={create}>
            建立
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field__label">名稱</span>
          <input
            data-autofocus
            className="input"
            type="text"
            placeholder="例如 claude-code"
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                create();
              }
            }}
          />
        </label>
        <fieldset className="field">
          <legend className="field__label">權限</legend>
          {SCOPES.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={scopes.has(s)}
                onChange={(e) => {
                  const next = new Set(scopes);
                  if (e.target.checked) next.add(s);
                  else next.delete(s);
                  setScopes(next);
                  setError(null);
                }}
              />
              <span>{SCOPE_LABEL[s]}</span>
              <span className="faint">{SCOPE_HINT[s]}</span>
            </label>
          ))}
          <p className="faint">權杖不能管理其他權杖。只給 Agent 需要的權限。</p>
        </fieldset>
        {error !== null && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function RevokeDialog({
  client,
  token,
  onClose,
}: {
  client: CreatorHubClient;
  token: ApiToken;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={`撤銷「${token.name}」？`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost dialog__primary"
            data-autofocus
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn--danger-solid"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              client.tokens
                .revoke(token.id)
                .then(onClose)
                .catch(() => {
                  setBusy(false);
                  setError('撤銷失敗，請稍後再試');
                });
            }}
          >
            撤銷
          </button>
        </>
      }
    >
      <div className="form">
        <p>使用這個權杖的 Agent 會立即無法存取本機 API。撤銷後不能恢復，只能建立新的權杖。</p>
        {error !== null && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
