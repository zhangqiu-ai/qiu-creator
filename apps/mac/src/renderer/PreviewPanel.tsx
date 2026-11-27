import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  charCount,
  PLATFORM_LIMITS,
  type AiModelChoice,
  type Platform,
  type VariantCover,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { formatShortDate } from '@qiu-creator/i18n';
import { getTemplate, PLATFORM_SHORT_KEY, PLATFORMS } from '@qiu-creator/platform-preview';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { thumbnailUrl } from '../shared/bridge.js';
import { AiProviders, AI_BLOCK_LABEL, FAILURE_LABEL } from './ai-session.js';
import { chooseModel, useCostConfirm } from './AiImageTab.js';
import { CandidateTags } from './AiChoices.js';
import { currentModel, useAiLibrary } from './ai-library.js';
import { useChangeEvents } from './events.js';
import { t, useLocale } from './i18n.js';
import { Icon } from './Icon.js';
import { AnimatedItem, Presence } from './motion.js';
import { CoverGenSession, coverPromptFrom, ratioStyle } from './preview-cover.js';
import { PreviewTitleSession, titleLimitOf } from './preview-titles.js';
import { addTags } from './TagEditor.js';
import { TechnicalDetails } from './TechnicalDetails.js';
import { cutSourceOffset, liveBody, type LiveBody } from './preview/derive.js';
import {
  isOwn,
  OverrideSession,
  type OverrideField,
  type OverrideState,
} from './preview/override-session.js';
import type { PhoneActions, PhoneModel, Screen } from './preview/phone-model.js';
import {
  blockAt,
  loadPreviewPrefs,
  savePreviewPrefs,
  type PreviewPrefs,
} from './preview/preview-prefs.js';
import { PreviewStage } from './preview/PreviewStage.js';
import type { PrefStorage } from './sidebar-prefs.js';
import './preview.css';

function shortName(platform: Platform): string {
  return t(PLATFORM_SHORT_KEY[platform]);
}

/** What the platforms derive from: the live, unsaved editor draft. */
export interface PreviewSource {
  title: string;
  /** Article Markdown, or the description of image and video works. */
  text: string;
  format: 'markdown' | 'text';
  tags: readonly string[];
}

export interface PreviewPanelProps {
  client: CreatorHubClient;
  work: WorkDetail;
  /** The live draft the bodies follow (QC-084). */
  source: PreviewSource;
  /** Which platforms this work previews; the four by default. */
  platforms?: readonly Platform[];
  /** Bring one platform forward (a count chip in the editor was clicked); `n` makes each ask new. */
  open?: { platform: Platform; n: number };
  /** The work's own cover, shown while a platform follows it (and for video-frame covers). */
  workCoverAssetId?: string | null;
  /** Video works: title suggestions from the understanding result (QC-076). */
  extraTitles?: readonly string[];
  /** The editor caret as a source offset, for 跟隨; null when unknown. */
  caret?: number | null;
  /** 「在原稿編輯」／「在原稿標出第 N 字」: select `start`–`end` of the source in the editor. */
  onEditSource?: (start: number, end: number) => void;
  /** 「用 AI 縮寫」: a shortened source as a candidate with diff in the editor; absent hides it. */
  onShorten?: (limit: number) => void;
  /** Resolves a Markdown image target for the article simulation. */
  resolveImage?: (src: string) => Promise<string>;
  /** Some platform goes over a limit (the orange dot on the sidebar's 預覽, QC-085). */
  onOverLimit?: (over: boolean) => void;
  onNotice: (text: string) => void;
}

function storage(): PrefStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useStore<S>(store: { subscribe: (l: () => void) => () => void; snapshot: S }): S {
  return useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
}

function useSession(session: OverrideSession | undefined): OverrideState | null {
  return useSyncExternalStore(
    useCallback((cb: () => void) => session?.subscribe(cb) ?? (() => undefined), [session]),
    () => session?.snapshot ?? null,
  );
}

/** Image targets of the article resolved to URLs, filled in as they resolve. */
function useResolved(
  text: string,
  format: PreviewSource['format'],
  resolve: PreviewPanelProps['resolveImage'],
): (src: string) => string | null {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (resolve === undefined || format !== 'markdown') return;
    for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
      const src = m[1] ?? '';
      if (src === '' || asked.current.has(src)) continue;
      asked.current.add(src);
      resolve(src)
        .then((url) => {
          setUrls((prev) => new Map(prev).set(src, url));
        })
        .catch(() => undefined);
    }
  }, [text, format, resolve]);
  return useCallback((src: string) => urls.get(src) ?? null, [urls]);
}

