import { AI_PROVIDER_NAMES, type RewriteMode } from '@qiu-creator/contracts';
import type { MarkdownEditorHandle, MarkdownRange } from '@qiu-creator/markdown-editor-web';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { ImageGenSession, ImageGenState, ImageJobView } from './ai-images.js';
import { FAILURE_LABEL, type RewriteSession, type RewriteState } from './ai-session.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { useIsPresent } from 'motion/react';
import { Animated, LAYOUT_LIMIT, Presence } from './motion.js';
import { currentMotionMode, moves } from './motion-mode.js';
import { duration, easing } from '@qiu-creator/design-tokens';
import type { Segment } from './rewrite-diff.js';
import { TechnicalDetails } from './TechnicalDetails.js';

/** How tall an image placeholder may be; wider ratios use the full width. */
const IMAGE_MAX_HEIGHT = 420;
/** Space between a candidate (with its bar) and the text that follows it. */
const GAP = 12;

/** A box inside the scrolling document area (its scroll included). */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function useStore<S>(store: { subscribe: (l: (s: S) => void) => () => void; snapshot: S }): S {
  return useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
}

const ratioOf = (r: string): number => {
  const [w, h] = r.split(':').map(Number);
  return w !== undefined && h !== undefined && h > 0 ? w / h : 1;
};

/**
 * Pushes the text below a candidate down by the room it really takes, through
 * the margin under the block it follows (the visual editor's own DOM; nothing
 * in the document changes). When that room changes, the blocks below slide to
 * their new place with a transform (QC-074, DESIGN.md 動效: transform only,
 * at most `LAYOUT_LIMIT` in view; none with Reduce Motion): it makes room at
 * once and gives it back smoothly (see `slideBelow`).
 */
class Spacers {
  private readonly original = new Map<HTMLElement, string>();

  private set(el: HTMLElement, value: string): void {
    const before = parseFloat(window.getComputedStyle(el).marginBottom) || 0;
    el.style.marginBottom = value;
    const after = parseFloat(window.getComputedStyle(el).marginBottom) || 0;
    slideBelow(el, after - before);
  }

  apply(wanted: Map<HTMLElement, number>): void {
    for (const [el, margin] of this.original)
      if (!wanted.has(el)) {
        this.set(el, margin);
        delete el.dataset['qcExtra'];
        this.original.delete(el);
      }
    for (const [el, extra] of wanted) {
      if (!this.original.has(el)) this.original.set(el, el.style.marginBottom);
      const base = parseFloat(window.getComputedStyle(el).marginBottom) || 0;
      const was = this.original.get(el) ?? '';
      // The base is the block's own margin, not one we added.
      const own = was === '' ? base - (parseFloat(el.dataset['qcExtra'] ?? '0') || 0) : base;
      const next = `${String(Math.round(own + extra))}px`;
      if (el.style.marginBottom !== next) {
        this.set(el, next);
        el.dataset['qcExtra'] = String(extra);
      }
    }
  }

  clear(): void {
    for (const [el, margin] of this.original) {
      this.set(el, margin);
      delete el.dataset['qcExtra'];
    }
    this.original.clear();
  }
}

/**
 * The blocks after `el` were moved by `delta`. Making room (delta > 0) happens
 * at once, in the frame the candidate appears, so it never covers what is
 * below even for a moment; giving room back (delta < 0) glides up into the
 * freed space.
 */
function slideBelow(el: HTMLElement, delta: number): void {
  if (delta > -1 || !moves(currentMotionMode())) return;
  const view = window.innerHeight;
  let n = el.nextElementSibling;
  for (let count = 0; n !== null && count < LAYOUT_LIMIT; n = n.nextElementSibling) {
    if (!(n instanceof HTMLElement)) continue;
    const r = n.getBoundingClientRect();
    if (r.top > view) break;
    if (r.bottom < 0) continue;
    count += 1;
    n.animate([{ transform: `translateY(${String(-delta)}px)` }, { transform: 'none' }], {
      duration: duration.moderate,
      easing: easing.inOut,
    });
  }
}

/**
 * 原位候選 (QC-070, PT-20261122-002) in the visual editor:
 * - a rewrite from the selection toolbar: the paragraphs are framed while it
 *   runs (a small pill with 停止), then the candidate shows in their place as a
 *   diff (deletions struck through, insertions underlined) with 重試／捨棄
 *   esc／保留 ⌘↩; nothing is written until 保留;
 * - 配圖: a placeholder the size of the image to come opens after the
 *   paragraph (skeleton and an indeterminate bar, 取消), then the image settles
 *   in with its variants, a caption, 重新生成／捨棄／保留.
 * The layer sits over the document; the text below gives way through the
 * margin under the block it follows.
 */
