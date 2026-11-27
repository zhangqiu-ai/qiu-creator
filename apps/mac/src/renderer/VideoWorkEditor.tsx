import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { watchAiStatus } from './ai-status.js';
import type {
  AssetRecord,
  Platform,
  Revision,
  VideoUnderstandingResult,
  WorkDetail,
  WorkStatus,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { formatUsd } from './ai-settings.js';
import { ConfirmDialog, ReuseDialog } from './AiWorkbenchPage.js';
import { PHASE_LABEL, uploadPercent, VideoSession, type VideoState } from './ai-video.js';
import { Chip } from './Chip.js';
import { SaveChip } from './SaveChip.js';
import { Dialog } from './Dialog.js';
import { sessionHandle, type EditorTabHandle } from './tab-handle.js';
import { InsertSession, type InsertState } from './editor-insert.js';
import { useChangeEvents } from './events.js';
import { formatDuration, WORK_STATUS } from './format.js';
import { FrameGrabber } from './frames.js';
import { HistoryPanel } from './HistoryPanel.js';
import { PreviewPanel } from './PreviewPanel.js';
import { progressStyle } from './motion.js';
import { codeText, formatBytes, t } from './i18n.js';
import { Icon } from './Icon.js';
import { shortPlatform } from './image-post.js';
import { AssetDrawer } from './InsertUI.js';
import { diffSentences } from './rewrite-diff.js';
import type { TabStatusPatch, TabView } from './tabs.js';
import { EditorSide, useSideStore } from './EditorSide.js';
import { LiveBanner } from './AgentLive.js';
import { ProposalsSideTab, usePendingFor } from './ProposalsSideTab.js';
import { TagEditor } from './TagEditor.js';
import { ProjectTags } from './ProjectTags.js';
import { TechnicalDetails } from './TechnicalDetails.js';
import { useToast } from './toasts.js';
import { uploadBlob, uploadFile } from './upload-wait.js';
import {
  analyzeBlock,
  COVER_CROPS,
  frameTimes,
  isLongVideo,
  orientationOf,
  scrubPercent,
  SEEK_STEP_SECONDS,
  seekBy,
  timeLabel,
  VIDEO_PLATFORMS,
  videoBodyCounts,
  videoTagCounts,
  videoTitleCounts,
  type CopyCount,
} from './video-work.js';
import { WorkSession, type Draft, type SaveError } from './work-session.js';

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];
const EMPTY_INSERT: InsertState = { pending: [], notice: null };

export interface VideoWorkEditorProps {
  client: CreatorHubClient;
  work: WorkDetail;
  userHome: string | null;
  onBack: () => void;
  /** QC-097: 活動記錄 in the live agent bar (設定 › Agent 與 MCP). */
  onOpenAgentActivity?: () => void;
  onOpenSettings?: () => void;
  active?: boolean;
  initialView?: TabView;
  initialDraft?: Draft | null;
  onTabStatus?: (patch: TabStatusPatch) => void;
  onViewChange?: (view: TabView) => void;
  onHandle?: (handle: EditorTabHandle | null) => void;
}

function saveErrorText(error: SaveError | null): string {
  if (error === null) return t('editor.saveFailed');
  if (error.kind === 'title_blank') return t('editor.titleRequired');
  if (error.kind === 'offline') return t('editor.saveOffline');
  return codeText(error.code);
}

function useStore<S>(
  store: { subscribe: (l: () => void) => () => void; snapshot: S } | null,
): S | null {
  return useSyncExternalStore(
    useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => undefined), [store]),
    () => store?.snapshot ?? null,
  );
}

/**
 * 視頻作品 (QC-046, PT-20261121-001 「v3 · 視頻作品」): a work built around one
 * video, no editing of the video itself. Player with key moments and the
 * cover on the scrubber (←→ 5 s); a cover from an 8-frame strip, the current
 * frame (grabbed in the App and uploaded as an image) or another image, with
 * 抖音 3:4 and 視頻號 6:7 crops; shared copy that 抖音 and 視頻號 can follow
 * or override; Gemini understanding with the cost shown and agreed first,
 * suggestions adopted only after a diff, and every adoption undoable.
 */
export function VideoWorkEditor(props: VideoWorkEditorProps) {
  const { client, work, onHandle } = props;
  const [session, setSession] = useState<WorkSession | null>(null);
  const initialDraft = useRef(props.initialDraft ?? null);
  useEffect(() => {
    const s = new WorkSession(client, work);
    let discarded = false;
    const back = initialDraft.current;
    initialDraft.current = null;
    if (back !== null) s.edit(back);
    setSession(s);
    onHandle?.(
      sessionHandle(s, () => {
        discarded = true;
      }),
    );
    return () => {
      onHandle?.(null);
      if (!discarded) s.close();
    };
  }, [client, work, onHandle]);
  if (session === null) return <main className="page" aria-busy="true" />;
  return <VideoEditor {...props} session={session} />;
}

/** 標題建議 moved to the 預覽 split (QC-076): only 簡介 and 封面 are adopted here. */
type Adopt = { kind: 'description'; text: string } | { kind: 'cover'; time: number };

