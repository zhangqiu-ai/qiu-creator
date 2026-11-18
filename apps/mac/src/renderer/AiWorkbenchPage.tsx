import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  AI_PROVIDER_NAMES,
  GEMINI_VIDEO_LIMITS,
  type AiJobRecord,
  type AssetRecord,
} from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { FAILURE_LABEL } from './ai-session.js';
import { formatUsd, modelOptions } from './ai-settings.js';
import {
  AiActivity,
  jobActionLabel,
  runLabel,
  uploadPercent,
  VideoSession,
  type VideoState,
} from './ai-video.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useChangeEvents } from './events.js';
import { formatBytes, formatDuration, formatWhen } from './format.js';
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
    return () => {
      v.dispose();
    };
  }, [client]);
  if (video === null) return <main className="page" aria-label="AI 工作台" aria-busy="true" />;
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

  const openJob = (job: AiJobRecord) => {
    if (job.task?.type !== 'video_understanding') return;
    void client.assets
      .get(job.task.asset_id)
      .then((asset) => video.open(job, asset))
      .catch(() => video.open(job, null));
  };

  return (
    <main className="page" aria-label="AI 工作台">
      <header className="page__header">
        <h1 className="page__title">AI 工作台</h1>
      </header>
      <div className="aiw">
        <section className="aiw__setup" aria-label="任務設定">
          <VideoCard
            asset={s.asset}
            onPick={() => {
              setPicking(true);
            }}
          />
          <fieldset className="aiw__fs">
            <legend className="aiw__h">任務</legend>
            <span className="aiw__opt aiw__opt--static">
              <Icon name="video" size={14} />
              視頻理解：摘要、時間點、標題、簡介、封面
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
            {s.phase === 'running' ? '分析中' : s.result !== null ? '重新分析' : '分析'}
          </button>
          {s.estimate !== null && (
            <span className="aiw__est">
              {formatDuration(s.estimate.duration_seconds)}
              {s.estimate.duration_source === 'size_guess' && '（依大小推估）'} ·{' '}
              {formatBytes(s.estimate.size_bytes)} · 最多{' '}
              {formatUsd(s.estimate.estimate.max_cost_usd)}
              （估算）
            </span>
          )}
          {s.estimateError !== null && (
            <p className="aiw__err" role="alert">
              {s.estimateError}
            </p>
          )}
        </section>

        <section className="card aiw__result" aria-label="分析結果">
          <ResultArea
            s={s}
            session={video}
            onOpenSettings={onOpenSettings}
            onPick={() => {
              setPicking(true);
            }}
            onOpenAsset={onOpenAsset}
          />
        </section>

        <UsageCard activity={a} onOpenJob={openJob} onRetry={() => void activity.load()} />
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
          尚未選擇視頻
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
        {asset === null ? '選擇視頻' : '更換'}
      </button>
    </div>
  );
}

