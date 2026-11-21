import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor';
import { SOURCE_LOCALE, translate, type Locale } from '@qiu-creator/i18n';
import '@mdxeditor/editor/style.css';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  detectLossySyntax,
  lossyReasonLabel,
  restoreFinalNewline,
  type LossyReason,
} from './lossy.js';
import { createEditorPlugins, liveTranslationPlugin, TO_MARKDOWN_OPTIONS } from './plugins.js';
import { blockEndAt, boundaryBeforeBlock, insertBlockAt } from './insert.js';
import {
  expandToBlocks,
  markdownBlocks,
  rangeForBlockTexts,
  type MarkdownRange,
} from './selection.js';
import { editorTranslation } from './translation.js';

export type EditorMode = 'visual' | 'source';

export interface MarkdownEditorProps {
  /** Initial Markdown. Read on mount only; remount (change `key`) to load another document. */
  markdown: string;
  /** Called with the new Markdown after a user edit. Never called while an IME composition is active. */
  onChange: (markdown: string) => void;
  /** Told when IME composition starts and ends so hosts can hold saves and shortcuts. */
  onCompositionChange?: (composing: boolean) => void;
  onModeChange?: (mode: EditorMode) => void;
  /** Force a starting mode. Default: source for documents with lossy syntax, visual otherwise. */
  initialMode?: EditorMode;
  readOnly?: boolean;
  /** Render the built-in 視覺／原始碼 switch. Hosts with their own switch call `requestMode`. */
  showModeSwitch?: boolean;
  /**
   * Map image `src` values to loadable URLs for display (e.g. relative paths to
   * signed media URLs). The Markdown itself is never changed. Read through a
   * ref, so a new function does not remount the editor.
   */
  resolveImage?: (src: string) => Promise<string>;
  /**
   * Told when the user's selection inside the editor moves, as a Markdown
   * source range. Visual mode widens it to whole blocks; a collapsed caret in
   * source mode also widens to its block. Selections outside the editor (for
   * example in a side panel) are not reported, so hosts keep the last one.
   */
  onSelectionChange?: (range: MarkdownRange | null) => void;
  /** Accessible name for the editing area. */
  label?: string;
  /** Interface language (QC-042). Defaults to 繁體中文, the source text. */
  locale?: Locale;
  className?: string;
}

export interface MarkdownEditorHandle {
  /** The document text as it would be saved. */
  getMarkdown: () => string;
  isComposing: () => boolean;
  getMode: () => EditorMode;
  /** Switch modes; switching a lossy document to visual asks for confirmation first. */
  requestMode: (mode: EditorMode) => void;
  focus: () => void;
  /** The current selection as a Markdown source range (see `onSelectionChange`), or null. */
  getSelectionRange: () => MarkdownRange | null;
  /**
   * Insert a whole block (QC-039: an image from the library, a pasted or dropped
   * file). `caret`: after the block holding the caret, or where it was last if
   * focus moved to a side panel; `{ beforeBlock }`: at a visual-mode drop point
   * from `boundaryAt`; `end`: at the end. Reported through `onChange` like typing.
   */
  insertBlock: (block: string, where?: 'caret' | 'end' | { beforeBlock: number }) => void;
  /**
   * Visual mode: the block boundary nearest to viewport `y` (for a drop line),
   * as `{ index, y }` where `y` is where to draw the line. Null in source mode
   * or when the rendered blocks cannot be matched to the Markdown.
   */
  boundaryAt: (y: number) => { index: number; y: number } | null;
  /**
   * Put the caret back where it was (QC-047, after a tab is reloaded): the exact
   * range in source mode, the start of the block holding `range.start` in
   * visual mode (the visual editor has no source offsets). Focuses the editor.
   */
  restoreSelection: (range: MarkdownRange) => void;
}

