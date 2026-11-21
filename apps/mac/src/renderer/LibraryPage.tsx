import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Work, WorkDetail, WorkListItem, WorkStatus, WorkType } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chip } from './Chip.js';
import { useRefreshOn } from './events.js';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { formatDuration, formatWhen, sourceLabel, WORK_STATUS, WORK_TYPE } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { externalSource, useMounts } from './mounts.js';

type View = 'grid' | 'list';
type TypeFilter = 'all' | WorkType;
type StatusFilter = 'all' | WorkStatus;

// 混合 works keep their label but only show under 全部 (PT-20261121-001 decision).
const TYPE_FILTERS: readonly TypeFilter[] = ['all', 'article', 'image', 'video'];

/** What 新建 can make (QC-045). Video waits for its editor (QC-046). */
export const NEW_TYPES: readonly { type: WorkType; enabled: boolean }[] = [
  { type: 'article', enabled: true },
  { type: 'image', enabled: true },
  { type: 'video', enabled: false },
];
const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'drafting',
  'in_review',
  'ready',
  'published',
];
const VIEW_KEY = 'qc.library.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function writeView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // per-viewer convenience only
  }
}

export interface LibraryPageProps {
  client: CreatorHubClient;
  /** For showing mount folders as `~/…`. */
  userHome: string | null;
  onOpen: (id: string) => void;
  onCreated: (work: WorkDetail) => void;
}

/** True when an external work's file is gone or its folder unmounted (PT-20261117-001). */
export function isMissing(work: Pick<Work, 'external_state'>): boolean {
  return work.external_state === 'missing' || work.external_state === 'unmounted';
}

/**
 * 作品庫 from the approved prototype: search, type/status filters, grid or
 * list. Refreshes live from SSE work events; external works show their mount
 * and a 檔案遺失 chip when the file is gone (PT-20261117-001).
 */