function VideoEditor({
  client,
  work,
  onBack,
  onOpenAgentActivity,
  onOpenSettings,
  session,
  active = true,
  initialView,
  onTabStatus,
  onViewChange,
}: VideoWorkEditorProps & { session: WorkSession }) {
  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.snapshot,
  );
  const draft = state.draft;
  const videoId = draft.video ?? null;
  const cover = draft.cover ?? null;
  const coverAsset = cover !== null && 'asset_id' in cover ? cover.asset_id : null;
  const readOnly = state.readOnly !== null;
  const external = work.storage_mode === 'external';
  const bridge = window.creatorhub ?? null;

  // QC-085: 預覽, AI (影片理解), 歷史 and 素材 are tabs of the window's right sidebar.
  const side = useSideStore();
  // QC-091: the 提案 tab while the work has pending agent proposals.
  const pendingProposals = usePendingFor(work.id);
  const [previewAsk, setPreviewAsk] = useState<{ platform: Platform; n: number } | undefined>(
    undefined,
  );
  const openPreview = (platform: Platform) => {
    setPreviewAsk((r) => ({ platform, n: (r?.n ?? 0) + 1 }));
    side.show('preview');
  };
  const onOverLimit = useCallback(
    (over: boolean) => {
      side.setOver(work.id, over);
    },
    [side, work.id],
  );
  /** Why something did not work. */
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ label: string; revision: string } | null>(null);
  const [adopt, setAdopt] = useState<Adopt | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null && undo === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
      setUndo(null);
    }, 8000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice, undo]);

  // ---- The video: library asset, upload ----------------------------------------------------
  const [asset, setAsset] = useState<AssetRecord | null>(null);
  useEffect(() => {
    if (videoId === null) {
      setAsset(null);
      return;
    }
    let live = true;
    client.assets
      .get(videoId)
      .then((a) => {
        if (live) setAsset(a);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, videoId]);
  const place = useCallback(
    (a: AssetRecord) => {
      session.edit({ video: a.id });
      return Promise.resolve();
    },
    [session],
  );
  const [insert, setInsert] = useState<InsertSession | null>(null);
  useEffect(() => {
    const s = new InsertSession({
      client,
      workId: work.id,
      insert: () => undefined,
      place,
      bridge,
    });
    setInsert(s);
    return () => {
      s.dispose();
    };
  }, [client, work.id, place, bridge]);
  const insertState = useSyncExternalStore(
    useCallback((cb: () => void) => insert?.subscribe(cb) ?? (() => undefined), [insert]),
    () => insert?.getSnapshot() ?? EMPTY_INSERT,
  );
  const uploading = insertState.pending.find((p) => p.state !== 'failed') ?? null;
  const uploadFailed = insertState.pending.find((p) => p.state === 'failed') ?? null;
  const videoInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  // ---- Gemini understanding (QC-023 job, estimate and notice) -------------------------------
  const [video, setVideo] = useState<VideoSession | null>(null);
  useEffect(() => {
    const v = new VideoSession(client, 3000, work.id);
    setVideo(v);
    void v.loadProvider();
    const unwatch = watchAiStatus(() => void v.refresh());
    return () => {
      unwatch();
      v.dispose();
    };
  }, [client, work.id]);
  // Shown again after another tab or page: a key, consent or model may have changed meanwhile.
  useEffect(() => {
    if (active) void video?.refresh();
  }, [active, video]);
  const vs = useStore<VideoState>(video);
  useEffect(() => {
    if (video === null || asset === null || uploading !== null) return;
    if (analyzeBlock(asset, false) !== null) return;
    if (video.snapshot.asset?.id === asset.id) return;
    void video.select(asset);
  }, [video, asset, uploading]);
  const block = analyzeBlock(asset, uploading !== null);
  const result: VideoUnderstandingResult | null = vs?.result ?? null;
  const resultJob = vs?.shown ?? null;

  // ---- Revisions, live changes ---------------------------------------------------------------
  const [revisions, setRevisions] = useState<readonly Revision[]>([]);
  const loadRevisions = useCallback(() => {
    client.works
      .revisions(work.id)
      .then((r) => {
        setRevisions(r.items);
      })
      .catch(() => undefined);
  }, [client, work.id]);
  useEffect(loadRevisions, [loadRevisions, state.baseRevision]);
  const numbers = useMemo(
    () => new Map(revisions.map((r, i) => [r.revision_id, revisions.length - i])),
    [revisions],
  );
  useChangeEvents((event) => {
    if (event.entity === 'job' && event.action.startsWith('ai_job.')) {
      void video?.jobChanged(event.entity_id);
      return;
    }
    if (event.entity !== 'work' || event.entity_id !== work.id) return;
    const rid = typeof event.data['revision_id'] === 'string' ? event.data['revision_id'] : null;
    if (
      (event.action === 'work.updated' || event.action === 'work.external_revision') &&
      rid !== null
    ) {
      const src = event.data['source'];
      void session.remoteRevision(
        rid,
        src === 'edit' || src === 'restore' || src === 'external' ? src : 'other',
      );
      loadRevisions();
    }
  });

  // ---- Tab: badges, view, shortcuts ------------------------------------------------------------
  useEffect(() => {
    onTabStatus?.({
      title: draft.title,
      unsaved: session.hasUnsavedChanges(),
      conflict: state.status === 'conflict' || state.remote !== null,
    });
  }, [state, draft.title, session, onTabStatus]);
  useEffect(() => {
    onTabStatus?.({
      aiBusy: vs?.phase === 'running',
      aiCandidate: vs?.phase === 'done' && result !== null,
    });
  }, [vs?.phase, result, onTabStatus]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(initialView?.scrollTop ?? 0);
  const latest = useRef({ onViewChange });
  latest.current = { onViewChange };
  const reportView = useCallback(() => {
    latest.current.onViewChange?.({
      mode: null,
      selection: null,
      scrollTop: scrollTop.current,
    });
  }, []);
  useEffect(() => {
    if (active) reportView();
  }, [active, reportView]);
  useLayoutEffect(() => {
    if (!active) return;
    return () => {
      if (scrollRef.current !== null) scrollTop.current = scrollRef.current.scrollTop;
    };
  }, [active]);
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) reportView();
    wasActive.current = active;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current !== null) scrollRef.current.scrollTop = scrollTop.current;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, reportView]);
  useLayoutEffect(() => reportView, [reportView]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.isComposing || session.isComposing()) return;
      const key = e.key.toLowerCase();
      if (!e.shiftKey && key === 's') {
        e.preventDefault();
        void session.save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [active, session]);

  // ---- Player and frames ---------------------------------------------------------------------
  const player = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const src = videoId === null ? null : assetMediaUrl(videoId);
  const [grabber, setGrabber] = useState<FrameGrabber | null>(null);
  useEffect(() => {
    if (src === null) {
      setGrabber(null);
      return;
    }
    const g = new FrameGrabber(src);
    setGrabber(g);
    return () => {
      g.dispose();
    };
  }, [src]);
  const times = useMemo(() => frameTimes(duration), [duration]);
  const [strip, setStrip] = useState<Record<number, string>>({});
  useEffect(() => {
    setStrip({});
    if (grabber === null || times.length === 0) return;
    // An object, so the loop sees the cleanup's change after each await.
    const run = { live: true };
    void (async () => {
      for (const at of times) {
        try {
          const url = await grabber.thumbnail(at);
          if (!run.live) return;
          setStrip((s) => ({ ...s, [at]: url }));
        } catch {
          return;
        }
      }
    })();
    return () => {
      run.live = false;
    };
  }, [grabber, times]);
  const seek = (at: number) => {
    const el = player.current;
    if (el === null) return;
    el.currentTime = at;
    setTime(at);
  };
  const coverLocked: string | null = readOnly
    ? t('editor.insertBlockedReadOnly')
    : external
      ? t('videoWork.externalLocked')
      : uploading !== null
        ? t('videoWork.lockedUploading')
        : null;

  /** Grab the frame at `at` (or what the player shows) and upload it as an image. */
  const grabCover = async (at: number | null): Promise<AssetRecord | null> => {
    if (bridge === null || grabber === null) return null;
    const when = at ?? player.current?.currentTime ?? 0;
    setBusy('cover');
    try {
      const blob = await grabber.frame(when);
      return await uploadBlob(bridge, `cover-${timeLabel(when).replace(':', 'm')}s.jpg`, blob);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('videoWork.frameFailed'));
      return null;
    } finally {
      setBusy(null);
    }
  };
  const setCoverFrom = async (at: number | null) => {
    const a = await grabCover(at);
    if (a !== null) {
      // The crops below show the new cover.
      session.edit({ cover: { asset_id: a.id } });
    }
  };

  // ---- Adopting suggestions ------------------------------------------------------------------
  const doAdopt = async (a: Adopt) => {
    if (resultJob === null) return;
    setBusy('adopt');
    try {
      let change: { description?: string; cover?: { asset_id: string } };
      if (a.kind === 'cover') {
        const asset2 = await grabCover(a.time);
        if (asset2 === null) return;
        change = { cover: { asset_id: asset2.id } };
      } else {
        change = { description: a.text };
      }
      const res = await session.acceptSuggestion(resultJob.id, change);
      if (res.result === 'accepted' && res.previousRevision !== null) {
        setAdopt(null);
        setUndo({ label: t('videoWork.adopted'), revision: res.previousRevision });
      } else {
        setAdopt(null);
        setNotice(t('videoWork.adoptBlocked'));
      }
    } catch (err) {
      setNotice(codeText(err instanceof ApiError ? err.code : null));
    } finally {
      setBusy(null);
    }
  };

  // ---- Toast -----------------------------------------------------------------------------------
  const toastText = undo?.label ?? notice ?? insertState.notice;
  useToast(
    !active || toastText === null
      ? null
      : {
          message: toastText,
          tone: undo !== null ? 'ok' : 'bad',
          actions:
            undo === null
              ? []
              : [
                  {
                    label: t('imagePost.undo'),
                    onClick: () => {
                      const rid = undo.revision;
                      setUndo(null);
                      void session.restore(rid);
                    },
                  },
                ],
          onClose: () => {
            setUndo(null);
            setNotice(null);
            insert?.dismissNotice();
          },
        },
  );

  // ---- Derived ---------------------------------------------------------------------------------
  const rev = numbers.get(state.baseRevision);
  const orientation = orientationOf(asset?.width ?? null, asset?.height ?? null);
  const moments = result?.key_moments ?? [];
  const onPlayerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = player.current;
    if (el === null) return;
    e.preventDefault();
    seek(
      seekBy(
        el.currentTime,
        e.key === 'ArrowLeft' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS,
        el.duration,
      ),
    );
  };

  return (
    <>
      <main
        className="page editor vw"
        aria-label={t('videoWork.pageLabel')}
        inert={state.status === 'conflict'}
      >
        <header className="editor__bar">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t('editor.backToLibrary')}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
          <span className="post__kind">
            <Icon name="video" size={14} />
            {t('format.typeVideo')}
          </span>
          <span className="save-status" role="status" aria-live="polite">
            <SaveChip
              status={state.status}
              readOnly={readOnly}
              onAct={() => {
                void session.save();
              }}
            />
          </span>
          {rev !== undefined && <Chip>r{rev}</Chip>}
        </header>

        <div className="editor__meta">
          <label className="meta-field">
            <span className="faint">{t('editor.statusLabel')}</span>
            <select
              className="select"
              value={draft.status}
              disabled={readOnly}
              onChange={(e) => {
                session.edit({ status: e.target.value as WorkStatus });
              }}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {WORK_STATUS[s].label}
                </option>
              ))}
            </select>
          </label>
          <TagEditor
            tags={draft.tags}
            disabled={readOnly}
            onChange={(tags) => {
              session.edit({ tags });
            }}
          />
          <ProjectTags
            client={client}
            workId={work.id}
            title={draft.title}
            initial={work.project_ids}
          />
          <span className="vw__chips">
            {videoTagCounts(draft.tags).map((c) => (
              <CountChip key={c.platform} count={c} onOpen={openPreview} />
            ))}
          </span>
        </div>

        {/* QC-097: an agent working on this work right now. */}
        <LiveBanner
          client={client}
          workId={work.id}
          typing={session.hasUnsavedChanges()}
          onSeeChanges={() => {
            side.show('history');
          }}
          onOpenActivity={() => {
            onOpenAgentActivity?.();
          }}
        />

        {state.status === 'error' && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text">{saveErrorText(state.error)}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void session.save();
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        )}
        {state.remote !== null && (
          <div className="banner banner--warn" role="alert">
            <Icon name="alert" />
            <span className="banner__text">{t('imagePost.remoteChanged')}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                session.reloadFromServer().catch(() => undefined);
              }}
            >
              {t('editor.discardReload')}
            </button>
          </div>
        )}

        <div className="editor__body">
          <div
            ref={scrollRef}
            className="post__doc"
            onScroll={(e) => {
              if (active) scrollTop.current = e.currentTarget.scrollTop;
            }}
          >
            {/* ---- Video and player ---- */}
            <section className="post__section" aria-label={t('videoWork.videoLabel')}>
              <div className="post__head">
                <h2 className="post__h">{t('videoWork.video')}</h2>
                {asset !== null && (
                  <span className="vw__facts">
                    {asset.duration !== null && <span>{formatDuration(asset.duration)}</span>}
                    {orientation !== null && <span>{t(`videoWork.${orientation}`)}</span>}
                    <span>{formatBytes(asset.bytes)}</span>
                  </span>
                )}
                {videoId !== null && !external && (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={readOnly || uploading !== null}
                    onClick={() => {
                      side.show('assets');
                    }}
                  >
                    {t('videoWork.replaceVideo')}
                  </button>
                )}
              </div>
              {uploading !== null ? (
                <div
                  className="vw__empty"
                  role="status"
                  aria-label={t('videoWork.uploading', { name: uploading.name })}
                >
                  <Icon name="upload" size={26} />
                  <span className="state-card__title">
                    {t('videoWork.uploading', { name: uploading.name })}
                  </span>
                  <span className="bar">
                    <span style={progressStyle(uploading.progress ?? 0)} />
                  </span>
                  <span className="faint">
                    {uploading.progress === null ? '' : `${String(uploading.progress)}%`} ·{' '}
                    {t('videoWork.lockedUploading')}
                  </span>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => {
                      insert?.remove(uploading.key);
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              ) : videoId === null ? (
                <div className="vw__empty">
                  <Icon name="video" size={28} />
                  <span className="state-card__title">{t('videoWork.noVideo')}</span>
                  <span className="faint">{t('videoWork.noVideoHint')}</span>
                  {uploadFailed !== null && (
                    <p className="aiw__err" role="alert">
                      {t('editor.uploadFailedWhy', {
                        error: uploadFailed.error ?? t('editor.uploadFailed'),
                      })}
                    </p>
                  )}
                  <span className="vw__row">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={readOnly || external}
                      onClick={() => {
                        side.show('assets');
                      }}
                    >
                      <Icon name="assets" size={14} />
                      {t('videoWork.pickFromLibrary')}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={readOnly || external}
                      onClick={() => {
                        videoInput.current?.click();
                      }}
                    >
                      <Icon name="upload" size={14} />
                      {t('videoWork.uploadVideo')}
                    </button>
                  </span>
                </div>
              ) : (
                <div
                  className="vw__player"
                  tabIndex={0}
                  onKeyDown={onPlayerKey}
                  aria-keyshortcuts="ArrowLeft ArrowRight"
                >
                  <video
                    ref={player}
                    key={src ?? ''}
                    className={
                      orientation === 'portrait' ? 'vw__video vw__video--portrait' : 'vw__video'
                    }
                    src={src ?? undefined}
                    crossOrigin="anonymous"
                    controls
                    preload="metadata"
                    aria-label={t('videoWork.player')}
                    onLoadedMetadata={(e) => {
                      setDuration(e.currentTarget.duration);
                    }}
                    onTimeUpdate={(e) => {
                      setTime(e.currentTarget.currentTime);
                    }}
                  />
                  <div className="vw__scrub" aria-label={t('videoWork.timeline')}>
                    <span className="vw__scrub-bar" />
                    <span
                      className="vw__scrub-head"
                      style={{ left: `${String(scrubPercent(time, duration))}%` }}
                    />
                    {moments
                      .filter((m) => m.within_duration !== false)
                      .map((m) => (
                        <button
                          key={`${String(m.time_seconds)}-${m.label}`}
                          type="button"
                          className="vw__mark"
                          style={{ left: `${String(scrubPercent(m.time_seconds, duration))}%` }}
                          title={`${timeLabel(m.time_seconds)} ${m.label}`}
                          aria-label={t('videoWork.jumpTo', {
                            time: timeLabel(m.time_seconds),
                            label: m.label,
                          })}
                          onClick={() => {
                            seek(m.time_seconds);
                          }}
                        />
                      ))}
                  </div>
                  <span className="post__hint">{t('videoWork.playerHint')}</span>
                </div>
              )}
            </section>

            {/* ---- Cover ---- */}
            <section className="post__section" aria-label={t('videoWork.cover')}>
              <div className="post__head">
                <h2 className="post__h">{t('videoWork.cover')}</h2>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={coverLocked !== null || videoId === null || busy !== null}
                  onClick={() => {
                    void setCoverFrom(null);
                  }}
                >
                  <Icon name="image" size={14} />
                  {t('videoWork.useCurrentFrame')}
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={coverLocked !== null || busy !== null}
                  onClick={() => {
                    coverInput.current?.click();
                  }}
                >
                  <Icon name="upload" size={14} />
                  {t('imagePost.coverUpload')}
                </button>
              </div>
              {coverLocked !== null && <p className="post__note">{coverLocked}</p>}
              {videoId !== null && uploading === null && (
                <div className="vw__strip" role="group" aria-label={t('videoWork.frameStrip')}>
                  {times.map((at) => (
                    <button
                      key={at}
                      type="button"
                      className="vw__frame"
                      disabled={coverLocked !== null || busy !== null}
                      aria-label={t('videoWork.frameAt', { time: timeLabel(at) })}
                      onClick={() => {
                        seek(at);
                        void setCoverFrom(at);
                      }}
                    >
                      {strip[at] !== undefined && <img src={strip[at]} alt="" />}
                      <span>{timeLabel(at)}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="vw__crops" aria-label={t('imagePost.cropPreview')}>
                {VIDEO_PLATFORMS.map((p) => (
                  <figure key={p} className="post__crop">
                    <span
                      className="post__crop-box vw__crop-box"
                      style={{ aspectRatio: COVER_CROPS[p] }}
                    >
                      {coverAsset !== null ? (
                        <img src={thumbnailUrl(coverAsset)} alt="" />
                      ) : (
                        <span className="vw__crop-empty">{t('videoWork.noCover')}</span>
                      )}
                    </span>
                    <figcaption>
                      {shortPlatform(p)} {COVER_CROPS[p].replace(' / ', ':')}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>

            {/* ---- Copy: the shared one only; each platform's version is in 預覽 (QC-076) ---- */}
            <section className="post__section" aria-label={t('videoWork.copy')}>
              <div className="post__head">
                <h2 className="post__h">
                  {t('videoWork.copy')}
                  <span className="vw__own">{t('videoWork.shared')}</span>
                </h2>
              </div>
              <label className="post__label" htmlFor={`vw-title-${work.id}`}>
                {t('editor.titleLabel')}
              </label>
              <input
                id={`vw-title-${work.id}`}
                className="input post__title"
                readOnly={readOnly}
                value={draft.title}
                onChange={(e) => {
                  session.edit({ title: e.target.value });
                }}
                onCompositionStart={() => {
                  session.setComposing(true);
                }}
                onCompositionEnd={() => {
                  session.setComposing(false);
                }}
              />
              <div className="post__chips">
                {videoTitleCounts(draft.title).map((c) => (
                  <CountChip key={c.platform} count={c} onOpen={openPreview} />
                ))}
              </div>
              <label className="post__label" htmlFor={`vw-desc-${work.id}`}>
                {t('videoWork.description')}
              </label>
              <textarea
                id={`vw-desc-${work.id}`}
                className="input post__desc"
                readOnly={readOnly}
                value={draft.markdown}
                placeholder={t('videoWork.descriptionPlaceholder')}
                onChange={(e) => {
                  session.edit({ markdown: e.target.value });
                }}
                onCompositionStart={() => {
                  session.setComposing(true);
                }}
                onCompositionEnd={() => {
                  session.setComposing(false);
                }}
              />
              <div className="post__chips">
                {videoBodyCounts(draft.markdown).map((c) => (
                  <CountChip key={c.platform} count={c} onOpen={openPreview} />
                ))}
              </div>
            </section>
          </div>
        </div>

        <input
          ref={videoInput}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])].filter((f) => f.type.startsWith('video/'));
            e.target.value = '';
            if (files.length > 0) void insert?.insertFiles(files.slice(0, 1), 'end');
          }}
        />
        <input
          ref={coverInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file === undefined || bridge === null) return;
            setBusy('cover');
            uploadFile(bridge, file)
              .then((a) => {
                session.edit({ cover: { asset_id: a.id } });
              })
              .catch((err: unknown) => {
                setNotice(err instanceof Error ? err.message : t('editor.uploadFailed'));
              })
              .finally(() => {
                setBusy(null);
              });
          }}
        />
      </main>
      <EditorSide
        workId={work.id}
        active={active}
        badges={{ proposals: pendingProposals }}
        panels={{
          preview: (
            <PreviewPanel
              client={client}
              work={work}
              platforms={VIDEO_PLATFORMS}
              open={previewAsk}
              workCoverAssetId={coverAsset}
              source={{
                title: draft.title,
                text: draft.markdown,
                format: 'text',
                tags: draft.tags,
              }}
              extraTitles={result?.title_suggestions ?? []}
              onOverLimit={onOverLimit}
              onNotice={setNotice}
            />
          ),
          ai: (
            <aside className="panel vw__side" aria-label={t('videoWork.understanding')}>
              <Understanding
                s={vs}
                video={video}
                asset={asset}
                block={block}
                hasVideo={videoId !== null}
                readOnly={readOnly}
                onSeek={seek}
                onAdopt={setAdopt}
                onOpenSettings={onOpenSettings}
              />
            </aside>
          ),
          ...(pendingProposals > 0
            ? {
                proposals: (
                  <ProposalsSideTab
                    client={client}
                    workId={work.id}
                    text={draft.markdown}
                    prepare={async () => {
                      await session.save();
                      const now = session.snapshot;
                      return session.hasUnsavedChanges() || now.status === 'conflict'
                        ? null
                        : now.baseRevision;
                    }}
                    onHighlight={ignoreHighlight}
                    onNotice={setNotice}
                  />
                ),
              }
            : {}),
          history: (
            <HistoryPanel
              client={client}
              workId={work.id}
              revisions={revisions}
              numbers={numbers}
              currentRevision={state.baseRevision}
              currentMarkdown={state.file}
              currentTitle={state.saved.title}
              readOnly={readOnly}
              onRestore={(rid) => session.restore(rid)}
            />
          ),
          assets: (
            <AssetDrawer
              client={client}
              workId={work.id}
              forPost
              kind="video"
              disabledReason={external ? t('videoWork.externalLocked') : null}
              onInsert={(a) => {
                session.edit({ video: a.id });
                side.show('ai');
              }}
              onDragAsset={() => undefined}
            />
          ),
        }}
      />

      {vs?.phase === 'confirm' && video !== null && (
        <ConfirmDialog s={vs} session={video} requireAck />
      )}
      {vs?.phase === 'reuse' && video !== null && <ReuseDialog s={vs} session={video} />}

      {adopt !== null && (
        <AdoptDialog
          adopt={adopt}
          current={{ title: draft.title, description: draft.markdown, cover: coverAsset }}
          grabber={grabber}
          busy={busy === 'adopt'}
          onCancel={() => {
            setAdopt(null);
          }}
          onAdopt={() => {
            void doAdopt(adopt);
          }}
        />
      )}

      {state.status === 'conflict' && (
        <Dialog
          title={t('imagePost.conflictTitle')}
          closable={false}
          onClose={() => undefined}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void session.keepBoth().catch(() => undefined);
                }}
              >
                {t('imagePost.keepMineAsCopy')}
              </button>
              <button
                type="button"
                className="btn btn--primary dialog__primary"
                data-autofocus
                onClick={() => {
                  session.reloadFromServer().catch(() => undefined);
                }}
              >
                {t('editor.discardReload')}
              </button>
            </>
          }
        >
          <p>{t('imagePost.conflictBody')}</p>
        </Dialog>
      )}
    </>
  );
}