export function InlineAi({
  editor,
  scroller,
  rewrite,
  rewriteTarget,
  images,
  layoutKey,
  active,
  readOnly,
  onRewriteClosed,
  onNotice,
}: {
  editor: RefObject<MarkdownEditorHandle | null>;
  scroller: RefObject<HTMLElement | null>;
  rewrite: RewriteSession;
  /** What a toolbar rewrite works on (null: none, or one from the side panel). */
  rewriteTarget: { range: MarkdownRange; mode: RewriteMode } | null;
  images: ImageGenSession;
  /** Changes whenever the document or the editor mode changed (positions are measured again). */
  layoutKey: unknown;
  active: boolean;
  readOnly: boolean;
  onRewriteClosed: () => void;
  onNotice: (text: string) => void;
}) {
  const rw = useStore(rewrite);
  const rewriteRange = rewriteTarget?.range ?? null;
  const img = useStore(images);
  const inline = img.jobs.find((j) => j.origin === 'inline') ?? null;
  const textOn =
    rewriteRange !== null &&
    (rw.phase === 'loading' ||
      rw.phase === 'pending' ||
      rw.phase === 'busy' ||
      rw.phase === 'failed');

  const [textBox, setTextBox] = useState<Box | null>(null);
  const [imageBox, setImageBox] = useState<{ gap: Box; card: Box } | null>(null);
  const [font, setFont] = useState<CSSProperties>({});
  /** The drawn candidate and placeholder: their real height is the room they take. */
  /**
   * The live layers, as they report themselves. A layer that is leaving (its
   * fade-out after a change) never reports, so only what stays takes room.
   */
  const layers = useRef<{ text: HTMLElement | null; image: HTMLElement | null }>({
    text: null,
    image: null,
  });
  /**
   * The latest `measure`, for the layers: with motion on, `AnimatePresence` hands
   * its children new props in a render of its own, where this component does
   * not render again; the layer measures from its own layout effect then.
   */
  const measureRef = useRef<() => void>(() => undefined);
  const waiting = useRef(false);
  const reportText = useCallback((el: HTMLElement | null) => {
    layers.current.text = el;
    if (el !== null) measureRef.current();
  }, []);
  const reportImage = useCallback((el: HTMLElement | null) => {
    layers.current.image = el;
    if (el !== null) measureRef.current();
  }, []);
  const spacers = useRef(new Spacers());

  // A toolbar rewrite that ended (kept, discarded, stopped) lets go of its range.
  useEffect(() => {
    if (rewriteRange !== null && rw.phase === 'idle') onRewriteClosed();
  }, [rewriteRange, rw.phase, onRewriteClosed]);

  const measure = useCallback(() => {
    const area = scroller.current;
    const ed = editor.current;
    if (area === null) return;
    if (ed === null) {
      // This layer comes before the editor in the tree: in a commit that also
      // re-creates the editor's handle, our layout effects run while it is
      // detached. Measure once the commit is done, still before the frame is
      // painted (QC-074: no frame with a candidate over the text below).
      if (!waiting.current) {
        waiting.current = true;
        queueMicrotask(() => {
          waiting.current = false;
          if (editor.current !== null) measureRef.current();
        });
      }
      return;
    }
    const origin = area.getBoundingClientRect();
    const inArea = (r: DOMRect): Box => ({
      top: r.top - origin.top + area.scrollTop,
      left: r.left - origin.left + area.scrollLeft,
      width: r.width,
      height: r.height,
    });
    const wanted = new Map<HTMLElement, number>();

    // Text: the paragraphs being rewritten.
    let tb: Box | null = null;
    const textEls = textOn ? ed.blockElements(rewriteRange) : null;
    if (textEls !== null && textEls.length > 0) {
      const first = textEls[0] as HTMLElement;
      const last = textEls[textEls.length - 1] as HTMLElement;
      const a = inArea(first.getBoundingClientRect());
      const b = inArea(last.getBoundingClientRect());
      tb = { top: a.top, left: a.left, width: a.width, height: b.top + b.height - a.top };
      const style = window.getComputedStyle(first);
      // The same font keeps the same object: measuring after every commit must not render again.
      setFont((old) =>
        old.fontFamily === style.fontFamily &&
        old.fontSize === style.fontSize &&
        old.lineHeight === style.lineHeight
          ? old
          : {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
            },
      );
      if (rw.phase === 'pending' || rw.phase === 'busy' || rw.phase === 'failed') {
        // Everything the candidate draws (the diff and its bar, however many lines the bar
        // wraps to) takes room in the article; what is below starts after it.
        const drawn = layers.current.text?.offsetHeight ?? tb.height;
        wanted.set(last, Math.max(0, drawn - tb.height) + GAP);
      }
    }
    setTextBox((old) => (same(old, tb) ? old : tb));

    // Image: a placeholder after the block that ends at the anchor.
    let ib: { gap: Box; card: Box } | null = null;
    if (inline?.anchor != null) {
      const at = inline.anchor;
      const els = ed.blockElements({ start: Math.max(0, at - 1), end: at });
      const block = els?.[els.length - 1];
      if (block !== undefined) {
        const r = inArea(block.getBoundingClientRect());
        const ratio = ratioOf(inline.request.aspectRatio);
        let w = r.width;
        let h = w / ratio;
        if (h > IMAGE_MAX_HEIGHT) {
          h = IMAGE_MAX_HEIGHT;
          w = h * ratio;
        }
        const own = parseFloat(window.getComputedStyle(block).marginBottom) || 0;
        const extra =
          block.dataset['qcExtra'] === undefined ? 0 : parseFloat(block.dataset['qcExtra']) || 0;
        const top = r.top + r.height + Math.max(0, own - extra) + 4;
        // The placeholder with its caption row and bar, as drawn.
        const drawn = Math.max(h, layers.current.image?.offsetHeight ?? h);
        ib = {
          gap: { top, left: r.left, width: r.width, height: drawn },
          card: { top, left: r.left + (r.width - w) / 2, width: w, height: h },
        };
        wanted.set(block, drawn + GAP);
      }
    }
    setImageBox((old) =>
      old !== null && ib !== null && same(old.gap, ib.gap) && same(old.card, ib.card) ? old : ib,
    );
    spacers.current.apply(wanted);
  }, [editor, scroller, textOn, rewriteRange, rw.phase, inline]);

  // After every render, before the browser paints (QC-074): the layers below have
  // committed and reported, so a candidate is never drawn for a frame before the
  // text under it has made room.
  const ro = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    measureRef.current = measure;
    measure();
    // The candidate itself changes height too (a bar that wraps, a caption row):
    // watch the live layers; observations come before the frame is painted.
    const observer = ro.current;
    if (observer === null) return;
    for (const layer of [layers.current.text, layers.current.image])
      if (layer !== null) observer.observe(layer);
  });

  // The document reflows (typing elsewhere, the window): measure again.
  useEffect(() => {
    const content = scroller.current?.querySelector('.qc-md-editor__content');
    if (content == null || (!textOn && inline === null)) return;
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Resize observations come before the frame is painted: measure right there.
    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(content);
    ro.current = observer;
    window.addEventListener('resize', again);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      ro.current = null;
      window.removeEventListener('resize', again);
    };
  }, [scroller, measure, textOn, inline, layoutKey]);

  // Gone: put the margins back.
  useEffect(() => {
    const s = spacers.current;
    return () => {
      s.clear();
    };
  }, []);
  useEffect(() => {
    if (!textOn && inline === null) spacers.current.clear();
  }, [textOn, inline]);

  // ⌘↩ keeps, esc discards a text candidate (not while typing in a field or the side panel).
  useEffect(() => {
    if (!active || !textOn || rw.phase !== 'pending') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ai, input, textarea, [role="dialog"], .ftb') != null) return;
      // Before the editor sees the key: ↩ must not reach the text it would change.
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        void rewrite.accept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        rewrite.discard();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active, textOn, rw.phase, rewrite]);

  return (
    <div className="inline-ai" aria-live="polite">
      <Presence>
        {textOn && textBox !== null && (
          <TextCandidate
            key="text"
            box={textBox}
            font={font}
            state={rw}
            mode={rewriteTarget?.mode ?? 'polish'}
            report={reportText}
            readOnly={readOnly}
            onStop={() => {
              void rewrite.stop();
            }}
            onRetry={() => {
              void rewrite.retry();
            }}
            onDiscard={() => {
              rewrite.discard();
            }}
            onKeep={() => {
              void rewrite.accept().then((r) => {
                if (r === 'accepted') onNotice(t('ai.keptText'));
              });
            }}
          />
        )}
        {inline !== null && imageBox !== null && (
          <ImagePlaceholder
            key={inline.key}
            job={inline}
            state={img}
            gap={imageBox.gap}
            card={imageBox.card}
            readOnly={readOnly}
            images={images}
            onNotice={onNotice}
            report={reportImage}
          />
        )}
      </Presence>
    </div>
  );
}

