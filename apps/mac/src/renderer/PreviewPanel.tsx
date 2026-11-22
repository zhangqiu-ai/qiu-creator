import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  charCount,
  checkVariantLimits,
  PLATFORM_LIMITS,
  type AiModelChoice,
  type AssetRecord,
  type Platform,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { formatShortDate, type MessageKey } from '@qiu-creator/i18n';
import {
  buildPreviewModel,
  getTemplate,
  PLATFORM_SHORT_KEY,
  PLATFORMS,
} from '@qiu-creator/platform-preview';
import { PlatformPreview } from '@qiu-creator/platform-preview/react';
import '@qiu-creator/platform-preview/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { thumbnailUrl } from '../shared/bridge.js';
import { AiProviders, FAILURE_LABEL, AI_BLOCK_LABEL } from './ai-session.js';
import { chooseModel, useCostConfirm } from './AiImageTab.js';
import { CandidateTags } from './AiChoices.js';
import { currentModel, useAiLibrary } from './ai-library.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useChangeEvents, useRefreshOn } from './events.js';
import { SAVE_STATUS } from './format.js';
import { t, useLocale } from './i18n.js';
import { Icon } from './Icon.js';
import { warningText } from './image-post.js';
import { AnimatedItem, Presence, useExitFade } from './motion.js';
import { CoverGenSession, coverPromptFrom, ratioStyle } from './preview-cover.js';
import { PreviewTitleSession, titleLimitOf } from './preview-titles.js';
import { addTags } from './TagEditor.js';
import { TechnicalDetails } from './TechnicalDetails.js';
import { VariantSession, type VariantDraft } from './variant-session.js';
import './preview.css';

/** Below this window width the split is one column with a 版本｜手機 switch (PT-20261122-004). */
export const PREVIEW_NARROW_BELOW = 1360;

/** Short platform name for our own labels, in the current language (QC-042). */
function shortName(platform: Platform): string {
  return t(PLATFORM_SHORT_KEY[platform]);
}

/** Which 第 n 張 label a thumbnail gets: cover and over-limit are said in one message. */
function imageAriaKey(isCover: boolean, over: boolean): MessageKey {
  if (isCover && over) return 'library.imageAtCoverOver';
  if (isCover) return 'library.imageAtCover';
  if (over) return 'library.imageAtOver';
  return 'library.imageAt';
}

/** Warnings for a draft, computed live as the user types (never blocks saving). */
export function draftWarnings(
  platform: Platform,
  draft: VariantDraft | null,
  /** Image posts count images against the image-post limit (QC-045). */
  workType?: string,
) {
  return draft === null
    ? []
    : checkVariantLimits(
        platform,
        {
          title: draft.title,
          body: draft.body,
          image_asset_ids: draft.image_asset_ids,
          tags: draft.tags,
        },
        PLATFORM_LIMITS,
        workType,
      );
}

/** Move `id` one step left (-1) or right (+1) in `ids`. */
export function moveId(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const next = [...ids];
  [next[i], next[j]] = [next[j] as string, next[i] as string];
  return next;
}

/** The shared copy a video work's platforms may follow (QC-046). */
export interface SharedCopy {
  title: string;
  body: string;
  tags: readonly string[];
}

export interface PreviewPanelProps {
  client: CreatorHubClient;
  work: WorkDetail;
  /** Which platforms this work has versions for; the four by default. */
  platforms?: readonly Platform[];
  /** Bring one platform forward (a count chip in the editor was clicked); `n` makes each ask new. */
  open?: { platform: Platform; n: number };
  /** The work's own cover, offered as this platform's cover (「用作品封面」). */
  workCoverAssetId?: string | null;
  /** Video works: the shared copy and the 沿用共用文案 switch. */
  shared?: SharedCopy | null;
  /** Video works: title suggestions from the understanding result (QC-076 entry audit). */
  extraTitles?: readonly string[];
  onClose: () => void;
  onNotice: (text: string) => void;
}