/**
 * One platform's count: an indicator (QC-076 entry audit); a click opens that
 * platform in the 預覽 split, where its own version is edited.
 */
function CountChip({ count, onOpen }: { count: CopyCount; onOpen: (platform: Platform) => void }) {
  const text =
    count.limit === null
      ? t('imagePost.countNoLimit', {
          platform: shortPlatform(count.platform),
          count: count.actual,
        })
      : t('imagePost.countOfLimit', {
          platform: shortPlatform(count.platform),
          count: count.actual,
          limit: count.limit,
        });
  return (
    <button
      type="button"
      className={count.over ? 'chip chip--warn chip--button' : 'chip chip--button'}
      title={t('library.openInPreview', { platform: shortPlatform(count.platform) })}
      onClick={() => {
        onOpen(count.platform);
      }}
    >
      {text}
    </button>
  );
}

/** The Gemini side panel: notice and cost first, progress, then results and suggestions. */
function Understanding({
  s,
  video,
  asset,
  block,
  hasVideo,
  readOnly,
  onSeek,
  onAdopt,
  onOpenSettings,
}: {
  s: VideoState | null;
  video: VideoSession | null;
  asset: AssetRecord | null;
  block: ReturnType<typeof analyzeBlock>;
  hasVideo: boolean;
  readOnly: boolean;
  onSeek: (at: number) => void;
  onAdopt: (a: Adopt) => void;
  onOpenSettings?: () => void;
}) {
  if (block === 'uploading') {
    return (
      <p className="vw__ai-note" role="status">
        <Icon name="upload" size={14} />
        {t('videoWork.lockedUploading')}
      </p>
    );
  }
  if (!hasVideo) {
    return <p className="vw__ai-note">{t('videoWork.aiNeedsVideo')}</p>;
  }
  if (block === 'too_large' && asset !== null) {
    return (
      <div className="vw__ai-block" role="alert">
        <Icon name="alert" size={16} />
        <span>{t('videoWork.tooLarge', { size: formatBytes(asset.bytes) })}</span>
      </div>
    );
  }
  if (block === 'too_long') {
    return (
      <div className="vw__ai-block" role="alert">
        <Icon name="alert" size={16} />
        <span>{t('videoWork.tooLong')}</span>
      </div>
    );
  }
  if (s === null || video === null) return null;
  if (s.noKey) {
    return (
      <div className="vw__ai-block">
        <span>{t('videoWork.noGeminiKey')}</span>
        <button type="button" className="btn btn--small" onClick={onOpenSettings}>
          {t('videoWork.goToSettings')}
        </button>
      </div>
    );
  }
  const est = s.estimate;
  const running = s.phase === 'running';
  const pct = uploadPercent(s.job);
  return (
    <div className="vw__ai">
      <p className="vw__ai-intro">
        {t('videoWork.aiIntro', { company: s.gemini?.company ?? 'Google' })}
      </p>
      {isLongVideo(asset) && (
        <p className="vw__ai-note" role="status">
          <Icon name="info" size={14} />
          {t('videoWork.longVideo')}
        </p>
      )}
      {s.estimateError !== null && (
        <p className="aiw__err" role="alert">
          {s.estimateError}
        </p>
      )}
      {!running && s.result === null && s.phase !== 'failed' && (
        <div className="vw__ai-start">
          {est !== null && (
            <span className="faint">
              {t('videoWork.estimateLine', {
                duration: formatDuration(est.duration_seconds),
                cost: formatUsd(est.estimate.max_cost_usd),
              })}
            </span>
          )}
          <button
            type="button"
            className="btn btn--primary"
            disabled={est === null || readOnly}
            onClick={() => {
              video.analyze();
            }}
          >
            <Icon name="spark" size={14} />
            {t('videoWork.analyze')}
          </button>
        </div>
      )}
      {running && (
        <div className="vw__ai-run" role="status">
          <span>
            {s.job?.progress?.phase !== undefined && s.job.progress.phase in PHASE_LABEL
              ? PHASE_LABEL[s.job.progress.phase as keyof typeof PHASE_LABEL]
              : t('videoWork.analyzing')}
            {pct !== null && ` · ${String(pct)}%`}
          </span>
          <span className={pct === null ? 'bar bar--indeterminate' : 'bar'}>
            <span style={progressStyle(pct)} />
          </span>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              void video.cancel();
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
      {s.phase === 'failed' && s.failure !== null && (
        <div className="vw__ai-block" role="alert">
          <Icon name="alert" size={16} />
          <span>{s.failure.message}</span>
          <TechnicalDetails text={s.failure.detail} />
          <span className="vw__row">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                if (s.job !== null) void video.retry();
                else video.analyze();
              }}
            >
              {t('common.retry')}
            </button>
            {s.previous !== null && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  video.showPrevious();
                }}
              >
                {t('videoWork.showPrevious')}
              </button>
            )}
          </span>
        </div>
      )}
      {s.result !== null && (
        <Results
          result={s.result}
          readOnly={readOnly}
          onSeek={onSeek}
          onAdopt={onAdopt}
          onReanalyze={() => {
            video.analyze();
          }}
        />
      )}
    </div>
  );
}

