import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Revision, RevisionDetail } from '@qiu-creator/contracts';
import { useEffect, useMemo, useState } from 'react';
import { conflictHunks } from './conflict.js';
import { formatWhen, REVISION_SOURCE_LABEL } from './format.js';
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
          setMessage({ tone: 'ok', text: `已恢復 r${selN ?? ''} 為 r${nextN}` });
          setSelected(null);
        } else if (result === 'conflict') {
          setMessage({ tone: 'bad', text: '作品剛在其他地方更新，請先處理上方提示再恢復' });
        } else {
          setMessage({ tone: 'bad', text: '有未儲存、衝突或唯讀狀態，暫時不能恢復' });
        }
      })
      .catch(() => {
        setBusy(false);
        setMessage({ tone: 'bad', text: '恢復失敗，請確認本機服務是否運行' });
      });
  };

  return (
    <aside
      id="history-panel"
      className="panel"
      aria-label="版本歷史"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          if (confirming) setConfirming(false);
          else onClose();
        }
      }}
    >
      <div className="panel__head">
        <span className="panel__title">版本歷史</span>
        <span className="faint">{revisions.length}</span>
        <button
          type="button"
          className="btn btn--ghost btn--icon panel__close"
          aria-label="關閉歷史"
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
                {r.revision_id === currentRevision && <span className="rev__cur">目前</span>}
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
                {hunks.length === 0 && !titleChanged ? '內容相同' : `${hunks.length} 處不同`}
              </span>
            )}
          </div>
          {loadFailed ? (
            <p className="rev-msg rev-msg--bad" role="alert">
              無法讀取這個版本
            </p>
          ) : detail === null ? (
            <span className="skel skel--line" aria-busy="true" />
          ) : isCurrent ? (
            <div className="rev-detail__same">即目前版本</div>
          ) : (
            <div className="diffview rev-detail__diff" aria-label="與目前版本的差異">
              {titleChanged && (
                <p className="diffview__hunk">
                  標題：<del className="del">{currentTitle}</del>
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
            <div className="rev-confirm" role="alertdialog" aria-label="確認恢復">
              <span className="rev-confirm__title">
                恢復 r{selN} 為新版本 r{nextN}
              </span>
              <span className="faint">歷史版本全部保留</span>
              <div className="rev-detail__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  autoFocus
                  onClick={restore}
                >
                  確認恢復
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="rev-detail__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={isCurrent || readOnly || detail === null}
                title={readOnly ? '原檔不在，暫時不能恢復' : undefined}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                恢復此版本
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setSelected(null);
                }}
              >
                取消
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
