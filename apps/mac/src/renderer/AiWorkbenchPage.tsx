import type { CreatorHubClient } from '@qiu-creator/api-client';
import { watchAiStatus } from './ai-status.js';
import {
  AI_PROVIDER_NAMES,
  GEMINI_VIDEO_LIMITS,
  type AiJobRecord,
  type AssetRecord,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { FAILURE_LABEL } from './ai-session.js';
import { formatUsd, modelOptions } from './ai-settings.js';
import {
  AiActivity,
  canOpenJob,
  jobActionLabel,
  selectedJobId,
  runLabel,
  uploadPercent,
  VideoSession,
  type VideoState,
} from './ai-video.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useChangeEvents } from './events.js';
import { formatDuration } from './format.js';
import { progressStyle } from './motion.js';
import { formatBytes, formatNumber, formatWhen, t } from './i18n.js';
import { budgetWarningText, noticeText } from './server-text.js';
import { TechnicalDetails } from './TechnicalDetails.js';
import { Icon } from './Icon.js';

function useStore<S>(store: { subscribe: (l: (s: S) => void) => () => void; snapshot: S }): S {
  return useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
}

const assetName = (a: AssetRecord) => a.original_name ?? a.path.split('/').pop() ?? a.id;

export interface AiWorkbenchPageProps {
  client: CreatorHubClient;
  onOpenSettings: () => void;
  onOpenAssets: () => void;
  /** Open the asset viewer and play from `at` seconds. */
  onOpenAsset: (assetId: string, at: number) => void;
}

/**
 * AI 工作台 (QC-025, prototype board MacAI plus the director-approved
 * additions): Gemini video understanding of a library video with estimate,
 * notice, progress, cancel and retry; results marked 待核驗; recent jobs and
 * this month's estimated usage.
 */
export function AiWorkbenchPage(props: AiWorkbenchPageProps) {
  const { client } = props;
  // Created inside the effect so React's dev double-mount gets a live session.
  const [video, setVideo] = useState<VideoSession | null>(null);
  useEffect(() => {
    const v = new VideoSession(client);
    setVideo(v);
    void v.loadProvider();
    const unwatch = watchAiStatus(() => void v.refresh());
    return () => {
      unwatch();
      v.dispose();
    };
  }, [client]);
  if (video === null) return <main className="page" aria-label={t('ai.page')} aria-busy="true" />;
  return <Workbench {...props} video={video} />;
}

function Workbench({
  client,
  onOpenSettings,
  onOpenAssets,
  onOpenAsset,
  video,
}: AiWorkbenchPageProps & { video: VideoSession }) {
  const activity = useMemo(() => new AiActivity(client), [client]);
  useEffect(() => {
    void activity.load();
  }, [activity]);
  const s = useStore(video);
  const a = useStore(activity);
  const [picking, setPicking] = useState(false);

  useChangeEvents((event) => {
    if (event.entity !== 'job' || !event.action.startsWith('ai_job.')) return;
    void video.jobChanged(event.entity_id);
    if (event.action !== 'ai_job.progress') void activity.load();
  });

  // Another result (or state) starts at its top, not where the last one was scrolled to.
  const resultRef = useRef<HTMLElement>(null);
  const shownKey = `${s.phase}:${selectedJobId(s) ?? ''}`;
  useEffect(() => {
    resultRef.current?.scrollTo({ top: 0 });
  }, [shownKey]);

  const openJob = (job: AiJobRecord) => {
    if (job.task?.type !== 'video_understanding') return;
    void client.assets
      .get(job.task.asset_id)
      .then((asset) => video.open(job, asset))
      .catch(() => video.open(job, null));
  };

  return (
    <main className="page page--aiw" aria-label={t('ai.page')}>
      <header className="page__header">
        <h1 className="page__title">{t('ai.page')}</h1>
      </header>
      {/* QC-056: two columns that scroll on their own; the left one holds setup, 最近任務 and 用量. */}
      <div className="aiw">
        <div className="aiw__side">
          <section className="aiw__setup" aria-label={t('ai.setupLabel')}>
            <VideoCard
              asset={s.asset}
              onPick={() => {
                setPicking(true);
              }}
            />
            <fieldset className="aiw__fs">
              <legend className="aiw__h">{t('ai.taskLegend')}</legend>
              <span className="aiw__opt aiw__opt--static">
                <Icon name="video" size={14} />
                {t('ai.taskVideo')}
              </span>
            </fieldset>
            <ModelPicker session={video} s={s} />
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                s.asset === null ||
                s.estimate === null ||
                s.noKey ||
                s.phase === 'running' ||
                s.phase === 'estimating'
              }
              onClick={() => {
                video.analyze();
              }}
            >
              <Icon name="spark" />
              {s.phase === 'running'
                ? t('ai.phaseAnalyzing')
                : s.result !== null
                  ? t('ai.reanalyze')
                  : t('ai.analyze')}
            </button>
            {s.estimate !== null && (
              <span className="aiw__est">
                {t(
                  s.estimate.duration_source === 'size_guess'
                    ? 'ai.estimateLineGuess'
                    : 'ai.estimateLine',
                  {
                    duration: formatDuration(s.estimate.duration_seconds),
                    size: formatBytes(s.estimate.size_bytes),
                    cost: formatUsd(s.estimate.estimate.max_cost_usd),
                  },
                )}
              </span>
            )}
            {s.estimateError !== null && (
              <p className="aiw__err" role="alert">
                {s.estimateError}
              </p>
            )}
          </section>
          <RecentJobs
            activity={a}
            selectedId={selectedJobId(s)}
            onOpenJob={openJob}
            onRetry={() => void activity.load()}
          />
          <UsageSummary activity={a} />
        </div>

        <section ref={resultRef} className="aiw__result" aria-label={t('ai.resultLabel')}>
          <div className="card aiw__result-card">
            <ResultArea
              s={s}
              session={video}
              onOpenSettings={onOpenSettings}
              onPick={() => {
                setPicking(true);
              }}
              onOpenAsset={onOpenAsset}
              scroller={resultRef}
            />
          </div>
        </section>
      </div>

      {picking && (
        <VideoPicker
          client={client}
          onClose={() => {
            setPicking(false);
          }}
          onPick={(asset) => {
            setPicking(false);
            void video.select(asset);
          }}
          onOpenAssets={onOpenAssets}
        />
      )}
      {s.phase === 'reuse' && <ReuseDialog s={s} session={video} />}
      {s.phase === 'confirm' && <ConfirmDialog s={s} session={video} />}
    </main>
  );
}

