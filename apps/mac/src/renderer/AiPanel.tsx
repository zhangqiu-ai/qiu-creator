import type { AiProviderStatus, Platform, RewriteMode } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
import { getTemplate } from '@qiu-creator/platform-preview';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import {
  AI_BLOCK_LABEL,
  FAILURE_LABEL,
  TITLE_PLATFORMS,
  titleLength,
  titleLimit,
  type AiBlock,
  type AiProviders,
  type RewriteSession,
  type TitleSession,
  type WriteOutcome,
} from './ai-session.js';
import { Icon } from './Icon.js';
import { useExitFade } from './motion.js';
import { t } from './i18n.js';
import { TechnicalDetails } from './TechnicalDetails.js';

/** What the 改寫 tab would rewrite: a range of the saved Markdown and its label. */
export interface AiSelection {
  range: { start: number; end: number } | null;
  /** 「第 2 段」, 「第 2–4 段」 or 「全文」. */
  label: string;
  /** Characters (字) of the selected text. */
  words: number;
}

/**
 * The rewrite styles. `mode` is what the service is sent, `label` only what
 * the button shows, so translating a label changes nothing that is sent.
 */
const PRESETS: readonly { mode: Exclude<RewriteMode, 'custom'>; label: MessageKey }[] = [
  { mode: 'polish', label: 'ai.presetPolish' },
  { mode: 'shorten', label: 'ai.presetShorten' },
  { mode: 'expand', label: 'ai.presetExpand' },
  { mode: 'tone', label: 'ai.presetTone' },
];

export interface AiPanelProps {
  providers: AiProviders;
  rewrite: RewriteSession;
  titles: TitleSession;
  selection: AiSelection;
  /** Read-only work (missing or unmounted external file): nothing can be generated or accepted. */
  readOnly: boolean;
  /** Revision number (r12) for the 「已採用 · r12」 bar. */
  revisionNumber: (id: string) => number | undefined;
  onOpenSettings: () => void;
  /** Bumped when the tab comes back to the front (QC-047): re-read the provider list. */
  refreshToken?: number;
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
  const panelRef = useRef<HTMLElement>(null);
  // The side panel slides in (24 px, moderate) and back out (base).
  useExitFade(panelRef, 'panel');
  const [tab, setTab] = useState<'rewrite' | 'title'>('rewrite');
  const rw = useStore(props.rewrite);
  const tt = useStore(props.titles);
  const { providers, rewrite, titles } = props;
  const [options, setOptions] = useState<AiProviderStatus[]>([]);
  const provider = rw.provider ?? tt.provider;
  const selected = options.find((item) => item.provider === provider?.provider);
  const canChoose = options.length > 1 || (options.length === 1 && selected === undefined);
  useEffect(() => {
    let active = true;
    void providers.list().then(
      (items) => {
        if (active) setOptions(items.filter((item) => item.ready));
      },
      () => {
        if (active) setOptions([]);
      },
    );
    return () => {
      active = false;
    };
  }, [providers, rw.block, tt.block, props.refreshToken]);
  return (
    <aside ref={panelRef} className="panel ai" aria-label={t('ai.panelLabel')} id="ai-panel">
      <div className="ai__tabs">
        <div className="ai__tab-list" role="tablist" aria-label="AI">
          <button
            type="button"
            role="tab"
            className="ai__tab"
            aria-selected={tab === 'rewrite'}
            onClick={() => {
              setTab('rewrite');
            }}
          >
            {t('ai.tabRewrite')}
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
            {t('ai.tabTitle')}
          </button>
        </div>
        {canChoose ? (
          <select
            className="input ai__provider ai__provider-select"
            aria-label={t('ai.providerLabel')}
            value={selected?.provider ?? ''}
            disabled={rw.phase === 'loading' || rw.phase === 'busy' || tt.phase === 'loading'}
            onChange={(event) => {
              const selected = options.find((item) => item.provider === event.target.value);
              if (selected === undefined) return;
              providers.select(selected.provider);
              void rewrite.loadProvider();
              void titles.loadProvider();
            }}
          >
            {selected === undefined && (
              <option value="" disabled>
                {t('ai.providerPick')}
              </option>
            )}
            {options.map((item) => (
              <option key={item.provider} value={item.provider}>
                {t('ai.providerCloud', { name: item.name })}
              </option>
            ))}
          </select>
        ) : provider !== null ? (
          <span className="chip chip--neutral ai__provider">
            <Icon name="spark" size={12} />
            {t('ai.providerCloud', { name: provider.name })}
          </span>
        ) : null}
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
        {t('ai.goToSettings')}
      </button>
    </div>
  );
}