/**
 * A layer's root element, reported to the parent while it is present (not
 * while it fades out after leaving), before the parent measures in the same
 * commit.
 */
function useLiveLayer(report: (el: HTMLElement | null) => void): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    if (!present) return;
    report(root.current);
    return () => {
      report(null);
    };
  });
  return root;
}

function same(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

const ACTION_KEY = {
  polish: 'ai.presetPolish',
  expand: 'ai.presetExpand',
  shorten: 'ai.presetShorten',
  tone: 'ai.presetTone',
  custom: 'ai.actMore',
} as const;

function TextCandidate({
  box,
  font,
  state,
  mode,
  report,
  readOnly,
  onStop,
  onRetry,
  onDiscard,
  onKeep,
}: {
  box: Box;
  font: CSSProperties;
  state: RewriteState;
  mode: RewriteMode;
  /** Tells the layer which element it draws (the room it takes is that element's height). */
  report: (el: HTMLElement | null) => void;
  readOnly: boolean;
  onStop: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  const c = state.candidate;
  const action = t(ACTION_KEY[mode]);
  const provider = state.provider === null ? '' : AI_PROVIDER_NAMES[state.provider.provider].name;
  const loading = state.phase === 'loading';
  const before = c?.original.length ?? 0;
  const after = c?.result.text.length ?? 0;
  const change = after - before >= 0 ? `+${String(after - before)}` : String(after - before);
  const root = useLiveLayer(report);
  return (
    <Animated
      ref={root}
      preset={{ kind: 'fade' }}
      className="inline-ai__text"
      style={{ top: box.top, left: box.left, width: box.width }}
    >
      {loading ? (
        <>
          <div className="inline-ai__lock" style={{ height: box.height }} aria-hidden="true" />
          <div className="gen-pill" role="status">
            <span className="spin" aria-hidden="true" />
            {t('ai.working', { action })}
            <button type="button" className="btn btn--ghost btn--small" onClick={onStop}>
              {t('ai.stop')}
            </button>
          </div>
        </>
      ) : state.phase === 'failed' ? (
        <>
          <div className="inline-ai__lock" style={{ height: box.height }} aria-hidden="true" />
          <div
            className="cand-bar cand-bar--bad"
            role="alert"
            style={{ marginTop: box.height + 8 }}
          >
            <Icon name="alert" size={14} />
            <span className="cand-bar__m">
              {state.failure?.code == null
                ? (state.failure?.message ?? t('ai.generateFailed'))
                : FAILURE_LABEL[state.failure.code]}
            </span>
            <button type="button" className="btn btn--small" onClick={onRetry}>
              {t('common.retry')}
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={onDiscard}>
              {t('ai.discard')}
            </button>
            <TechnicalDetails text={state.failure?.detail} />
          </div>
        </>
      ) : c !== null ? (
        <>
          <div className="inline-ai__diff" style={font} aria-label={t('ai.candidate')}>
            {c.segments.map((s: Segment, i) =>
              s.kind === 'same' ? (
                <span key={i}>{s.text}</span>
              ) : (
                <span key={i}>
                  {s.before !== '' && <del className="del">{s.before}</del>}
                  {s.after !== '' && <ins className="ins">{s.after}</ins>}
                </span>
              ),
            )}
          </div>
          <div className="cand-bar" role="group" aria-label={t('ai.candidate')}>
            <span className="cand-bar__m">
              <Icon name="spark" size={13} />
              {t('ai.candidate')} · {t('ai.candidateMeta', { action, provider, change })}
            </span>
            <button type="button" className="btn btn--ghost btn--small" onClick={onRetry}>
              {t('common.retry')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              aria-keyshortcuts="Escape"
              onClick={onDiscard}
            >
              {t('ai.discard')}
              <kbd>esc</kbd>
            </button>
            <button
              type="button"
              className="btn btn--primary btn--small"
              aria-keyshortcuts="Meta+Enter"
              disabled={readOnly || state.phase === 'busy'}
              onClick={onKeep}
            >
              {t('ai.keep')}
              <kbd>⌘↩</kbd>
            </button>
          </div>
        </>
      ) : null}
    </Animated>
  );
}

function ImagePlaceholder({
  job,
  state,
  gap,
  card,
  readOnly,
  images,
  onNotice,
  report,
}: {
  job: ImageJobView;
  state: ImageGenState;
  gap: Box;
  card: Box;
  readOnly: boolean;
  images: ImageGenSession;
  onNotice: (text: string) => void;
  /** Tells the layer which element it draws (the room it takes is that element's height). */
  report: (el: HTMLElement | null) => void;
}) {
  const root = useLiveLayer(report);
  const live = job.candidates.filter((c) => c.fate === 'new');
  const [pick, setPick] = useState(0);
  const shown = live[Math.min(pick, Math.max(0, live.length - 1))];
  const [alt, setAlt] = useState(() => (job.request.prompt ?? '').trim().slice(0, 40));
  const model = state.models?.find((m) => m.id === job.request.model)?.id ?? job.request.model;

  // A cancelled placeholder goes; one whose candidates were all used or dropped too.
  useEffect(() => {
    if (job.phase === 'cancelled' || (job.phase === 'ready' && live.length === 0))
      void images.remove(job.key);
  }, [job.phase, live.length, images, job.key]);

  const keep = () => {
    if (shown === undefined || job.anchor === null) return;
    const placement = {
      type: 'insert' as const,
      offset: job.anchor,
      ...(alt.trim() === '' ? {} : { alt: alt.trim() }),
    };
    void images.keep(job.key, shown.index, placement).then((r) => {
      if (r === 'kept') {
        onNotice(t('ai.keptImage'));
        void images.remove(job.key);
      } else if (r === 'expired') onNotice(t('ai.candidateExpired'));
    });
  };

  return (
    <Animated
      ref={root}
      preset={{ kind: 'reveal' }}
      className="imgslot-wrap"
      style={{ top: gap.top, left: gap.left, width: gap.width }}
    >
      <div
        className={job.phase === 'ready' ? 'imgslot imgslot--ready' : 'imgslot'}
        style={{ marginLeft: card.left - gap.left, width: card.width, height: card.height }}
        role={job.phase === 'generating' ? 'status' : undefined}
        aria-label={job.phase === 'generating' ? t('ai.imageGenerating') : undefined}
      >
        {job.phase === 'generating' && (
          <>
            {/* One quiet signal (QC-074): a still fill, a small spinner and the words. */}
            <div className="imgslot__sk">
              <span className="spin" aria-hidden="true" />
              <span>{t('ai.imageGenerating')}</span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  void images.stop(job.key);
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}
        {job.phase === 'failed' && (
          <div className="imgslot__err" role="alert">
            <b>
              <Icon name="alert" size={14} />
              {t('ai.generateFailed')}
            </b>
            <span>
              {job.failure?.code == null
                ? (job.failure?.message ?? '')
                : FAILURE_LABEL[job.failure.code]}
            </span>
            <span className="imgslot__acts">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  void images.retry(job.key);
                }}
              >
                {t('common.retry')}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  void images.remove(job.key);
                }}
              >
                {t('common.remove')}
              </button>
            </span>
            <TechnicalDetails text={job.failure?.detail} />
          </div>
        )}
        {job.phase === 'ready' && shown?.src != null && (
          <>
            <img key={shown.index} className="imgslot__img" src={shown.src} alt={alt} />
            {live.length > 1 && (
              <span className="imgslot__pager" role="group" aria-label={t('ai.candidate')}>
                {live.map((c, i) => (
                  <button
                    key={c.index}
                    type="button"
                    aria-pressed={c === shown}
                    aria-label={t('ai.imageVariant', { n: i + 1 })}
                    onClick={() => {
                      setPick(i);
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
              </span>
            )}
          </>
        )}
      </div>
      {job.phase === 'ready' && shown !== undefined && (
        <div className="imgslot__under">
          <input
            className="imgslot__caption"
            aria-label={t('ai.caption')}
            placeholder={t('ai.caption')}
            value={alt}
            onChange={(e) => {
              setAlt(e.target.value);
            }}
          />
          <div className="cand-bar" role="group" aria-label={t('ai.candidate')}>
            <span className="cand-bar__m">
              <Icon name="image" size={13} />
              {t('ai.imageMeta', {
                model,
                ratio: job.request.aspectRatio,
                i: live.indexOf(shown) + 1,
                n: live.length,
              })}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={job.busy !== null}
              onClick={() => {
                void images.retry(job.key);
              }}
            >
              {t('ai.regenerate')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={job.busy !== null}
              onClick={() => {
                void images.discard(job.key, shown.index);
                setPick(0);
              }}
            >
              {t('ai.discard')}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={readOnly || job.busy !== null}
              onClick={keep}
            >
              {t('ai.keep')}
            </button>
          </div>
        </div>
      )}
    </Animated>
  );
}