/**
 * The frame of a library video at `at` seconds, read straight from the stream
 * (no extracted image). Seeking after metadata makes Chromium paint the frame.
 */
function VideoFrame({
  assetId,
  at,
  className,
  onError,
}: {
  assetId: string;
  at: number;
  className?: string;
  onError?: () => void;
}) {
  return (
    <video
      className={className}
      src={assetMediaUrl(assetId)}
      preload="metadata"
      muted
      playsInline
      aria-hidden="true"
      tabIndex={-1}
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        v.currentTime = Math.min(at, Number.isFinite(v.duration) ? v.duration : at);
      }}
      onError={onError}
    />
  );
}

function VideoThumb({ asset, size = 'small' }: { asset: AssetRecord; size?: 'small' | 'large' }) {
  const [broken, setBroken] = useState(false);
  const onError = () => {
    setBroken(true);
  };
  return (
    <span className={`aiw__thumb aiw__thumb--${size}`}>
      {broken ? (
        <Icon name="video" />
      ) : asset.thumbnail_status === 'ready' ? (
        <img src={thumbnailUrl(asset.id)} alt="" onError={onError} />
      ) : (
        // No generated thumbnail: the frame at 1 s.
        <VideoFrame assetId={asset.id} at={1} onError={onError} />
      )}
      {asset.duration !== null && (
        <span className="aiw__dur">{formatDuration(asset.duration)}</span>
      )}
    </span>
  );
}

