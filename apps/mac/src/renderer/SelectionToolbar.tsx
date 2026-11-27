import type { Prompt, RewriteMode } from '@qiu-creator/contracts';
import type {
  EditorMode,
  MarkdownEditorHandle,
  MarkdownRange,
} from '@qiu-creator/markdown-editor-web';
import type { MessageKey } from '@qiu-creator/i18n';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { t } from './i18n.js';
import { Icon, type IconName } from './Icon.js';
import { LanguageModelSwitch } from './AiChoices.js';
import { Animated, Presence } from './motion.js';
import { PromptPicker } from './PromptPicker.js';

/** What a toolbar button asks for. */
export type ToolbarAction =
  | { kind: 'rewrite'; mode: Exclude<RewriteMode, 'custom' | 'tone'> }
  | { kind: 'rewrite'; mode: 'tone'; tone: string }
  | { kind: 'rewrite'; mode: 'custom'; instruction: string }
  /** A prompt from the library (QC-075). */
  | { kind: 'prompt'; prompt: Prompt }
  | { kind: 'image' };

type Button =
  | { id: 'polish' | 'expand' | 'shorten'; label: MessageKey; icon: IconName }
  | { id: 'tone' | 'prompt' | 'image'; label: MessageKey; icon: IconName };

const REWRITE: readonly Button[] = [
  { id: 'polish', label: 'ai.presetPolish', icon: 'spark' },
  { id: 'expand', label: 'ai.presetExpand', icon: 'expandText' },
  { id: 'shorten', label: 'ai.presetShorten', icon: 'shortenText' },
  { id: 'tone', label: 'ai.presetTone', icon: 'tone' },
];
const IMAGE: Button = { id: 'image', label: 'ai.actImage', icon: 'image' };
/** 「更多」 became 「Prompt」 (QC-075): it is mostly a prompt picker now (⌘K). */
const PROMPT: Button = { id: 'prompt', label: 'ai.promptButton', icon: 'prompt' };

/** Room the toolbar with the prompt picker open needs above the selection (px). */
const PICKER_ROOM = 440;

/**
 * Where the toolbar stands for a selection's box. Source mode: upright inside
 * the text area's left padding, beside the line. Visual mode: above the
 * selection when there is room (with the prompt picker open, it needs much
 * more, since the picker opens inside the toolbar), else below it.
 */
/** A selection's box on screen. */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function placeFor(rect: Box, mode: EditorMode, picker: boolean): Place {
  if (mode === 'source') return { left: rect.left + 2, top: rect.top - 4, side: 'left' };
  const above = rect.top > (picker ? PICKER_ROOM : 72);
  return {
    left: rect.left + rect.width / 2,
    top: above ? rect.top - 8 : rect.top + rect.height + 8,
    side: above ? 'above' : 'below',
  };
}

/** How long a finished selection waits before the toolbar appears (PT-20261122-002). */
export const TOOLBAR_DELAY_MS = 200;

interface Place {
  left: number;
  top: number;
  /** Visual mode: above the selection (or below it near the top). Source: beside the line. */
  side: 'above' | 'below' | 'left';
}

/**
 * 選取浮動工具列 (QC-070, PT-20261122-002): after a selection is made, a row of
 * actions appears above it (潤色 擴寫 縮寫 語氣 ｜ 配圖 ｜ Prompt ｜ 語言 模型,
 * QC-075, PT-20261122-003). ⌘K opens the prompt picker. It never takes
 * focus by itself, so typing goes on into the text; ⌘J moves into it, ←→
 * (↑↓ when upright) move along it, esc closes it and puts the selection back.
 * Not while dragging a selection, typing or composing with an IME. In source
 * mode it stands upright beside the selected line, never over the text.
 */
