import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  ApiToken,
  Project,
  Revision,
  TokenActivity,
  TokenScope,
  UpdateTokenRequest,
} from '@qiu-creator/contracts';
import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import {
  ACTIVITY_ICON,
  activityKind,
  activityText,
  mcpConfig,
  SCOPE_HINT,
  SCOPE_LABEL,
  SCOPES,
  scopeSummary,
  sortTokens,
  tokenChangeText,
  toggleScope,
} from './agents-settings.js';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { projectColor } from './projects-store.js';
import { ProjectsContext } from './ProjectTags.js';
import { Avatar } from './ProposalView.js';
import { useToast } from './toasts.js';
import './agents-settings.css';

type Notice = { text: string; tone: 'ok' | 'bad' } | null;

const NONE = (): (() => void) => () => undefined;
const NO_PROJECTS = (): readonly Project[] => [];

function useProjectList(): readonly Project[] {
  const store = useContext(ProjectsContext);
  return useSyncExternalStore(
    store?.subscribe ?? NONE,
    () => store?.getSnapshot().projects ?? NO_PROJECTS(),
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    if (window.creatorhub !== undefined) await window.creatorhub.copyText(text);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 設定 › Agent 與 MCP (QC-091, PT-20261124-001): the agent tokens (moved here
 * from 匯入任務), each with its scopes, the 允許直接修改正文 switch (behind a
 * confirmation), the projects it may touch, and its recent activity, where a
 * direct edit can be undone with one click. 複製 MCP 設定 copies the agent's
 * config entry.
 */
export function AgentsSettings({ client }: { client: CreatorHubClient }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useToast(
    notice === null
      ? null
      : {
          message: notice.text,
          tone: notice.tone,
          onClose: () => {
            setNotice(null);
          },
        },
  );
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const load = useCallback(() => {
    client.tokens
      .list()
      .then((res) => {
        setFailed(false);
        const sorted = sortTokens(res.items);
        setTokens(sorted);
        setSelected((s) =>
          s !== null && sorted.some((x) => x.id === s) ? s : (sorted[0]?.id ?? null),
        );
      })
      .catch(() => {
        setFailed(true);
      });
  }, [client]);
  useEffect(load, [load]);

  const token = tokens?.find((x) => x.id === selected) ?? null;
  const live = tokens?.filter((x) => x.revoked_at === null).length ?? 0;

  return (
    <section className="set-sec ag" aria-labelledby="set-agents">
      <header className="set-h">
        <h1 id="set-agents" className="set-h__title" tabIndex={-1}>
          {t('agents.settingsTitle')}
        </h1>
        <div className="set-h__r">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void copy(mcpConfig(null)).then((ok) => {
                setNotice(
                  ok
                    ? { text: t('agents.mcpCopied'), tone: 'ok' }
                    : { text: t('agents.copyFailed'), tone: 'bad' },
                );
              });
            }}
          >
            <Icon name="copy" size={14} />
            {t('agents.copyMcp')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Icon name="plus" size={14} />
            {t('agents.newToken')}
          </button>
        </div>
      </header>

      <div className="ag__cols">
        <section className="ag__list" aria-label={t('agents.tokensLabel')}>
          <h2 className="set-g__t">{t('agents.tokensCount', { count: live })}</h2>
          {failed ? (
            <div className="set-list ag__empty">
              <span className="muted">{t('serviceSettings.tokensLoadFailed')}</span>
              <button type="button" className="btn btn--small" onClick={load}>
                {t('common.retry')}
              </button>
            </div>
          ) : tokens === null ? (
            <div className="set-list ag__empty" aria-busy="true" />
          ) : tokens.length === 0 ? (
            <div className="set-list ag__empty">
              <b>{t('agents.noTokens')}</b>
              <span className="faint">{t('agents.noTokensHint')}</span>
            </div>
          ) : (
            <ul className="ag__tokens">
              {tokens.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className={x.revoked_at === null ? 'ag-token' : 'ag-token ag-token--revoked'}
                    aria-current={x.id === selected ? 'true' : undefined}
                    onClick={() => {
                      setSelected(x.id);
                    }}
                  >
                    <Avatar name={x.name} size={30} />
                    <span className="ag-token__main">
                      <span className="ag-token__name">{x.name}</span>
                      <span className="ag-token__scopes">{scopeSummary(x.scopes)}</span>
                      <span className="ag-token__foot">
                        {x.revoked_at !== null && (
                          <span className="chip">{t('serviceSettings.tokenRevoked')}</span>
                        )}
                        {x.revoked_at === null && x.allow_direct_body_edit === true && (
                          <span className="chip chip--warn">{t('agents.canDirect')}</span>
                        )}
                        {x.revoked_at === null && (x.project_ids ?? null) !== null && (
                          <span className="chip">
                            {t('agents.limitedTo', { count: x.project_ids?.length ?? 0 })}
                          </span>
                        )}
                        <span className="faint ag-token__when">
                          {x.last_used_at === null
                            ? t('agents.neverUsed')
                            : formatWhen(x.last_used_at)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {token !== null && (
          <TokenDetail
            key={token.id}
            client={client}
            token={token}
            onUpdated={(next) => {
              setTokens((list) =>
                list === null ? list : list.map((x) => (x.id === next.id ? next : x)),
              );
            }}
            onRevoked={load}
            onNotice={setNotice}
          />
        )}
      </div>

      {creating && (
        <CreateTokenDialog
          client={client}
          onCreated={(id) => {
            setSelected(id);
            load();
          }}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </section>
  );
}

function TokenDetail({
  client,
  token,
  onUpdated,
  onRevoked,
  onNotice,
}: {
  client: CreatorHubClient;
  token: ApiToken;
  onUpdated: (token: ApiToken) => void;
  onRevoked: () => void;
  onNotice: (n: Notice) => void;
}) {
  const projects = useProjectList();
  const [confirmDirect, setConfirmDirect] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activityEpoch, setActivityEpoch] = useState(0);
  const revoked = token.revoked_at !== null;
  const direct = token.allow_direct_body_edit === true;
  const limited = token.project_ids ?? null;
  // 只限這些項目 picked but no project added yet: shown, not saved (the API needs one).
  const [onlyDraft, setOnlyDraft] = useState(false);
  const onlyMode = limited !== null || onlyDraft;

  /** Shown at once (a checkbox follows the click), put back if the service refuses. */
  const update = (input: UpdateTokenRequest) => {
    if (busy) return;
    setBusy(true);
    const before = token;
    onUpdated({ ...token, ...input });
    client.tokens
      .update(token.id, input)
      .then((next) => {
        onUpdated(next);
        setActivityEpoch((n) => n + 1);
      })
      .catch(() => {
        onUpdated(before);
        onNotice({ text: t('agents.updateFailed'), tone: 'bad' });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const limitNames = (limited ?? [])
    .map((id) => projects.find((p) => p.id === id)?.name)
    .filter((n): n is string => n !== undefined);

  return (
    <section className="ag__detail" aria-labelledby={`ag-name-${token.id}`}>
      <header className="ag__head">
        <Avatar name={token.name} size={40} />
        <div className="ag__who">
          <h2 id={`ag-name-${token.id}`} className="ag__name">
            {token.name}
          </h2>
          <span className="faint">
            {t('agents.createdOn', { date: formatWhen(token.created_at) })}
            {' · '}
            {revoked
              ? t('serviceSettings.tokenRevokedAt', { when: formatWhen(token.revoked_at ?? '') })
              : token.last_used_at === null
                ? t('agents.neverUsed')
                : t('agents.lastUsed', { when: formatWhen(token.last_used_at) })}
            {' · '}
            <span className="mono">{token.prefix}…</span>
          </span>
        </div>
        {!revoked && (
          <button
            type="button"
            className="btn btn--ghost btn--danger ag__revoke"
            onClick={() => {
              setRevoking(true);
            }}
          >
            {t('agents.revokeToken')}
          </button>
        )}
      </header>

      <section className="set-g">
        <h3 className="set-g__t">{t('agents.whatCan')}</h3>
        <div className="set-list">
          {SCOPES.map((s) => (
            <label key={s} className="set-row ag-scope">
              <input
                type="checkbox"
                checked={token.scopes.includes(s)}
                disabled={revoked || busy}
                onChange={() => {
                  const next = toggleScope(token.scopes, s);
                  if (next === null) onNotice({ text: t('agents.scopeAtLeastOne'), tone: 'bad' });
                  else update({ scopes: next });
                }}
              />
              <span className="ag-scope__text">
                <span>
                  {SCOPE_LABEL[s]} <code className="ag-scope__code">{s}</code>
                </span>
                <span className="faint">{SCOPE_HINT[s]}</span>
              </span>
            </label>
          ))}
          <label className={direct ? 'set-row ag-direct ag-direct--on' : 'set-row ag-direct'}>
            <span className="ag-scope__text">
              <span>{t('agents.direct')}</span>
              <span className="faint">{t(direct ? 'agents.directOn' : 'agents.directOff')}</span>
            </span>
            <input
              className="sw ag-direct__sw"
              type="checkbox"
              role="switch"
              checked={direct}
              disabled={revoked || busy}
              onChange={() => {
                if (direct) update({ allow_direct_body_edit: false });
                else setConfirmDirect(true);
              }}
            />
          </label>
        </div>
      </section>

      <section className="set-g">
        <h3 className="set-g__t">{t('agents.projectsTitle')}</h3>
        <div className="set-list" role="radiogroup" aria-label={t('agents.projectsTitle')}>
          <label className="set-row ag-radio">
            <input
              type="radio"
              name={`ag-scope-${token.id}`}
              checked={!onlyMode}
              disabled={revoked || busy}
              onChange={() => {
                setOnlyDraft(false);
                if (limited !== null) update({ project_ids: null });
              }}
            />
            <span>{t('agents.allWorks')}</span>
          </label>
          <div className="set-row set-row--top ag-radio">
            <input
              id={`ag-only-${token.id}`}
              type="radio"
              name={`ag-scope-${token.id}`}
              checked={onlyMode}
              disabled={revoked || busy}
              onChange={() => {
                setOnlyDraft(true);
              }}
            />
            <div className="ag-scope__text">
              <label htmlFor={`ag-only-${token.id}`}>{t('agents.onlyProjects')}</label>
              <span className="faint">{t('agents.onlyHint')}</span>
              {onlyMode && (
                <div className="ag-projects">
                  {(limited ?? []).map((id) => {
                    const p = projects.find((x) => x.id === id);
                    const name = p?.name ?? id;
                    return (
                      <span key={id} className="ag-chip">
                        <i style={{ background: projectColor(p?.color ?? 0) }} />
                        {name}
                        <button
                          type="button"
                          aria-label={t('agents.removeProjectAria', { name })}
                          disabled={revoked || busy}
                          onClick={() => {
                            const rest = (limited ?? []).filter((x) => x !== id);
                            if (rest.length === 0) {
                              setOnlyDraft(true);
                              update({ project_ids: null });
                            } else update({ project_ids: rest });
                          }}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </span>
                    );
                  })}
                  <select
                    className="select ag-projects__add"
                    aria-label={t('agents.addProjectAria')}
                    value=""
                    disabled={revoked || busy}
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id === '') return;
                      update({ project_ids: [...(limited ?? []), id] });
                      setOnlyDraft(false);
                    }}
                  >
                    <option value="">
                      {projects.length === 0
                        ? t('agents.noProjects')
                        : `＋ ${t('agents.addProject')}`}
                    </option>
                    {projects
                      .filter((p) => !p.archived && !(limited ?? []).includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  {limited === null && (
                    <span className="faint">{t('agents.pickProjectFirst')}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <Activity
        key={`${token.id}:${String(activityEpoch)}`}
        client={client}
        token={token}
        onNotice={onNotice}
      />

      {confirmDirect && (
        <DirectEditDialog
          name={token.name}
          projects={limited === null ? null : limitNames}
          onCancel={() => {
            setConfirmDirect(false);
          }}
          onAllow={() => {
            setConfirmDirect(false);
            update({ allow_direct_body_edit: true });
          }}
        />
      )}
      {revoking && (
        <RevokeDialog
          client={client}
          token={token}
          onClose={(done) => {
            setRevoking(false);
            if (done) onRevoked();
          }}
        />
      )}
    </section>
  );
}

/**
 * 讓 X 直接修改正文？ (PT-20261124-001 decision 5): what changes, what
 * protects you, where it applies; 「我了解」 must be ticked before the red
 * 允許直接修改, and 取消 has the focus.
 */
export function DirectEditDialog({
  name,
  projects,
  onCancel,
  onAllow,
}: {
  name: string;
  /** Project names it is limited to, or null for all works. */
  projects: readonly string[] | null;
  onCancel: () => void;
  onAllow: () => void;
}) {
  const [ack, setAck] = useState(false);
  return (
    <Dialog
      title={t('agents.confirmTitle', { name })}
      onClose={onCancel}
      width={520}
      footer={
        <>
          <button type="button" className="btn dialog__primary" data-autofocus onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--danger-solid" disabled={!ack} onClick={onAllow}>
            {t('agents.confirmAllow')}
          </button>
        </>
      }
    >
      <div className="form ag-confirm">
        <p>{t('agents.confirmLead')}</p>
        <ul className="ag-confirm__list">
          <li>{t('agents.confirmSnapshot', { name })}</li>
          <li>
            {projects === null
              ? t('agents.confirmScopeAll')
              : t('agents.confirmScopeSome', {
                  projects: projects.map((p) => `「${p}」`).join(''),
                })}
          </li>
          <li>{t('agents.confirmAi')}</li>
        </ul>
        <label className="ag-confirm__ack">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => {
              setAck(e.target.checked);
            }}
          />
          <span>{t('agents.confirmAck')}</span>
        </label>
      </div>
    </Dialog>
  );
}

type Row = {
  a: TokenActivity;
  title: string | null;
  /** The direct edit's revision (it can be undone), with the one before it. */
  undo: { workId: string; revision: string; restoreTo: string } | null;
  /** The revision it made, as r12 (null when unknown). */
  rev: string | null;
};

/** 最近活動: what the agent did or tried; a direct edit can be undone (恢復上一版). */
function Activity({
  client,
  token,
  onNotice,
}: {
  client: CreatorHubClient;
  token: ApiToken;
  onNotice: (n: Notice) => void;
}) {
  const projects = useProjectList();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [undone, setUndone] = useState<ReadonlySet<number>>(new Set());

  const page = useCallback(
    async (before: number | undefined): Promise<void> => {
      const res = await client.tokens.activity(token.id, {
        limit: 20,
        ...(before === undefined ? {} : { before }),
      });
      const workIds = [
        ...new Set(
          res.items
            .filter((a) => a.target_type === 'work' && a.target_id !== null)
            .map((a) => a.target_id ?? ''),
        ),
      ];
      const titles = new Map<string, string>();
      const agentRevs = new Map<string, Revision>();
      const revNumber = new Map<string, number>();
      if (workIds.length > 0) {
        const [list, ...revs] = await Promise.all([
          client.works.list({ ids: workIds, limit: workIds.length }).catch(() => null),
          ...workIds.map((id) => client.works.revisions(id).catch(() => null)),
        ]);
        for (const w of list?.items ?? []) titles.set(w.id, w.title);
        for (const r of revs) {
          const items = r?.items ?? [];
          // The list comes newest first.
          items.forEach((x, i) => {
            agentRevs.set(x.revision_id, x);
            revNumber.set(x.revision_id, items.length - i);
          });
        }
      }
      const made = res.items.map((a): Row => {
        const rev = a.revision === null ? undefined : agentRevs.get(a.revision);
        const via = rev?.agent?.via;
        const n = a.revision === null ? undefined : revNumber.get(a.revision);
        return {
          a,
          rev: n === undefined ? null : `r${String(n)}`,
          title: a.target_id === null ? null : (titles.get(a.target_id) ?? null),
          undo:
            via === 'direct' && rev?.agent?.restore_to != null && a.target_id !== null
              ? { workId: a.target_id, revision: rev.revision_id, restoreTo: rev.agent.restore_to }
              : null,
        };
      });
      setRows((old) => (before === undefined ? made : [...(old ?? []), ...made]));
      setNext(res.next_before);
    },
    [client, token.id],
  );
  useEffect(() => {
    page(undefined).catch(() => {
      setFailed(true);
    });
  }, [page]);

  const undo = (r: Row) => {
    if (r.undo === null || busy !== null) return;
    const u = r.undo;
    setBusy(r.a.id);
    client.works
      .get(u.workId)
      .then((w) => {
        // Only while nothing came after it; otherwise history is the place to decide.
        if (w.current_revision_id !== u.revision) throw new Error('moved on');
        return client.works.restore(u.workId, u.restoreTo, { base_revision: u.revision });
      })
      .then(() => {
        setUndone((s) => new Set([...s, r.a.id]));
        onNotice({ text: t('agents.restoredPrev'), tone: 'ok' });
      })
      .catch(() => {
        onNotice({ text: t('agents.restoreFailed'), tone: 'bad' });
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <section className="set-g">
      <h3 className="set-g__t">{t('agents.activityTitle')}</h3>
      <div className="set-list">
        {failed ? (
          <div className="set-row">
            <span className="muted">{t('agents.activityFailed')}</span>
          </div>
        ) : rows === null ? (
          <div className="set-row" aria-busy="true" />
        ) : rows.length === 0 ? (
          <div className="set-row">
            <span className="faint">{t('agents.activityEmpty')}</span>
          </div>
        ) : (
          <ul className="ag-acts">
            {rows.map((r) => {
              const kind = activityKind(r.a, r.undo !== null);
              const said = activityText(r.a, kind, r.title);
              const line = said.line;
              const detail =
                kind === 'token' && said.detail !== null
                  ? tokenChangeText(
                      said.detail,
                      (id) => projects.find((p) => p.id === id)?.name ?? id,
                    )
                  : said.detail;
              const tone =
                r.a.result !== 'ok'
                  ? 'bad'
                  : kind === 'direct'
                    ? 'warn'
                    : kind === 'propose'
                      ? 'accent'
                      : '';
              return (
                <li key={r.a.id} className="ag-act">
                  <span className={`ag-act__icon ag-act__icon--${tone === '' ? 'plain' : tone}`}>
                    <Icon name={r.a.result === 'ok' ? ACTIVITY_ICON[kind] : 'alert'} size={14} />
                  </span>
                  <span className="ag-act__main">
                    <span className="ag-act__line">{line}</span>
                    {(detail !== null || r.undo !== null) && (
                      <span className="faint ag-act__detail">
                        {detail ??
                          t('agents.actRevision', {
                            rev: r.rev ?? r.undo?.revision.slice(0, 8) ?? '',
                          })}
                      </span>
                    )}
                  </span>
                  <span className="faint ag-act__when">{formatWhen(r.a.at)}</span>
                  {r.undo !== null && !undone.has(r.a.id) && (
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={busy !== null}
                      onClick={() => {
                        undo(r);
                      }}
                    >
                      {t('agents.restorePrev')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {next !== null && (
        <button
          type="button"
          className="btn btn--ghost btn--small ag-acts__more"
          onClick={() => {
            page(next).catch(() => {
              onNotice({ text: t('agents.activityFailed'), tone: 'bad' });
            });
          }}
        >
          {t('agents.activityMore')}
        </button>
      )}
    </section>
  );
}

function CreateTokenDialog({
  client,
  onCreated,
  onClose,
}: {
  client: CreatorHubClient;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<readonly TokenScope[]>(['read', 'propose']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<'secret' | 'mcp' | null>(null);

  const create = () => {
    if (busy) return;
    if (name.trim() === '') {
      setError(t('serviceSettings.tokenNameRequired'));
      return;
    }
    if (scopes.length === 0) {
      setError(t('serviceSettings.tokenScopeRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    client.tokens
      .create({ name: name.trim(), scopes: SCOPES.filter((s) => scopes.includes(s)) })
      .then((res) => {
        setSecret(res.secret);
        onCreated(res.token.id);
      })
      .catch(() => {
        setBusy(false);
        setError(t('serviceSettings.tokenCreateFailed'));
      });
  };

  if (secret !== null) {
    return (
      <Dialog
        title={t('agents.tokenSecretTitle')}
        onClose={onClose}
        closable={false}
        width={560}
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
                void copy(secret).then((ok) => {
                  if (ok) setCopied('secret');
                });
              }}
            >
              <Icon name={copied === 'secret' ? 'check' : 'copy'} />
              {copied === 'secret' ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <p className="faint">{t('agents.tokenSecretMcp')}</p>
          <pre className="ag-mcp mono">{mcpConfig(secret)}</pre>
          <button
            type="button"
            className="btn ag-mcp__copy"
            onClick={() => {
              void copy(mcpConfig(secret)).then((ok) => {
                if (ok) setCopied('mcp');
              });
            }}
          >
            <Icon name={copied === 'mcp' ? 'check' : 'copy'} />
            {copied === 'mcp' ? t('agents.mcpCopiedWithSecret') : t('agents.copyMcp')}
          </button>
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
                checked={scopes.includes(s)}
                onChange={() => {
                  setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));
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
  onClose: (done: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={t('serviceSettings.tokenRevokeTitle', { name: token.name })}
      onClose={() => {
        onClose(false);
      }}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost dialog__primary"
            data-autofocus
            onClick={() => {
              onClose(false);
            }}
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
                .then(() => {
                  onClose(true);
                })
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
