import type { AiImageAspectRatio, AiImagePlacement } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  canSend,
  type ImageCandidateView,
  type ImageGenSession,
  type ImageJobView,
  type ImagePurpose,
  type ImageRequest,
} from './ai-images.js';
import { AI_BLOCK_LABEL, FAILURE_LABEL } from './ai-session.js';
import { Dialog } from './Dialog.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { AnimatedItem, Presence } from './motion.js';
import { TechnicalDetails } from './TechnicalDetails.js';

/** The ratios offered (PT-20261122-002), with what each is for. */
export const RATIOS: readonly { value: AiImageAspectRatio; label: MessageKey }[] = [
  { value: '16:9', label: 'ai.ratioWide' },
  { value: '2.35:1', label: 'ai.ratioWechat' },
  { value: '3:4', label: 'ai.ratioRed' },
  { value: '1:1', label: 'ai.ratioSquare' },
  { value: '9:16', label: 'ai.ratioTall' },
  { value: '3:2', label: 'ai.ratioPhoto' },
];
const DEFAULT_RATIO: Record<ImagePurpose, AiImageAspectRatio> = { image: '16:9', cover: '2.35:1' };
const COUNTS = [1, 2, 3, 4] as const;

const MODEL_KEY = 'qc.ai.imageModel';
const COST_ACK_KEY = 'qc.ai.imageCostAcknowledged';

/** Per-viewer conveniences: the last image model, and models whose unknown cost was accepted. */
function readModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}
function writeModel(id: string): void {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {
    // only a convenience
  }
}
export function costAcknowledged(model: string): boolean {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(COST_ACK_KEY) ?? '[]');
    return Array.isArray(list) && list.includes(model);
  } catch {
    return false;
  }
}
function acknowledgeCost(model: string): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COST_ACK_KEY) ?? '[]');
    const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    if (!list.includes(model)) localStorage.setItem(COST_ACK_KEY, JSON.stringify([...list, model]));
  } catch {
    // only a convenience
  }
}

/** The image model to use: the one chosen before if the relay still offers it, else the first. */
export function chooseModel(models: readonly { id: string }[] | null): string {
  if (models === null || models.length === 0) return '';
  const last = readModel();
  return models.some((m) => m.id === last) && last !== null ? last : (models[0]?.id ?? '');
}

function useStore<S>(store: { subscribe: (l: (s: S) => void) => () => void; snapshot: S }): S {
  return useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
}

/**
 * The first generation with a model whose cost cannot be estimated asks once
 * (PT-20261122-002: 取消／仍要生成, 「這個模型不再提示」); afterwards the panel
 * keeps saying 「費用無法預估」. Resolves to whether to send.
 */