function coverUrl(cover: VariantCover | null, workCover: string | null): string | null {
  if (cover === null) return workCover === null ? null : thumbnailUrl(workCover);
  if ('asset_id' in cover) return thumbnailUrl(cover.asset_id);
  return workCover === null ? null : thumbnailUrl(workCover);
}

/** The live body of every platform, deriving once per body format. */
function useBodies(
  source: PreviewSource,
  platforms: readonly Platform[],
  resolveImage: (src: string) => string | null,
): ReadonlyMap<Platform, LiveBody> {
  const text = useDeferredValue(source.text);
  const title = useDeferredValue(source.title);
  return useMemo(() => {
    const out = new Map<Platform, LiveBody>();
    const byFormat = new Map<string, LiveBody>();
    const options = source.format === 'text' ? { sourceFormat: 'text' as const } : { title };
    for (const p of platforms) {
      const fmt = PLATFORM_LIMITS[p].bodyFormat;
      const done = byFormat.get(fmt);
      if (done !== undefined) {
        const limit = PLATFORM_LIMITS[p].bodyMaxChars;
        const length = done.phone.length;
        out.set(p, {
          derived: done.derived,
          phone: {
            ...done.phone,
            limit,
            cutAt: limit !== null && length > limit ? limit : null,
          },
        });
        continue;
      }
      const body = liveBody(text, p, options, resolveImage);
      byFormat.set(fmt, body);
      out.set(p, body);
    }
    return out;
  }, [text, title, source.format, platforms, resolveImage]);
}

/** Does the platform go over a limit with these values? (orange dot on the tab) */
function overLimit(model: PhoneModel): boolean {
  const over = (n: number, l: number | null) => l !== null && n > l;
  return (
    over(model.title.length, model.title.limit) ||
    over(model.body.length, model.body.limit) ||
    over(model.images.value.length, model.images.limit) ||
    over(model.tags.value.length, model.tags.limit)
  );
}

/**
 * The phone model for one platform: its overrides (pending first) on top of
 * what the live draft gives. Following fields show the draft's values at once,
 * before the work is saved.
 */
function phoneModel(
  platform: Platform,
  state: OverrideState,
  source: PreviewSource,
  body: LiveBody,
  work: WorkDetail,
  workCover: string | null,
  locale: ReturnType<typeof useLocale>,
  caret: number | null,
): PhoneModel {
  const { view, pending } = state;
  const limits = PLATFORM_LIMITS[platform];
  const template = getTemplate(platform);
  const own = (f: OverrideField) => isOwn(state, f);
  const title = own('title') ? (pending.title ?? view.title) : source.title;
  const tags = own('tags') ? (pending.tags ?? view.tags) : source.tags;
  const imageIds =
    'images' in pending && pending.images !== null && pending.images !== undefined
      ? pending.images
      : view.images;
  const cover = 'cover' in pending ? (pending.cover ?? null) : view.cover;
  const legacy = view.body_source === 'legacy_override';
  const shownBody = legacy ? liveBody(view.body, platform, { sourceFormat: 'text' }) : body;
  const current =
    caret === null || legacy
      ? null
      : (() => {
          const i = blockAt(
            shownBody.phone.blocks.filter((b) => b.kind !== 'image'),
            caret,
          );
          if (i === null) return null;
          const target = shownBody.phone.blocks.filter((b) => b.kind !== 'image')[i];
          return target === undefined ? null : shownBody.phone.blocks.indexOf(target);
        })();
  return {
    platform,
    author: t('library.previewAuthor'),
    dateLabel: formatShortDate(locale, new Date(view.updated_at ?? work.updated_at)),
    title: {
      value: title,
      own: own('title'),
      length: charCount(title),
      limit: limits.titleMaxChars,
    },
    cover: {
      value: coverUrl(own('cover') ? cover : view.cover, workCover),
      own: own('cover'),
    },
    coverRatio: template.coverAspectRatio,
    coverRatioLabel: template.coverRatioLabel,
    images: {
      value: imageIds.map((id) => ({ id, url: thumbnailUrl(id) })),
      own: own('images'),
      limit: limits.imagesMax,
    },
    tags: { value: tags, own: own('tags'), limit: limits.tagsMax },
    body: shownBody.phone,
    current,
  };
}

