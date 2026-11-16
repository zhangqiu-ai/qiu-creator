import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  detectLossySyntax,
  LOSSY_REASON_LABELS,
  restoreFinalNewline,
  type LossyReason,
} from './lossy.js';
import { createEditorPlugins, TO_MARKDOWN_OPTIONS } from './plugins.js';
import { translateZhTW } from './translation.js';

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
  /** Accessible name for the editing area. */
  label?: string;
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
      }),
      [mode, requestMode],
    );

    const plugins = useMemo(() => createEditorPlugins(), []);
    const label = props.label ?? '內文';

    return (
      <div
        className={['qc-md-editor', props.className].filter(Boolean).join(' ')}
        data-mode={mode}
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
          <div className="qc-md-editor__modes" role="radiogroup" aria-label="編輯模式">
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
                {m === 'visual' ? '視覺' : '原始碼'}
              </button>
            ))}
          </div>
        )}

        {pendingVisual !== null && (
          <div className="qc-md-editor__confirm" role="alertdialog" aria-label="切換到視覺模式">
            <span>
              {pendingVisual.map((r) => LOSSY_REASON_LABELS[r]).join('、')} 可能在視覺模式被改寫
            </span>
            <button type="button" onClick={enterVisual}>
              仍要切換
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingVisual(null);
              }}
            >
              取消
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
            translation={translateZhTW}
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
            readOnly={readOnly}
            spellCheck={false}
          />
        )}
      </div>
    );
  },
);
