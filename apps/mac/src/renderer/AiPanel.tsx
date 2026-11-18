import type { Platform, RewriteMode } from '@qiu-creator/contracts';
import { getTemplate } from '@qiu-creator/platform-preview';
import { useCallback, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import {
  AI_BLOCK_LABEL,
  FAILURE_LABEL,
  TITLE_PLATFORMS,
  titleLength,
  titleLimit,
  type AiBlock,
  type RewriteSession,
  type TitleSession,
  type WriteOutcome,
} from './ai-session.js';
import { Icon } from './Icon.js';

/** What the 改寫 tab would rewrite: a range of the saved Markdown and its label. */
export interface AiSelection {
  range: { start: number; end: number } | null;
  /** 「第 2 段」, 「第 2–4 段」 or 「全文」. */
  label: string;
  /** Characters (字) of the selected text. */
  words: number;
}

const PRESETS: readonly { mode: Exclude<RewriteMode, 'custom'>; label: string }[] = [
  { mode: 'polish', label: '潤色' },
  { mode: 'shorten', label: '縮寫' },
  { mode: 'expand', label: '擴寫' },
  { mode: 'tone', label: '語氣' },
];

export interface AiPanelProps {
  rewrite: RewriteSession;
  titles: TitleSession;
  selection: AiSelection;
  /** Read-only work (missing or unmounted external file): nothing can be generated or accepted. */
  readOnly: boolean;
  /** Revision number (r12) for the 「已採用 · r12」 bar. */
  revisionNumber: (id: string) => number | undefined;
  onOpenSettings: () => void;
}

function useStore<S>(store: { subscribe: (l: (s: S) => void) => () => void; snapshot: S }): S {
  return useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
}

/**
 * Editor AI panel (QC-024) from the approved MacEditor board: 改寫 with a
 * per-hunk diff, and four-platform title candidates.
 */
export function AiPanel(props: AiPanelProps) {
  const [tab, setTab] = useState<'rewrite' | 'title'>('rewrite');
  const rw = useStore(props.rewrite);
  const tt = useStore(props.titles);
  const provider = (tab === 'rewrite' ? rw.provider : tt.provider) ?? rw.provider ?? tt.provider;
  return (
    <aside className="panel ai" aria-label="AI 改寫" id="ai-panel">
      <div className="ai__tabs" role="tablist" aria-label="AI">
        <button
          type="button"
          role="tab"
          className="ai__tab"
          aria-selected={tab === 'rewrite'}
          onClick={() => {
            setTab('rewrite');
          }}
        >
          改寫
        </button>
        <button
          type="button"
          role="tab"
          className="ai__tab"
          aria-selected={tab === 'title'}
          onClick={() => {
            setTab('title');
          }}
        >
          標題
        </button>
        {provider !== null && (
          <span className="chip chip--neutral ai__provider">
            <Icon name="spark" size={12} />
            {provider.name} · 雲端
          </span>
        )}
      </div>
      {tab === 'rewrite' ? <RewriteTab {...props} /> : <TitleTab {...props} />}
    </aside>
  );
}

function BlockNotice({ block, onOpenSettings }: { block: AiBlock; onOpenSettings: () => void }) {
  return (
    <div className="ai__notice" role="alert">
      <Icon name="key" />
      <span className="ai__notice-text">{AI_BLOCK_LABEL[block]}</span>
      <button type="button" className="btn btn--small" onClick={onOpenSettings}>
        前往設定
      </button>
    </div>
  );
}

function Generating({ onStop }: { onStop: () => void }) {
  return (
    <div className="ai__box" role="status" aria-label="生成中">
      <div className="skel ai__skel" style={{ width: '90%' }} />
      <div className="skel ai__skel" style={{ width: '75%' }} />
      <div className="skel ai__skel" style={{ width: '82%' }} />
      <div className="skel ai__skel" style={{ width: '60%' }} />
      <button type="button" className="btn btn--ghost btn--small ai__stop" onClick={onStop}>
        停止
      </button>
    </div>
  );
}

function Failed({
  failure,
  onRetry,
  onClose,
}: {
  failure: { code: keyof typeof FAILURE_LABEL | null; message: string };
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="ai__failed" role="alert">
      <span className="ai__failed-title">
        生成失敗 · {failure.code === null ? failure.message : FAILURE_LABEL[failure.code]}
      </span>
      {failure.code !== null && failure.message !== '' && (
        <span className="ai__failed-detail">{failure.message}</span>
      )}
      <div className="ai__row">
        <button type="button" className="btn btn--small" onClick={onRetry}>
          重試
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  );
}

function RewriteTab({
  rewrite,
  selection,
  readOnly,
  revisionNumber,
  onOpenSettings,
}: AiPanelProps) {
  const s = useStore(rewrite);
  const [preset, setPreset] = useState<Exclude<RewriteMode, 'custom'> | null>('polish');
  const [prompt, setPrompt] = useState('');
  const [composing, setComposing] = useState(false);
  const extra = prompt.trim();
  const needsText = preset === null || preset === 'tone';
  const sendDisabled =
    readOnly ||
    s.block !== null ||
    s.phase === 'loading' ||
    s.phase === 'busy' ||
    (needsText && extra === '');

  const send = () => {
    if (sendDisabled) return;
    const mode: RewriteMode = preset ?? 'custom';
    void rewrite.generate({
      mode,
      ...(mode === 'tone' ? { tone: extra } : extra === '' ? {} : { instruction: extra }),
      range: selection.range,
    });
  };

  const pending = s.phase === 'pending' || s.phase === 'busy';
  const c = s.candidate;
  const checked = s.picks.filter(Boolean).length;
  const lengths = rewrite.lengths();
  const doneN = s.done === null ? undefined : revisionNumber(s.done.revisionId);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || composing) return;
    if (s.phase === 'pending') {
      if (e.key === 'Enter' && e.metaKey && checked > 0) {
        e.preventDefault();
        void rewrite.accept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rewrite.discard();
      }
    }
    const inField = e.target instanceof HTMLInputElement;
    if (s.done !== null && !inField && e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void rewrite.undo();
    }
  };

  return (
    <div className="ai__body" onKeyDown={onKeyDown}>
      {s.block !== null && <BlockNotice block={s.block} onOpenSettings={onOpenSettings} />}
      {s.done !== null && (
        <div className="ai__done" role="status">
          <Icon name="check" />
          {s.done.label}
          {doneN !== undefined && ` · r${String(doneN)}`}
          <button
            type="button"
            className="btn btn--ghost btn--small ai__undo"
            aria-keyshortcuts="Meta+Z"
            onClick={() => {
              void rewrite.undo();
            }}
          >
            <Icon name="undo" />
            復原
          </button>
        </div>
      )}
      <div className="ai__sel">
        <Icon name="lines" size={13} />
        選取：{selection.label} · {selection.words} 字
      </div>
      <div className="ai__compose">
        <div className="ai__presets" role="group" aria-label="改寫方式">
          {PRESETS.map((p) => (
            <button
              key={p.mode}
              type="button"
              className="ai__preset"
              aria-pressed={preset === p.mode}
              onClick={() => {
                setPreset((cur) => (cur === p.mode ? null : p.mode));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="ai__prompt">
          <span className="visually-hidden">
            {preset === 'tone' ? '語氣' : preset === null ? '改寫指令' : '補充指令'}
          </span>
          <input
            type="text"
            placeholder={
              preset === 'tone' ? '語氣，例如：輕鬆口語' : preset === null ? '改寫指令' : '補充指令'
            }
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
            }}
            onCompositionStart={() => {
              setComposing(true);
            }}
            onCompositionEnd={() => {
              setComposing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !composing && !e.metaKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            className="btn btn--primary btn--icon ai__send"
            aria-label="生成"
            disabled={sendDisabled}
            onClick={send}
          >
            <Icon name="send" size={14} />
          </button>
        </label>
      </div>

      {s.phase === 'loading' && (
        <Generating
          onStop={() => {
            void rewrite.stop();
          }}
        />
      )}
      {s.phase === 'failed' && s.failure !== null && (
        <Failed
          failure={s.failure}
          onRetry={() => {
            void rewrite.retry();
          }}
          onClose={() => {
            rewrite.discard();
          }}
        />
      )}
      {pending && c !== null && (
        <div className="ai__cand">
          <div className="ai__meta">
            <span>{c.hunks} 處修改</span>
            {lengths !== null && (
              <span className="ai__nums">
                {lengths.before} → {lengths.after} 字
              </span>
            )}
          </div>
          {c.segments.map((seg) =>
            seg.kind === 'same' ? null : (
              <label key={seg.index} className="ai__hunk">
                <input
                  type="checkbox"
                  checked={s.picks[seg.index] === true}
                  onChange={() => {
                    rewrite.toggle(seg.index);
                  }}
                />
                <span className="ai__hunk-text">
                  {seg.before !== '' && <span className="del">{seg.before}</span>}
                  {seg.after !== '' && <span className="ins">{seg.after}</span>}
                </span>
              </label>
            ),
          )}
          {s.notice !== null && (
            <p className="ai__warn" role="alert">
              {s.notice}
            </p>
          )}
          <div className="ai__row ai__actions">
            <button
              type="button"
              className="btn btn--primary"
              aria-keyshortcuts="Meta+Enter"
              disabled={checked === 0 || s.phase === 'busy' || readOnly}
              onClick={() => {
                void rewrite.accept();
              }}
            >
              <Icon name="check" />
              {checked === c.hunks ? '採用' : `採用 ${String(checked)}/${String(c.hunks)}`}
              <kbd>⌘↩</kbd>
            </button>
            <button
              type="button"
              className="btn"
              disabled={s.phase === 'busy' || readOnly}
              onClick={() => {
                void rewrite.insert();
              }}
            >
              插入
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={s.phase === 'busy' || readOnly}
              onClick={() => {
                void rewrite.retry();
              }}
            >
              <Icon name="retry" />
              重試
            </button>
            <button
              type="button"
              className="btn btn--ghost ai__discard"
              aria-keyshortcuts="Escape"
              disabled={s.phase === 'busy'}
              onClick={() => {
                rewrite.discard();
              }}
            >
              捨棄<kbd>esc</kbd>
            </button>
          </div>
        </div>
      )}
      {s.phase === 'idle' && (
        <div className="ai__empty">
          <span>{s.notice ?? '無候選'}</span>
          <button
            type="button"
            className="btn"
            disabled={readOnly || s.block !== null || (needsText && extra === '')}
            onClick={send}
          >
            <Icon name="spark" />
            {selection.range === null ? '改寫全文' : '改寫選取段落'}
          </button>
        </div>
      )}
    </div>
  );
}

const OUTCOME_LABEL: Readonly<Record<WriteOutcome, string>> = {
  updated: '已寫入',
  created: '已新建並寫入',
  conflict: '已在別處修改，未寫入',
  error: '寫入失敗',
};

function writtenSummary(written: Partial<Record<Platform, WriteOutcome>>) {
  const entries = Object.entries(written) as [Platform, WriteOutcome][];
  const ok = entries.filter(([, o]) => o === 'updated' || o === 'created');
  const created = entries.filter(([, o]) => o === 'created').length;
  const failed = entries.filter(([, o]) => o === 'conflict' || o === 'error');
  return { ok: ok.length, created, failed };
}

function TitleTab({ titles, readOnly, onOpenSettings }: AiPanelProps) {
  const s = useStore(titles);
  const summary = s.written === null ? null : writtenSummary(s.written);
  return (
    <div className="ai__body">
      {s.block !== null && <BlockNotice block={s.block} onOpenSettings={onOpenSettings} />}
      {s.phase === 'loading' && (
        <Generating
          onStop={() => {
            void titles.stop();
          }}
        />
      )}
      {s.phase === 'failed' && s.failure !== null && (
        <Failed
          failure={s.failure}
          onRetry={() => {
            void titles.retry();
          }}
          onClose={() => {
            void titles.stop();
          }}
        />
      )}
      {s.phase === 'ready' &&
        TITLE_PLATFORMS.map((platform) => {
          const list = s.titles[platform];
          if (list === undefined) return null;
          const limit = titleLimit(platform);
          const name = getTemplate(platform).shortName;
          return (
            <fieldset key={platform} className="ai__pl">
              <legend className="ai__pl-name">
                {name}
                {limit !== null && <span className="ai__pl-limit">上限 {limit}</span>}
              </legend>
              {list.map((cand, i) => {
                const len = titleLength(cand.text);
                const over = limit !== null && len > limit;
                return (
                  <label key={`${String(i)}:${cand.text}`} className="ai__opt">
                    <input
                      type="radio"
                      name={`title-${platform}`}
                      checked={s.picks[platform] === i}
                      onChange={() => {
                        titles.pick(platform, i);
                      }}
                    />
                    <span className="ai__opt-text">{cand.text}</span>
                    <span className={over ? 'chip chip--warn ai__count' : 'ai__count'}>
                      {len}
                      {limit !== null && `/${String(limit)}`}
                    </span>
                  </label>
                );
              })}
              {s.written?.[platform] !== undefined &&
                (s.written[platform] === 'conflict' || s.written[platform] === 'error') && (
                  <span className="ai__pl-fail" role="alert">
                    {OUTCOME_LABEL[s.written[platform]]}
                  </span>
                )}
            </fieldset>
          );
        })}
      {s.phase === 'ready' && (
        <div className="ai__row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={s.writing || readOnly}
            onClick={() => {
              void titles.write();
            }}
          >
            寫入平台版本
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={s.writing}
            onClick={() => {
              void titles.generate();
            }}
          >
            <Icon name="retry" />
            重試
          </button>
          {summary !== null && summary.ok > 0 && (
            <span className="chip chip--ok" role="status">
              已寫入 {summary.ok} 個版本
              {summary.created > 0 && `（${String(summary.created)} 個新建）`}
            </span>
          )}
        </div>
      )}
      {s.phase === 'idle' && (
        <div className="ai__empty">
          <span>無候選</span>
          <button
            type="button"
            className="btn"
            disabled={readOnly || s.block !== null}
            onClick={() => {
              void titles.generate();
            }}
          >
            <Icon name="spark" />
            生成標題候選
          </button>
        </div>
      )}
    </div>
  );
}
