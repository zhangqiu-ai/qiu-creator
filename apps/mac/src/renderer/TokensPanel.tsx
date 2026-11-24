import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { ApiToken, TokenScope } from '@qiu-creator/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';

export const SCOPE_LABEL: Readonly<Record<TokenScope, string>> = {
  get read() {
    return t('serviceSettings.scopeRead');
  },
  get import() {
    return t('serviceSettings.scopeImport');
  },
  get write() {
    return t('serviceSettings.scopeWrite');
  },
  // QC-089: the scope exists in the API; the token settings UI comes in QC-091.
  get propose() {
    return t('serviceSettings.scopePropose');
  },
};

const SCOPE_HINT: Readonly<Record<TokenScope, string>> = {
  get read() {
    return t('serviceSettings.scopeReadHint');
  },
  get import() {
    return t('serviceSettings.scopeImportHint');
  },
  get write() {
    return t('serviceSettings.scopeWriteHint');
  },
  get propose() {
    return t('serviceSettings.scopeProposeHint');
  },
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
          {t('serviceSettings.tokensTitle')}
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Icon name="plus" size={14} />
          {t('serviceSettings.add')}
        </button>
      </div>
      {failed ? (
        <div className="side-card__row">
          <span className="muted">{t('serviceSettings.tokensLoadFailed')}</span>
          <button type="button" className="btn btn--small" onClick={load}>
            {t('common.retry')}
          </button>
        </div>
      ) : tokens === null ? (
        <div className="side-card__row" aria-busy="true">
          <span className="skel skel--line" style={{ width: '70%' }} />
        </div>
      ) : tokens.length === 0 ? (
        <p className="side-card__empty muted">{t('serviceSettings.tokensEmpty')}</p>
      ) : (
        <ul className="tokens">
          {tokens.map((token) => (
            <li key={token.id} className="token">
              <Icon name="key" />
              <div className="token__main">
                <span className="token__name">{token.name}</span>
                <span className="faint token__meta">
                  <span className="mono">{token.prefix}…</span>
                  {' · '}
                  {SCOPES.filter((s) => token.scopes.includes(s))
                    .map((s) => SCOPE_LABEL[s])
                    .join(t('common.listSeparator'))}
                  {' · '}
                  {token.revoked_at !== null
                    ? t('serviceSettings.tokenRevokedAt', { when: formatWhen(token.revoked_at) })
                    : token.last_used_at === null
                      ? t('serviceSettings.tokenUnused')
                      : t('serviceSettings.tokenUsedAt', {
                          when: formatWhen(token.last_used_at),
                        })}
                </span>
              </div>
              {token.revoked_at === null ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--small btn--danger"
                  aria-label={t('serviceSettings.tokenRevokeAria', { name: token.name })}
                  onClick={() => {
                    setRevoking(token);
                  }}
                >
                  {t('serviceSettings.tokenRevoke')}
                </button>
              ) : (
                <Chip>{t('serviceSettings.tokenRevoked')}</Chip>
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
      setError(t('serviceSettings.tokenNameRequired'));
      return;
    }
    if (scopes.size === 0) {
      setError(t('serviceSettings.tokenScopeRequired'));
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
        setError(t('serviceSettings.tokenCreateFailed'));
      });
  };

  if (secret !== null) {
    return (
      <Dialog
        title={t('serviceSettings.tokenCreatedTitle')}
        onClose={onClose}
        closable={false}
        footer={
          <button type="button" className="btn btn--primary dialog__primary" onClick={onClose}>
            {t('common.done')}
          </button>
        }
      >
        <div className="form">
          <p className="field__warn" role="status">
            {t('serviceSettings.tokenSecretWarn')}
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
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <p className="faint">
            {t('serviceSettings.tokenHeaderHintLead')}{' '}
            <span className="mono">{t('serviceSettings.tokenBearerHeader')}</span>
            {t('serviceSettings.tokenHeaderHintMid')} <span className="mono">Idempotency-Key</span>
            {t('serviceSettings.tokenHeaderHintEnd')}
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('serviceSettings.tokenCreateTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost dialog__primary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={create}>
            {t('serviceSettings.tokenCreate')}
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field__label">{t('serviceSettings.tokenName')}</span>
          <input
            data-autofocus
            className="input"
            type="text"
            placeholder={t('serviceSettings.tokenNamePlaceholder')}
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
          <legend className="field__label">{t('serviceSettings.tokenScopes')}</legend>
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
          <p className="faint">{t('serviceSettings.tokenScopeNote')}</p>
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
      title={t('serviceSettings.tokenRevokeTitle', { name: token.name })}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost dialog__primary"
            data-autofocus
            onClick={onClose}
          >
            {t('common.cancel')}
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
                  setError(t('serviceSettings.tokenRevokeFailed'));
                });
            }}
          >
            {t('serviceSettings.tokenRevoke')}
          </button>
        </>
      }
    >
      <div className="form">
        <p>{t('serviceSettings.tokenRevokeBody')}</p>
        {error !== null && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