/**
 * 平台預覽 (QC-084, PT-20261123-001 v2): a right split in the work editor.
 * Each platform has three screens — 發布編輯 (edit title, cover, image order
 * and tags in place), 刷到時 and 正文 (read-only). The body always follows the
 * editor's live draft; each platform keeps only overrides, which follow the
 * source until changed (「自訂」) and can go back (「改回跟隨原稿」). Nothing
 * here writes the original.
 */
export function PreviewPanel({
  client,
  work,
  source,
  platforms = PLATFORMS,
  open,
  workCoverAssetId = null,
  extraTitles = [],
  caret = null,
  onEditSource,
  onShorten,
  resolveImage,
  onOverLimit,
  onNotice,
}: PreviewPanelProps) {
  const locale = useLocale();
  const list = useMemo(() => [...platforms], [platforms]);
  const [platform, setPlatform] = useState<Platform>(list[0] ?? 'xiaohongshu');
  const [prefs, setPrefsState] = useState<PreviewPrefs>(() => loadPreviewPrefs(storage()));
  const setPrefs = useCallback((change: Partial<PreviewPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...change };
      savePreviewPrefs(storage(), next);
      return next;
    });
  }, []);
  const [failed, setFailed] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyMap<Platform, OverrideSession> | null>(null);
  const [focus, setFocus] = useState<{ field: 'title' | 'cover' | 'tags'; n: number } | null>(null);
  const [sheet, setSheet] = useState<'title' | 'cover' | null>(null);
  const [undo, setUndo] = useState<{
    platform: Platform;
    field: OverrideField;
    value: unknown;
  } | null>(null);
  const [followTick, setFollowTick] = useState(0);

  useEffect(() => {
    if (open === undefined || !list.includes(open.platform)) return;
    setPlatform(open.platform);
  }, [open, list]);

  useEffect(() => {
    let alive = true;
    let made: Map<Platform, OverrideSession> | null = null;
    client.variants
      .list(work.id)
      .then((r) => {
        if (!alive) return;
        made = new Map();
        for (const v of r.items) {
          if (list.includes(v.platform))
            made.set(v.platform, new OverrideSession(client, work.id, v));
        }
        setSessions(made);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (made !== null) for (const s of made.values()) s.close();
    };
  }, [client, work.id, list]);

  // AI 標題 and AI 封面 live as long as the split is open.
  const [ai, setAi] = useState<{ titles: PreviewTitleSession; covers: CoverGenSession } | null>(
    null,
  );
  useEffect(() => {
    const providers = new AiProviders(client);
    const titles = new PreviewTitleSession(client, work.id, providers);
    const covers = new CoverGenSession(client, work.id, providers);
    setAi({ titles, covers });
    void covers.load();
    return () => {
      void covers.discardAll();
      titles.dispose();
      covers.dispose();
    };
  }, [client, work.id]);

  const refreshAll = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChangeEvents((event) => {
    if (event.entity === 'job' && event.action.startsWith('ai_job.')) {
      void ai?.titles.jobChanged(event.entity_id);
      void ai?.covers.jobChanged(event.entity_id);
      return;
    }
    if (event.entity !== 'work' || event.entity_id !== work.id || sessions === null) return;
    if (event.action === 'work.variant_changed') {
      const p = list.find((x) => x === event.data['platform']);
      const rev = event.data['revision'];
      if (p !== undefined) void sessions.get(p)?.refresh(typeof rev === 'number' ? rev : undefined);
      return;
    }
    if (event.action === 'work.updated' || event.action === 'work.assets_changed') {
      // The work gives new images or cover: refresh the views (debounced while typing).
      if (refreshAll.current !== null) clearTimeout(refreshAll.current);
      refreshAll.current = setTimeout(() => {
        for (const s of sessions.values()) void s.refresh();
      }, 400);
    }
  });
  useEffect(
    () => () => {
      if (refreshAll.current !== null) clearTimeout(refreshAll.current);
    },
    [],
  );

  const resolved = useResolved(source.text, source.format, resolveImage);
  const bodies = useBodies(source, list, resolved);
  const session = sessions?.get(platform);
  const state = useSession(session);
  const states = useSessions(sessions);

  const models = useMemo(() => {
    const out = new Map<Platform, PhoneModel>();
    for (const p of list) {
      const s = states.get(p);
      const b = bodies.get(p);
      if (s === undefined || b === undefined) continue;
      out.set(
        p,
        phoneModel(p, s, source, b, work, workCoverAssetId, locale, p === platform ? caret : null),
      );
    }
    return out;
  }, [list, states, bodies, source, work, workCoverAssetId, locale, platform, caret]);
  const model = models.get(platform) ?? null;

  // Follow: when the caret's block changes, the body screen scrolls to it.
  const lastBlock = useRef<number | null>(null);
  useEffect(() => {
    if (!prefs.follow || model === null) return;
    if (model.current === lastBlock.current) return;
    lastBlock.current = model.current;
    if (model.current !== null) setFollowTick((n) => n + 1);
  }, [model, prefs.follow]);

  const body = bodies.get(platform);

  const { state: choices } = useAiLibrary();
  const titleModel = useRef<AiModelChoice | null>(null);
  titleModel.current = currentModel(choices, 'suggestions');

  const actions = useMemo((): PhoneActions | null => {
    if (session === undefined || model === null) return null;
    const editSource = (start: number, end = start) => {
      onEditSource?.(start, end);
    };
    return {
      editTitle: (text) => {
        session.edit({ title: text }, false);
      },
      follow: (field) => {
        session.edit({ [field]: null });
      },
      reorderImages: (ids) => {
        session.edit({ images: [...ids] });
      },
      removeTag: (tag) => {
        session.edit({ tags: model.tags.value.filter((x) => x !== tag) });
      },
      addTags: (text) => {
        session.edit({ tags: addTags(model.tags.value, text) });
      },
      openTitleAi: () => {
        setSheet('title');
        void ai?.titles.generate(platform, titleModel.current);
      },
      openCover: () => {
        setSheet('cover');
      },
      goEdit: (field) => {
        setPrefs({ screen: 'publish' });
        setFocus((f) => ({ field, n: (f?.n ?? 0) + 1 }));
      },
      editSource: (offset) => {
        editSource(offset);
      },
      markCut: () => {
        if (body === undefined) return;
        const at = cutSourceOffset(body);
        if (at !== null) editSource(at, at);
      },
      shorten: () => {
        if (model.body.limit !== null) onShorten?.(model.body.limit);
      },
      composing: (on) => {
        session.setComposing(on);
      },
    };
  }, [session, model, platform, ai, body, onEditSource, onShorten, setPrefs]);

  /** Apply an AI result as this platform's override, offering 復原. */
  const applyAi = (field: 'title' | 'cover', value: string | VariantCover) => {
    if (session === undefined || state === null) return;
    const before =
      field in state.pending
        ? state.pending[field]
        : field === 'title'
          ? state.view.title_source === 'override'
            ? state.view.title
            : null
          : state.view.cover_source === 'override'
            ? state.view.cover
            : null;
    setUndo({ platform, field, value: before ?? null });
    session.edit({ [field]: value });
  };

  const anyOver = [...models.values()].some(overLimit);
  useEffect(() => {
    onOverLimit?.(anyOver);
  }, [anyOver, onOverLimit]);

  const conflictSheet =
    state?.conflict != null && session !== undefined ? (
      <ConflictSheet platform={platform} state={state} session={session} />
    ) : null;

  return (
    <aside className="panel pv-split" aria-label={t('library.preview')} id="preview-panel">
      <div className="pv-split__head">
        <div
          className="pv-tabs"
          role="tablist"
          aria-label={t('library.platform')}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const i = list.indexOf(platform);
            const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
            if (next === undefined) return;
            setPlatform(next);
            setSheet(null);
            requestAnimationFrame(() => {
              document.getElementById(`pv-tab-${work.id}-${next}`)?.focus();
            });
          }}
        >
          {list.map((p) => {
            const m = models.get(p);
            const warn = m !== undefined && overLimit(m);
            const bad = states.get(p)?.status === 'conflict';
            return (
              <button
                key={p}
                type="button"
                role="tab"
                id={`pv-tab-${work.id}-${p}`}
                className="pv-tab"
                aria-selected={platform === p}
                tabIndex={platform === p ? 0 : -1}
                title={`${shortName(p)}${warn ? ` · ${t('library.overLimit')}` : ''}`}
                onClick={() => {
                  setPlatform(p);
                  setSheet(null);
                }}
              >
                {shortName(p)}
                {warn && (
                  <span className="pv-tab__warn" aria-label={t('library.overLimit')} role="img" />
                )}
                {bad && (
                  <span
                    className="pv-tab__bad"
                    aria-label={t('library.versionConflict')}
                    role="img"
                  />
                )}
              </button>
            );
          })}
        </div>
        <div className="pv-split__tools">
          <button
            type="button"
            className="pv-follow"
            aria-pressed={prefs.follow}
            title={t('previewPanel.followHint')}
            onClick={() => {
              setPrefs({ follow: !prefs.follow });
            }}
          >
            <Icon name="follow" size={14} />
            {t('previewPanel.follow')}
          </button>
        </div>
      </div>
      {failed ? (
        <div className="pv-split__body">
          <div className="state-card" role="alert">
            <Icon name="offline" size={28} />
            <span className="state-card__title">{t('library.previewLoadFailed')}</span>
          </div>
        </div>
      ) : model === null ||
        actions === null ||
        state === null ||
        ai === null ||
        session === undefined ? (
        <div className="pv-split__body" aria-busy="true" />
      ) : (
        <div className="pv-split__body">
          {state.view.body_source === 'legacy_override' && (
            <div className="banner banner--warn pv-legacy" role="status">
              <Icon name="alert" />
              <span className="banner__text">{t('previewPanel.legacyBody')}</span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  void client.variants
                    .patch(work.id, platform, { base_revision: state.view.revision, body: null })
                    .then(() => session.refresh())
                    .catch(() => {
                      onNotice(t('library.actionFailed'));
                    });
                }}
              >
                {t('previewPanel.followSource')}
              </button>
            </div>
          )}
          {state.status === 'error' && (
            <div className="banner banner--bad pv-legacy" role="alert">
              <Icon name="alert" />
              <span className="banner__text">{state.errorMessage ?? t('library.saveFailed')}</span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  session.retry();
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          <PreviewStage
            key={platform}
            model={model}
            actions={actions}
            screen={prefs.screen}
            onScreen={(s: Screen) => {
              setPrefs({ screen: s });
              setSheet(null);
            }}
            zoom={prefs.zoom}
            onZoom={(z) => {
              setPrefs({ zoom: z });
            }}
            focus={focus}
            followTick={followTick}
            follow={prefs.follow}
            sheet={
              conflictSheet ??
              (sheet === 'title' ? (
                <TitleSheet
                  platform={platform}
                  titles={ai.titles}
                  extraTitles={extraTitles}
                  model={titleModel.current}
                  onUse={(text) => {
                    setSheet(null);
                    applyAi('title', text);
                  }}
                  onClose={() => {
                    setSheet(null);
                    ai.titles.clear();
                  }}
                />
              ) : sheet === 'cover' ? (
                <CoverSheet
                  work={work}
                  platform={platform}
                  covers={ai.covers}
                  images={model.images.value}
                  current={model.cover.value}
                  title={model.title.value}
                  body={model.body.text}
                  onSet={(cover) => {
                    setSheet(null);
                    applyAi('cover', cover);
                  }}
                  onClose={() => {
                    setSheet(null);
                  }}
                  onNotice={onNotice}
                />
              ) : null)
            }
          />
          {undo !== null && undo.platform === platform && (
            <div className="pv-undo" role="status">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  session.edit({ [undo.field]: undo.value });
                  setUndo(null);
                }}
              >
                <Icon name="undo" size={14} />
                {t('common.undo')}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--small"
                aria-label={t('common.close')}
                onClick={() => {
                  setUndo(null);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/** Every session's state, re-rendering when any changes (for the tab dots). */
function useSessions(
  sessions: ReadonlyMap<Platform, OverrideSession> | null,
): ReadonlyMap<Platform, OverrideState> {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (sessions === null) return () => undefined;
      const offs = [...sessions.values()].map((s) => s.subscribe(cb));
      return () => {
        for (const off of offs) off();
      };
    },
    [sessions],
  );
  const cache = useRef<{
    key: readonly OverrideState[];
    value: Map<Platform, OverrideState>;
  } | null>(null);
  const get = () => {
    if (sessions === null) return EMPTY;
    const now = [...sessions.values()].map((s) => s.snapshot);
    const prev = cache.current;
    if (prev !== null && prev.key.length === now.length && prev.key.every((s, i) => s === now[i])) {
      return prev.value;
    }
    const value = new Map(now.map((s) => [s.platform, s]));
    cache.current = { key: now, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get);
}
const EMPTY: ReadonlyMap<Platform, OverrideState> = new Map();

/** The split's left edge: drag 400–720, ←／→ in steps, double-click back to 520 (remembered). */
/** A bottom sheet inside the phone, like the real apps (PT v2). */
function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input, textarea')?.focus();
  }, []);
  return (
    <>
      <div className="pv-sheet-bg" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className="pv-sheet"
        role="dialog"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="pv-sheet__grab" aria-hidden="true" />
        {children}
      </div>
    </>
  );
}