export function useCostConfirm(): {
  confirm: (model: string, unknownCost: boolean) => Promise<boolean>;
  node: ReactNode;
} {
  const [ask, setAsk] = useState<{ model: string; done: (ok: boolean) => void } | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const confirm = useCallback((model: string, unknownCost: boolean): Promise<boolean> => {
    if (!unknownCost || costAcknowledged(model)) return Promise.resolve(true);
    setDontAsk(false);
    return new Promise((resolve) => {
      setAsk({ model, done: resolve });
    });
  }, []);
  const close = (ok: boolean) => {
    if (ask === null) return;
    if (ok && dontAsk) acknowledgeCost(ask.model);
    ask.done(ok);
    setAsk(null);
  };
  const node =
    ask === null ? null : (
      <Dialog
        title={t('ai.costConfirmTitle')}
        onClose={() => {
          close(false);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn dialog__primary"
              data-autofocus
              onClick={() => {
                close(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                close(true);
              }}
            >
              {t('ai.generateAnyway')}
            </button>
          </>
        }
      >
        <p>{t('ai.costConfirmBody', { model: ask.model })}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => {
              setDontAsk(e.target.checked);
            }}
          />
          {t('ai.dontAskModel')}
        </label>
      </Dialog>
    );
  return { confirm, node };
}

/**
 * 圖片 tab of the AI panel (QC-070, PT-20261122-002): 插圖 or 封面, a prompt
 * (the selection can be brought in; a cover can do without, it follows the
 * title and text), style, ratio, count, model and the cost before sending;
 * then this editor's generations (生成記錄) with 插入到游標處 and 設為封面.
 */
export function AiImageTab({
  images,
  selectionText,
  readOnly,
  insertOffset,
  onOpenSettings,
  onNotice,
}: {
  images: ImageGenSession;
  /** The selected text, for 「帶入選取」. */
  selectionText: string;
  readOnly: boolean;
  /** Where 插入到游標處 puts an image: the end of the block holding the caret. */
  insertOffset: () => number;
  onOpenSettings: () => void;
  onNotice: (text: string) => void;
}) {
  const s = useStore(images);
  const [purpose, setPurpose] = useState<ImagePurpose>('image');
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('');
  const [ratio, setRatio] = useState<AiImageAspectRatio>(DEFAULT_RATIO.image);
  const [count, setCount] = useState<number>(2);
  const [model, setModel] = useState('');
  const cost = useCostConfirm();

  useEffect(() => {
    void images.load();
  }, [images]);
  useEffect(() => {
    if (model === '' || s.models?.some((m) => m.id === model) !== true)
      setModel(chooseModel(s.models));
  }, [s.models, model]);

  const request = useMemo(
    (): ImageRequest => ({ purpose, model, prompt, style, aspectRatio: ratio, count }),
    [purpose, model, prompt, style, ratio, count],
  );
  // The cost follows the request (a little after the last change).
  useEffect(() => {
    if (s.block !== null || model === '') return;
    const timer = setTimeout(() => {
      void images.estimate(request);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [images, request, s.block, model]);

  const noModel = s.block === null && s.models !== null && s.models.length === 0;
  const unknownCost = s.estimate !== null && s.estimate.estimate.max_cost_usd === null;
  const disabled = readOnly || s.block !== null || noModel || !canSend(request);

  const generate = async () => {
    if (disabled) return;
    if (!(await cost.confirm(model, unknownCost))) return;
    await images.generate(request, { origin: 'panel' });
  };

  const place = (job: ImageJobView, c: ImageCandidateView, where: 'insert' | 'cover') => {
    const placement: AiImagePlacement =
      where === 'cover' ? { type: 'cover' } : { type: 'insert', offset: insertOffset() };
    void images.keep(job.key, c.index, placement).then((r) => {
      if (r === 'kept') onNotice(placement.type === 'cover' ? t('ai.coverSet') : t('ai.keptImage'));
      else if (r === 'expired') onNotice(t('ai.candidateExpired'));
    });
  };

  const panelJobs = s.jobs.filter((j) => j.origin === 'panel');

  return (
    <div className="ai__body ai-img">
      {s.block !== null && (
        <div className="ai__notice" role="alert">
          <Icon name="key" />
          <span className="ai__notice-text">{AI_BLOCK_LABEL[s.block]}</span>
          <button type="button" className="btn btn--small" onClick={onOpenSettings}>
            {t('ai.goToSettings')}
          </button>
        </div>
      )}
      {noModel && (
        <div className="ai__notice" role="alert">
          <Icon name="image" />
          <span className="ai__notice-text">
            <b>{t('ai.noImageModel')}</b> {t('ai.noImageModelHint')}
          </span>
          <button type="button" className="btn btn--small" onClick={onOpenSettings}>
            {t('ai.goAiServices')}
          </button>
        </div>
      )}
      {s.undo !== null && (
        <div className="ai__done" role="status">
          <Icon name="check" />
          {s.undo.placement === 'cover' ? t('ai.coverSet') : t('ai.keptImage')}
          <button
            type="button"
            className="btn btn--ghost btn--small ai__undo"
            onClick={() => {
              void images.undo();
            }}
          >
            <Icon name="undo" />
            {t('common.undo')}
          </button>
        </div>
      )}

      <div className="seg ai-img__purpose" role="radiogroup" aria-label={t('ai.imagePurpose')}>
        {(['image', 'cover'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={purpose === p}
            onClick={() => {
              setPurpose(p);
              setRatio(DEFAULT_RATIO[p]);
            }}
          >
            {p === 'image' ? t('ai.purposeImage') : t('ai.purposeCover')}
          </button>
        ))}
      </div>

      <div className="ai-img__field">
        <span className="ai-img__label" id="ai-img-prompt">
          {t('ai.prompt')}
          {purpose === 'image' && selectionText.trim() !== '' && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setPrompt(selectionText.trim().slice(0, 4000));
              }}
            >
              {t('ai.promptFromSelection')}
            </button>
          )}
        </span>
        <textarea
          className="ai-img__prompt"
          aria-labelledby="ai-img-prompt"
          rows={3}
          placeholder={
            purpose === 'cover' ? t('ai.promptCoverPlaceholder') : t('ai.promptPlaceholder')
          }
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
        />
      </div>

      <label className="ai-img__field">
        <span className="ai-img__label">{t('ai.style')}</span>
        <input
          type="text"
          className="ai-img__input"
          placeholder={t('ai.stylePlaceholder')}
          value={style}
          onChange={(e) => {
            setStyle(e.target.value);
          }}
        />
      </label>

      <div className="ai-img__field">
        <span className="ai-img__label" id="ai-img-ratio">
          {t('ai.ratio')}
        </span>
        <div className="ai-img__ratios" role="radiogroup" aria-labelledby="ai-img-ratio">
          {RATIOS.map((r) => {
            const [w = 1, h = 1] = r.value.split(':').map(Number);
            const scale = 22 / Math.max(w, h);
            return (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={ratio === r.value}
                className="ai-img__ratio"
                onClick={() => {
                  setRatio(r.value);
                }}
              >
                <span
                  className="ai-img__shape"
                  style={{ width: w * scale, height: h * scale }}
                  aria-hidden="true"
                />
                <span className="num">{r.value}</span>
                <span className="ai-img__ratio-for">{t(r.label)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="ai-img__row">
        <div className="ai-img__field">
          <span className="ai-img__label" id="ai-img-count">
            {t('ai.count')}
          </span>
          <div className="seg" role="radiogroup" aria-labelledby="ai-img-count">
            {COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={count === n}
                onClick={() => {
                  setCount(n);
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <label className="ai-img__field ai-img__model">
          <span className="ai-img__label">{t('ai.model')}</span>
          <select
            value={model}
            disabled={s.models === null || s.models.length === 0}
            onChange={(e) => {
              setModel(e.target.value);
              writeModel(e.target.value);
            }}
          >
            {(s.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="ai-img__go">
        <span className="ai-img__cost" role="status">
          {s.estimate === null || model === ''
            ? ''
            : unknownCost
              ? t('ai.costUnknown')
              : t('ai.costAbout', {
                  cost: (s.estimate.estimate.max_cost_usd ?? 0).toFixed(2),
                })}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={() => {
            void generate();
          }}
        >
          <Icon name="spark" />
          {t('ai.generateCount', { count })}
        </button>
      </div>

      {panelJobs.length > 0 && (
        <section className="ai-img__history" aria-label={t('ai.history')}>
          <h3 className="ai-img__label">{t('ai.history')}</h3>
          <ul className="ai-img__grid">
            <Presence popLayout>{panelJobs.flatMap((job) => cells(job, place, images))}</Presence>
          </ul>
        </section>
      )}
      {cost.node}
    </div>
  );
}

/** The history cells of one job: placeholders while it runs, then its candidates. */
function cells(
  job: ImageJobView,
  place: (job: ImageJobView, c: ImageCandidateView, where: 'insert' | 'cover') => void,
  images: ImageGenSession,
) {
  const ratio = job.request.aspectRatio.replace(':', ' / ');
  if (job.phase === 'generating')
    return Array.from({ length: job.request.count }, (_, i) => (
      <AnimatedItem
        key={`${job.key}-sk-${String(i)}`}
        layout={false}
        quiet={false}
        preset={{ kind: 'reveal' }}
      >
        <div
          className="ai-img__cell ai-img__cell--sk"
          style={{ aspectRatio: ratio }}
          role="status"
          aria-label={t('ai.generating')}
        >
          {/* One quiet signal (QC-074): a small spinner in the first cell, nothing else moves. */}
          {i === 0 && <span className="spin ai-img__spin" aria-hidden="true" />}
          {i === 0 && (
            <button
              type="button"
              className="ai-img__cancel"
              aria-label={t('common.cancel')}
              onClick={() => {
                void images.stop(job.key);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      </AnimatedItem>
    ));
  if (job.phase === 'failed' || job.phase === 'cancelled')
    return [
      <AnimatedItem key={`${job.key}-err`} layout={false} quiet={false} preset={{ kind: 'reveal' }}>
        <div
          className="ai-img__cell ai-img__cell--err"
          role={job.phase === 'failed' ? 'alert' : 'status'}
        >
          <span>
            {job.phase === 'cancelled'
              ? t('ai.cancelled')
              : job.failure?.code == null
                ? (job.failure?.message ?? t('ai.generateFailed'))
                : FAILURE_LABEL[job.failure.code]}
          </span>
          <span className="ai-img__acts">
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
      </AnimatedItem>,
    ];
  return job.candidates
    .filter((c) => c.fate === 'new' || c.fate === 'kept')
    .map((c) => (
      <AnimatedItem
        key={`${job.key}-${String(c.index)}`}
        layout={false}
        quiet={false}
        preset={{ kind: 'reveal' }}
      >
        <div
          className={c.fate === 'kept' ? 'ai-img__cell ai-img__cell--kept' : 'ai-img__cell'}
          style={{ aspectRatio: ratio }}
          tabIndex={0}
        >
          {c.src !== null && <img className="ai-img__thumb" src={c.src} alt="" />}
          {c.fate === 'kept' ? (
            <span className="ai-img__badge">
              <Icon name="check" size={12} />
              {c.keptAs === 'cover' ? t('ai.coverSet') : t('ai.inserted')}
            </span>
          ) : (
            <span className="ai-img__hover">
              {job.request.purpose === 'image' && (
                <button
                  type="button"
                  disabled={job.busy !== null}
                  onClick={() => {
                    place(job, c, 'insert');
                  }}
                >
                  {t('ai.insertAtCursor')}
                </button>
              )}
              <button
                type="button"
                disabled={job.busy !== null}
                onClick={() => {
                  place(job, c, 'cover');
                }}
              >
                {t('ai.setAsCover')}
              </button>
              <button
                type="button"
                className="ai-img__x"
                aria-label={t('ai.discard')}
                onClick={() => {
                  void images.discard(job.key, c.index);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          )}
        </div>
      </AnimatedItem>
    ));
}