export function SelectionToolbar({
  editor,
  scroller,
  mode,
  active,
  disabled,
  imageDisabledReason,
  onAction,
  onManagePrompts,
  onOpenAiServices,
  onNotice,
  onError,
}: {
  editor: RefObject<MarkdownEditorHandle | null>;
  /** The scrolling document area: the toolbar follows its scroll. */
  scroller: RefObject<HTMLElement | null>;
  mode: EditorMode;
  /** This editor is the tab in front. */
  active: boolean;
  /** Nothing can be generated (read-only, or a generation is already running). */
  disabled: boolean;
  /** Why 配圖 is unavailable (no image model, New API not set up), or null. */
  imageDisabledReason: string | null;
  onAction: (action: ToolbarAction, range: MarkdownRange) => void;
  onManagePrompts: () => void;
  onOpenAiServices: () => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const [extra, setExtra] = useState<'tone' | 'prompt' | null>(null);
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const range = useRef<MarkdownRange | null>(null);
  /** The selection an action was just taken on: no toolbar again until the selection changes. */
  const used = useRef<string | null>(null);
  /** The DOM selection when the toolbar appeared, to put back on esc (visual mode). */
  const saved = useRef<Range | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const open = place !== null;
  const hintId = useId();
  const openRef = useRef(open);
  openRef.current = open;
  const pickerOpen = useRef(false);
  /** The selection's box when the toolbar was last placed. */
  const selRect = useRef<Box | null>(null);
  pickerOpen.current = extra === 'prompt';

  const hide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPlace(null);
    setExtra(null);
    setText('');
  }, []);

  /** Where the toolbar stands for the selection now, or null when there is none to act on. */
  const measure = useCallback((): Place | null => {
    const ed = editor.current;
    if (ed === null || ed.isComposing()) return null;
    // Only for a selection the person is working in (not one left behind in the text
    // while they use the side panel).
    const focused = document.activeElement;
    if (focused?.closest('.qc-md-editor') == null) return null;
    const rect = ed.selectionRect();
    const r = ed.getSelectionRange();
    if (rect === null || r === null) {
      used.current = null;
      return null;
    }
    const key = `${String(r.start)}-${String(r.end)}:${window.getSelection()?.toString() ?? ''}`;
    if (used.current === key) return null;
    used.current = null;
    range.current = r;
    selRect.current = rect;
    return placeFor(rect, mode, pickerOpen.current);
  }, [editor, mode]);

  const show = useCallback((): Place | null => {
    const p = measure();
    if (p === null) {
      hide();
      return null;
    }
    const sel = window.getSelection();
    saved.current =
      mode === 'visual' && sel !== null && sel.rangeCount > 0
        ? sel.getRangeAt(0).cloneRange()
        : null;
    setPlace(p);
    return p;
  }, [measure, hide, mode]);

  // A finished selection (mouse up, ⇧ released, or any selection change) shows it after a pause.
  useEffect(() => {
    if (!active || disabled) {
      hide();
      return;
    }
    const schedule = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (dragging.current) return;
        // Focus inside the toolbar (⌘J, 更多): keep it where it is.
        if (bar.current?.contains(document.activeElement) === true) return;
        show();
      }, TOOLBAR_DELAY_MS);
    };
    const area = scroller.current;
    const onDown = (e: MouseEvent) => {
      if (bar.current?.contains(e.target as Node) === true) return;
      // A new selection begins: whatever it becomes, it may have the toolbar.
      used.current = null;
      dragging.current = true;
      hide();
    };
    const onUp = () => {
      dragging.current = false;
      schedule();
    };
    const onSelection = () => {
      if (bar.current?.contains(document.activeElement) === true) return;
      if (!openRef.current) {
        schedule();
        return;
      }
      // Already showing: follow the selection, or go when it is gone.
      if (measure() === null) hide();
      else schedule();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (bar.current?.contains(e.target as Node) === true) return;
      // Typing (not moving the selection with ⇧ and arrows) puts the toolbar away.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.startsWith('Arrow') || e.key === 'Shift') {
        schedule();
        return;
      }
      hide();
    };
    area?.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onSelection);
    area?.addEventListener('keydown', onKey);
    return () => {
      area?.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onSelection);
      area?.removeEventListener('keydown', onKey);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [active, disabled, scroller, show, hide, measure]);

  // Opening or closing the picker changes the room the toolbar needs: place it again
  // for the selection it was shown for (focus may be in the picker by now).
  useEffect(() => {
    const rect = selRect.current;
    if (!openRef.current || rect === null) return;
    setPlace(placeFor(rect, mode, extra === 'prompt'));
  }, [extra, mode]);

  // It follows the text while the document scrolls or the window resizes.
  useEffect(() => {
    if (!open) return;
    const area = scroller.current;
    const follow = () => {
      const p = measure();
      if (p === null) hide();
      else setPlace(p);
    };
    area?.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
    return () => {
      area?.removeEventListener('scroll', follow);
      window.removeEventListener('resize', follow);
    };
  }, [open, scroller, measure, hide]);

  // ⌘J: into the toolbar (showing it first if a selection is there).
  useEffect(() => {
    if (!active || disabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      if (!openRef.current && show() === null) return;
      e.preventDefault();
      // ⌘K: straight into the prompt picker.
      if (key === 'k') {
        e.stopPropagation();
        setExtra('prompt');
        return;
      }
      requestAnimationFrame(() => {
        bar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      });
    };
    // Capture: the editor would otherwise take ⌘K (its link shortcut) first.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active, disabled, show]);

  /** Back to the text with the selection as it was. */
  const backToText = useCallback(() => {
    hide();
    if (mode === 'source') {
      document.querySelector<HTMLTextAreaElement>('.qc-md-editor__source')?.focus();
      return;
    }
    const r = saved.current;
    const content = document.querySelector<HTMLElement>('.qc-md-editor__content');
    content?.focus({ preventScroll: true });
    if (r !== null) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }, [hide, mode]);

  const run = (action: ToolbarAction) => {
    const r = range.current;
    if (r !== null)
      used.current = `${String(r.start)}-${String(r.end)}:${window.getSelection()?.toString() ?? ''}`;
    hide();
    if (r !== null) onAction(action, r);
  };

  const pick = (b: Button) => {
    if (b.id === 'tone' || b.id === 'prompt') {
      const id = b.id;
      setExtra((cur) => (cur === id ? null : id));
      setText('');
      return;
    }
    if (b.id === 'image') run({ kind: 'image' });
    else run({ kind: 'rewrite', mode: b.id });
  };

  const sendExtra = () => {
    const value = text.trim();
    if (value === '' || extra === null) return;
    run({ kind: 'rewrite', mode: 'tone', tone: value });
  };

  const upright = place?.side === 'left';
  /** The selected text, for what 跟隨原文 detects. */
  const selectedText = () => {
    const r = range.current;
    const md = editor.current?.getMarkdown() ?? '';
    return r === null ? '' : md.slice(r.start, r.end);
  };
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || composing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (
        extra !== null &&
        e.target instanceof HTMLElement &&
        e.target.closest('.ftb__more, .qpop') !== null
      ) {
        setExtra(null);
        return;
      }
      backToText();
      return;
    }
    const next = upright ? 'ArrowDown' : 'ArrowRight';
    const prev = upright ? 'ArrowUp' : 'ArrowLeft';
    if (
      (e.key !== next && e.key !== prev) ||
      e.target instanceof HTMLInputElement ||
      (e.target instanceof HTMLElement && e.target.closest('.qpop') !== null)
    )
      return;
    e.preventDefault();
    const buttons = Array.from(
      bar.current?.querySelectorAll<HTMLButtonElement>('.ftb__btn:not(:disabled)') ?? [],
    );
    const at = buttons.findIndex((b) => b === document.activeElement);
    const to = (at + (e.key === next ? 1 : -1) + buttons.length) % buttons.length;
    buttons[to]?.focus();
  };

  const button = (b: Button) => {
    const imageOff = b.id === 'image' && imageDisabledReason !== null;
    return (
      <button
        key={b.id}
        type="button"
        className="ftb__btn"
        aria-expanded={b.id === 'tone' || b.id === 'prompt' ? extra === b.id : undefined}
        aria-haspopup={b.id === 'prompt' ? 'dialog' : undefined}
        aria-keyshortcuts={b.id === 'prompt' ? 'Meta+K' : undefined}
        disabled={imageOff}
        aria-label={t(b.label)}
        title={imageOff ? imageDisabledReason : place?.side === 'left' ? t(b.label) : undefined}
        onMouseDown={(e) => {
          // Keep the text selection while clicking the toolbar.
          e.preventDefault();
        }}
        onClick={() => {
          pick(b);
        }}
      >
        <Icon name={b.icon} size={14} />
        <span className="ftb__label" aria-hidden="true">
          {t(b.label)}
        </span>
      </button>
    );
  };

  const anchor: CSSProperties | undefined =
    place === null
      ? undefined
      : {
          left: place.left,
          top: place.top,
          transform:
            place.side === 'above'
              ? 'translate(-50%, -100%)'
              : place.side === 'below'
                ? 'translate(-50%, 0)'
                : 'none',
        };

  return (
    <Presence>
      {place !== null && (
        <div key="ftb" className="ftb-anchor" style={anchor}>
          <Animated
            ref={bar}
            preset={{
              kind: 'popover',
              origin:
                place.side === 'above'
                  ? 'bottom center'
                  : place.side === 'below'
                    ? 'center'
                    : 'top right',
            }}
            className={upright ? 'ftb ftb--upright' : 'ftb'}
            role="toolbar"
            aria-label={t('ai.toolbarLabel')}
            aria-orientation={upright ? 'vertical' : 'horizontal'}
            aria-keyshortcuts="Meta+J"
            aria-describedby={hintId}
            onKeyDown={onBarKey}
          >
            <span id={hintId} className="visually-hidden">
              {t('ai.toolbarHint')}
            </span>
            <div className="ftb__row">
              {REWRITE.map(button)}
              <span className="ftb__sep" aria-hidden="true" />
              {button(IMAGE)}
              <span className="ftb__sep" aria-hidden="true" />
              {button(PROMPT)}
              {!upright && (
                <>
                  <span className="ftb__sep" aria-hidden="true" />
                  <LanguageModelSwitch
                    variant="toolbar"
                    sample={selectedText()}
                    onError={onError}
                    onOpenServices={onOpenAiServices}
                  />
                </>
              )}
            </div>
            {extra === 'prompt' && (
              <div className="ftb__picker qpop" role="dialog" aria-label={t('ai.promptButton')}>
                <PromptPicker
                  scene="selection"
                  onApply={(prompt) => {
                    run({ kind: 'prompt', prompt });
                  }}
                  onSend={(instruction) => {
                    run({ kind: 'rewrite', mode: 'custom', instruction });
                  }}
                  onManage={() => {
                    hide();
                    onManagePrompts();
                  }}
                  onSaved={(name) => {
                    onNotice(t('ai.promptSaved', { name }));
                  }}
                  onClose={() => {
                    setExtra(null);
                    requestAnimationFrame(() => {
                      bar.current
                        ?.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Meta+K"]')
                        ?.focus();
                    });
                  }}
                />
              </div>
            )}
            {extra === 'tone' && (
              <form
                className="ftb__more"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendExtra();
                }}
              >
                <input
                  // The field takes focus when it opens: it is what the button asked for.
                  autoFocus
                  type="text"
                  className="ftb__input"
                  aria-label={t('ai.presetTone')}
                  placeholder={t('ai.tonePlaceholderShort')}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                  }}
                  onCompositionStart={() => {
                    setComposing(true);
                  }}
                  onCompositionEnd={() => {
                    setComposing(false);
                  }}
                />
                <button
                  type="submit"
                  className="btn btn--primary btn--small"
                  disabled={text.trim() === ''}
                >
                  {t('ai.send')}
                </button>
              </form>
            )}
          </Animated>
        </div>
      )}
    </Presence>
  );
}