function Generating({ onStop }: { onStop: () => void }) {
  return (
    <div className="ai__box" role="status" aria-label={t('ai.generating')}>
      <div className="skel ai__skel" style={{ width: '90%' }} />
      <div className="skel ai__skel" style={{ width: '75%' }} />
      <div className="skel ai__skel" style={{ width: '82%' }} />
      <div className="skel ai__skel" style={{ width: '60%' }} />
      <button type="button" className="btn btn--ghost btn--small ai__stop" onClick={onStop}>
        {t('ai.stop')}
      </button>
    </div>
  );
}

function Failed({
  failure,
  onRetry,
  onClose,
}: {
  failure: { code: keyof typeof FAILURE_LABEL | null; message: string; detail?: string | null };
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="ai__failed" role="alert">
      <span className="ai__failed-title">
        {t('ai.generateFailedWith', {
          reason: failure.code === null ? failure.message : FAILURE_LABEL[failure.code],
        })}
      </span>
      <TechnicalDetails text={failure.detail} />
      <div className="ai__row">
        <button type="button" className="btn btn--small" onClick={onRetry}>
          {t('common.retry')}
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
          {t('common.close')}
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
            {t('common.undo')}
          </button>
        </div>
      )}
      <div className="ai__sel">
        <Icon name="lines" size={13} />
        {t('ai.selection', { label: selection.label, count: selection.words })}
      </div>
      <div className="ai__compose">
        <div className="ai__presets" role="group" aria-label={t('ai.rewriteWays')}>
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
              {t(p.label)}
            </button>
          ))}
        </div>
        <label className="ai__prompt">
          <span className="visually-hidden">
            {preset === 'tone'
              ? t('ai.presetTone')
              : preset === null
                ? t('ai.instruction')
                : t('ai.extraInstruction')}
          </span>
          <input
            type="text"
            placeholder={
              preset === 'tone'
                ? t('ai.tonePlaceholder')
                : preset === null
                  ? t('ai.instruction')
                  : t('ai.extraInstruction')
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
            aria-label={t('ai.generate')}
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
            <span>{t('ai.hunkCount', { count: c.hunks })}</span>
            {lengths !== null && (
              <span className="ai__nums">
                {t('ai.lengthChange', { before: lengths.before, after: lengths.after })}
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
              {checked === c.hunks ? t('ai.apply') : t('ai.applySome', { checked, total: c.hunks })}
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
              {t('ai.insert')}
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
              {t('common.retry')}
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
              {t('ai.discard')}
              <kbd>esc</kbd>
            </button>
          </div>
        </div>
      )}
      {s.phase === 'idle' && (
        <div className="ai__empty">
          <span>{s.notice ?? t('ai.noCandidates')}</span>
          <button
            type="button"
            className="btn"
            disabled={readOnly || s.block !== null || (needsText && extra === '')}
            onClick={send}
          >
            <Icon name="spark" />
            {selection.range === null ? t('ai.rewriteAll') : t('ai.rewriteSelection')}
          </button>
        </div>
      )}
    </div>
  );
}

const OUTCOME_LABEL: Readonly<Record<WriteOutcome, string>> = {
  get updated() {
    return t('ai.outcomeUpdated');
  },
  get created() {
    return t('ai.outcomeCreated');
  },
  get conflict() {
    return t('ai.outcomeConflict');
  },
  get error() {
    return t('ai.outcomeError');
  },
};

function writtenSummary(written: Partial<Record<Platform, WriteOutcome>>) {
  const entries = Object.entries(written) as [Platform, WriteOutcome][];
  const ok = entries.filter(([, o]) => o === 'updated' || o === 'created');
  const created = entries.filter(([, o]) => o === 'created').map(([p]) => getTemplate(p).shortName);
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
                {limit !== null && (
                  <span className="ai__pl-limit">{t('ai.titleLimitLabel', { limit })}</span>
                )}
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
            {t('ai.writeVariants')}
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
            {t('common.retry')}
          </button>
          {summary !== null && summary.ok > 0 && (
            <span className="chip chip--ok ai__written" role="status">
              {summary.created.length === 0
                ? t('ai.titleWritten', { count: summary.ok })
                : t('ai.titleWrittenNew', {
                    count: summary.ok,
                    names: summary.created.join(t('common.listSeparator')),
                  })}
            </span>
          )}
        </div>
      )}
      {s.phase === 'idle' && (
        <div className="ai__empty">
          <span>{t('ai.noCandidates')}</span>
          <button
            type="button"
            className="btn"
            disabled={readOnly || s.block !== null}
            onClick={() => {
              void titles.generate();
            }}
          >
            <Icon name="spark" />
            {t('ai.generateTitles')}
          </button>
        </div>
      )}
    </div>
  );
}
