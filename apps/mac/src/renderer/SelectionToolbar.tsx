import type { RewriteMode } from '@qiu-creator/contracts';
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
import { Animated, Presence } from './motion.js';

/** What a toolbar button asks for. */
export type ToolbarAction =
  | { kind: 'rewrite'; mode: Exclude<RewriteMode, 'custom' | 'tone'> }
  | { kind: 'rewrite'; mode: 'tone'; tone: string }
  | { kind: 'rewrite'; mode: 'custom'; instruction: string }
  | { kind: 'image' };

type Button =
  | { id: 'polish' | 'expand' | 'shorten'; label: MessageKey; icon: IconName }
  | { id: 'tone' | 'more' | 'image'; label: MessageKey; icon: IconName };

const REWRITE: readonly Button[] = [
  { id: 'polish', label: 'ai.presetPolish', icon: 'spark' },
  { id: 'expand', label: 'ai.presetExpand', icon: 'expandText' },
  { id: 'shorten', label: 'ai.presetShorten', icon: 'shortenText' },
  { id: 'tone', label: 'ai.presetTone', icon: 'tone' },
];
const IMAGE: Button = { id: 'image', label: 'ai.actImage', icon: 'image' };
const MORE: Button = { id: 'more', label: 'ai.actMore', icon: 'more' };

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
 * actions appears above it (潤色 擴寫 縮寫 語氣 ｜ 配圖 ｜ 更多). It never takes
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
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const [extra, setExtra] = useState<'tone' | 'more' | null>(null);
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
    // Source mode: upright inside the text area's left padding, beside the line.
    if (mode === 'source') return { left: rect.left + 2, top: rect.top - 4, side: 'left' };
    const above = rect.top > 72;
    return {
      left: rect.left + rect.width / 2,
      top: above ? rect.top - 8 : rect.top + rect.height + 8,
      side: above ? 'above' : 'below',
    };
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
      if (e.key.toLowerCase() !== 'j') return;
      if (!openRef.current && show() === null) return;
      e.preventDefault();
      requestAnimationFrame(() => {
        bar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
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
    if (b.id === 'tone' || b.id === 'more') {
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
    run(
      extra === 'tone'
        ? { kind: 'rewrite', mode: 'tone', tone: value }
        : { kind: 'rewrite', mode: 'custom', instruction: value },
    );
  };

  const upright = place?.side === 'left';
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || composing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (extra !== null && e.target instanceof HTMLInputElement) {
        setExtra(null);
        return;
      }
      backToText();
      return;
    }
    const next = upright ? 'ArrowDown' : 'ArrowRight';
    const prev = upright ? 'ArrowUp' : 'ArrowLeft';
    if ((e.key !== next && e.key !== prev) || e.target instanceof HTMLInputElement) return;
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
        aria-expanded={b.id === 'tone' || b.id === 'more' ? extra === b.id : undefined}
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
              {button(MORE)}
            </div>
            {extra !== null && (
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
                  aria-label={extra === 'tone' ? t('ai.presetTone') : t('ai.instruction')}
                  placeholder={
                    extra === 'tone' ? t('ai.tonePlaceholderShort') : t('ai.morePlaceholder')
                  }
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
