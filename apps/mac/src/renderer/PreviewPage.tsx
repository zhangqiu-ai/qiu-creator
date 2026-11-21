import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  charCount,
  checkVariantLimits,
  PLATFORM_LIMITS,
  type AssetRecord,
  type Platform,
  type Work,
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
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { thumbnailUrl } from '../shared/bridge.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useChangeEvents, useRefreshOn } from './events.js';
import { SAVE_STATUS, WORK_STATUS } from './format.js';
import { t, useLocale } from './i18n.js';
import { Icon } from './Icon.js';
import { warningText } from './image-post.js';
import { addTags } from './TagEditor.js';
import { VariantSession, type VariantDraft } from './variant-session.js';

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

/**
 * 平台預覽 (prototype board MacPreview + PT-20261117-001 over-limit styles):
 * edit each platform's version on the left, see a phone-framed simulation on
 * the right. Each platform has its own session and revision; nothing here
 * writes another platform or the original.
 */
export function PreviewPage({
  client,
  workId,
  onPickWork,
  onBack,
}: {
  client: CreatorHubClient;
  workId: string | null;
  onPickWork: (workId: string) => void;
  onBack: (() => void) | null;
}) {
  if (workId === null) return <WorkPicker client={client} onPick={onPickWork} />;
  return <WorkPreview key={workId} client={client} workId={workId} onBack={onBack} />;
}