function Results({
  result,
  readOnly,
  onSeek,
  onAdopt,
  onReanalyze,
}: {
  result: VideoUnderstandingResult;
  readOnly: boolean;
  onSeek: (at: number) => void;
  onAdopt: (a: Adopt) => void;
  onReanalyze: () => void;
}) {
  const descs = [
    ...new Set(result.description_suggestions.map((x) => x.trim()).filter((x) => x !== '')),
  ];
  return (
    <div className="vw__results">
      <section className="vw__res">
        <h3 className="vw__res-h">{t('videoWork.summary')}</h3>
        <p>{result.summary}</p>
      </section>
      <section className="vw__res">
        <h3 className="vw__res-h">{t('videoWork.keyMoments')}</h3>
        <ul className="vw__moments">
          {[...result.key_moments]
            .sort((a, b) => a.time_seconds - b.time_seconds)
            .map((m) => (
              <li key={`${String(m.time_seconds)}-${m.label}`}>
                <button
                  type="button"
                  className="vw__moment"
                  disabled={m.within_duration === false}
                  onClick={() => {
                    onSeek(m.time_seconds);
                  }}
                >
                  <span className="mono">{timeLabel(m.time_seconds)}</span>
                  <span className="vw__moment-label">{m.label}</span>
                </button>
                <Chip tone="warn">{t('videoWork.toVerify')}</Chip>
                {m.within_duration === false && <Chip tone="bad">{t('videoWork.beyondEnd')}</Chip>}
                <span className="vw__moment-desc">{m.description}</span>
              </li>
            ))}
        </ul>
      </section>
      <section className="vw__res">
        <h3 className="vw__res-h">{t('videoWork.descriptionSuggestions')}</h3>
        {descs.map((x) => (
          <Suggestion
            key={x}
            text={x}
            disabled={readOnly}
            onAdopt={() => {
              onAdopt({ kind: 'description', text: x });
            }}
          />
        ))}
      </section>
      <section className="vw__res">
        <h3 className="vw__res-h">{t('videoWork.coverSuggestions')}</h3>
        {result.cover_suggestions.map((c) => (
          <div key={c.time_seconds} className="vw__sugg">
            <button
              type="button"
              className="vw__moment"
              disabled={c.within_duration === false}
              onClick={() => {
                onSeek(c.time_seconds);
              }}
            >
              <span className="mono">{timeLabel(c.time_seconds)}</span>
              <span className="vw__moment-label">{c.description || c.label}</span>
            </button>
            <Chip tone="warn">{t('videoWork.toVerify')}</Chip>
            <button
              type="button"
              className="btn btn--small"
              disabled={readOnly || c.within_duration === false}
              onClick={() => {
                onAdopt({ kind: 'cover', time: c.time_seconds });
              }}
            >
              {t('videoWork.review')}
            </button>
          </div>
        ))}
      </section>
      {/* Our own words (QC-043): the service's `disclaimer` is not interface text. */}
      <p className="post__hint">{t('videoWork.disclaimer')}</p>
      <button type="button" className="btn btn--ghost btn--small" onClick={onReanalyze}>
        {t('videoWork.reanalyze')}
      </button>
    </div>
  );
}

