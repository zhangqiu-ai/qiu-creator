import type { Prompt, RewriteMode } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
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
  type AiBlock,
  type AiProviders,
  type RewriteSession,
} from './ai-session.js';
import type { ImageGenSession } from './ai-images.js';
import { AiImageTab } from './AiImageTab.js';
import { currentModel, useAiLibrary } from './ai-library.js';
import { CandidateTags, LanguageModelSwitch } from './AiChoices.js';
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
  selection: AiSelection;
  /** Read-only work (missing or unmounted external file): nothing can be generated or accepted. */
  readOnly: boolean;
  /** Revision number (r12) for the 「已採用 · r12」 bar. */
  revisionNumber: (id: string) => number | undefined;
  onOpenSettings: () => void;
  /** 管理 Prompt (QC-075). */
  onOpenPrompts?: () => void;
  /** Bumped when the tab comes back to the front (QC-047): re-read the provider list. */
  refreshToken?: number;
  /** 圖片 tab (QC-070): the image generations, the selected text, where 插入到游標處 puts an image. */
  images: ImageGenSession;
  selectionText: string;
  insertOffset: () => number;
  onNotice: (text: string) => void;
  /** Bring a tab to the front (the source-mode toolbar shows its results here); `n` makes each ask new. */
  tabRequest?: { tab: AiTab; n: number };
}

/** 標題 moved to the platform preview (QC-076): the editor keeps 改寫 and 圖片. */
export type AiTab = 'rewrite' | 'image';

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
  const [tab, setTab] = useState<AiTab>('rewrite');
  const { tabRequest } = props;
  useEffect(() => {
    if (tabRequest !== undefined) setTab(tabRequest.tab);
  }, [tabRequest]);
  const rw = useStore(props.rewrite);
  const { library } = useAiLibrary();
  // Back in front, or after a key or consent problem: list the models again.
  useEffect(() => {
    void library?.loadModels(true);
  }, [library, rw.block, props.refreshToken]);
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
            aria-selected={tab === 'image'}
            onClick={() => {
              setTab('image');
            }}
          >
            {t('ai.tabImage')}
          </button>
        </div>
      </div>
      {tab === 'rewrite' ? (
        <RewriteTab {...props} />
      ) : (
        <AiImageTab
          images={props.images}
          selectionText={props.selectionText}
          readOnly={props.readOnly}
          insertOffset={props.insertOffset}
          onOpenSettings={props.onOpenSettings}
          onNotice={props.onNotice}
        />
      )}
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

/** Waiting for candidates; when they come, this fades out (fast) over where they appear. */
function Generating({ onStop }: { onStop: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useExitFade(ref);
  return (
    <div ref={ref} className="ai__box" role="status" aria-label={t('ai.generating')}>
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

/** What the 改寫 tab will run: a built-in way, a prompt from the library, or only the typed text. */
type Pick =
  | { kind: 'preset'; mode: Exclude<RewriteMode, 'custom'> }
  | { kind: 'prompt'; prompt: Prompt }
  | null;

function RewriteTab({
  rewrite,
  selection,
  selectionText,
  readOnly,
  revisionNumber,
  onOpenSettings,
  onOpenPrompts,
  onNotice,
}: AiPanelProps) {
  const s = useStore(rewrite);
  const { state: choices } = useAiLibrary();
  const [pick, setPick] = useState<Pick>({ kind: 'preset', mode: 'polish' });
  const preset = pick?.kind === 'preset' ? pick.mode : null;
  // Custom prompts for selected text, in library order, next to the four built-in ways.
  const custom = (choices.prompts ?? []).filter((p) => !p.builtin && p.scene === 'selection');
  const [prompt, setPrompt] = useState('');
  const [composing, setComposing] = useState(false);
  const extra = prompt.trim();
  const needsText = pick === null || preset === 'tone';
  const sendDisabled =
    readOnly ||
    s.block !== null ||
    s.phase === 'loading' ||
    s.phase === 'busy' ||
    (needsText && extra === '');

  const send = () => {
    if (sendDisabled) return;
    const model = currentModel(choices, 'rewrite');
    if (pick?.kind === 'prompt') {
      void rewrite.generate({
        promptId: pick.prompt.id,
        ...(extra === '' ? {} : { instruction: extra }),
        model,
        range: selection.range,
      });
      return;
    }
    const mode: RewriteMode = preset ?? 'custom';
    void rewrite.generate({
      mode,
      ...(mode === 'tone' ? { tone: extra } : extra === '' ? {} : { instruction: extra }),
      model,
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
      <div className="ai-choices">
        <LanguageModelSwitch
          variant="panel"
          sample={selectionText}
          onNotice={onNotice}
          onOpenServices={onOpenSettings}
        />
      </div>
      <div className="ai__sel">
        <Icon name="lines" size={13} />
        {t('ai.selection', { label: selection.label, count: selection.words })}
      </div>
      <div className="ai__compose">
        <div className="ai__presets-head">
          <span>{t('ai.panelPrompts')}</span>
          {onOpenPrompts !== undefined && (
            <button type="button" className="ai__manage" onClick={onOpenPrompts}>
              {t('ai.panelManage')}
            </button>
          )}
        </div>
        <div className="ai__presets" role="group" aria-label={t('ai.rewriteWays')}>
          {PRESETS.map((p) => (
            <button
              key={p.mode}
              type="button"
              className="ai__preset"
              aria-pressed={preset === p.mode}
              onClick={() => {
                setPick((cur) =>
                  cur?.kind === 'preset' && cur.mode === p.mode
                    ? null
                    : { kind: 'preset', mode: p.mode },
                );
              }}
            >
              {t(p.label)}
            </button>
          ))}
          {custom.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ai__preset"
              aria-pressed={pick?.kind === 'prompt' && pick.prompt.id === p.id}
              title={p.content}
              onClick={() => {
                setPick((cur) =>
                  cur?.kind === 'prompt' && cur.prompt.id === p.id
                    ? null
                    : { kind: 'prompt', prompt: p },
                );
              }}
            >
              {p.name}
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
            <span>
              {t('ai.hunkCount', { count: c.hunks })}
              <CandidateTags result={c.result} model={c.model} />
            </span>
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