/**
 * Markdown editor with a visual (MDXEditor) mode and a plain-text source mode.
 *
 * Original-text protection:
 * - Documents with syntax the visual editor may rewrite open in source mode,
 *   and switching to visual needs an explicit confirmation.
 * - Loading a document never reports a change: MDXEditor's initial
 *   normalisation is ignored, and if the user's edits bring the visual
 *   document back to its loaded state the original text is reported, not the
 *   normalised one.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(props, ref) {
    const { onChange, onCompositionChange, onModeChange, readOnly = false } = props;
    const initialLossy = useMemo(() => detectLossySyntax(props.markdown), [props.markdown]);
    const [mode, setMode] = useState<EditorMode>(
      props.initialMode ?? (initialLossy.length > 0 ? 'source' : 'visual'),
    );
    const [sourceText, setSourceText] = useState(props.markdown);
    const [visualKey, setVisualKey] = useState(0);
    const [pendingVisual, setPendingVisual] = useState<LossyReason[] | null>(null);

    /** Text as it will be saved. */
    const current = useRef(props.markdown);
    const lastEmitted = useRef(props.markdown);
    /** Text handed to MDXEditor on its last (re)mount, and MDXEditor's normalised form of it. */
    const visualLoaded = useRef(props.markdown);
    const visualNormalized = useRef(props.markdown);
    const composing = useRef(false);
    const mdx = useRef<MDXEditorMethods>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const container = useRef<HTMLDivElement>(null);

    const selectionRange = useCallback((): MarkdownRange | null => {
      if (mode === 'source') {
        const t = textarea.current;
        if (t === null) return null;
        const { selectionStart: start, selectionEnd: end } = t;
        return start === end ? expandToBlocks(current.current, { start, end }) : { start, end };
      }
      const root = container.current?.querySelector('.qc-md-editor__content');
      const sel = window.getSelection();
      if (root == null || sel === null || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
      const top = (node: Node): Element | null => {
        let n: Node | null = node;
        while (n !== null && n.parentNode !== root) n = n.parentNode;
        return n instanceof Element ? n : null;
      };
      const a = top(r.startContainer);
      const b = top(r.endContainer);
      if (a === null || b === null) return null;
      const children = Array.from(root.children);
      return rangeForBlockTexts(current.current, a.textContent, b.textContent, {
        start: children.indexOf(a),
        end: children.indexOf(b),
      });
    }, [mode]);

    /** The last caret or selection inside the editor, kept while focus is in a side panel. */
    const lastRange = useRef<MarkdownRange | null>(null);
    useEffect(() => {
      const remember = () => {
        const r = selectionRange();
        if (r !== null) lastRange.current = r;
      };
      document.addEventListener('selectionchange', remember);
      return () => {
        document.removeEventListener('selectionchange', remember);
      };
    }, [selectionRange]);

    const { onSelectionChange } = props;
    const reportSourceSelection = useCallback(() => {
      onSelectionChange?.(selectionRange());
    }, [onSelectionChange, selectionRange]);
    useEffect(() => {
      if (onSelectionChange === undefined || mode !== 'visual') return;
      const onChange = () => {
        const range = selectionRange();
        if (range !== null) onSelectionChange(range);
      };
      document.addEventListener('selectionchange', onChange);
      return () => {
        document.removeEventListener('selectionchange', onChange);
      };
    }, [mode, onSelectionChange, selectionRange]);

    const emit = useCallback(() => {
      if (composing.current || current.current === lastEmitted.current) return;
      lastEmitted.current = current.current;
      onChange(current.current);
    }, [onChange]);

    const setComposing = useCallback(
      (value: boolean) => {
        if (composing.current === value) return;
        composing.current = value;
        onCompositionChange?.(value);
        if (!value) emit();
      },
      [emit, onCompositionChange],
    );

    const handleVisualChange = useCallback(
      (markdown: string, initialNormalize: boolean) => {
        if (initialNormalize) {
          visualNormalized.current = markdown;
          return;
        }
        current.current =
          markdown === visualNormalized.current
            ? visualLoaded.current
            : restoreFinalNewline(markdown, visualLoaded.current);
        emit();
      },
      [emit],
    );

    const handleSourceChange = useCallback(
      (event: ChangeEvent<HTMLTextAreaElement>) => {
        setSourceText(event.target.value);
        current.current = event.target.value;
        emit();
      },
      [emit],
    );

    const changeMode = useCallback(
      (next: EditorMode) => {
        setMode(next);
        onModeChange?.(next);
      },
      [onModeChange],
    );

    const enterVisual = useCallback(() => {
      visualLoaded.current = current.current;
      visualNormalized.current = current.current;
      setPendingVisual(null);
      setVisualKey((k) => k + 1);
      changeMode('visual');
    }, [changeMode]);

    const requestMode = useCallback(
      (next: EditorMode) => {
        if (next === mode) return;
        if (next === 'source') {
          setSourceText(current.current);
          setPendingVisual(null);
          changeMode('source');
          return;
        }
        const reasons = detectLossySyntax(current.current);
        if (reasons.length > 0) {
          setPendingVisual(reasons);
          return;
        }
        enterVisual();
      },
      [changeMode, enterVisual, mode],
    );

    const insertBlock = useCallback(
      (block: string, where: 'caret' | 'end' | { beforeBlock: number } = 'caret') => {
        const text = current.current;
        let offset = text.length;
        if (typeof where === 'object') {
          offset = boundaryBeforeBlock(text, where.beforeBlock);
        } else if (where === 'caret') {
          const t = textarea.current;
          const caret =
            mode === 'source' && t !== null
              ? t.selectionEnd
              : (selectionRange()?.end ?? lastRange.current?.end ?? null);
          if (caret !== null) offset = blockEndAt(text, caret);
        }
        const result = insertBlockAt(text, offset, block);
        current.current = result.markdown;
        lastRange.current = { start: result.end, end: result.end };
        if (mode === 'visual') {
          visualLoaded.current = result.markdown;
          visualNormalized.current = result.markdown;
          setVisualKey((k) => k + 1);
        } else {
          setSourceText(result.markdown);
          requestAnimationFrame(() => {
            const el = textarea.current;
            if (el === null) return;
            el.focus();
            el.setSelectionRange(result.end, result.end);
          });
        }
        emit();
      },
      [emit, mode, selectionRange],
    );

    const boundaryAt = useCallback(
      (y: number): { index: number; y: number } | null => {
        if (mode !== 'visual') return null;
        const root = container.current?.querySelector('.qc-md-editor__content');
        if (root == null) return null;
        // Empty paragraphs (a fresh line, the one Lexical keeps after a divider) are not in
        // the Markdown: leave them out. An image paragraph has element children, not just <br>.
        const children = Array.from(root.children).filter(
          (c) =>
            c.tagName === 'HR' ||
            c.textContent.trim() !== '' ||
            Array.from(c.children).some((ch) => ch.tagName !== 'BR'),
        );
        if (children.length !== markdownBlocks(current.current).length) return null;
        for (const [i, child] of children.entries()) {
          const r = child.getBoundingClientRect();
          if (y < r.top + r.height / 2) {
            const prev = children[i - 1]?.getBoundingClientRect();
            return { index: i, y: prev === undefined ? r.top - 6 : (prev.bottom + r.top) / 2 };
          }
        }
        const last = children.at(-1)?.getBoundingClientRect();
        return { index: children.length, y: last === undefined ? y : last.bottom + 6 };
      },
      [mode],
    );

    /** Top-level rendered blocks that exist in the Markdown (see `boundaryAt`). */
    const renderedBlocks = useCallback((): Element[] | null => {
      const root = container.current?.querySelector('.qc-md-editor__content');
      if (root == null) return null;
      return Array.from(root.children).filter(
        (c) =>
          c.tagName === 'HR' ||
          c.textContent.trim() !== '' ||
          Array.from(c.children).some((ch) => ch.tagName !== 'BR'),
      );
    }, []);

    const restoreSelection = useCallback(
      (range: MarkdownRange) => {
        const text = current.current;
        const start = Math.max(0, Math.min(range.start, text.length));
        const end = Math.max(start, Math.min(range.end, text.length));
        if (mode === 'source') {
          const el = textarea.current;
          if (el === null) return;
          el.focus();
          el.setSelectionRange(start, end);
          lastRange.current = { start, end };
          return;
        }
        const place = () => {
          const blocks = markdownBlocks(text);
          const index = blocks.findIndex((b) => start <= b.end);
          const rendered = renderedBlocks();
          const target =
            rendered === null || rendered.length !== blocks.length || index < 0
              ? undefined
              : rendered[index];
          const sel = window.getSelection();
          if (target === undefined || sel === null) return;
          const r = document.createRange();
          r.selectNodeContents(target);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        };
        // Lexical places its own caret when focused; move it once that is done.
        mdx.current?.focus(place, { preventScroll: true });
      },
      [mode, renderedBlocks],
    );

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => current.current,
        isComposing: () => composing.current,
        getMode: () => mode,
        requestMode,
        focus: () => {
          if (mode === 'visual') mdx.current?.focus();
          else textarea.current?.focus();
        },
        getSelectionRange: selectionRange,
        insertBlock,
        boundaryAt,
        restoreSelection,
      }),
      [mode, requestMode, selectionRange, insertBlock, boundaryAt, restoreSelection],
    );

    const locale = props.locale ?? SOURCE_LOCALE;
    const resolveImageRef = useRef(props.resolveImage);
    resolveImageRef.current = props.resolveImage;
    const hasResolver = props.resolveImage !== undefined;
    const translation = useMemo(() => editorTranslation(locale), [locale]);
    const plugins = useMemo(
      () => [
        ...createEditorPlugins({
          locale,
          ...(hasResolver
            ? {
                resolveImage: (src: string) =>
                  resolveImageRef.current?.(src) ?? Promise.resolve(src),
              }
            : {}),
        }),
        // A new language reaches an open editor through `update`, without a remount.
        liveTranslationPlugin({ translation }),
      ],
      [hasResolver, locale, translation],
    );
    const label = props.label ?? translate(locale, 'editor.sourceLabel');

    return (
      <div
        ref={container}
        className={['qc-md-editor', props.className].filter(Boolean).join(' ')}
        data-mode={mode}
        onBlurCapture={() => {
          // Focus is leaving (e.g. to the asset drawer): the selection is still here, keep it.
          const r = selectionRange();
          if (r !== null) lastRange.current = r;
        }}
        onCompositionStartCapture={() => {
          setComposing(true);
        }}
        onCompositionEndCapture={() => {
          // Let the editor commit the composed text before flushing.
          queueMicrotask(() => {
            setComposing(false);
          });
        }}
      >
        {props.showModeSwitch !== false && (
          <div
            className="qc-md-editor__modes"
            role="radiogroup"
            aria-label={translate(locale, 'editor.modeGroup')}
          >
            {(['visual', 'source'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className="qc-md-editor__mode"
                onClick={() => {
                  requestMode(m);
                }}
              >
                {translate(locale, m === 'visual' ? 'editor.modeVisual' : 'editor.modeSource')}
              </button>
            ))}
          </div>
        )}

        {pendingVisual !== null && (
          <div
            className="qc-md-editor__confirm"
            role="alertdialog"
            aria-label={translate(locale, 'editor.switchToVisualTitle')}
          >
            <span>
              {translate(locale, 'editor.lossyWarning', {
                reasons: pendingVisual
                  .map((r) => lossyReasonLabel(r, locale))
                  .join(translate(locale, 'common.listSeparator')),
              })}
            </span>
            <button type="button" onClick={enterVisual}>
              {translate(locale, 'editor.switchAnyway')}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingVisual(null);
              }}
            >
              {translate(locale, 'common.cancel')}
            </button>
          </div>
        )}

        {mode === 'visual' ? (
          <MDXEditor
            key={visualKey}
            ref={mdx}
            className="qc-md-editor__visual"
            contentEditableClassName="qc-md-editor__content"
            markdown={visualLoaded.current}
            plugins={plugins}
            onChange={handleVisualChange}
            onError={() => {
              // The parser could not import this text: protect it in source mode.
              setSourceText(current.current);
              changeMode('source');
            }}
            readOnly={readOnly}
            translation={translation}
            trim={false}
            toMarkdownOptions={TO_MARKDOWN_OPTIONS}
          />
        ) : (
          <textarea
            ref={textarea}
            className="qc-md-editor__source"
            aria-label={label}
            value={sourceText}
            onChange={handleSourceChange}
            onSelect={reportSourceSelection}
            onKeyUp={reportSourceSelection}
            onMouseUp={reportSourceSelection}
            readOnly={readOnly}
            spellCheck={false}
          />
        )}
      </div>
    );
  },
);