export function LibraryPage({ client, userHome, onOpen, onCreated }: LibraryPageProps) {
  const [works, setWorks] = useState<readonly WorkListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    setFailed(false);
    const q = appliedQuery.trim();
    // All types at once: the type filter shows a count for each and filters here.
    client.works
      .list({
        limit: 200,
        ...(q === '' ? {} : { q }),
      })
      .then((res) => {
        if (id === request.current) setWorks(res.items);
      })
      .catch(() => {
        if (id === request.current) setFailed(true);
      });
  }, [client, appliedQuery]);

  useEffect(load, [load]);
  useRefreshOn(['work'], load, 300);
  const mounts = useMounts(client);

  // Search is debounced and never runs while the IME is still composing.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQuery = (value: string, composing: boolean) => {
    setQuery(value);
    if (timer.current !== null) clearTimeout(timer.current);
    if (composing) return;
    timer.current = setTimeout(() => {
      setAppliedQuery(value);
    }, 250);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const create = useCallback(
    (kind: WorkType = 'article') => {
      if (creating) return;
      setCreating(true);
      setMenuOpen(false);
      // The service never invents a title (QC-043): it is sent in the interface language.
      client.works
        .create(
          kind === 'article'
            ? { title: t('library.untitledWork'), markdown: '', source: 'mac-app' }
            : { title: t('library.untitledWork'), type: kind, source: 'mac-app' },
        )
        .then(onCreated)
        .catch(() => {
          setFailed(true);
        })
        .finally(() => {
          setCreating(false);
        });
    },
    [client, creating, onCreated],
  );

  // ⌘N new work, ⌘F search; ignored during IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        setMenuOpen(true);
      } else if (key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const ofType = useMemo(
    () => (works ?? []).filter((w) => type === 'all' || w.type === type),
    [works, type],
  );
  const shown = useMemo(
    () => ofType.filter((w) => status === 'all' || w.status === status),
    [ofType, status],
  );
  const typeCounts = useMemo(() => {
    const c: Record<TypeFilter, number> = { all: 0, article: 0, image: 0, video: 0, mixed: 0 };
    for (const w of works ?? []) {
      c.all++;
      c[w.type]++;
    }
    return c;
  }, [works]);
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      drafting: 0,
      in_review: 0,
      ready: 0,
      published: 0,
    };
    for (const w of ofType) {
      c.all++;
      c[w.status]++;
    }
    return c;
  }, [ofType]);

  const filtering = appliedQuery.trim() !== '' || type !== 'all' || status !== 'all';
  const clearFilters = () => {
    setQuery('');
    setAppliedQuery('');
    setType('all');
    setStatus('all');
  };

  return (
    <main className="page" aria-label={t('library.library')}>
      <header className="page__header">
        <h1 className="page__title">{t('library.library')}</h1>
        <span className="page__count">{works === null ? '' : shown.length}</span>
        <label className="search">
          <Icon name="search" />
          <span className="visually-hidden">{t('library.searchWorks')}</span>
          <input
            ref={searchRef}
            type="search"
            placeholder={t('common.search')}
            value={query}
            aria-keyshortcuts="Meta+F"
            onChange={(e) => {
              onQuery(e.target.value, (e.nativeEvent as InputEvent).isComposing);
            }}
            onCompositionEnd={(e) => {
              onQuery(e.currentTarget.value, false);
            }}
          />
          <kbd>⌘F</kbd>
        </label>
        <div className="seg" role="group" aria-label={t('library.view')}>
          {(['grid', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-label={v === 'grid' ? t('library.viewGrid') : t('library.viewList')}
              aria-pressed={view === v}
              onClick={() => {
                setView(v);
                writeView(v);
              }}
            >
              <Icon name={v} />
            </button>
          ))}
        </div>
        <NewMenu open={menuOpen} busy={creating} onOpenChange={setMenuOpen} onCreate={create} />
      </header>

      <div className="filters">
        <div className="seg" role="group" aria-label={t('library.type')}>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={type === f}
              onClick={() => {
                setType(f);
              }}
            >
              {f === 'all' ? t('library.all') : WORK_TYPE[f].label}
              <span className="fchip__n">{typeCounts[f]}</span>
            </button>
          ))}
        </div>
        <span className="filters__divider" aria-hidden="true" />
        <div className="filters__chips" role="group" aria-label={t('library.status')}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className="fchip"
              aria-pressed={status === s}
              onClick={() => {
                setStatus(s);
              }}
            >
              {s === 'all' ? t('library.all') : WORK_STATUS[s].label}
              <span className="fchip__n">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>

      <section
        className="page__body"
        aria-label={t('library.works')}
        aria-busy={works === null && !failed}
      >
        {failed ? (
          <div className="state-card" role="alert">
            <Icon name="offline" size={28} />
            <span className="state-card__title">{t('common.serviceDown')}</span>
            <button type="button" className="btn btn--primary" onClick={load}>
              {t('common.retry')}
            </button>
          </div>
        ) : works === null ? (
          <div className="card-grid" aria-label={t('common.loading')}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="wcard wcard--skeleton">
                <div className="skel wcard__cover" />
                <div className="skel skel--line" style={{ width: '80%' }} />
                <div className="skel skel--line" style={{ width: '50%' }} />
              </div>
            ))}
          </div>
        ) : works.length === 0 && !filtering ? (
          <div className="state-card state-card--dashed">
            <Icon name="library" size={28} />
            <span className="state-card__title">{t('library.empty')}</span>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setMenuOpen(true);
              }}
            >
              {t('library.new')}
            </button>
          </div>
        ) : type !== 'all' && ofType.length === 0 && appliedQuery.trim() === '' ? (
          <TypeEmpty type={type} busy={creating} onCreate={create} />
        ) : shown.length === 0 ? (
          <div className="state-card state-card--dashed">
            <Icon name="search" size={28} />
            <span className="state-card__title">{t('library.noMatches')}</span>
            <button type="button" className="btn" onClick={clearFilters}>
              {t('library.clearFilters')}
            </button>
          </div>
        ) : view === 'grid' ? (
          <ul className="card-grid">
            {shown.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className={isMissing(w) ? 'wcard wcard--missing' : 'wcard'}
                  onClick={() => {
                    onOpen(w.id);
                  }}
                >
                  <CardCover work={w} />
                  <span className="wcard__body">
                    <span className="wcard__title">{w.title}</span>
                    <span className="wcard__meta">
                      <Chip tone={WORK_STATUS[w.status].tone}>{WORK_STATUS[w.status].label}</Chip>
                      <span>{WORK_TYPE[w.type].label}</span>
                      {isMissing(w) && <MissingChip />}
                    </span>
                    <span className="wcard__meta wcard__meta--muted">
                      <span title={externalSource(w, mounts, userHome)?.file ?? undefined}>
                        {externalSource(w, mounts, userHome)?.label ?? sourceLabel(w)}
                      </span>
                      <span className="wcard__when">{formatWhen(w.updated_at)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t('library.colTitle')}</th>
                  <th scope="col">{t('library.colType')}</th>
                  <th scope="col">{t('library.colStatus')}</th>
                  <th scope="col">{t('library.colSource')}</th>
                  <th scope="col">{t('library.colTags')}</th>
                  <th scope="col" className="tbl__right">
                    {t('library.colUpdated')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <span className="tbl__title">
                        <button
                          type="button"
                          className="tbl__open"
                          onClick={() => {
                            onOpen(w.id);
                          }}
                        >
                          <span
                            className={
                              isMissing(w) ? 'tbl__thumb tbl__thumb--missing' : 'tbl__thumb'
                            }
                            aria-hidden="true"
                          >
                            <Icon name={WORK_TYPE[w.type].icon} size={14} />
                          </span>
                          {w.title}
                        </button>
                        {w.storage_mode === 'external' && (
                          <span
                            className="src-ext src-ext--small"
                            title={externalSource(w, mounts, userHome)?.folder ?? undefined}
                          >
                            <Icon name="folder" size={11} />
                            {t('library.externalBadge')}
                          </span>
                        )}
                        {isMissing(w) && <MissingChip />}
                      </span>
                    </td>
                    <td className="muted">{WORK_TYPE[w.type].label}</td>
                    <td>
                      <Chip tone={WORK_STATUS[w.status].tone}>{WORK_STATUS[w.status].label}</Chip>
                    </td>
                    <td className="muted">
                      {externalSource(w, mounts, userHome)?.label ?? sourceLabel(w)}
                    </td>
                    <td className="faint">{w.tags.map((tag) => `#${tag}`).join(' ')}</td>
                    <td className="faint tbl__right">{formatWhen(w.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function MissingChip() {
  return (
    <span className="chip chip--bad">
      <Icon name="fileMissing" size={12} />
      {t('library.fileMissing')}
    </span>
  );
}

const TYPE_EMPTY_KEY = {
  article: 'library.emptyArticle',
  image: 'library.emptyImage',
  video: 'library.emptyVideo',
  mixed: 'library.emptyArticle',
} as const;
const TYPE_NEW_KEY = {
  article: 'library.newArticle',
  image: 'library.newImage',
  video: 'library.newVideo',
  mixed: 'library.newArticle',
} as const;

const TYPE_HINT_KEY = {
  article: 'library.newArticleHint',
  image: 'library.newImageHint',
  video: 'library.newVideoHint',
  mixed: 'library.newArticleHint',
} as const;

/**
 * 新建 with a type menu (PT-20261121-001 「v3 · 新建」): 文章／貼圖／視頻, ↑↓ to
 * move, 1–3 to pick, ↩ to create, esc to close; ⌘N opens it.
 */
function NewMenu({
  open,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (type: WorkType) => void;
}) {
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setAt(0);
    requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target) !== true)
        onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onOpenChange]);
  const focusAt = (i: number) => {
    setAt(i);
    root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[i]?.focus();
  };
  const pick = (i: number) => {
    const item = NEW_TYPES[i];
    if (item?.enabled === true) onCreate(item.type);
  };
  return (
    <div className="new-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="btn btn--primary"
        aria-keyshortcuts="Meta+N"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        <Icon name="plus" />
        {t('library.new')}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div
          className="pop new-menu__pop"
          role="menu"
          aria-label={t('library.newMenu')}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              onOpenChange(false);
              button.current?.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = NEW_TYPES.length;
              focusAt((at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
            } else if (/^[1-3]$/.test(e.key)) {
              e.preventDefault();
              pick(Number(e.key) - 1);
            }
          }}
        >
          {NEW_TYPES.map((item, i) => (
            <button
              key={item.type}
              type="button"
              role="menuitem"
              className="pop__item new-menu__item"
              aria-disabled={!item.enabled}
              tabIndex={i === at ? 0 : -1}
              onFocus={() => {
                setAt(i);
              }}
              onClick={() => {
                pick(i);
              }}
            >
              <Icon name={WORK_TYPE[item.type].icon} size={16} />
              <span className="new-menu__text">
                <span>{WORK_TYPE[item.type].label}</span>
                <span className="new-menu__hint">{t(TYPE_HINT_KEY[item.type])}</span>
              </span>
              <kbd>{i + 1}</kbd>
            </button>
          ))}
          <div className="pop__sep" />
          <div className="pop__keys">
            <span>{t('library.newKeysMove')}</span>
            <span>{t('library.newKeysPick')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** A type with no works yet: say so and offer to make one (video waits for QC-046). */
function TypeEmpty({
  type,
  busy,
  onCreate,
}: {
  type: WorkType;
  busy: boolean;
  onCreate: (type: WorkType) => void;
}) {
  const enabled = NEW_TYPES.find((n) => n.type === type)?.enabled === true;
  return (
    <div className="state-card state-card--dashed">
      <Icon name={WORK_TYPE[type].icon} size={28} />
      <span className="state-card__title">{t(TYPE_EMPTY_KEY[type])}</span>
      <span className="state-card__detail">{t(TYPE_HINT_KEY[type])}</span>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!enabled || busy}
        onClick={() => {
          onCreate(type);
        }}
      >
        <Icon name="plus" />
        {t(TYPE_NEW_KEY[type])}
      </button>
    </div>
  );
}

/**
 * The card's picture (PT-20261121-001): an image post shows its cover or
 * first image and how many images; a video its cover frame, length and
 * orientation; an article (no picture) its type icon.
 */
function CardCover({ work }: { work: WorkListItem }) {
  const thumb = work.thumbnail ?? null;
  const assetId = thumb?.asset_id ?? null;
  return (
    <span className="wcard__cover" aria-hidden="true">
      {thumb === null || assetId === null ? (
        <Icon name={WORK_TYPE[work.type].icon} size={28} />
      ) : thumb.kind === 'video' ? (
        <video
          className="wcard__media"
          src={`${assetMediaUrl(assetId)}#t=${String(thumb.time_seconds ?? 0.1)}`}
          muted
          preload="metadata"
        />
      ) : (
        <img className="wcard__media" src={thumbnailUrl(assetId)} alt="" loading="lazy" />
      )}
      {work.type === 'image' && work.image_count != null && work.image_count > 0 && (
        <span className="wcard__badge">
          <Icon name="image" size={12} />
          {t('library.imageCount', { count: work.image_count })}
        </span>
      )}
      {work.type === 'video' && work.duration_seconds != null && (
        <span className="wcard__badge">
          {formatDuration(work.duration_seconds)}
          {work.orientation === 'portrait'
            ? ` · ${t('library.portrait')}`
            : work.orientation === 'landscape'
              ? ` · ${t('library.landscape')}`
              : ''}
        </span>
      )}
      {(work.missing_media ?? 0) > 0 && (
        <span className="wcard__badge wcard__badge--bad">
          <Icon name="fileMissing" size={12} />
          {t('library.mediaMissing', { count: work.missing_media ?? 0 })}
        </span>
      )}
    </span>
  );
}