function useNarrowSplit(): boolean {
  const query = `(max-width: ${String(PREVIEW_NARROW_BELOW - 1)}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => {
      setNarrow(mq.matches);
    };
    mq.addEventListener('change', on);
    return () => {
      mq.removeEventListener('change', on);
    };
  }, [query]);
  return narrow;
}

function useSession(session: VariantSession | undefined) {
  return useSyncExternalStore(
    useCallback((cb: () => void) => session?.subscribe(cb) ?? (() => undefined), [session]),
    () => session?.snapshot ?? null,
  );
}

function useStore<S>(store: { subscribe: (l: () => void) => () => void; snapshot: S }): S {
  return useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb), [store]),
    () => store.snapshot,
  );
}

/**
 * 平台預覽 as a split inside the work editor (QC-076, PT-20261122-004): the
 * platform tabs on top, that platform's own version on the left and its phone
 * simulation on the right. One rule decides where things live: the editor is
 * the original, this split holds each platform's version. Nothing here writes
 * the original; each platform has its own session and revision.
 */
export function PreviewPanel({
  client,
  work,
  platforms = PLATFORMS,
  open,
  workCoverAssetId = null,
  shared = null,
  extraTitles = [],
  onClose,
  onNotice,
}: PreviewPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  // The split slides in (24 px, moderate) and back out (base), like the other right panels.
  useExitFade(panelRef, 'panel');
  const narrow = useNarrowSplit();
  const [view, setView] = useState<'form' | 'phone'>('form');
  const first = platforms[0] ?? 'xiaohongshu';
  const [platform, setPlatform] = useState<Platform>(first);
  const [failed, setFailed] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyMap<Platform, VariantSession> | null>(null);
  const [images, setImages] = useState<AssetRecord[]>([]);
  const list = useMemo(() => [...platforms], [platforms]);

  useEffect(() => {
    if (open !== undefined && list.includes(open.platform)) setPlatform(open.platform);
  }, [open, list]);

  const loadImages = useCallback(() => {
    client.workAssets
      .list(work.id)
      .then((r) => {
        const byId = new Map<string, AssetRecord>();
        for (const item of r.items) {
          if (item.asset.kind === 'image') byId.set(item.asset.id, item.asset);
        }
        setImages([...byId.values()]);
      })
      .catch(() => undefined);
  }, [client, work.id]);

  useEffect(() => {
    let alive = true;
    let made: Map<Platform, VariantSession> | null = null;
    client.variants
      .list(work.id)
      .then((r) => {
        if (!alive) return;
        const byPlatform = new Map(r.items.map((v) => [v.platform, v]));
        made = new Map(
          list.map((p) => [p, new VariantSession(client, work.id, p, byPlatform.get(p) ?? null)]),
        );
        setSessions(made);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    loadImages();
    return () => {
      alive = false;
      if (made !== null) for (const s of made.values()) s.close();
    };
  }, [client, work.id, list, loadImages]);

  // AI 標題 and AI 封面 live as long as the split is open.
  const [ai, setAi] = useState<{
    titles: PreviewTitleSession;
    covers: CoverGenSession;
  } | null>(null);
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

  useRefreshOn(['asset'], loadImages, 500);
  useChangeEvents((event) => {
    if (event.entity === 'job' && event.action.startsWith('ai_job.')) {
      void ai?.titles.jobChanged(event.entity_id);
      void ai?.covers.jobChanged(event.entity_id);
      return;
    }
    if (event.entity !== 'work' || event.entity_id !== work.id || sessions === null) return;
    if (event.action === 'work.assets_changed') loadImages();
    if (event.action !== 'work.variant_created' && event.action !== 'work.variant_updated') return;
    const p = event.data['platform'];
    const rev = event.data['revision'];
    const found = list.find((x) => x === p);
    if (found === undefined || typeof rev !== 'number') return;
    void sessions.get(found)?.remoteRevision(rev);
  });

  const showForm = !narrow || view === 'form';
  const showPhone = !narrow || view === 'phone';

  return (
    <aside
      ref={panelRef}
      className={narrow ? 'panel pv-split pv-split--narrow' : 'panel pv-split'}
      aria-label={t('library.preview')}
      id="preview-panel"
    >
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
            requestAnimationFrame(() => {
              document.getElementById(`pv-tab-${work.id}-${next}`)?.focus();
            });
          }}
        >
          {list.map((p) => (
            <PlatformTab
              key={p}
              id={`pv-tab-${work.id}-${p}`}
              session={sessions?.get(p)}
              platform={p}
              workType={work.type}
              selected={platform === p}
              onSelect={() => {
                setPlatform(p);
              }}
            />
          ))}
        </div>
        {narrow && (
          <div className="seg pv-split__seg" role="group" aria-label={t('library.previewView')}>
            {(['form', 'phone'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                }}
              >
                {t(v === 'form' ? 'library.previewForm' : 'library.previewPhone')}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--icon pv-split__close"
          aria-label={t('library.closePreview')}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {failed ? (
        <div className="pv-split__body">
          <div className="state-card" role="alert">
            <Icon name="offline" size={28} />
            <span className="state-card__title">{t('library.previewLoadFailed')}</span>
          </div>
        </div>
      ) : sessions === null || ai === null ? (
        <div className="pv-split__body" aria-busy="true" />
      ) : (
        <VariantEditor
          key={platform}
          work={work}
          session={sessions.get(platform)}
          platform={platform}
          mpDraft={sessions.get('wechat_mp')?.snapshot.draft ?? null}
          images={images}
          workCoverAssetId={workCoverAssetId}
          shared={shared}
          extraTitles={extraTitles}
          titles={ai.titles}
          covers={ai.covers}
          showForm={showForm}
          showPhone={showPhone}
          onNotice={onNotice}
        />
      )}
    </aside>
  );
}

function PlatformTab({
  id,
  session,
  platform,
  workType,
  selected,
  onSelect,
}: {
  id: string;
  session: VariantSession | undefined;
  platform: Platform;
  workType: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = useSession(session);
  const warn = draftWarnings(platform, state?.draft ?? null, workType).length > 0;
  const none = state === null || state.record === null;
  const unsaved = state?.status === 'dirty' || state?.status === 'saving';
  return (
    <button
      type="button"
      role="tab"
      id={id}
      className="pv-tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      title={`${shortName(platform)}${
        none ? ` · ${t('library.noVersion')}` : warn ? ` · ${t('library.overLimit')}` : ''
      }`}
      onClick={onSelect}
    >
      {shortName(platform)}
      {warn && <span className="pv-tab__warn" aria-label={t('library.overLimit')} role="img" />}
      {!warn && none && (
        <span className="pv-tab__none" aria-label={t('library.noVersion')} role="img" />
      )}
      {state?.status === 'conflict' && (
        <span className="pv-tab__bad" aria-label={t('library.versionConflict')} role="img" />
      )}
      {unsaved && <span className="visually-hidden">{t('library.unsaved')}</span>}
    </button>
  );
}

function Count({
  value,
  limit,
  unit = '',
}: {
  value: number;
  limit: number | null;
  unit?: string;
}) {
  const over = limit !== null && value > limit;
  return (
    <span className={over ? 'pv-ct pv-ct--over' : 'pv-ct'}>
      {value}
      {limit !== null && `/${String(limit)}`}
      {unit}
    </span>
  );
}

function VariantEditor({
  work,
  session,
  platform,
  mpDraft,
  images,
  workCoverAssetId,
  shared,
  extraTitles,
  titles,
  covers,
  showForm,
  showPhone,
  onNotice,
}: {
  work: WorkDetail;
  session: VariantSession | undefined;
  platform: Platform;
  mpDraft: VariantDraft | null;
  images: readonly AssetRecord[];
  workCoverAssetId: string | null;
  shared: SharedCopy | null;
  extraTitles: readonly string[];
  titles: PreviewTitleSession;
  covers: CoverGenSession;
  showForm: boolean;
  showPhone: boolean;
  onNotice: (text: string) => void;
}) {
  const state = useSession(session);
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [tagText, setTagText] = useState('');
  const [confirmRedraft, setConfirmRedraft] = useState(false);
  const [inheritTarget, setInheritTarget] = useState<boolean | null>(null);
  /** The value before the last AI change, for 復原. */
  const [undo, setUndo] = useState<Partial<VariantDraft> | null>(null);
  /** Bumped when the title is written from outside the field, to reload the input. */
  const [applied, setApplied] = useState(0);

  const draft = state?.draft ?? null;
  const template = getTemplate(platform);
  const limits = PLATFORM_LIMITS[platform];
  const inherit = shared !== null && (state === null || state.record?.inherit !== false);
  /**
   * What this platform will publish. A video work that follows the shared copy
   * (QC-046) shows that copy read-only, even before it has a version of its
   * own: unticking 沿用共用文案 is what creates one.
   */
  const effective = useMemo(
    (): VariantDraft | null =>
      inherit
        ? {
            cover_asset_id: draft?.cover_asset_id ?? null,
            image_asset_ids: draft?.image_asset_ids ?? [],
            title: shared.title,
            body: shared.body,
            tags: shared.tags,
          }
        : draft,
    [draft, inherit, shared],
  );
  const warnings = useMemo(
    () => draftWarnings(platform, effective, work.type),
    [platform, effective, work.type],
  );

  const ids = effective?.image_asset_ids ?? [];
  const cover = effective?.cover_asset_id ?? workCoverAssetId ?? ids[0] ?? null;

  const model = useMemo(() => {
    if (effective === null) return null;
    return buildPreviewModel({
      platform,
      title: effective.title,
      body: effective.body,
      tags: effective.tags,
      coverUrl: cover === null ? null : thumbnailUrl(cover),
      imageUrls: ids.map(thumbnailUrl),
      workType: work.type,
      dateLabel: formatShortDate(locale, new Date(state?.record?.updated_at ?? work.updated_at)),
      locale,
    });
    // `ids` and `cover` are read from `effective`.
  }, [
    platform,
    effective,
    cover,
    ids,
    state?.record?.updated_at,
    work.type,
    work.updated_at,
    locale,
  ]);

  if (session === undefined || state === null) return null;

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    action()
      .catch(() => {
        setActionError(t('library.actionFailed'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const composition = {
    onCompositionStart: () => {
      session.setComposing(true);
    },
    onCompositionEnd: () => {
      session.setComposing(false);
    },
  };

  const save = state.status === 'none' ? null : SAVE_STATUS[state.status];
  const addable = images.filter((a) => !ids.includes(a.id));
  const imagesOver = limits.imagesMax !== null && ids.length > limits.imagesMax;
  const titleId = `pv-title-${work.id}`;
  const bodyId = `pv-body-${work.id}`;

  /** Apply an AI result to this platform's version, remembering the old value for 復原. */
  const apply = (change: Partial<VariantDraft>, notice: string) => {
    if (draft === null) return;
    const before: Partial<VariantDraft> = {};
    for (const key of Object.keys(change) as (keyof VariantDraft)[]) {
      Object.assign(before, { [key]: draft[key] });
    }
    setUndo(before);
    session.edit(change, true);
    setApplied((n) => n + 1);
    onNotice(notice);
  };

  return (
    <div className="pv-split__body">
      {showForm && (
        <section className="pv__form" aria-label={t('library.platformVersion')}>
          {state.record === null && shared === null ? (
            <div className="pv-empty">
              <span className="pv-empty__title">
                {t('library.noPlatformVersion', { platform: shortName(platform) })}
              </span>
              <div className="state-card__actions">
                <button
                  type="button"
                  className="btn btn--accent-outline"
                  disabled={busy}
                  onClick={() => {
                    run(() => session.draftFromSource());
                  }}
                >
                  {t('library.draftFromSource')}
                </button>
                {platform !== 'wechat_mp' && mpDraft !== null && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      run(() => session.copyFrom(mpDraft));
                    }}
                  >
                    {t('library.copyPlatformVersion', { platform: shortName('wechat_mp') })}
                  </button>
                )}
              </div>
              <span className="faint">{t('library.draftRuleNote')}</span>
            </div>
          ) : effective === null ? null : (
            <>
              <div className="pv-vline">
                <span className="pv-vline__text">
                  {t('library.platformVersionTitle', { platform: shortName(platform) })}
                  {state.record !== null && <Chip>r{state.record.revision}</Chip>}
                  {save !== null && (
                    <span role="status" aria-live="polite">
                      <Chip tone={save.tone}>{save.label}</Chip>
                    </span>
                  )}
                  <span className="faint">{t('library.sourceUntouched')}</span>
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={busy || inherit || state.status === 'conflict'}
                  onClick={() => {
                    setConfirmRedraft(true);
                  }}
                >
                  <Icon name="refresh" size={14} />
                  {t('library.redraftFromSource')}
                </button>
              </div>

              {undo !== null && (
                <div className="pv-undo" role="status">
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => {
                      session.edit(undo, true);
                      setUndo(null);
                      setApplied((n) => n + 1);
                    }}
                  >
                    <Icon name="undo" size={14} />
                    {t('common.undo')}
                  </button>
                </div>
              )}

              {shared !== null && (
                <label className="pv-inherit">
                  <input
                    type="checkbox"
                    checked={inheritTarget ?? inherit}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setInheritTarget(next);
                      void session
                        .setInherit(next)
                        .catch(() => undefined)
                        .finally(() => {
                          setInheritTarget(null);
                        });
                    }}
                  />
                  <span>
                    {t('videoWork.inherit')}
                    <span className="faint">
                      {t(inherit ? 'videoWork.inheritOnHint' : 'videoWork.inheritOffHint')}
                    </span>
                  </span>
                </label>
              )}

              {state.status === 'conflict' && (
                <div className="banner banner--warn pv-banner" role="alert">
                  <Icon name="alert" />
                  <span className="banner__text">
                    {state.conflictRevision === null
                      ? t('library.variantConflict', { platform: shortName(platform) })
                      : t('library.variantConflictAt', {
                          platform: shortName(platform),
                          revision: String(state.conflictRevision),
                        })}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      run(() => session.takeLatest());
                    }}
                  >
                    {t('library.loadLatest')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost banner__warn-action"
                    disabled={busy}
                    onClick={() => {
                      run(() => session.keepMine());
                    }}
                  >
                    {t('library.overwriteWithMine')}
                  </button>
                </div>
              )}
              {state.status === 'error' && (
                <div className="banner banner--bad pv-banner" role="alert">
                  <Icon name="alert" />
                  <span className="banner__text">
                    {state.errorMessage ?? t('library.saveFailed')}
                  </span>
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
              {warnings.length > 0 && (
                <div className="pv-wbar" role="status">
                  <Icon name="alert" />
                  {t('library.overLimitCount', { count: warnings.length })}
                  <span className="pv-wbar__note">{t('library.doesNotBlockSaving')}</span>
                  {/* QC-048: worded here from code, limit and actual, never the service's message. */}
                  <ul className="pv-wbar__list">
                    {warnings.map((w) => (
                      <li key={w.code}>{warningText(w)}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="pv-fld">
                <label className="pv-lb" htmlFor={titleId}>
                  {t('library.colTitle')}
                  <Count value={charCount(effective.title)} limit={limits.titleMaxChars} />
                </label>
                <div className="pv-row">
                  <input
                    id={titleId}
                    key={`t${String(state.epoch)}-${String(applied)}${String(inherit)}`}
                    className={
                      limits.titleMaxChars !== null &&
                      charCount(effective.title) > limits.titleMaxChars
                        ? 'input pv-inp pv-inp--over'
                        : 'input pv-inp'
                    }
                    readOnly={inherit}
                    defaultValue={effective.title}
                    aria-describedby={`${titleId}-hint`}
                    onChange={(e) => {
                      session.edit({ title: e.target.value });
                    }}
                    {...composition}
                  />
                  <TitleAi platform={platform} titles={titles} disabled={inherit} />
                </div>
                {limits.titleMaxChars !== null &&
                  charCount(effective.title) > limits.titleMaxChars && (
                    <span id={`${titleId}-hint`} className="pv-hint">
                      <Icon name="alert" size={13} />
                      {t('library.titleOverBy', {
                        count: charCount(effective.title) - limits.titleMaxChars,
                      })}
                    </span>
                  )}
                <TitleCandidates
                  platform={platform}
                  titles={titles}
                  extraTitles={extraTitles}
                  onUse={(text) => {
                    apply({ title: text }, t('library.titleApplied'));
                  }}
                />
              </div>

              <div className="pv-fld">
                <label className="pv-lb" htmlFor={bodyId}>
                  {t('library.body')}
                  <Count value={charCount(effective.body)} limit={limits.bodyMaxChars} />
                </label>
                <textarea
                  id={bodyId}
                  key={`b${String(state.epoch)}${String(inherit)}`}
                  className={
                    limits.bodyMaxChars !== null && charCount(effective.body) > limits.bodyMaxChars
                      ? 'input pv-inp pv-ta pv-inp--over'
                      : 'input pv-inp pv-ta'
                  }
                  rows={6}
                  readOnly={inherit}
                  defaultValue={effective.body}
                  onChange={(e) => {
                    session.edit({ body: e.target.value });
                  }}
                  {...composition}
                />
                {limits.bodyMaxChars !== null &&
                  charCount(effective.body) > limits.bodyMaxChars && (
                    <span className="pv-hint">
                      <Icon name="alert" size={13} />
                      {t('library.bodyOverBy', {
                        count: charCount(effective.body) - limits.bodyMaxChars,
                      })}
                    </span>
                  )}
              </div>

              <div className="pv-fld">
                <span className="pv-lb">
                  {t('library.coverAndOrder')}
                  <Count
                    value={ids.length}
                    limit={limits.imagesMax}
                    unit={t('library.unitImages')}
                  />
                </span>
                <div className="pv-cov">
                  <span
                    className="pv-cov__box"
                    style={{ aspectRatio: ratioStyle(platform) }}
                    role="img"
                    aria-label={`${t('library.coverBadge')} · ${template.coverRatioLabel}`}
                  >
                    {cover === null ? (
                      <span className="faint">{t('library.noCover')}</span>
                    ) : (
                      <img src={thumbnailUrl(cover)} alt="" draggable={false} />
                    )}
                    <span className="pv-cov__ratio">{template.coverRatioLabel}</span>
                  </span>
                  <div className="pv-cov__acts">
                    <CoverAi
                      work={work}
                      platform={platform}
                      covers={covers}
                      title={effective.title}
                      body={effective.body}
                      disabled={inherit}
                      onKept={(assetId) => {
                        apply(
                          { cover_asset_id: assetId },
                          t('library.coverKept', { platform: shortName(platform) }),
                        );
                      }}
                      onNotice={onNotice}
                    />
                    {workCoverAssetId !== null && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        disabled={inherit || effective.cover_asset_id === workCoverAssetId}
                        onClick={() => {
                          session.edit({ cover_asset_id: workCoverAssetId }, true);
                        }}
                      >
                        {t('library.useWorkCover')}
                      </button>
                    )}
                  </div>
                </div>
                {ids.length > 0 && (
                  <div className="pv-thumbs" role="group" aria-label={t('library.imageOrder')}>
                    {ids.map((id, i) => {
                      const over = limits.imagesMax !== null && i >= limits.imagesMax;
                      const isCover = id === cover;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={over ? 'pv-thumb pv-thumb--over' : 'pv-thumb'}
                          aria-pressed={selectedImage === id}
                          aria-label={t(imageAriaKey(isCover, over), { index: i + 1 })}
                          onClick={() => {
                            setSelectedImage(selectedImage === id ? null : id);
                          }}
                        >
                          <img src={thumbnailUrl(id)} alt="" draggable={false} />
                          <span
                            className="pv-thumb__no"
                            title={isCover ? t('library.coverBadge') : undefined}
                          >
                            {isCover ? t('library.coverBadge') : String(i + 1)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedImage !== null && ids.includes(selectedImage) && (
                  <div className="pv-imgbar" role="toolbar" aria-label={t('library.selectedImage')}>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={selectedImage === cover}
                      onClick={() => {
                        session.edit({ cover_asset_id: selectedImage }, true);
                      }}
                    >
                      {t('library.setAsCover')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-label={t('library.moveEarlier')}
                      disabled={ids.indexOf(selectedImage) === 0}
                      onClick={() => {
                        session.edit({ image_asset_ids: moveId(ids, selectedImage, -1) }, true);
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-label={t('library.moveLater')}
                      disabled={ids.indexOf(selectedImage) === ids.length - 1}
                      onClick={() => {
                        session.edit({ image_asset_ids: moveId(ids, selectedImage, 1) }, true);
                      }}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      onClick={() => {
                        const next = ids.filter((x) => x !== selectedImage);
                        session.edit(
                          {
                            image_asset_ids: next,
                            ...(effective.cover_asset_id === selectedImage
                              ? { cover_asset_id: next[0] ?? null }
                              : {}),
                          },
                          true,
                        );
                        setSelectedImage(null);
                      }}
                    >
                      {t('library.removeFromPlatform')}
                    </button>
                  </div>
                )}
                {imagesOver && (
                  <span className="pv-hint">
                    <Icon name="alert" size={13} />
                    {t('library.imagesOverBy', { count: ids.length - (limits.imagesMax ?? 0) })}
                  </span>
                )}
                {addable.length > 0 && (
                  <div className="pv-add">
                    <span className="faint">{t('library.workImages')}</span>
                    <div className="pv-thumbs">
                      {addable.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="pv-thumb pv-thumb--add"
                          aria-label={t('library.addImage', {
                            name: a.original_name ?? t('library.imageFallback'),
                          })}
                          onClick={() => {
                            session.edit(
                              {
                                image_asset_ids: [...ids, a.id],
                                ...(effective.cover_asset_id === null
                                  ? { cover_asset_id: a.id }
                                  : {}),
                              },
                              true,
                            );
                          }}
                        >
                          <img src={thumbnailUrl(a.id)} alt="" draggable={false} />
                          <span className="pv-thumb__plus">
                            <Icon name="plus" size={14} />
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="pv-fld">
                <span className="pv-lb">
                  {t('library.tags')}
                  {limits.tagsMax !== null && (
                    <Count
                      value={effective.tags.length}
                      limit={limits.tagsMax}
                      unit={t('library.unitTags')}
                    />
                  )}
                </span>
                <div className="tags">
                  {effective.tags.map((tag) => (
                    <span key={tag} className="tag">
                      #{tag}
                      {!inherit && (
                        <button
                          type="button"
                          className="tag__remove"
                          aria-label={t('library.removeTag', { tag })}
                          onClick={() => {
                            session.edit({ tags: effective.tags.filter((x) => x !== tag) }, true);
                          }}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                  {!inherit && (
                    <input
                      className="tags__input pv-taginput"
                      aria-label={t('library.addTag')}
                      placeholder={t('library.addTagPlaceholder')}
                      value={tagText}
                      onChange={(e) => {
                        setTagText(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Enter' && tagText.trim() !== '') {
                          e.preventDefault();
                          session.edit({ tags: addTags(effective.tags, tagText) }, true);
                          setTagText('');
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
          {actionError !== null && (
            <p className="field__error" role="alert">
              {actionError}
            </p>
          )}
        </section>
      )}

      {showPhone && (
        <section className="pv__preview" aria-label={t('library.simulatedPreview')}>
          <PlatformPreview
            model={model}
            empty={t('library.noPlatformVersion', { platform: shortName(platform) })}
            locale={locale}
          />
          <p className="faint pv__note">{t('library.simulationNote')}</p>
        </section>
      )}

      {confirmRedraft && (
        <Dialog
          title={t('library.redraftTitle', { platform: shortName(platform) })}
          onClose={() => {
            setConfirmRedraft(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setConfirmRedraft(false);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setConfirmRedraft(false);
                  run(() => session.draftFromSource());
                }}
              >
                {t('library.redraft')}
              </button>
            </>
          }
        >
          <div className="form">
            <p>
              {t('library.redraftBody', { revision: String((state.record?.revision ?? 0) + 1) })}
            </p>
            <p className="muted">{t('library.redraftNote')}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** 「AI 標題」 beside the title field: candidates for this platform only. */
function TitleAi({
  platform,
  titles,
  disabled,
}: {
  platform: Platform;
  titles: PreviewTitleSession;
  disabled: boolean;
}) {
  const s = useStore(titles);
  const { state: choices } = useAiLibrary();
  const busy = s.phase === 'loading' && s.platform === platform;
  const model: AiModelChoice | null = currentModel(choices, 'suggestions');
  return (
    <button
      type="button"
      className="btn btn--small pv-aibtn"
      disabled={disabled || busy}
      onClick={() => {
        if (busy) return;
        void titles.generate(platform, model);
      }}
    >
      {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="spark" size={14} />}
      {t('library.aiTitles')}
    </button>
  );
}

/** The candidate list under the title field; clicking one applies it (復原 is offered). */
function TitleCandidates({
  platform,
  titles,
  extraTitles,
  onUse,
}: {
  platform: Platform;
  titles: PreviewTitleSession;
  extraTitles: readonly string[];
  onUse: (text: string) => void;
}) {
  const s = useStore(titles);
  const mine = s.platform === platform;
  const limit = titleLimitOf(platform);
  const extras = [...new Set(extraTitles.map((x) => x.trim()).filter((x) => x !== ''))];
  if (!mine && extras.length === 0) return null;
  if (mine && s.block !== null) {
    return (
      <div className="ai__notice" role="alert">
        <Icon name="key" />
        <span className="ai__notice-text">{AI_BLOCK_LABEL[s.block]}</span>
      </div>
    );
  }
  if (mine && s.phase === 'failed') {
    return (
      <div className="banner banner--bad pv-banner" role="alert">
        <Icon name="alert" />
        <span className="banner__text">
          {s.failure?.code == null
            ? (s.failure?.message ?? t('ai.generateFailed'))
            : FAILURE_LABEL[s.failure.code]}
        </span>
        <TechnicalDetails text={s.failure?.detail} />
      </div>
    );
  }
  const ready = mine && s.phase === 'ready';
  if (!ready && extras.length === 0) return null;
  return (
    <div className="pv-cands" role="listbox" aria-label={t('library.titleCandidates')}>
      {ready && (
        <div className="pv-cands__head">
          <span className="faint">
            {limit === null
              ? shortName(platform)
              : t('library.titleCandidatesMeta', { platform: shortName(platform), limit })}
          </span>
          {s.model !== null && <CandidateTags result={s.marks} model={s.model} />}
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              titles.clear();
            }}
          >
            {t('ai.discard')}
          </button>
        </div>
      )}
      {ready && s.candidates.length === 0 && (
        <span className="faint">{t('library.titleNoCandidates')}</span>
      )}
      {ready &&
        s.candidates.map((c) => (
          <button
            key={c.text}
            type="button"
            role="option"
            aria-selected={false}
            className="pv-cand"
            onClick={() => {
              onUse(c.text);
              titles.clear();
            }}
          >
            <span className="pv-cand__text">{c.text}</span>
            <span className={c.over ? 'pv-ct pv-ct--over' : 'pv-ct'}>
              {c.chars}
              {limit === null ? '' : `/${String(limit)}`}
            </span>
          </button>
        ))}
      {extras.length > 0 && (
        <>
          <span className="pv-cands__group">{t('videoWork.titleSuggestions')}</span>
          {extras.map((text) => (
            <button
              key={text}
              type="button"
              role="option"
              aria-selected={false}
              className="pv-cand"
              onClick={() => {
                onUse(text);
              }}
            >
              <span className="pv-cand__text">{text}</span>
              <span
                className={
                  limit !== null && charCount(text) > limit ? 'pv-ct pv-ct--over' : 'pv-ct'
                }
              >
                {charCount(text)}
                {limit === null ? '' : `/${String(limit)}`}
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** 「AI 封面」 under the cover: this platform's ratio, four candidates, 保留 sets the cover. */
function CoverAi({
  work,
  platform,
  covers,
  title,
  body,
  disabled,
  onKept,
  onNotice,
}: {
  work: WorkDetail;
  platform: Platform;
  covers: CoverGenSession;
  title: string;
  body: string;
  disabled: boolean;
  onKept: (assetId: string) => void;
  onNotice: (text: string) => void;
}) {
  const s = useStore(covers);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [model, setModel] = useState('');
  const cost = useCostConfirm();
  const ratio = ratioStyle(platform);

  useEffect(() => {
    if (model === '' || s.models?.some((m) => m.id === model) !== true) {
      setModel(chooseModel(s.models));
    }
  }, [s.models, model]);

  const noModel = s.block === null && s.models !== null && s.models.length === 0;
  const unknownCost = s.estimate !== null && s.estimate.estimate.max_cost_usd === null;
  const generating = s.phase === 'generating' && s.platform === platform;
  const mine = s.platform === platform;

  const openBox = () => {
    setPrompt(coverPromptFrom(title, body));
    setPicked(null);
    setOpen(true);
  };

  const generate = () => {
    if (model === '') return;
    void covers.estimate(platform, model, prompt).then(async (noPrice) => {
      if (!(await cost.confirm(model, noPrice || unknownCost))) return;
      setPicked(null);
      await covers.generate(platform, model, prompt);
    });
  };

  const keep = () => {
    if (picked === null) return;
    void covers.keep(picked, work.current_revision_id).then((r) => {
      if (!r.ok) {
        onNotice(r.reason === 'expired' ? t('ai.candidateExpired') : t('library.actionFailed'));
        return;
      }
      onKept(r.assetId);
      setPicked(null);
      setOpen(false);
      void covers.discardAll();
    });
  };

  return (
    <>
      <button
        type="button"
        className="btn btn--small"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            void covers.discardAll();
          } else {
            openBox();
          }
        }}
      >
        <Icon name="spark" size={14} />
        {t('library.aiCover')}
      </button>
      {open && (
        <div className="pv-cover-gen">
          <div className="pv-cover-gen__head">
            <Icon name="spark" size={14} />
            {t('library.aiCover')}
            <span className="langtag">{`${shortName(platform)} · ${ratio.replace(' / ', ':')}`}</span>
          </div>
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
            className="input pv-inp pv-ta"
            rows={2}
            aria-label={t('ai.prompt')}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
            }}
          />
          <div className="pv-cover-gen__go">
            <span className="pv-ct" role="status">
              {s.estimate === null || s.estimate.estimate.max_cost_usd === null
                ? t('ai.costUnknown')
                : t('ai.costAbout', { cost: s.estimate.estimate.max_cost_usd.toFixed(2) })}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                if (generating) void covers.stop();
                setOpen(false);
                void covers.discardAll();
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={s.block !== null || noModel || model === '' || generating}
              onClick={generate}
            >
              {generating ? t('ai.generating') : t('ai.generateCount', { count: 4 })}
            </button>
          </div>
          {mine && (generating || s.candidates.length > 0 || s.pending > 0) && (
            <ul className="pv-cover-grid">
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
                          className="pv-cover-cell pv-cover-cell--sk"
                          style={{ aspectRatio: ratio }}
                          role="status"
                          aria-label={t('library.generatingCover')}
                        >
                          {/* One waiting signal (QC-074): a spinner in the first cell only. */}
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
                          <div
                            className={
                              picked === c.index
                                ? 'pv-cover-cell pv-cover-cell--on'
                                : 'pv-cover-cell'
                            }
                            style={{ aspectRatio: ratio }}
                          >
                            <button
                              type="button"
                              aria-pressed={picked === c.index}
                              aria-label={t('library.coverCandidate', { index: c.index + 1 })}
                              onClick={() => {
                                setPicked(c.index);
                              }}
                            >
                              {c.src !== null && <img src={c.src} alt="" />}
                            </button>
                          </div>
                        </AnimatedItem>
                      ))}
              </Presence>
            </ul>
          )}
          {s.phase === 'failed' && (
            <div className="banner banner--bad pv-banner" role="alert">
              <Icon name="alert" />
              <span className="banner__text">
                {s.failure?.code == null
                  ? (s.failure?.message ?? t('ai.generateFailed'))
                  : FAILURE_LABEL[s.failure.code]}
              </span>
              <TechnicalDetails text={s.failure?.detail} />
            </div>
          )}
          {picked !== null && (
            <div className="pv-cover-gen__keep" role="status">
              <span className="faint">{t('library.coverPicked')}</span>
              <button type="button" className="btn btn--primary btn--small" onClick={keep}>
                {t('ai.keep')}
              </button>
            </div>
          )}
          {cost.node}
        </div>
      )}
    </>
  );
}
