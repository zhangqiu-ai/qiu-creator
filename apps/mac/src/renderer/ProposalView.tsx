import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { ProposalConflict, ProposalDetail, ProposalHunk } from '@qiu-creator/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from './Dialog.js';
import { formatWhen } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import {
  acceptBlock,
  acceptInput,
  avatarTone,
  defaultPicks,
  initials,
  lineStats,
  revName,
  statusLabel,
} from './proposals.js';
import './proposals.css';

/** Says why a decision did not go through; a decision that did shows on screen. */
export type Notice = (problem: string) => void;

/** A work's revision numbers (r1, r2, …), for “基於 r12”. */
export function useRevisionNumbers(
  client: CreatorHubClient,
  workId: string,
  key: string,
): ReadonlyMap<string, number> {
  const [numbers, setNumbers] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    let alive = true;
    client.works
      .revisions(workId)
      .then((r) => {
        if (!alive) return;
        // The list comes newest first.
        setNumbers(new Map(r.items.map((x, i) => [x.revision_id, r.items.length - i])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, workId, key]);
  return numbers;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className={`pr-avatar pr-avatar--${String(avatarTone(name))}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function Stats({ hunks }: { hunks: readonly ProposalHunk[] }) {
  const s = lineStats(hunks);
  return (
    <span className="pr-stats">
      <span className="pr-stats__add">+{s.added}</span>
      <span className="pr-stats__del">−{s.removed}</span>
    </span>
  );
}

/**
 * One proposal (QC-091): who and when, the agent's note as data (a quote,
 * “只作參考”), the overlap state, each change with a checkbox (deleted text
 * struck out on badSoft, added text underlined on okSoft), and 捨棄／採用.
 * Used by the inbox and by the editor sidebar's 提案 tab.
 */
export function ProposalView({
  client,
  detail,
  compact = false,
  onChanged,
  onOpenInEditor,
  prepare,
  onNotice,
}: {
  client: CreatorHubClient;
  detail: ProposalDetail;
  /** The editor sidebar: no work title, the actions stay at the bottom. */
  compact?: boolean;
  /** After 採用 or 捨棄, or a reload after a 409 (the newest detail). */
  onChanged: (next: ProposalDetail) => void;
  onOpenInEditor?: () => void;
  /** Before accepting (the editor saves first): the base to accept on, or null to stop. */
  prepare?: () => Promise<string | null>;
  onNotice: Notice;
}) {
  const numbers = useRevisionNumbers(client, detail.work_id, detail.current_revision);
  const hunkKey = detail.hunks.map((h) => `${h.id}:${h.overlap}`).join(',');
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => defaultPicks(detail));
  const [shownKey, setShownKey] = useState(`${detail.id}|${hunkKey}`);
  if (shownKey !== `${detail.id}|${hunkKey}`) {
    setShownKey(`${detail.id}|${hunkKey}`);
    setPicked(defaultPicks(detail));
  }
  const [busy, setBusy] = useState(false);
  const [threeWay, setThreeWay] = useState(false);
  const block = acceptBlock(detail, picked);
  const conflicts = detail.hunks.filter((h) => h.overlap === 'conflict').length;
  const base = revName(numbers, detail.base_revision);
  const current = revName(numbers, detail.current_revision);
  const pending = detail.status === 'pending';
  const lines = useMemo(() => detail.base_markdown.split('\n'), [detail.base_markdown]);

  const reload = (message: string) => {
    void client.proposals.get(detail.id).then(onChanged, () => undefined);
    onNotice(message);
  };

  const accept = async () => {
    if (block !== null || busy) return;
    setBusy(true);
    try {
      const at = prepare === undefined ? detail.current_revision : await prepare();
      if (at === null) {
        onNotice(t('agents.saveFirst'));
        return;
      }
      const res = await client.proposals.accept(detail.id, {
        ...acceptInput(detail, picked),
        base_revision: at,
      });
      onChanged(res.proposal);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'proposal_conflict')
        reload(t('agents.conflictNow'));
      else if (err instanceof ApiError && err.status === 409) reload(t('agents.staleReloaded'));
      else onNotice(t('agents.acceptFailed'));
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    if (busy) return;
    setBusy(true);
    client.proposals
      .discard(detail.id)
      .then((next) => {
        onChanged(next);
      })
      .catch(() => {
        onNotice(t('agents.discardFailed'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className={compact ? 'pr-view pr-view--compact' : 'pr-view'}>
      <div className="pr-view__scroll">
        <header className="pr-view__head">
          <Avatar name={detail.token_name} size={compact ? 30 : 36} />
          <div className="pr-view__who">
            <div className="pr-view__title-row">
              <h2 className="pr-view__title">
                {compact ? t('agents.sideOf', { agent: detail.token_name }) : detail.work_title}
              </h2>
              {!compact && onOpenInEditor !== undefined && (
                <button type="button" className="link-btn" onClick={onOpenInEditor}>
                  {t('agents.openInEditor')}
                  <Icon name="chevronRight" size={12} />
                </button>
              )}
            </div>
            <span className="faint pr-view__meta">
              {t('agents.meta', {
                agent: detail.token_name,
                when: formatWhen(detail.created_at),
                base,
              })}
              {' · '}
              <Stats hunks={detail.hunks} />
            </span>
          </div>
        </header>

        {detail.note !== null && detail.note.trim() !== '' && (
          <figure className="pr-note">
            <figcaption className="pr-note__label">{t('agents.noteLabel')}</figcaption>
            {/* The agent's own words are data, shown as a quote; never instructions. */}
            <blockquote className="pr-note__text">「{detail.note}」</blockquote>
            <p className="pr-note__hint">{t('agents.noteHint')}</p>
          </figure>
        )}

        {pending && detail.overlap === 'conflict' && (
          <div className="pr-banner pr-banner--bad" role="alert">
            <Icon name="alert" size={16} />
            <div className="pr-banner__text">
              <strong>{t('agents.conflictTitle')}</strong>
              <span>{t('agents.conflictBody', { base, current, count: conflicts })}</span>
            </div>
            {!compact && (
              <button
                type="button"
                className="btn btn--small pr-banner__btn"
                onClick={() => {
                  setThreeWay(true);
                }}
              >
                {t('agents.threeWay')}
              </button>
            )}
          </div>
        )}
        {pending && detail.overlap === 'stale' && (
          <div className="pr-banner pr-banner--warn" role="status">
            <Icon name="info" size={16} />
            <div className="pr-banner__text">
              <strong>{t('agents.staleTitle')}</strong>
              <span>{t('agents.staleBody', { base, current })}</span>
            </div>
          </div>
        )}
        {!pending && (
          <p className="pr-decided faint" role="status">
            {t('agents.decidedAt', {
              status: statusLabel(detail.status),
              when: formatWhen(detail.decided_at ?? detail.created_at),
            })}
            {detail.result_revision_id !== null &&
              ` · ${t('agents.resultRevision', { rev: revName(numbers, detail.result_revision_id) })}`}
            {detail.expires_at !== null &&
              ` · ${t('agents.expiresAt', { when: formatWhen(detail.expires_at) })}`}
          </p>
        )}
        {compact && pending && <p className="faint pr-side-hint">{t('agents.sideHighlight')}</p>}

        <ol className="pr-hunks" aria-label={t('agents.changesLabel')}>
          {detail.hunks.map((h, i) => {
            const on = pending ? picked.has(h.id) : detail.accepted_hunk_ids.includes(h.id);
            return (
              <li
                key={h.id}
                className={[
                  'pr-hunk',
                  on ? '' : 'pr-hunk--off',
                  h.overlap === 'conflict' ? 'pr-hunk--conflict' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <label className="pr-hunk__head">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!pending}
                    aria-label={t('agents.pickHunk', { n: i + 1 })}
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(h.id)) next.delete(h.id);
                      else next.add(h.id);
                      setPicked(next);
                    }}
                  />
                  <span>
                    {t(h.removed.length === 0 ? 'agents.hunkInsert' : 'agents.hunkTitle', {
                      n: i + 1,
                      line: h.removed.length === 0 ? h.base_start : h.base_start + 1,
                    })}
                  </span>
                  {h.overlap === 'conflict' && (
                    <span className="chip chip--bad pr-hunk__tag">{t('agents.hunkConflict')}</span>
                  )}
                </label>
                <HunkText hunk={h} lines={lines} />
              </li>
            );
          })}
        </ol>
      </div>

      {pending && (
        <footer className="pr-view__foot">
          {!compact && (
            <p className="faint pr-view__foot-note">
              {t('agents.footAccept', { agent: detail.token_name })}
            </p>
          )}
          <div className="pr-view__actions">
            <button type="button" className="btn" disabled={busy} onClick={discard}>
              <Icon name="close" size={14} />
              {t('agents.discard')}
            </button>
            {compact && detail.overlap === 'conflict' && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setThreeWay(true);
                }}
              >
                {t('agents.threeWay')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary pr-view__accept"
              disabled={block !== null || busy}
              onClick={() => {
                void accept();
              }}
            >
              <Icon name="check" size={14} />
              {block === 'conflict'
                ? t('agents.acceptBlocked')
                : picked.size === detail.hunks.length
                  ? t('agents.accept')
                  : t('agents.acceptSome', { checked: picked.size, total: detail.hunks.length })}
            </button>
          </div>
        </footer>
      )}

      {threeWay && (
        <ThreeWayDialog
          detail={detail}
          base={base}
          current={current}
          onSkip={() => {
            const next = new Set(picked);
            for (const h of detail.hunks) if (h.overlap === 'conflict') next.delete(h.id);
            setPicked(next);
            setThreeWay(false);
          }}
          onOpenInEditor={onOpenInEditor}
          onClose={() => {
            setThreeWay(false);
          }}
        />
      )}
    </div>
  );
}

/** A change in context: the removed lines struck out, the added ones underlined. */
function HunkText({ hunk, lines }: { hunk: ProposalHunk; lines: readonly string[] }) {
  // An insertion shows the line it follows, so the reader knows where it goes.
  const before =
    hunk.removed.length === 0 && hunk.base_start > 0 ? lines[hunk.base_start - 1] : null;
  return (
    <div className="pr-hunk__text">
      {before !== null && before !== undefined && before !== '' && (
        <p className="pr-hunk__ctx">{before}</p>
      )}
      {hunk.removed.map((line, i) => (
        <p key={`r${String(i)}`} className="pr-line">
          <del className="del">{line === '' ? t('agents.emptyText') : line}</del>
        </p>
      ))}
      {hunk.added.map((line, i) => (
        <p key={`a${String(i)}`} className="pr-line">
          <ins className="ins">{line === '' ? t('agents.emptyText') : line}</ins>
        </p>
      ))}
    </div>
  );
}

/**
 * 看三方對照 (QC-091): the prototype draws only the entry, so this is a plain
 * three-column comparison per overlapping region — the original, the work
 * now, and the proposal — with a way to leave those changes out.
 */
function ThreeWayDialog({
  detail,
  base,
  current,
  onSkip,
  onOpenInEditor,
  onClose,
}: {
  detail: ProposalDetail;
  base: string;
  current: string;
  onSkip: () => void;
  onOpenInEditor: (() => void) | undefined;
  onClose: () => void;
}) {
  const count = detail.hunks.filter((h) => h.overlap === 'conflict').length;
  return (
    <Dialog
      title={t('agents.threeWayTitle', { title: detail.work_title })}
      width={880}
      onClose={onClose}
      footer={
        <>
          {onOpenInEditor !== undefined && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose();
                onOpenInEditor();
              }}
            >
              {t('agents.openInEditor')}
            </button>
          )}
          <button type="button" className="btn dialog__primary" data-autofocus onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="btn btn--primary" onClick={onSkip}>
            {t('agents.skipConflicts', { count })}
          </button>
        </>
      }
    >
      <p className="faint">{t('agents.threeWayHint')}</p>
      {detail.conflicts.map((c, i) => (
        <ThreeWayRegion
          key={`${String(c.base_start)}-${String(i)}`}
          n={i + 1}
          region={c}
          base={base}
          current={current}
          agent={detail.token_name}
        />
      ))}
    </Dialog>
  );
}

function ThreeWayRegion({
  n,
  region,
  base,
  current,
  agent,
}: {
  n: number;
  region: ProposalConflict;
  base: string;
  current: string;
  agent: string;
}) {
  const col = (label: string, text: string, tone: string) => (
    <div className={`pr-3w__col pr-3w__col--${tone}`}>
      <div className="pr-3w__label">{label}</div>
      <pre className="pr-3w__text">{text === '' ? t('agents.emptyText') : text}</pre>
    </div>
  );
  return (
    <section className="pr-3w" aria-label={t('agents.regionLabel', { n })}>
      <h3 className="pr-3w__title">{t('agents.regionLabel', { n })}</h3>
      <div className="pr-3w__cols">
        {col(t('agents.colBase', { base }), region.base, 'base')}
        {col(t('agents.colMine', { current }), region.mine, 'mine')}
        {col(t('agents.colTheirs', { agent }), region.theirs, 'theirs')}
      </div>
    </section>
  );
}