/** AI 標題: candidates at this platform's limit; tapping one applies it (復原 is offered). */
function TitleSheet({
  platform,
  titles,
  extraTitles,
  model,
  onUse,
  onClose,
}: {
  platform: Platform;
  titles: PreviewTitleSession;
  extraTitles: readonly string[];
  model: AiModelChoice | null;
  onUse: (text: string) => void;
  onClose: () => void;
}) {
  const s = useStore(titles);
  const mine = s.platform === platform;
  const limit = titleLimitOf(platform);
  const extras = [...new Set(extraTitles.map((x) => x.trim()).filter((x) => x !== ''))];
  const loading = mine && s.phase === 'loading';
  const ready = mine && s.phase === 'ready';
  const count = (text: string) => (
    <span className={limit !== null && charCount(text) > limit ? 'pv-ct pv-ct--over' : 'pv-ct'}>
      {charCount(text)}
      {limit === null ? '' : `/${String(limit)}`}
    </span>
  );
  return (
    <Sheet label={t('library.aiTitles')} onClose={onClose}>
      <div className="pv-sheet__head">
        <Icon name="spark" size={14} />
        <b>{t('library.aiTitles')}</b>
        <span className="pv-sheet__meta">
          {limit === null
            ? shortName(platform)
            : t('library.titleCandidatesMeta', { platform: shortName(platform), limit })}
        </span>
        {ready && s.model !== null && <CandidateTags result={s.marks} model={s.model} />}
      </div>
      {mine && s.block !== null && (
        <div className="ai__notice pv-sheet__note" role="alert">
          <Icon name="key" />
          <span className="ai__notice-text">{AI_BLOCK_LABEL[s.block]}</span>
        </div>
      )}
      {mine && s.phase === 'failed' && (
        <div className="banner banner--bad pv-sheet__note" role="alert">
          <Icon name="alert" />
          <span className="banner__text">
            {s.failure?.code == null
              ? (s.failure?.message ?? t('ai.generateFailed'))
              : FAILURE_LABEL[s.failure.code]}
          </span>
          <TechnicalDetails text={s.failure?.detail} />
        </div>
      )}
      <div
        className="pv-sheet__list"
        role="listbox"
        aria-label={t('library.titleCandidates')}
        aria-busy={loading}
      >
        {loading &&
          Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="pv-sheet__opt pv-sheet__opt--sk" aria-hidden="true">
              {i === 0 && <span className="spin" />}
            </div>
          ))}
        {ready && s.candidates.length === 0 && (
          <span className="pv-sheet__empty">{t('library.titleNoCandidates')}</span>
        )}
        {ready &&
          s.candidates.map((c) => (
            <button
              key={c.text}
              type="button"
              role="option"
              aria-selected={false}
              className="pv-sheet__opt"
              onClick={() => {
                onUse(c.text);
                titles.clear();
              }}
            >
              <span className="pv-sheet__text">{c.text}</span>
              {count(c.text)}
            </button>
          ))}
        {extras.length > 0 && (
          <>
            <span className="pv-sheet__group">{t('videoWork.titleSuggestions')}</span>
            {extras.map((text) => (
              <button
                key={text}
                type="button"
                role="option"
                aria-selected={false}
                className="pv-sheet__opt"
                onClick={() => {
                  onUse(text);
                }}
              >
                <span className="pv-sheet__text">{text}</span>
                {count(text)}
              </button>
            ))}
          </>
        )}
      </div>
      <div className="pv-sheet__foot">
        <button
          type="button"
          className="btn btn--small"
          disabled={loading}
          onClick={() => {
            void titles.generate(platform, model);
          }}
        >
          {t('common.retry')}
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Sheet>
  );
}