function VideoCard({ asset, onPick }: { asset: AssetRecord | null; onPick: () => void }) {
  return (
    <div className="card aiw__video">
      {asset === null ? (
        <span className="aiw__video-empty">
          <Icon name="video" />
          {t('ai.noVideo')}
        </span>
      ) : (
        <>
          <VideoThumb asset={asset} />
          <span className="aiw__video-meta">
            <span className="mono aiw__video-name" title={assetName(asset)}>
              {assetName(asset)}
            </span>
            <span className="faint">{formatBytes(asset.bytes)}</span>
          </span>
        </>
      )}
      <button type="button" className="btn btn--small aiw__pick" onClick={onPick}>
        {asset === null ? t('ai.chooseVideo') : t('ai.changeVideo')}
      </button>
    </div>
  );
}

function ModelPicker({ session, s }: { session: VideoSession; s: VideoState }) {
  const options = modelOptions('gemini', s.model);
  return (
    <fieldset className="aiw__fs">
      <legend className="aiw__h">{t('ai.modelLegend')}</legend>
      <label className="aiw__opt">
        <input type="radio" name="aiw-model" checked readOnly />
        Gemini
        <select
          className="select aiw__model"
          aria-label={t('ai.geminiModel')}
          value={s.model ?? ''}
          disabled={s.phase === 'running'}
          onChange={(e) => {
            void session.setModel(e.target.value);
          }}
        >
          {options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="aiw__where">{t('ai.cloud')}</span>
      </label>
      {(
        [
          [AI_PROVIDER_NAMES.anthropic.name, t('ai.noVideoSupport')],
          [AI_PROVIDER_NAMES.openai.name, t('ai.noVideoSupport')],
          [t('ai.localModel'), t('ai.comingLater')],
        ] as const
      ).map(([name, why]) => (
        <label key={name} className="aiw__opt aiw__opt--off">
          <input type="radio" name="aiw-model" disabled />
          {name}
          <span className="aiw__where">{why}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ResultArea({
  s,
  session,
  onOpenSettings,
  onPick,
  onOpenAsset,
  scroller,
}: {
  s: VideoState;
  session: VideoSession;
  onOpenSettings: () => void;
  onPick: () => void;
  onOpenAsset: (assetId: string, at: number) => void;
  /** The result column, which scrolls on its own (for the section jumps). */
  scroller: RefObject<HTMLElement | null>;
}) {
  if (s.noKey) {
    return (
      <div className="aiw__empty">
        <Icon name="key" size={28} />
        <span className="aiw__empty-title">{t('ai.noGeminiKey')}</span>
        <div className="aiw__row">
          <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
            {t('ai.goToSettings')}
          </button>
          <button type="button" className="btn" disabled title={t('ai.localModelLater')}>
            {t('ai.useLocalModel')}
          </button>
        </div>
      </div>
    );
  }
  if (s.asset === null) {
    return (
      <div className="aiw__empty">
        <Icon name="video" size={28} />
        <span className="aiw__empty-title">{t('ai.pickAssetVideo')}</span>
        <span className="faint">{t('ai.pickAssetHint')}</span>
        <button type="button" className="btn btn--primary" onClick={onPick}>
          {t('ai.chooseVideo')}
        </button>
      </div>
    );
  }
  if (s.phase === 'running') {
    const pct = uploadPercent(s.job);
    return (
      <div className="aiw__run" role="status">
        <div className="aiw__row">
          <span className="aiw__run-label">{runLabel(s.job)}</span>
          {pct !== null && <span className="aiw__pct">{pct}%</span>}
        </div>
        <div className={pct === null ? 'bar bar--indeterminate' : 'bar'}>
          <span style={progressStyle(pct)} />
        </div>
        <div className="skel aiw__skel" style={{ width: '92%' }} />
        <div className="skel aiw__skel" style={{ width: '80%' }} />
        <div className="skel aiw__skel" style={{ width: '66%' }} />
        <div>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void session.cancel();
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }
  if (s.phase === 'failed' && s.failure !== null) {
    return (
      <div className="aiw__failed" role="alert">
        <span className="aiw__failed-title">
          <Icon name="alert" />
          {t('ai.analyzeFailed')}
        </span>
        <span className="aiw__failed-text">
          {s.failure.code === null ? s.failure.message : FAILURE_LABEL[s.failure.code]}
        </span>
        <TechnicalDetails text={s.failure.detail} />
        <div className="aiw__row">
          {s.job !== null && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void session.retry();
              }}
            >
              {t('common.retry')}
            </button>
          )}
          {s.previous !== null && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                session.showPrevious();
              }}
            >
              {t('ai.showLastResult')}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (s.phase === 'estimating') {
    return (
      <div className="aiw__run" aria-busy="true">
        <div className="skel aiw__skel" style={{ width: '70%' }} />
        <div className="skel aiw__skel" style={{ width: '50%' }} />
      </div>
    );
  }
  if (s.result === null || s.shown === null) {
    return (
      <div className="aiw__empty">
        <Icon name="spark" size={28} />
        <span className="aiw__empty-title">{t('ai.notAnalyzed')}</span>
        <span className="faint">{t('ai.notAnalyzedHint')}</span>
      </div>
    );
  }
  const r = s.result;
  const asset = s.asset;
  const sections: { id: SectionId; label: string }[] = [
    { id: 'summary', label: t('ai.summary') },
    ...(r.key_moments.length > 0 ? [{ id: 'moments' as const, label: t('ai.keyMoments') }] : []),
    ...(r.cover_suggestions.length > 0
      ? [{ id: 'covers' as const, label: t('ai.coverSuggestions') }]
      : []),
    ...(r.title_suggestions.length > 0
      ? [{ id: 'titles' as const, label: t('ai.titleSuggestions') }]
      : []),
    ...(r.description_suggestions.length > 0
      ? [{ id: 'descriptions' as const, label: t('ai.descriptionSuggestions') }]
      : []),
  ];
  return (
    <div className="aiw__done">
      <SectionNav sections={sections} scroller={scroller} />
      <div className="aiw__row aiw__done-head" id={sectionDomId('summary')}>
        <h2 className="aiw__title">{t('ai.summary')}</h2>
        <Chip>
          {s.shown.cost_usd === null
            ? t('ai.resultMeta', { when: formatWhen(s.shown.finished_at ?? s.shown.updated_at) })
            : t('ai.resultMetaCost', {
                when: formatWhen(s.shown.finished_at ?? s.shown.updated_at),
                cost: formatUsd(s.shown.cost_usd),
              })}
        </Chip>
        <span className="aiw__verify">
          <Chip tone="warn">{t('ai.needsVerification')}</Chip>
        </span>
      </div>
      <p className="aiw__disclaimer faint">{r.disclaimer}</p>
      <p className="aiw__summary">{r.summary}</p>

      {r.key_moments.length > 0 && (
        <div className="aiw__block" id={sectionDomId('moments')}>
          <h3 className="aiw__h">{t('ai.keyMoments')}</h3>
          {r.key_moments.map((m, i) => (
            <button
              key={`${String(m.time_seconds)}:${String(i)}`}
              type="button"
              className="aiw__chap"
              title={t('ai.playFromHere')}
              onClick={() => {
                onOpenAsset(asset.id, m.time_seconds);
              }}
            >
              <span className="aiw__ts mono">{formatDuration(m.time_seconds)}</span>
              <span className="aiw__chap-text">
                <span>{m.label}</span>
                {m.description !== '' && <span className="faint">{m.description}</span>}
              </span>
              {m.within_duration === false && <Chip tone="warn">{t('ai.beyondDuration')}</Chip>}
            </button>
          ))}
        </div>
      )}

      {r.cover_suggestions.length > 0 && (
        <div className="aiw__block" id={sectionDomId('covers')}>
          <h3 className="aiw__h">{t('ai.coverSuggestions')}</h3>
          <div className="aiw__frames" role="group" aria-label={t('ai.coverSuggestions')}>
            {r.cover_suggestions.map((m, i) => (
              <button
                key={`${String(m.time_seconds)}:${String(i)}`}
                type="button"
                className="aiw__frame"
                title={m.description || m.label}
                onClick={() => {
                  onOpenAsset(asset.id, m.time_seconds);
                }}
              >
                <VideoFrame className="aiw__frame-img" assetId={asset.id} at={m.time_seconds} />
                <span className="mono aiw__frame-ts">
                  {m.within_duration === false
                    ? t('ai.tsBeyond', { time: formatDuration(m.time_seconds) })
                    : formatDuration(m.time_seconds)}
                </span>
                {m.label !== '' && <span className="aiw__frame-label">{m.label}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <Suggestions
        id={sectionDomId('titles')}
        title={t('ai.titleSuggestions')}
        items={r.title_suggestions}
      />
      <Suggestions
        id={sectionDomId('descriptions')}
        title={t('ai.descriptionSuggestions')}
        items={r.description_suggestions}
      />
    </div>
  );
}

function Suggestions({
  id,
  title,
  items,
}: {
  id: string;
  title: string;
  items: readonly string[];
}) {
  const [copied, setCopied] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="aiw__block" id={id}>
      <h3 className="aiw__h">{title}</h3>
      {items.map((text, i) => (
        <div key={`${String(i)}:${text}`} className="aiw__cand">
          <span className="aiw__cand-text">{text}</span>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              void window.creatorhub?.copyText(text).then(() => {
                setCopied(i);
              });
            }}
          >
            {copied === i ? (
              <>
                <Icon name="check" size={14} />
                {t('common.copied')}
              </>
            ) : (
              <>
                <Icon name="copy" size={14} />
                {t('common.copy')}
              </>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

type SectionId = 'summary' | 'moments' | 'covers' | 'titles' | 'descriptions';

const sectionDomId = (id: SectionId) => `aiw-sec-${id}`;

/** Space the sticky section bar takes at the top of the result column. */
const NAV_OFFSET = 56;

/**
 * Jumps between the parts of a result (QC-056,
 * `qiuge-design/cases/kubai-999-008-responsive-wiki`): stays at the top of the
 * result column and marks the part being read.
 */
function SectionNav({
  sections,
  scroller,
}: {
  sections: readonly { id: SectionId; label: string }[];
  scroller: RefObject<HTMLElement | null>;
}) {
  const [current, setCurrent] = useState<SectionId>('summary');
  const ids = sections.map((x) => x.id).join(',');
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const list = ids.split(',') as SectionId[];
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + NAV_OFFSET + 8;
      let at: SectionId = list[0] ?? 'summary';
      for (const id of list) {
        const node = document.getElementById(sectionDomId(id));
        if (node !== null && node.getBoundingClientRect().top <= top) at = id;
      }
      // At the very bottom the last part counts as read even when it is short.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) at = list.at(-1) ?? at;
      setCurrent(at);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [ids, scroller]);
  if (sections.length < 2) return null;
  return (
    <nav className="aiw__nav" aria-label={t('ai.resultSections')}>
      {sections.map((x) => (
        <button
          key={x.id}
          type="button"
          className="aiw__nav-item"
          aria-current={current === x.id ? 'location' : undefined}
          onClick={() => {
            const el = scroller.current;
            const node = document.getElementById(sectionDomId(x.id));
            if (el === null || node === null) return;
            const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
            // The first part is the top of the result, bar and all.
            const top = x.id === sections[0]?.id ? 0 : el.scrollTop + delta - NAV_OFFSET;
            el.scrollTo({ top, behavior: 'smooth' });
            setCurrent(x.id);
          }}
        >
          {x.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * 最近任務 (QC-056): under the setup in the left column, because picking one
 * is how you choose what the result column shows. The one shown is marked;
 * failed ones open with their reason and 重試.
 */
function RecentJobs({
  activity,
  selectedId,
  onOpenJob,
  onRetry,
}: {
  activity: AiActivity['snapshot'];
  selectedId: string | null;
  onOpenJob: (job: AiJobRecord) => void;
  onRetry: () => void;
}) {
  return (
    <section className="aiw__jobs-box" aria-labelledby="aiw-jobs">
      <h2 id="aiw-jobs" className="aiw__h">
        {t('ai.recentJobs')}
      </h2>
      <span className="aiw__jobs-hint faint">{t('ai.jobsHint')}</span>
      {activity.failed ? (
        <div className="aiw__row">
          <span className="muted">{t('ai.loadFailed')}</span>
          <button type="button" className="btn btn--small" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      ) : activity.jobs === null ? (
        <div className="skel skel--line" />
      ) : activity.jobs.length === 0 ? (
        <span className="faint">{t('ai.noJobs')}</span>
      ) : (
        <ol className="aiw__jobs">
          {activity.jobs.map((job) => {
            const current = job.id === selectedId;
            const body = (
              <>
                <span className="aiw__job-k">{jobActionLabel(job)}</span>
                <span className="aiw__num">
                  {job.cost_usd === null ? '—' : formatUsd(job.cost_usd)}
                </span>
                <span className="faint aiw__job-v">
                  {AI_PROVIDER_NAMES[job.provider].name} · {formatWhen(job.created_at)}
                </span>
                <span className="aiw__job-s">
                  {job.status === 'failed' ? (
                    <Chip tone="bad">{t('ai.statusFailed')}</Chip>
                  ) : job.status === 'cancelled' ? (
                    <Chip>{t('ai.statusCancelled')}</Chip>
                  ) : job.status === 'succeeded' ? null : (
                    <Chip tone="accent">{t('ai.statusRunning')}</Chip>
                  )}
                </span>
                {current && <span className="visually-hidden">{t('ai.jobShowing')}</span>}
              </>
            );
            return (
              <li key={job.id}>
                {canOpenJob(job) ? (
                  <button
                    type="button"
                    className={
                      current
                        ? 'aiw__job aiw__job--open aiw__job--current'
                        : 'aiw__job aiw__job--open'
                    }
                    aria-current={current ? 'true' : undefined}
                    onClick={() => {
                      onOpenJob(job);
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="aiw__job">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * 用量 (QC-056): one line at the foot of the left column, the month's total
 * (and an over-budget warning) always visible; the per-service breakdown
 * opens on demand, since it is checked rarely.
 */
function UsageSummary({ activity }: { activity: AiActivity['snapshot'] }) {
  const usage = activity.usage;
  const budget = usage?.budget ?? null;
  const warning = budget === null ? null : budgetWarningText(budget);
  return (
    <section className="card aiw__usage" aria-labelledby="aiw-use">
      <details className="aiw__usage-details">
        <summary className="aiw__row aiw__usage-head">
          <Icon name="chevronDown" size={14} />
          <h2 id="aiw-use" className="aiw__title">
            {t('ai.usage')}
          </h2>
          <span className="aiw__total">{formatUsd(budget?.spent_usd ?? null)}</span>
        </summary>
        <span className="aiw__usage-sub faint">
          {budget?.budget_usd == null
            ? t('ai.usageSub')
            : t('ai.usageSubBudget', { budget: formatUsd(budget.budget_usd) })}
        </span>
        {usage !== null && usage.by_provider.length > 0 && (
          <div className="aiw__providers">
            {usage.by_provider.map((p) => (
              <span key={p.provider} className="aiw__prov">
                <span>{AI_PROVIDER_NAMES[p.provider].name}</span>
                <span className="faint">{t('ai.jobCount', { count: p.jobs })}</span>
                <span className="aiw__num">{formatUsd(p.cost_usd)}</span>
              </span>
            ))}
          </div>
        )}
      </details>
      {warning !== null && (
        <p className="aiw__over" role="status">
          <Icon name="alert" size={14} />
          {warning}
        </p>
      )}
    </section>
  );
}

function VideoPicker({
  client,
  onClose,
  onPick,
  onOpenAssets,
}: {
  client: CreatorHubClient;
  onClose: () => void;
  onPick: (asset: AssetRecord) => void;
  onOpenAssets: () => void;
}) {
  const [items, setItems] = useState<AssetRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true;
    const query = q.trim();
    const t = setTimeout(() => {
      client.assets
        .list({ kind: 'video', limit: 100, ...(query === '' ? {} : { q: query }) })
        .then((res) => {
          if (!alive) return;
          setFailed(false);
          setItems(res.items);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, q]);
  return (
    <Dialog title={t('ai.chooseVideo')} onClose={onClose} width={640}>
      <div className="aiw-pick">
        <input
          className="input"
          type="search"
          placeholder={t('ai.searchFilename')}
          aria-label={t('ai.searchVideo')}
          data-autofocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
        />
        {failed ? (
          <p className="muted">{t('ai.assetsLoadFailed')}</p>
        ) : items === null ? (
          <div className="skel skel--line" />
        ) : items.length === 0 ? (
          <div className="aiw__empty aiw__empty--small">
            <span className="aiw__empty-title">
              {q.trim() === '' ? t('ai.noVideosInLibrary') : t('ai.noMatchingVideos')}
            </span>
            {q.trim() === '' && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  onOpenAssets();
                }}
              >
                {t('ai.goToAssets')}
              </button>
            )}
          </div>
        ) : (
          <div className="aiw-pick__grid">
            {items.map((asset) => (
              <button
                key={asset.id}
                type="button"
                className="aiw-pick__item"
                onClick={() => {
                  onPick(asset);
                }}
              >
                <VideoThumb asset={asset} size="large" />
                <span className="mono aiw-pick__name" title={assetName(asset)}>
                  {assetName(asset)}
                </span>
                <span className="faint">{formatBytes(asset.bytes)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function ReuseDialog({ s, session }: { s: VideoState; session: VideoSession }) {
  const prev = s.previous;
  const max = s.estimate?.estimate.max_cost_usd ?? null;
  return (
    <Dialog
      title={t('ai.reuseTitle')}
      width={420}
      onClose={() => {
        session.closeDialog();
      }}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => {
              session.rerun();
            }}
          >
            {t('ai.reanalyze')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-autofocus
            onClick={() => {
              void session.reuse();
            }}
          >
            {t('ai.reuseKeep')}
          </button>
        </>
      }
    >
      <div className="form">
        {prev !== null && (
          <div className="aiw__row">
            <Chip>{formatWhen(prev.finished_at ?? prev.updated_at)}</Chip>
            <Chip>Gemini · {prev.model}</Chip>
            {prev.cost_usd !== null && <Chip>{formatUsd(prev.cost_usd)}</Chip>}
          </div>
        )}
        <p>{t('ai.reuseFree')}</p>
        <p className="aiw__warn-text">
          {max === null ? t('ai.reuseRerun') : t('ai.reuseRerunCost', { max: formatUsd(max) })}
        </p>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({
  s,
  session,
  requireAck = false,
}: {
  s: VideoState;
  session: VideoSession;
  /**
   * The video editor (QC-046): nothing is sent until the user ticks that the
   * video goes to Google and the estimated cost is charged.
   */
  requireAck?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const asset = s.asset;
  const est = s.estimate;
  if (asset === null) return null;
  const needsConsent = s.gemini !== null && s.gemini.consent === null;
  const tooLongForDefault =
    asset.duration !== null && asset.duration > GEMINI_VIDEO_LIMITS.maxDurationSeconds.default;
  return (
    <Dialog
      title={t('ai.confirmTitle', { company: s.gemini?.company ?? 'Google' })}
      width={480}
      onClose={() => {
        session.closeDialog();
      }}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost dialog__primary"
            onClick={() => {
              session.closeDialog();
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-autofocus
            disabled={busy || est === null || (requireAck && !ack)}
            onClick={() => {
              setBusy(true);
              void session.confirm().finally(() => {
                setBusy(false);
              });
            }}
          >
            {needsConsent ? t('ai.consentAndUpload') : t('ai.uploadAndAnalyze')}
          </button>
        </>
      }
    >
      <div className="form aiw-confirm">
        <p>{s.reanalyze ? t('ai.confirmIntroRerun') : t('ai.confirmIntro')}</p>
        {needsConsent && s.gemini !== null && (
          <section className="aiw-confirm__sec aiw-confirm__notice" aria-labelledby="aiw-notice">
            <h3 id="aiw-notice" className="aiw-confirm__h">
              {t('ai.noticeHeading')}
            </h3>
            <p>{noticeText(s.gemini.notice)}</p>
          </section>
        )}
        <section className="aiw-confirm__sec" aria-labelledby="aiw-cost">
          <h3 id="aiw-cost" className="aiw-confirm__h">
            {needsConsent ? t('ai.costHeadingNumbered') : t('ai.costHeading')}
          </h3>
          <div className="aiw-confirm__file">
            <VideoThumb asset={asset} />
            <span className="mono aiw-confirm__name">{assetName(asset)}</span>
            <span className="faint">{formatBytes(asset.bytes)}</span>
          </div>
          {est === null ? (
            <p className="aiw__err" role="alert">
              {s.estimateError ?? t('ai.reestimating')}
            </p>
          ) : (
            <dl className="aiw-confirm__facts">
              <dt>{t('ai.duration')}</dt>
              <dd>
                {est.duration_source === 'size_guess'
                  ? t('ai.durationGuess', { duration: formatDuration(est.duration_seconds) })
                  : formatDuration(est.duration_seconds)}
              </dd>
              <dt>{t('ai.modelLegend')}</dt>
              <dd className="mono">{est.model}</dd>
              <dt>{t('ai.input')}</dt>
              <dd>{t('ai.inputTokens', { tokens: formatNumber(est.estimate.input_tokens) })}</dd>
              <dt>{t('ai.maxCost')}</dt>
              <dd>
                <strong>{formatUsd(est.estimate.max_cost_usd)}</strong>
                {t('ai.estimatedSuffix')}
              </dd>
              <dt>{t('ai.monthToDate')}</dt>
              <dd>
                {est.budget.budget_usd === null
                  ? t('ai.spentLine', { spent: formatUsd(est.budget.spent_usd) })
                  : t('ai.spentLineBudget', {
                      spent: formatUsd(est.budget.spent_usd),
                      budget: formatUsd(est.budget.budget_usd),
                    })}
              </dd>
            </dl>
          )}
          <label className="aiw-confirm__low">
            <input
              type="checkbox"
              checked={s.resolution === 'low'}
              onChange={(e) => {
                void session.setResolution(e.target.checked ? 'low' : 'default');
              }}
            />
            <span>
              {t('ai.lowResolution')}
              {s.autoLow && tooLongForDefault && (
                <span className="aiw-confirm__why">{t('ai.autoLowWhy')}</span>
              )}
            </span>
          </label>
          {est !== null && budgetWarningText(est.budget) !== null && (
            <p className="aiw__over" role="status">
              <Icon name="alert" size={14} />
              {budgetWarningText(est.budget)}
            </p>
          )}
        </section>
        {requireAck && (
          <label className="aiw-confirm__ack">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => {
                setAck(e.target.checked);
              }}
            />
            <span>
              {t('videoWork.ackSend', {
                company: s.gemini?.company ?? 'Google',
                max: est === null ? '—' : formatUsd(est.estimate.max_cost_usd),
              })}
            </span>
          </label>
        )}
        {s.confirmError !== null && (
          <p className="aiw__err" role="alert">
            {s.confirmError}
          </p>
        )}
      </div>
    </Dialog>
  );
}