function Suggestion({
  text,
  disabled,
  onAdopt,
}: {
  text: string;
  disabled: boolean;
  onAdopt: () => void;
}) {
  return (
    <div className="vw__sugg">
      <span className="vw__sugg-text">{text}</span>
      <button type="button" className="btn btn--small" disabled={disabled} onClick={onAdopt}>
        {t('videoWork.review')}
      </button>
    </div>
  );
}

/** 採用 only after seeing what changes (the AI never overwrites by itself). */
function AdoptDialog({
  adopt,
  current,
  grabber,
  busy,
  onCancel,
  onAdopt,
}: {
  adopt: Adopt;
  current: { title: string; description: string; cover: string | null };
  grabber: FrameGrabber | null;
  busy: boolean;
  onCancel: () => void;
  onAdopt: () => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (adopt.kind !== 'cover' || grabber === null) return;
    let live = true;
    grabber
      .thumbnail(adopt.time, 320)
      .then((url) => {
        if (live) setFrame(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [adopt, grabber]);
  const before = adopt.kind === 'description' ? current.description : '';
  const segments = adopt.kind === 'cover' ? [] : diffSentences(before, adopt.text);
  return (
    <Dialog
      title={t(
        adopt.kind === 'description' ? 'videoWork.adoptDescription' : 'videoWork.adoptCover',
      )}
      width={560}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn dialog__primary" data-autofocus onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={onAdopt}>
            {t('videoWork.adopt')}
          </button>
        </>
      }
    >
      <p className="post__hint">{t('videoWork.adoptHint')}</p>
      {adopt.kind === 'cover' ? (
        <div className="vw__adopt-covers">
          <figure className="post__crop">
            <span
              className="post__crop-box vw__crop-box"
              style={{ aspectRatio: COVER_CROPS.douyin }}
            >
              {current.cover !== null ? (
                <img src={thumbnailUrl(current.cover)} alt="" />
              ) : (
                <span className="vw__crop-empty">{t('videoWork.noCover')}</span>
              )}
            </span>
            <figcaption>{t('videoWork.before')}</figcaption>
          </figure>
          <Icon name="send" size={18} />
          <figure className="post__crop">
            <span
              className="post__crop-box vw__crop-box"
              style={{ aspectRatio: COVER_CROPS.douyin }}
            >
              {frame !== null && <img src={frame} alt="" />}
            </span>
            <figcaption>
              {t('videoWork.after')} · {timeLabel(adopt.time)}
            </figcaption>
          </figure>
        </div>
      ) : (
        <p className="vw__diff" aria-label={t('videoWork.changes')}>
          {segments.map((seg, i) =>
            seg.kind === 'same' ? (
              <span key={i}>{seg.text}</span>
            ) : (
              <span key={i}>
                {seg.before !== '' && <span className="del">{seg.before}</span>}
                {seg.after !== '' && <span className="ins">{seg.after}</span>}
              </span>
            ),
          )}
        </p>
      )}
    </Dialog>
  );
}

/** The description is plain text: proposals are not highlighted in it. */
function ignoreHighlight(): void {
  // nothing to frame
}