type CoverPick = { kind: 'image'; id: string } | { kind: 'ai'; index: number };

/** 選封面: pick one of the images, or generate AI covers at this platform's ratio; 設為封面 applies. */
function CoverSheet({
  work,
  platform,
  covers,
  images,
  current,
  title,
  body,
  onSet,
  onClose,
  onNotice,
}: {
  work: WorkDetail;
  platform: Platform;
  covers: CoverGenSession;
  images: PhoneModel['images']['value'];
  current: string | null;
  title: string;
  body: string;
  onSet: (cover: VariantCover) => void;
  onClose: () => void;
  onNotice: (text: string) => void;
}) {
  const s = useStore(covers);
  const [pick, setPick] = useState<CoverPick | null>(null);
  const [prompt, setPrompt] = useState(() => coverPromptFrom(title, body));
  const [model, setModel] = useState('');
  const cost = useCostConfirm();
  const ratio = ratioStyle(platform);
  const template = getTemplate(platform);

  useEffect(() => {
    if (model === '' || s.models?.some((m) => m.id === model) !== true)
      setModel(chooseModel(s.models));
  }, [s.models, model]);

  const noModel = s.block === null && s.models !== null && s.models.length === 0;
  const unknownCost = s.estimate !== null && s.estimate.estimate.max_cost_usd === null;
  const generating = s.phase === 'generating' && s.platform === platform;
  const mine = s.platform === platform;

  const close = () => {
    if (generating) void covers.stop();
    void covers.discardAll();
    onClose();
  };

  const generate = () => {
    if (model === '') return;
    void covers.estimate(platform, model, prompt).then(async (noPrice) => {
      if (!(await cost.confirm(model, noPrice || unknownCost))) return;
      setPick(null);
      await covers.generate(platform, model, prompt);
    });
  };

  const apply = () => {
    if (pick === null) return;
    if (pick.kind === 'image') {
      onSet({ asset_id: pick.id });
      return;
    }
    void covers.keep(pick.index, work.current_revision_id).then((r) => {
      if (!r.ok) {
        onNotice(r.reason === 'expired' ? t('ai.candidateExpired') : t('library.actionFailed'));
        return;
      }
      void covers.discardAll();
      onSet({ asset_id: r.assetId });
    });
  };

  return (
    <Sheet label={t('previewPanel.coverSheet')} onClose={close}>
      <div className="pv-sheet__head">
        <b>{t('previewPanel.coverSheet')}</b>
        <span className="pv-sheet__meta">{`${template.coverRatioLabel} · ${shortName(platform)}`}</span>
      </div>
      <div className="pv-sheet__body">
        {images.length > 0 && (
          <div className="pv-sheet__grid" role="group" aria-label={t('previewPanel.fromImages')}>
            {images.map((img, i) => (
              <button
                key={img.id}
                type="button"
                className="pv-sheet__cell"
                style={{ aspectRatio: ratio }}
                aria-pressed={pick?.kind === 'image' && pick.id === img.id}
                aria-label={t('library.imageAt', { index: i + 1 })}
                data-current={current === img.url || undefined}
                onClick={() => {
                  setPick({ kind: 'image', id: img.id });
                }}
              >
                <img src={img.url} alt="" draggable={false} />
              </button>
            ))}
          </div>
        )}
        <div className="pv-sheet__ai">
          <span className="pv-sheet__label">
            <Icon name="spark" size={13} />
            {t('library.aiCover')}
            <span className="pv-ct">
              {s.estimate === null || s.estimate.estimate.max_cost_usd === null
                ? t('ai.costUnknown')
                : t('ai.costAbout', { cost: s.estimate.estimate.max_cost_usd.toFixed(2) })}
            </span>
          </span>
          {s.block !== null && (
            <div className="ai__notice" role="alert">
              <Icon name="key" />
              <span className="ai__notice-text">{AI_BLOCK_LABEL[s.block]}</span>
            </div>
          )}
          {noModel && (
            <div className="ai__notice" role="alert">
              <Icon name="image" />
              <span className="ai__notice-text">{t('ai.noImageModel')}</span>
            </div>
          )}
          <textarea
            className="input pv-sheet__prompt"
            rows={2}
            aria-label={t('ai.prompt')}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn btn--small"
            disabled={s.block !== null || noModel || model === '' || generating}
            onClick={generate}
          >
            {generating ? t('ai.generating') : t('ai.generateCount', { count: 4 })}
          </button>
          {mine && (generating || s.candidates.length > 0 || s.pending > 0) && (
            <ul className="pv-sheet__grid">
              <Presence popLayout>
                {generating
                  ? Array.from({ length: s.pending }, (_, i) => (
                      <AnimatedItem
                        key={`sk-${String(i)}`}
                        layout={false}
                        quiet={false}
                        preset={{ kind: 'reveal' }}
                      >
                        <div
                          className="pv-sheet__cell pv-sheet__cell--sk"
                          style={{ aspectRatio: ratio }}
                          role="status"
                          aria-label={t('library.generatingCover')}
                        >
                          {i === 0 && <span className="spin" aria-hidden="true" />}
                        </div>
                      </AnimatedItem>
                    ))
                  : s.candidates
                      .filter((c) => c.fate === 'new' || c.fate === 'kept')
                      .map((c) => (
                        <AnimatedItem
                          key={c.index}
                          layout={false}
                          quiet={false}
                          preset={{ kind: 'reveal' }}
                        >
                          <button
                            type="button"
                            className="pv-sheet__cell"
                            style={{ aspectRatio: ratio }}
                            aria-pressed={pick?.kind === 'ai' && pick.index === c.index}
                            aria-label={t('library.coverCandidate', { index: c.index + 1 })}
                            onClick={() => {
                              setPick({ kind: 'ai', index: c.index });
                            }}
                          >
                            {c.src !== null && <img src={c.src} alt="" />}
                          </button>
                        </AnimatedItem>
                      ))}
              </Presence>
            </ul>
          )}
          {mine && s.phase === 'failed' && (
            <div className="banner banner--bad" role="alert">
              <Icon name="alert" />
              <span className="banner__text">
                {s.failure?.code == null
                  ? (s.failure?.message ?? t('ai.generateFailed'))
                  : FAILURE_LABEL[s.failure.code]}
              </span>
              <TechnicalDetails text={s.failure?.detail} />
            </div>
          )}
        </div>
      </div>
      <div className="pv-sheet__foot">
        <button type="button" className="btn btn--ghost btn--small" onClick={close}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={pick === null}
          onClick={apply}
        >
          {t('previewPanel.setCover')}
        </button>
      </div>
      {cost.node}
    </Sheet>
  );
}

