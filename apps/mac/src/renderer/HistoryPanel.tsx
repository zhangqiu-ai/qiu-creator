import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Revision, RevisionDetail } from '@qiu-creator/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { conflictHunks } from './conflict.js';
import { formatWhen, REVISION_SOURCE_LABEL } from './format.js';
import { useExitFade } from './motion.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import type { RestoreResult } from './work-session.js';

function lines(text: readonly string[]): string {
  return text.join('\n');
}

/**
 * 版本歷史 with 恢復 (PT-20261117-001): pick a revision to see how it differs
 * from the current one, then 恢復此版本 → a confirm step that says the result
 * is a new revision and history stays. Read-only works can browse but not restore.
 */
export function HistoryPanel({
  client,
  workId,
  revisions,
  numbers,
  currentRevision,
  currentMarkdown,
  currentTitle,
  readOnly,
  onRestore,
  onClose,
}: {
  client: CreatorHubClient;
  workId: string;
  revisions: readonly Revision[];
  numbers: ReadonlyMap<string, number>;
  currentRevision: string;
  currentMarkdown: string;
  currentTitle: string;
  readOnly: boolean;
  onRestore: (revisionId: string) => Promise<RestoreResult>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useExitFade(panelRef, 'panel');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    setDetail(null);
    setLoadFailed(false);
    setConfirming(false);
    if (selected === null) return;
    let alive = true;
    client.works
      .revision(workId, selected)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setLoadFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [client, workId, selected]);

  const isCurrent = selected === currentRevision;
  const hunks = useMemo(
    () => (detail === null || isCurrent ? [] : conflictHunks(currentMarkdown, detail.markdown)),
    [detail, isCurrent, currentMarkdown],
  );
  const titleChanged = detail !== null && !isCurrent && detail.title !== currentTitle;
  const curN = numbers.get(currentRevision);
  const selN = selected === null ? undefined : numbers.get(selected);
  const nextN = revisions.length + 1;

  const restore = () => {
    if (selected === null) return;
    setBusy(true);
    setMessage(null);
    onRestore(selected)
      .then((result) => {
        setBusy(false);
        setConfirming(false);
        if (result === 'restored') {
          setMessage({
            tone: 'ok',
            text: t('editor.restoredMessage', {
              rev: selN === undefined ? '' : String(selN),
              next: nextN,
            }),
          });
          setSelected(null);
        } else if (result === 'conflict') {
          setMessage({ tone: 'bad', text: t('editor.restoreConflict') });
        } else {
          setMessage({ tone: 'bad', text: t('editor.restoreBlocked') });
        }
      })
      .catch(() => {
        setBusy(false);
        setMessage({ tone: 'bad', text: t('editor.restoreFailed') });
      });
  };

  return (
    <aside
      ref={panelRef}
      id="history-panel"
      className="panel"
      aria-label={t('editor.historyTitle')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          if (confirming) setConfirming(false);
          else onClose();
        }
      }}
    >
      <div className="panel__head">
        <span className="panel__title">{t('editor.historyTitle')}</span>
        <span className="faint">{revisions.length}</span>
        <button
          type="button"
          className="btn btn--ghost btn--icon panel__close"
          aria-label={t('editor.closeHistory')}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <ol className="revs">
        {revisions.map((r) => (
          <li key={r.revision_id}>
            <button
              type="button"
              className="rev rev--button"
              aria-pressed={selected === r.revision_id}
              aria-current={r.revision_id === currentRevision ? 'true' : undefined}
              onClick={() => {
                setMessage(null);
                setSelected(selected === r.revision_id ? null : r.revision_id);
              }}
            >
              <span className="mono rev__n">r{numbers.get(r.revision_id)}</span>
              <span className="rev__src">
                {REVISION_SOURCE_LABEL[r.source]}
                {r.revision_id === currentRevision && (
                  <span className="rev__cur">{t('editor.revCurrent')}</span>
                )}
              </span>
              <time className="rev__when" dateTime={r.created_at}>
                {formatWhen(r.created_at)}
              </time>
            </button>
          </li>
        ))}
      </ol>

      {message !== null && (
        <p className={`rev-msg rev-msg--${message.tone}`} role="status">
          {message.text}
        </p>
      )}

      {selected !== null && (
        <div className="rev-detail">
          <div className="rev-detail__head">
            <span className="mono">
              r{curN ?? '?'} → r{selN ?? '?'}
            </span>
            {!isCurrent && detail !== null && (
              <span className="rev-detail__stat">
                {hunks.length === 0 && !titleChanged
                  ? t('editor.diffSame')
                  : t('editor.diffCount', { count: hunks.length })}
              </span>
            )}
          </div>
          {loadFailed ? (
            <p className="rev-msg rev-msg--bad" role="alert">
              {t('editor.revLoadFailed')}
            </p>
          ) : detail === null ? (
            <span className="skel skel--line" aria-busy="true" />
          ) : isCurrent ? (
            <div className="rev-detail__same">{t('editor.revIsCurrent')}</div>
          ) : (
            <div className="diffview rev-detail__diff" aria-label={t('editor.diffWithCurrent')}>
              {titleChanged && (
                <p className="diffview__hunk">
                  {t('editor.titleChanged')}
                  <del className="del">{currentTitle}</del>
                  <ins className="ins">{detail.title}</ins>
                </p>
              )}
              {hunks.map((h) => (
                <p key={h.index} className="diffview__hunk">
                  {h.server.length > 0 && <del className="del">{lines(h.server)}</del>}
                  {h.mine.length > 0 && <ins className="ins">{lines(h.mine)}</ins>}
                </p>
              ))}
            </div>
          )}
          {confirming ? (
            <div className="rev-confirm" role="alertdialog" aria-label={t('editor.confirmRestore')}>
              <span className="rev-confirm__title">
                {t('editor.restoreAsNew', {
                  rev: selN === undefined ? '' : String(selN),
                  next: nextN,
                })}
              </span>
              <span className="faint">{t('editor.historyKept')}</span>
              <div className="rev-detail__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  autoFocus
                  onClick={restore}
                >
                  {t('editor.confirmRestore')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="rev-detail__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={isCurrent || readOnly || detail === null}
                title={readOnly ? t('editor.restoreDisabled') : undefined}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('editor.restoreThis')}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setSelected(null);
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
