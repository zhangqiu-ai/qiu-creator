import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { ProposalDetail, ProposalSummary } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChangeEvents } from './events.js';
import { formatWhen } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { isProposalEvent, statusLabel } from './proposals.js';
import { Avatar, ProposalView } from './ProposalView.js';
import { useToast } from './toasts.js';
import './proposals.css';

type Tab = 'pending' | 'done';

/**
 * Agent 提案 inbox (QC-091, PT-20261124-001): 待處理／已處理 and an agent
 * filter; the list on the left (agent, work, the agent's note in one line,
 * overlap state, time), the chosen proposal on the right. Agents can only
 * propose: nothing changes the original until 採用.
 */
export function ProposalsPage({
  client,
  onOpenWork,
}: {
  client: CreatorHubClient;
  /** 在編輯頁打開: the work's tab, with the sidebar on 提案. */
  onOpenWork: (workId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const [agent, setAgent] = useState<string>('');
  const [items, setItems] = useState<ProposalSummary[] | null>(null);
  const [pendingTotal, setPendingTotal] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  useToast(
    notice === null
      ? null
      : {
          message: notice,
          tone: 'bad',
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
    let alive = true;
    Promise.all([client.proposals.list({ status: tab, limit: 200 }), client.proposals.counts()])
      .then(([list, counts]) => {
        if (!alive) return;
        setFailed(false);
        setItems(list.items);
        setPendingTotal(counts.pending);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [client, tab]);
  useEffect(() => load(), [load, epoch]);
  useChangeEvents((event) => {
    if (event.entity === 'work' && isProposalEvent(event.action)) setEpoch((n) => n + 1);
  });

  const agents = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of items ?? []) if (!seen.has(p.token_id)) seen.set(p.token_id, p.token_name);
    return [...seen.entries()];
  }, [items]);
  const shown = useMemo(
    () => (items ?? []).filter((p) => agent === '' || p.token_id === agent),
    [items, agent],
  );

  // Keep a selection that is still listed; otherwise the first one.
  useEffect(() => {
    if (items === null) return;
    if (selected !== null && shown.some((p) => p.id === selected)) return;
    setSelected(shown[0]?.id ?? null);
  }, [items, shown, selected]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    client.proposals
      .get(selected)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setDetail(null);
      });
    return () => {
      alive = false;
    };
  }, [client, selected, epoch]);

  return (
    <main className="page pr-page" aria-labelledby="pr-title">
      <header className="pr-page__head">
        <h1 id="pr-title" className="page__title" tabIndex={-1}>
          {t('agents.title')}
        </h1>
        {pendingTotal !== null && (
          <span className="faint">{t('agents.pendingCount', { count: pendingTotal })}</span>
        )}
        <div className="pr-page__tools">
          <div className="seg" role="group" aria-label={t('agents.filterLabel')}>
            {(['pending', 'done'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={tab === k}
                onClick={() => {
                  setTab(k);
                  setSelected(null);
                }}
              >
                {t(k === 'pending' ? 'agents.tabPending' : 'agents.tabDone')}
                {k === 'pending' && pendingTotal !== null && pendingTotal > 0 && (
                  <span className="num pr-page__n">{pendingTotal}</span>
                )}
              </button>
            ))}
          </div>
          <select
            className="select"
            aria-label={t('agents.agentFilter')}
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
            }}
          >
            <option value="">{t('agents.allAgents')}</option>
            {agents.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="pr-page__body">
        <section className="pr-list" aria-label={t('agents.listLabel')}>
          {failed ? (
            <div className="state-card" role="alert">
              <Icon name="offline" size={24} />
              <span className="state-card__title">{t('agents.loadFailed')}</span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setEpoch((n) => n + 1);
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : items === null ? (
            <div className="pr-list__items" aria-busy="true" />
          ) : shown.length === 0 ? (
            <div className="pr-empty">
              <Icon name="agentInbox" size={28} />
              <span className="pr-empty__title">
                {t(tab === 'pending' ? 'agents.emptyPending' : 'agents.emptyDone')}
              </span>
              <span className="faint">{t('agents.emptyHint')}</span>
            </div>
          ) : (
            <ul className="pr-list__items">
              {shown.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="pr-row"
                    aria-current={p.id === selected ? 'true' : undefined}
                    onClick={() => {
                      setSelected(p.id);
                    }}
                  >
                    <Avatar name={p.token_name} size={28} />
                    <span className="pr-row__main">
                      <span className="pr-row__title">{p.work_title}</span>
                      <span className="pr-row__note">
                        {p.token_name}
                        {p.note !== null && p.note.trim() !== '' ? ` · ${p.note}` : ''}
                      </span>
                      <span className="pr-row__foot">
                        <span className="faint">
                          {t('agents.changes', { count: p.hunk_count })}
                        </span>
                        {p.status === 'pending' && p.overlap === 'conflict' && (
                          <span className="chip chip--bad">{t('agents.overlapTag')}</span>
                        )}
                        {p.status === 'pending' && p.overlap === 'stale' && (
                          <span className="chip">{t('agents.staleTag')}</span>
                        )}
                        {p.status !== 'pending' && (
                          <span className="chip">{statusLabel(p.status)}</span>
                        )}
                        <span className="faint pr-row__when">{formatWhen(p.created_at)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="pr-list__foot faint">
            <Icon name="info" size={14} />
            {t('agents.footNote')}
          </p>
        </section>

        <section className="pr-detail" aria-label={detail?.work_title ?? t('agents.pickOne')}>
          {detail === null ? (
            <p className="pr-detail__none faint">{shown.length > 0 ? '' : t('agents.pickOne')}</p>
          ) : (
            <ProposalView
              key={detail.id}
              client={client}
              detail={detail}
              onChanged={(next) => {
                setDetail(next);
                setEpoch((n) => n + 1);
              }}
              onOpenInEditor={() => {
                onOpenWork(detail.work_id);
              }}
              onNotice={setNotice}
            />
          )}
        </section>
      </div>
    </main>
  );
}
