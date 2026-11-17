import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Work, WorkDetail, WorkStatus, WorkType } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chip } from './Chip.js';
import { useRefreshOn } from './events.js';
import { formatWhen, sourceLabel, WORK_STATUS, WORK_TYPE } from './format.js';
import { Icon } from './Icon.js';
import { externalSource, useMounts } from './mounts.js';

type View = 'grid' | 'list';
type TypeFilter = 'all' | WorkType;
type StatusFilter = 'all' | WorkStatus;

const TYPE_FILTERS: readonly TypeFilter[] = ['all', 'article', 'image', 'video', 'mixed'];
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
  const [works, setWorks] = useState<readonly Work[] | null>(null);
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
    client.works
      .list({
        limit: 200,
        ...(q === '' ? {} : { q }),
        ...(type === 'all' ? {} : { type }),
      })
      .then((res) => {
        if (id === request.current) setWorks(res.items);
      })
      .catch(() => {
        if (id === request.current) setFailed(true);
      });
  }, [client, appliedQuery, type]);

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

  const create = useCallback(() => {
    if (creating) return;
    setCreating(true);
    client.works
      .create({ title: '未命名', markdown: '', source: 'mac-app' })
      .then(onCreated)
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        setCreating(false);
      });
  }, [client, creating, onCreated]);

  // ⌘N new work, ⌘F search; ignored during IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        create();
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
  }, [create]);

  const shown = useMemo(
    () => (works ?? []).filter((w) => status === 'all' || w.status === status),
    [works, status],
  );
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      drafting: 0,
      in_review: 0,
      ready: 0,
      published: 0,
    };
    for (const w of works ?? []) {
      c.all++;
      c[w.status]++;
    }
    return c;
  }, [works]);

  const filtering = appliedQuery.trim() !== '' || type !== 'all' || status !== 'all';
  const clearFilters = () => {
    setQuery('');
    setAppliedQuery('');
    setType('all');
    setStatus('all');
  };

  return (
    <main className="page" aria-label="作品庫">
      <header className="page__header">
        <h1 className="page__title">作品庫</h1>
        <span className="page__count">{works === null ? '' : shown.length}</span>
        <label className="search">
          <Icon name="search" />
          <span className="visually-hidden">搜尋作品</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="搜尋"
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
        <div className="seg" role="group" aria-label="檢視">
          {(['grid', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-label={v === 'grid' ? '網格' : '列表'}
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
        <button
          type="button"
          className="btn btn--primary"
          aria-keyshortcuts="Meta+N"
          disabled={creating}
          onClick={create}
        >
          <Icon name="plus" />
          新建
        </button>
      </header>

      <div className="filters">
        <div className="seg" role="group" aria-label="類型">
          {TYPE_FILTERS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={type === t}
              onClick={() => {
                setType(t);
              }}
            >
              {t === 'all' ? '全部' : WORK_TYPE[t].label}
            </button>
          ))}
        </div>
        <span className="filters__divider" aria-hidden="true" />
        <div className="filters__chips" role="group" aria-label="狀態">
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
              {s === 'all' ? '全部' : WORK_STATUS[s].label}
              <span className="fchip__n">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="page__body" aria-label="作品" aria-busy={works === null && !failed}>
        {failed ? (
          <div className="state-card" role="alert">
            <Icon name="offline" size={28} />
            <span className="state-card__title">本機服務未回應</span>
            <button type="button" className="btn btn--primary" onClick={load}>
              重試
            </button>
          </div>
        ) : works === null ? (
          <div className="card-grid" aria-label="載入中">
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
            <span className="state-card__title">還沒有作品</span>
            <button type="button" className="btn btn--primary" onClick={create}>
              新建
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="state-card state-card--dashed">
            <Icon name="search" size={28} />
            <span className="state-card__title">無符合作品</span>
            <button type="button" className="btn" onClick={clearFilters}>
              清除篩選
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
                  <span className="wcard__cover" aria-hidden="true">
                    <Icon name={WORK_TYPE[w.type].icon} size={28} />
                  </span>
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
                  <th scope="col">標題</th>
                  <th scope="col">類型</th>
                  <th scope="col">狀態</th>
                  <th scope="col">來源</th>
                  <th scope="col">標籤</th>
                  <th scope="col" className="tbl__right">
                    更新
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
                            外部
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
                    <td className="faint">{w.tags.map((t) => `#${t}`).join(' ')}</td>
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
      檔案遺失
    </span>
  );
}