function WorkPicker({
  client,
  onPick,
}: {
  client: CreatorHubClient;
  onPick: (id: string) => void;
}) {
  const [works, setWorks] = useState<Work[] | null>(null);
  useEffect(() => {
    client.works
      .list({ limit: 200 })
      .then((r) => {
        setWorks(r.items);
      })
      .catch(() => {
        setWorks([]);
      });
  }, [client]);
  return (
    <main className="page" aria-label={t('library.preview')}>
      <header className="page__header">
        <h1 className="page__title">{t('library.preview')}</h1>
      </header>
      <section className="page__body">
        <p className="muted pv-pick__hint">{t('library.previewPickHint')}</p>
        <ul className="pv-pick">
          {(works ?? []).map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className="ref"
                onClick={() => {
                  onPick(w.id);
                }}
              >
                <Icon name="library" size={14} />
                <span className="ref__title">{w.title}</span>
                <Chip tone={WORK_STATUS[w.status].tone}>{WORK_STATUS[w.status].label}</Chip>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function WorkPreview({
  client,
  workId,
  onBack,
}: {
  client: CreatorHubClient;
  workId: string;
  onBack: (() => void) | null;
}) {
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyMap<Platform, VariantSession> | null>(null);
  const [platform, setPlatform] = useState<Platform>('xiaohongshu');
  const [images, setImages] = useState<AssetRecord[]>([]);

  const loadImages = useCallback(() => {
    client.workAssets
      .list(workId)
      .then((r) => {
        const byId = new Map<string, AssetRecord>();
        for (const item of r.items) {
          if (item.asset.kind === 'image') byId.set(item.asset.id, item.asset);
        }
        setImages([...byId.values()]);
      })
      .catch(() => undefined);
  }, [client, workId]);

  useEffect(() => {
    let alive = true;
    let made: Map<Platform, VariantSession> | null = null;
    Promise.all([client.works.get(workId), client.variants.list(workId)])
      .then(([w, list]) => {
        if (!alive) return;
        setWork(w);
        const byPlatform = new Map(list.items.map((v) => [v.platform, v]));
        made = new Map(
          PLATFORMS.map((p) => [
            p,
            new VariantSession(client, workId, p, byPlatform.get(p) ?? null),
          ]),
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
  }, [client, workId, loadImages]);

  useRefreshOn(['asset'], loadImages, 500);
  useChangeEvents((event) => {
    if (event.entity !== 'work' || event.entity_id !== workId || sessions === null) return;
    if (event.action === 'work.assets_changed') loadImages();
    if (event.action === 'work.updated') {
      void client.works
        .get(workId)
        .then(setWork)
        .catch(() => undefined);
    }
    if (event.action !== 'work.variant_created' && event.action !== 'work.variant_updated') return;
    const p = event.data['platform'];
    const rev = event.data['revision'];
    const session = PLATFORMS.find((x) => x === p);
    if (session === undefined || typeof rev !== 'number') return;
    void sessions.get(session)?.remoteRevision(rev);
  });

  if (failed) {
    return (
      <main className="page page--center">
        <div className="state-card" role="alert">
          <Icon name="offline" size={28} />
          <span className="state-card__title">{t('library.previewLoadFailed')}</span>
        </div>
      </main>
    );
  }
  if (work === null || sessions === null) return <main className="page" aria-busy="true" />;

  return (
    <main className="page pv" aria-label={t('library.preview')}>
      <header className="editor__bar">
        {onBack !== null && (
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t('library.backToEditor')}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        )}
        <span className="pv__work">{work.title}</span>
        <Chip tone={WORK_STATUS[work.status].tone}>{WORK_STATUS[work.status].label}</Chip>
        <div className="pv-tabs" role="tablist" aria-label={t('library.platform')}>
          {PLATFORMS.map((p) => (
            <PlatformTab
              key={p}
              session={sessions.get(p)}
              workType={work.type}
              selected={platform === p}
              onSelect={() => {
                setPlatform(p);
              }}
            />
          ))}
        </div>
      </header>
      <VariantEditor
        key={platform}
        session={sessions.get(platform)}
        mpDraft={sessions.get('wechat_mp')?.snapshot.draft ?? null}
        images={images}
        work={work}
      />
    </main>
  );
}

function useSession(session: VariantSession | undefined) {
  return useSyncExternalStore(
    useCallback((cb: () => void) => session?.subscribe(cb) ?? (() => undefined), [session]),
    () => session?.snapshot ?? null,
  );
}

function PlatformTab({
  session,
  workType,
  selected,
  onSelect,
}: {
  session: VariantSession | undefined;
  workType: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = useSession(session);
  if (state === null) return null;
  const warn = draftWarnings(state.platform, state.draft, workType).length > 0;
  const unsaved = state.status === 'dirty' || state.status === 'saving';
  return (
    <button type="button" role="tab" className="pv-tab" aria-selected={selected} onClick={onSelect}>
      {shortName(state.platform)}
      {warn && <span className="pv-tab__warn" aria-label={t('library.overLimit')} role="img" />}
      {state.status === 'conflict' && (
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
  session,
  mpDraft,
  images,
  work,
}: {
  session: VariantSession | undefined;
  mpDraft: VariantDraft | null;
  images: readonly AssetRecord[];
  work: WorkDetail;
}) {
  const state = useSession(session);
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [tagText, setTagText] = useState('');
  const [confirmRedraft, setConfirmRedraft] = useState(false);

  const draft = state?.draft ?? null;
  const platform = state?.platform ?? 'xiaohongshu';
  const template = getTemplate(platform);
  const limits = PLATFORM_LIMITS[platform];
  const warnings = useMemo(
    () => draftWarnings(platform, draft, work.type),
    [platform, draft, work.type],
  );

  const model = useMemo(() => {
    if (draft === null) return null;
    const ids = draft.image_asset_ids;
    const cover = draft.cover_asset_id ?? ids[0] ?? null;
    return buildPreviewModel({
      platform,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      coverUrl: cover === null ? null : thumbnailUrl(cover),
      imageUrls: ids.map(thumbnailUrl),
      workType: work.type,
      dateLabel: formatShortDate(locale, new Date(state?.record?.updated_at ?? work.updated_at)),
      locale,
    });
  }, [platform, draft, state?.record?.updated_at, work.updated_at, locale]);

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
  const ids = draft?.image_asset_ids ?? [];
  const cover = draft?.cover_asset_id ?? ids[0] ?? null;
  const addable = images.filter((a) => !ids.includes(a.id));
  const imagesOver = limits.imagesMax !== null && ids.length > limits.imagesMax;

  return (
    <div className="pv__body">
      <section className="pv__form" aria-label={t('library.platformVersion')}>
        <div className="pv__head">
          <h1 className="pv__title">
            {t('library.platformVersionTitle', { platform: shortName(platform) })}
          </h1>
          {state.record !== null && <Chip>r{state.record.revision}</Chip>}
          {save !== null && (
            <span role="status" aria-live="polite">
              <Chip tone={save.tone}>{save.label}</Chip>
            </span>
          )}
          <span className="pv__ratio">
            <Chip>{template.coverRatioLabel}</Chip>
          </span>
        </div>

        {state.record === null ? (
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
        ) : draft === null ? null : (
          <>
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
              <label className="pv-lb" htmlFor="pv-title">
                {t('library.colTitle')}
                <Count value={charCount(draft.title)} limit={limits.titleMaxChars} />
              </label>
              <input
                id="pv-title"
                key={`t${String(state.epoch)}`}
                className={
                  limits.titleMaxChars !== null && charCount(draft.title) > limits.titleMaxChars
                    ? 'input pv-inp pv-inp--over'
                    : 'input pv-inp'
                }
                defaultValue={draft.title}
                aria-describedby="pv-title-hint"
                onChange={(e) => {
                  session.edit({ title: e.target.value });
                }}
                {...composition}
              />
              {limits.titleMaxChars !== null && charCount(draft.title) > limits.titleMaxChars && (
                <span id="pv-title-hint" className="pv-hint">
                  <Icon name="alert" size={13} />
                  {t('library.titleOverBy', {
                    count: charCount(draft.title) - limits.titleMaxChars,
                  })}
                </span>
              )}
            </div>

            <div className="pv-fld">
              <label className="pv-lb" htmlFor="pv-body">
                {t('library.body')}
                <Count value={charCount(draft.body)} limit={limits.bodyMaxChars} />
              </label>
              <textarea
                id="pv-body"
                key={`b${String(state.epoch)}`}
                className={
                  limits.bodyMaxChars !== null && charCount(draft.body) > limits.bodyMaxChars
                    ? 'input pv-inp pv-ta pv-inp--over'
                    : 'input pv-inp pv-ta'
                }
                rows={8}
                defaultValue={draft.body}
                onChange={(e) => {
                  session.edit({ body: e.target.value });
                }}
                {...composition}
              />
              {limits.bodyMaxChars !== null && charCount(draft.body) > limits.bodyMaxChars && (
                <span className="pv-hint">
                  <Icon name="alert" size={13} />
                  {t('library.bodyOverBy', { count: charCount(draft.body) - limits.bodyMaxChars })}
                </span>
              )}
            </div>

            <div className="pv-fld">
              <span className="pv-lb">
                {t('library.coverAndOrder')}
                <Count value={ids.length} limit={limits.imagesMax} unit={t('library.unitImages')} />
              </span>
              {ids.length === 0 ? (
                <span className="faint">{t('library.noImagesHint')}</span>
              ) : (
                <div className="pv-thumbs" role="group" aria-label={t('library.imageOrder')}>
                  {cover !== null && !ids.includes(cover) && (
                    <span
                      className="pv-thumb pv-thumb--cover"
                      role="img"
                      aria-label={t('library.coverNotInList')}
                    >
                      <img src={thumbnailUrl(cover)} alt="" draggable={false} />
                      <span className="pv-thumb__no" title={t('library.coverNotInList')}>
                        {t('library.coverBadge')}
                      </span>
                    </span>
                  )}
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
                          ...(draft.cover_asset_id === selectedImage
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
                              ...(draft.cover_asset_id === null ? { cover_asset_id: a.id } : {}),
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
                    value={draft.tags.length}
                    limit={limits.tagsMax}
                    unit={t('library.unitTags')}
                  />
                )}
              </span>
              <div className="tags">
                {draft.tags.map((tag) => (
                  <span key={tag} className="tag">
                    #{tag}
                    <button
                      type="button"
                      className="tag__remove"
                      aria-label={t('library.removeTag', { tag })}
                      onClick={() => {
                        session.edit({ tags: draft.tags.filter((x) => x !== tag) }, true);
                      }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
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
                      session.edit({ tags: addTags(draft.tags, tagText) }, true);
                      setTagText('');
                    }
                  }}
                />
              </div>
            </div>

            <div className="pv-foot">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={busy || state.status === 'conflict'}
                onClick={() => {
                  setConfirmRedraft(true);
                }}
              >
                <Icon name="refresh" size={14} />
                {t('library.redraftFromSource')}
              </button>
              <span className="faint">{t('library.perPlatformNote')}</span>
            </div>
          </>
        )}
        {actionError !== null && (
          <p className="field__error" role="alert">
            {actionError}
          </p>
        )}
      </section>

      <section className="pv__preview" aria-label={t('library.simulatedPreview')}>
        <PlatformPreview
          model={model}
          empty={t('library.noPlatformVersion', { platform: shortName(platform) })}
          locale={locale}
        />
        <p className="faint pv__note">{t('library.simulationNote')}</p>
      </section>

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