function ModelPicker({ session, s }: { session: VideoSession; s: VideoState }) {
  const options = modelOptions('gemini', s.model);
  return (
    <fieldset className="aiw__fs">
      <legend className="aiw__h">模型</legend>
      <label className="aiw__opt">
        <input type="radio" name="aiw-model" checked readOnly />
        Gemini
        <select
          className="select aiw__model"
          aria-label="Gemini 模型"
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
        <span className="aiw__where">雲端</span>
      </label>
      {(
        [
          [AI_PROVIDER_NAMES.anthropic.name, '不支援視頻'],
          [AI_PROVIDER_NAMES.openai.name, '不支援視頻'],
          ['本地模型', '延後提供'],
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
}: {
  s: VideoState;
  session: VideoSession;
  onOpenSettings: () => void;
  onPick: () => void;
  onOpenAsset: (assetId: string, at: number) => void;
}) {
  if (s.noKey) {
    return (
      <div className="aiw__empty">
        <Icon name="key" size={28} />
        <span className="aiw__empty-title">未設定 Gemini 金鑰</span>
        <div className="aiw__row">
          <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
            前往設定
          </button>
          <button type="button" className="btn" disabled title="本地模型延後提供">
            改用本地模型
          </button>
        </div>
      </div>
    );
  }
  if (s.asset === null) {
    return (
      <div className="aiw__empty">
        <Icon name="video" size={28} />
        <span className="aiw__empty-title">選擇素材庫的視頻來分析</span>
        <span className="faint">Gemini 會產生摘要、重要時間點、標題、簡介與封面建議。</span>
        <button type="button" className="btn btn--primary" onClick={onPick}>
          選擇視頻
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
          <span style={pct === null ? undefined : { width: `${String(pct)}%` }} />
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
            取消
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
          分析失敗
        </span>
        <span className="aiw__failed-text">
          {s.failure.code === null
            ? s.failure.message
            : `${FAILURE_LABEL[s.failure.code]}：${s.failure.message}`}
        </span>
        <div className="aiw__row">
          {s.job !== null && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void session.retry();
              }}
            >
              重試
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
              查看上次結果
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
        <span className="aiw__empty-title">尚未分析這支視頻</span>
        <span className="faint">按「分析」後會先顯示大小、時長與估算費用，確認後才上傳。</span>
      </div>
    );
  }
  const r = s.result;
  const asset = s.asset;
  return (
    <div className="aiw__done">
      <div className="aiw__row aiw__done-head">
        <h2 className="aiw__title">摘要</h2>
        <Chip>
          Gemini · {formatWhen(s.shown.finished_at ?? s.shown.updated_at)}
          {s.shown.cost_usd !== null && ` · ${formatUsd(s.shown.cost_usd)}（估算）`}
        </Chip>
        <span className="aiw__verify">
          <Chip tone="warn">待核驗</Chip>
        </span>
      </div>
      <p className="aiw__disclaimer faint">{r.disclaimer}</p>
      <p className="aiw__summary">{r.summary}</p>

      {r.key_moments.length > 0 && (
        <div className="aiw__block">
          <h3 className="aiw__h">時間點</h3>
          {r.key_moments.map((m, i) => (
            <button
              key={`${String(m.time_seconds)}:${String(i)}`}
              type="button"
              className="aiw__chap"
              title="在素材檢視器從這裡播放"
              onClick={() => {
                onOpenAsset(asset.id, m.time_seconds);
              }}
            >
              <span className="aiw__ts mono">{formatDuration(m.time_seconds)}</span>
              <span className="aiw__chap-text">
                <span>{m.label}</span>
                {m.description !== '' && <span className="faint">{m.description}</span>}
              </span>
              {m.within_duration === false && <Chip tone="warn">超出片長</Chip>}
            </button>
          ))}
        </div>
      )}

      {r.cover_suggestions.length > 0 && (
        <div className="aiw__block">
          <h3 className="aiw__h">封面建議</h3>
          <div className="aiw__frames" role="group" aria-label="封面建議">
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
                  {formatDuration(m.time_seconds)}
                  {m.within_duration === false && ' · 超出片長'}
                </span>
                {m.label !== '' && <span className="aiw__frame-label">{m.label}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <Suggestions title="標題建議" items={r.title_suggestions} />
      <Suggestions title="簡介建議" items={r.description_suggestions} />
    </div>
  );
}

function Suggestions({ title, items }: { title: string; items: readonly string[] }) {
  const [copied, setCopied] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="aiw__block">
      <h3 className="aiw__h">{title}</h3>
      {items.map((t, i) => (
        <div key={`${String(i)}:${t}`} className="aiw__cand">
          <span className="aiw__cand-text">{t}</span>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              void window.creatorhub?.copyText(t).then(() => {
                setCopied(i);
              });
            }}
          >
            {copied === i ? (
              <>
                <Icon name="check" size={14} />
                已複製
              </>
            ) : (
              <>
                <Icon name="copy" size={14} />
                複製
              </>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

function UsageCard({
  activity,
  onOpenJob,
  onRetry,
}: {
  activity: AiActivity['snapshot'];
  onOpenJob: (job: AiJobRecord) => void;
  onRetry: () => void;
}) {
  const usage = activity.usage;
  const budget = usage?.budget ?? null;
  return (
    <section className="card aiw__usage" aria-labelledby="aiw-use">
      <div className="aiw__row aiw__usage-head">
        <h2 id="aiw-use" className="aiw__title">
          用量
        </h2>
        <span className="aiw__total">{formatUsd(budget?.spent_usd ?? null)}</span>
      </div>
      <span className="aiw__usage-sub faint">
        本月 · 估算
        {budget?.budget_usd != null && ` · 提醒 ${formatUsd(budget.budget_usd)}`}
      </span>
      {budget?.over_budget === true && budget.warning !== null && (
        <p className="aiw__over" role="status">
          <Icon name="alert" size={14} />
          {budget.warning}
        </p>
      )}
      {usage !== null && usage.by_provider.length > 0 && (
        <div className="aiw__providers">
          {usage.by_provider.map((p) => (
            <span key={p.provider} className="aiw__prov">
              <span>{AI_PROVIDER_NAMES[p.provider].name}</span>
              <span className="faint">{p.jobs} 次</span>
              <span className="aiw__num">{formatUsd(p.cost_usd)}</span>
            </span>
          ))}
        </div>
      )}
      <h3 className="aiw__h aiw__recent">最近任務</h3>
      {activity.failed ? (
        <div className="aiw__row">
          <span className="muted">無法載入</span>
          <button type="button" className="btn btn--small" onClick={onRetry}>
            重試
          </button>
        </div>
      ) : activity.jobs === null ? (
        <div className="skel skel--line" />
      ) : activity.jobs.length === 0 ? (
        <span className="faint">還沒有 AI 任務</span>
      ) : (
        <ol className="aiw__jobs">
          {activity.jobs.map((job) => {
            const openable = job.task?.type === 'video_understanding' && job.status === 'succeeded';
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
                    <Chip tone="bad">失敗</Chip>
                  ) : job.status === 'cancelled' ? (
                    <Chip>已取消</Chip>
                  ) : job.status === 'succeeded' ? null : (
                    <Chip tone="accent">進行中</Chip>
                  )}
                </span>
              </>
            );
            return (
              <li key={job.id}>
                {openable ? (
                  <button
                    type="button"
                    className="aiw__job aiw__job--open"
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
    <Dialog title="選擇視頻" onClose={onClose} width={640}>
      <div className="aiw-pick">
        <input
          className="input"
          type="search"
          placeholder="搜尋檔名"
          aria-label="搜尋視頻"
          data-autofocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
        />
        {failed ? (
          <p className="muted">無法載入素材</p>
        ) : items === null ? (
          <div className="skel skel--line" />
        ) : items.length === 0 ? (
          <div className="aiw__empty aiw__empty--small">
            <span className="aiw__empty-title">
              {q.trim() === '' ? '素材庫還沒有視頻' : '沒有符合的視頻'}
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
                前往素材庫
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

function ReuseDialog({ s, session }: { s: VideoState; session: VideoSession }) {
  const prev = s.previous;
  const max = s.estimate?.estimate.max_cost_usd ?? null;
  return (
    <Dialog
      title="已分析過此影片"
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
            重新分析
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-autofocus
            onClick={() => {
              void session.reuse();
            }}
          >
            沿用結果
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
        <p>沿用不會送出任何內容，也不收費。</p>
        <p className="aiw__warn-text">
          重新分析會再次上傳並計費
          {max !== null && `（估算最多 ${formatUsd(max)}）`}。
        </p>
      </div>
    </Dialog>
  );
}

function ConfirmDialog({ s, session }: { s: VideoState; session: VideoSession }) {
  const [busy, setBusy] = useState(false);
  const asset = s.asset;
  const est = s.estimate;
  if (asset === null) return null;
  const needsConsent = s.gemini !== null && s.gemini.consent === null;
  const tooLongForDefault =
    asset.duration !== null && asset.duration > GEMINI_VIDEO_LIMITS.maxDurationSeconds.default;
  return (
    <Dialog
      title={`上傳至 ${s.gemini?.company ?? 'Google'} Gemini`}
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
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-autofocus
            disabled={busy || est === null}
            onClick={() => {
              setBusy(true);
              void session.confirm().finally(() => {
                setBusy(false);
              });
            }}
          >
            {needsConsent ? '同意並上傳分析' : '上傳並分析'}
          </button>
        </>
      }
    >
      <div className="form aiw-confirm">
        <p>影片會傳到 Google 處理，並產生費用{s.reanalyze && '（重新分析會再次計費）'}。</p>
        {needsConsent && s.gemini !== null && (
          <div className="aiw-confirm__notice" role="group" aria-label="Gemini 使用告知">
            <span className="aiw-confirm__notice-title">首次使用 Gemini，請確認：</span>
            <p>{s.gemini.notice.text}</p>
          </div>
        )}
        <div className="aiw-confirm__file">
          <VideoThumb asset={asset} />
          <span className="mono aiw-confirm__name">{assetName(asset)}</span>
          <span className="faint">{formatBytes(asset.bytes)}</span>
        </div>
        {est === null ? (
          <p className="aiw__err" role="alert">
            {s.estimateError ?? '正在重新估算…'}
          </p>
        ) : (
          <dl className="aiw-confirm__facts">
            <dt>時長</dt>
            <dd>
              {formatDuration(est.duration_seconds)}
              {est.duration_source === 'size_guess' && '（依大小推估）'}
            </dd>
            <dt>模型</dt>
            <dd className="mono">{est.model}</dd>
            <dt>輸入</dt>
            <dd>約 {est.estimate.input_tokens.toLocaleString('en-US')} tokens（估算）</dd>
            <dt>最多花費</dt>
            <dd>
              <strong>{formatUsd(est.estimate.max_cost_usd)}</strong>（估算）
            </dd>
            <dt>本月累計</dt>
            <dd>
              {formatUsd(est.budget.spent_usd)}
              {est.budget.budget_usd !== null && ` / 提醒 ${formatUsd(est.budget.budget_usd)}`}
              （估算）
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
            低解析度（較省、可分析到約 3 小時）
            {s.autoLow && tooLongForDefault && (
              <span className="aiw-confirm__why">
                已自動勾選：影片超過 1 小時，預設解析度無法分析
              </span>
            )}
          </span>
        </label>
        {est?.budget.over_budget === true && est.budget.warning !== null && (
          <p className="aiw__over" role="status">
            <Icon name="alert" size={14} />
            {est.budget.warning}
          </p>
        )}
      </div>
    </Dialog>
  );
}