const FIELD_KEY = {
  title: 'previewPanel.fieldTitle',
  cover: 'previewPanel.fieldCover',
  images: 'previewPanel.fieldImages',
  tags: 'previewPanel.fieldTags',
} as const;

/** A 409 inside the phone: 另一處改了這個平台的{欄位}, with 保留我的／使用對方的. */
function ConflictSheet({
  platform,
  state,
  session,
}: {
  platform: Platform;
  state: OverrideState;
  session: OverrideSession;
}) {
  const fields = state.conflict?.fields ?? [];
  const what = fields.map((f) => t(FIELD_KEY[f])).join(t('previewPanel.listSeparator'));
  return (
    <Sheet
      label={t('previewPanel.conflict', { platform: shortName(platform), field: what })}
      onClose={() => undefined}
    >
      <div className="pv-sheet__head pv-sheet__head--warn" role="alert">
        <Icon name="alert" size={14} />
        <b>{t('previewPanel.conflict', { platform: shortName(platform), field: what })}</b>
      </div>
      {fields.includes('title') && state.conflict !== null && (
        <dl className="pv-sheet__cmp">
          <dt>{t('previewPanel.mine')}</dt>
          <dd>{state.pending.title ?? t('previewPanel.following')}</dd>
          <dt>{t('previewPanel.theirs')}</dt>
          <dd>{state.conflict.theirs.title}</dd>
        </dl>
      )}
      <div className="pv-sheet__foot">
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            session.useTheirs();
          }}
        >
          {t('previewPanel.useTheirs')}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          onClick={() => {
            void session.keepMine();
          }}
        >
          {t('previewPanel.keepMine')}
        </button>
      </div>
    </Sheet>
  );
}
