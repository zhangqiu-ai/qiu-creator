import type { WorkDetail } from '@qiu-creator/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chip } from './Chip.js';
import { conflictHunks, mergeHunks, type Hunk, type Side } from './conflict.js';
import { formatWhen } from './format.js';
import { Icon } from './Icon.js';
import type { WorkSession } from './work-session.js';

type Mode = 'choose' | 'diff' | 'merge' | 'done';

interface Outcome {
  title: string;
  note: string;
}

export interface ConflictDialogProps {
  session: WorkSession;
  revisionNumber: (revisionId: string) => number | undefined;
  onRevisionsChanged: () => void;
  onClose: () => void;
}

const lines = (h: readonly string[]) => h.join('\n');

/**
 * 版本衝突 dialog from the approved prototype: my draft and the server
 * version side by side, an inline diff, 保留雙方, and 手動合併 per hunk.
 * Nothing is written until the user picks an outcome.
 */
export function ConflictDialog({
  session,
  revisionNumber,
  onRevisionsChanged,
  onClose,
}: ConflictDialogProps) {
  const [mode, setMode] = useState<Mode>('choose');
  const [server, setServer] = useState<WorkDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picks, setPicks] = useState<Side[]>([]);
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [baseOfDraft] = useState(() => session.snapshot.baseRevision);
  const dialogRef = useRef<HTMLElement>(null);
  const conflictRevision = session.snapshot.conflictRevision;

  // Load (and on a repeated 409, reload) the server version being compared against.
  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    session
      .fetchServerVersion()
      .then((w) => {
        if (!live) return;
        setServer(w);
        setPicks([]);
        setEdited(null);
        onRevisionsChanged();
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [session, conflictRevision, onRevisionsChanged]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const mine = session.snapshot.draft.markdown;
  const hunks: Hunk[] = useMemo(
    () => (server === null ? [] : conflictHunks(server.markdown, mine)),
    [server, mine],
  );
  const pickOf = (i: number): Side => picks[i] ?? 'mine';
  const merged =
    edited ??
    (server === null
      ? mine
      : mergeHunks(
          server.markdown,
          mine,
          hunks.map((h) => pickOf(h.index)),
        ));

  const baseN = revisionNumber(baseOfDraft);
  const serverN = server === null ? undefined : revisionNumber(server.current_revision_id);
  const r = (n: number | undefined) => (n === undefined ? '' : `r${n}`);

  const keepBoth = async () => {
    setBusy(true);
    setActionFailed(false);
    try {
      const title = session.snapshot.draft.title;
      const copy = await session.keepBoth();
      setOutcomes([
        { title, note: `伺服器版本 ${r(serverN)}`.trim() },
        { title: copy.title, note: '新副本' },
      ]);
      setMode('done');
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const finishMerge = async () => {
    if (server === null) return;
    setBusy(true);
    setActionFailed(false);
    try {
      const result = await session.resolveWithMerge(merged, server.current_revision_id);
      if (result === 'saved') {
        setOutcomes([
          {
            title: session.snapshot.draft.title,
            note: `合併結果${serverN === undefined ? '' : ` · r${serverN} 可恢復`}`,
          },
        ]);
        setMode('done');
      }
      // On another 409 the effect above reloads the newer server version.
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const done = mode === 'done';

  return (
    <div className="scrim">
      <section
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-title"
        tabIndex={-1}
      >
        <header className="dialog__head">
          <span className={done ? 'dialog__icon dialog__icon--ok' : 'dialog__icon'}>
            <Icon name={done ? 'check' : 'alert'} size={18} />
          </span>
          <h2 id="cf-title" className="dialog__title">
            {done ? '已解決' : '版本衝突'}
          </h2>
          {!done && server !== null && (
            <span className="faint">
              你的修改基於 {r(baseN) || '舊版本'}，伺服器已是 {r(serverN) || '新版本'}
            </span>
          )}
          {!done && (
            <span className="dialog__kept">
              <Chip tone="accent">
                <Icon name="check" size={12} />
                你的修改已保留
              </Chip>
            </span>
          )}
        </header>

        <div className="dialog__body">
          {loadFailed ? (
            <div className="state-card" role="alert">
              <span className="state-card__title">無法讀取伺服器版本</span>
            </div>
          ) : server === null ? (
            <div className="state-card" aria-busy="true" />
          ) : mode === 'choose' ? (
            <div className="panes">
              <div className="pane">
                <div className="pane__head">
                  <span className="pane__title">你的修改</span>
                  <Chip tone="accent">此視窗</Chip>
                  <span className="pane__rev">基於 {r(baseN)}</span>
                </div>
                {hunks.map((h) => (
                  <p key={h.index} className="pane__text">
                    {h.mine.length > 0 ? (
                      <mark className="mark mark--mine">{lines(h.mine)}</mark>
                    ) : (
                      <span className="faint">（無）</span>
                    )}
                  </p>
                ))}
              </div>
              <div className="pane">
                <div className="pane__head">
                  <span className="pane__title">伺服器上的版本</span>
                  <Chip tone="warn">{formatWhen(server.updated_at)}</Chip>
                  <span className="pane__rev">{r(serverN)}</span>
                </div>
                {hunks.map((h) => (
                  <p key={h.index} className="pane__text">
                    {h.server.length > 0 ? (
                      <mark className="mark mark--server">{lines(h.server)}</mark>
                    ) : (
                      <span className="faint">（無）</span>
                    )}
                  </p>
                ))}
              </div>
            </div>
          ) : mode === 'diff' ? (
            <div className="diffview">
              <div className="diffview__legend">
                <span>
                  <del className="del">刪除</del> 伺服器 {r(serverN)}
                </span>
                <span>
                  <ins className="ins">新增</ins> 你的修改
                </span>
              </div>
              {hunks.map((h) => (
                <p key={h.index} className="diffview__hunk">
                  {h.server.length > 0 && <del className="del">{lines(h.server)}</del>}
                  {h.mine.length > 0 && <ins className="ins">{lines(h.mine)}</ins>}
                </p>
              ))}
            </div>
          ) : mode === 'merge' ? (
            <div className="merge">
              {hunks.map((h) => (
                <div key={h.index} className="merge__row">
                  <span className="merge__no">{h.index + 1}</span>
                  <span className="merge__texts">
                    <mark className="mark mark--mine">
                      {h.mine.length > 0 ? lines(h.mine) : '（無）'}
                    </mark>
                    <span className="faint">/</span>
                    <mark className="mark mark--server">
                      {h.server.length > 0 ? lines(h.server) : '（無）'}
                    </mark>
                  </span>
                  <div className="seg" role="group" aria-label={`第 ${h.index + 1} 處`}>
                    {(['mine', 'server'] as const).map((side) => (
                      <button
                        key={side}
                        type="button"
                        aria-pressed={pickOf(h.index) === side}
                        onClick={() => {
                          const next = hunks.map((x) => pickOf(x.index));
                          next[h.index] = side;
                          setPicks(next);
                          setEdited(null);
                        }}
                      >
                        {side === 'mine' ? '我的' : '伺服器'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <label htmlFor="merged" className="merge__label">
                結果
              </label>
              <textarea
                id="merged"
                className="merge__result"
                rows={8}
                spellCheck={false}
                value={merged}
                onChange={(e) => {
                  setEdited(e.target.value);
                }}
              />
            </div>
          ) : (
            <ul className="outcomes">
              {outcomes.map((o) => (
                <li key={o.title} className="outcome">
                  <Icon name="check" />
                  <span className="outcome__title">{o.title}</span>
                  <span className="faint outcome__note">{o.note}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {actionFailed && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text">服務未回應，你的修改仍保留</span>
          </div>
        )}

        <footer className="dialog__foot">
          {(mode === 'choose' || mode === 'diff') && (
            <>
              <button
                type="button"
                className="btn"
                aria-pressed={mode === 'diff'}
                disabled={server === null}
                onClick={() => {
                  setMode(mode === 'diff' ? 'choose' : 'diff');
                }}
              >
                <Icon name="diff" />
                查看差異
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || server === null}
                onClick={() => void keepBoth()}
              >
                <Icon name="copy" />
                保留雙方
              </button>
              <button
                type="button"
                className="btn btn--primary dialog__primary"
                disabled={server === null}
                onClick={() => {
                  setMode('merge');
                }}
              >
                <Icon name="merge" />
                手動合併
              </button>
            </>
          )}
          {mode === 'merge' && (
            <>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setMode('choose');
                }}
              >
                返回
              </button>
              <button
                type="button"
                className="btn btn--primary dialog__primary"
                disabled={busy}
                onClick={() => void finishMerge()}
              >
                完成合併
              </button>
            </>
          )}
          {done && (
            <button type="button" className="btn btn--primary dialog__primary" onClick={onClose}>
              返回編輯
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
