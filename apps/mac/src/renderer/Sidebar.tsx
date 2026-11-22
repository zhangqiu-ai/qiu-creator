import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { Icon, type IconName } from './Icon.js';
import {
  clampWidth,
  isToggleShortcut,
  limitLabel,
  loadPrefs,
  savePrefs,
  SIDEBAR_DEFAULT,
  SIDEBAR_FORCE_RAIL_BELOW,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_RAIL,
  widthForKey,
  type PrefStorage,
  type ServiceSummary,
} from './sidebar-prefs.js';
import type { MessageKey } from '@qiu-creator/i18n';
import { t } from './i18n.js';
import { morphSidebar, snapshotSidebar, type SidebarSnapshot } from './sidebar-morph.js';

export type NavPage = 'library' | 'assets' | 'imports' | 'ai' | 'preview' | 'settings';

interface NavItem {
  page: NavPage;
  label: string;
  icon: IconName;
}

/**
 * Groups (QC-069, PT-20261122-001): the works' scopes and the projects come
 * first (from App), then 素材 and 工具; 最近刪除 and 設定 sit in the fixed foot.
 * 發布中心 waits for M4.
 */
const nav = (page: NavPage, key: MessageKey, icon: IconName): NavItem => ({
  page,
  get label() {
    return t(key);
  },
  icon,
});
const GROUPS: readonly { id: string; title: MessageKey; items: readonly NavItem[] }[] = [
  {
    id: 'assets',
    title: 'shell.groupAssets',
    items: [
      nav('assets', 'shell.navAssets', 'assets'),
      nav('imports', 'shell.navImports', 'imports'),
    ],
  },
  {
    id: 'tools',
    title: 'shell.groupTools',
    items: [nav('ai', 'shell.navAi', 'spark'), nav('preview', 'shell.navPreview', 'phone')],
  },
];
/** 全部作品 while the service is not there to list projects. */
const ALL_WORKS: NavItem = nav('library', 'shell.navAllWorks', 'library');
const SETTINGS: NavItem = nav('settings', 'shell.navSettings', 'settings');

function storage(): PrefStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useNarrowWindow(): boolean {
  const query = `(max-width: ${String(SIDEBAR_FORCE_RAIL_BELOW - 1)}px)`;
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

/** The q mark of the App icon (PT-20261119-001 「v2 · App 圖示」 option B). */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="sb__mark">
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="15"
        fill="#1C1B19"
        stroke="rgba(255,255,255,.14)"
        strokeWidth="2"
      />
      <circle cx="29" cy="29" r="11.5" fill="none" stroke="#F6F5F1" strokeWidth="7" />
      <path d="M40.5 21v21" stroke="#F6F5F1" strokeWidth="7" strokeLinecap="round" />
      <circle cx="40.5" cy="51" r="5" fill="#8EA2FF" />
    </svg>
  );
}

export interface SidebarProps {
  current: NavPage;
  onNavigate: (page: NavPage) => void;
  /** Queued and running imports, shown beside 匯入任務. */
  importsCount: number;
  service: ServiceSummary;
  /** `127.0.0.1:7420` */
  address: string;
  onRecheck: () => void;
  /** 全部作品, 未分類 and the 項目 section, at the top (QC-062, QC-069). */
  projects?: (rail: boolean) => ReactNode;
  /** 最近刪除, in the foot above 設定 (QC-069). */
  foot?: (rail: boolean) => ReactNode;
}

/**
 * Sidebar v2: 232 px by default, drag the right edge between 200 and 320,
 * double-click to reset, ⌃⌘S or the button to collapse into a 56 px icon rail
 * with tooltips. Width and collapsed state are remembered on this Mac.
 */
export function Sidebar({
  current,
  onNavigate,
  importsCount,
  service,
  address,
  onRecheck,
  projects,
  foot,
}: SidebarProps) {
  const [prefs, setPrefs] = useState(() => loadPrefs(storage()));
  const narrow = useNarrowWindow();
  const rail = prefs.collapsed || narrow;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const update = useCallback((next: Partial<typeof prefs>) => {
    setPrefs((p) => {
      const merged = { ...p, ...next, width: clampWidth(next.width ?? p.width) };
      savePrefs(storage(), merged);
      return merged;
    });
  }, []);

  const navRef = useRef<HTMLElement>(null);
  /** The sidebar as it looked before a collapse or expand, for the transition (QC-068). */
  const morph = useRef<SidebarSnapshot | null>(null);
  useLayoutEffect(() => {
    const snap = morph.current;
    morph.current = null;
    morphSidebar(navRef.current, snap);
  }, [rail]);

  const toggle = useCallback(() => {
    morph.current = snapshotSidebar(navRef.current);
    setPrefs((p) => {
      const merged = { ...p, collapsed: !p.collapsed };
      savePrefs(storage(), merged);
      return merged;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToggleShortcut(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [toggle]);

  const width = rail ? SIDEBAR_RAIL : prefs.width;
  const railArea = useRef<HTMLDivElement>(null);
  const railFoot = useRef<HTMLDivElement>(null);
  const tip = useRailTip(rail, railArea, railFoot);
  const limit = dragging ? limitLabel(prefs.width) : null;
  const style: CSSProperties = { width, flexBasis: width };

  const item = (it: NavItem) => (
    <button
      key={it.page}
      type="button"
      className="sb__nav"
      aria-current={current === it.page ? 'page' : undefined}
      aria-label={it.label}
      data-tip={
        it.page === 'imports' && importsCount > 0
          ? t('shell.importsRunningTip', { label: it.label, count: importsCount })
          : it.label
      }
      onClick={() => {
        onNavigate(it.page);
      }}
    >
      <Icon name={it.icon} />
      <span className="sb__label">{it.label}</span>
      {it.page === 'imports' && importsCount > 0 && (
        <span className="sb__count">
          <span className="visually-hidden">{t('shell.importsRunning')}</span>
          {importsCount}
        </span>
      )}
    </button>
  );

  return (
    <nav
      ref={navRef}
      className={rail ? 'sb sb--rail' : dragging ? 'sb sb--dragging' : 'sb'}
      style={style}
      aria-label={t('shell.mainNav')}
    >
      <div className="sb__top">
        <div className="sb__brand">
          <button
            type="button"
            className="sb__logo"
            aria-label={rail ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            aria-keyshortcuts="Control+Meta+S"
            data-tip={
              narrow
                ? t('shell.narrowRail')
                : rail
                  ? t('shell.expandSidebarTip')
                  : t('shell.collapseSidebarTip')
            }
            disabled={narrow}
            onClick={toggle}
          >
            <BrandMark />
            <span className="sb__logo-swap" aria-hidden="true">
              <Icon name="sidebar" size={16} />
            </span>
          </button>
          <span className="sb__name">qiu-creator</span>
        </div>
        <span className={`sb__svc sb__svc--${service.tone}`}>
          <button
            type="button"
            className="sb__dot"
            aria-label={service.title}
            aria-describedby="sb-svc-pop"
          />
          <div className="sb__pop" id="sb-svc-pop" role="tooltip">
            <div className="sb__pop-row sb__pop-title">{service.title}</div>
            <div className="sb__pop-row">
              <span>{t('shell.popService')}</span>
              <span className="sb__pop-v mono">{address}</span>
            </div>
            <div className="sb__pop-row">
              <span>{t('shell.popRealtime')}</span>
              <span className="sb__pop-v">{service.realtime}</span>
            </div>
            <div className="sb__pop-row">
              <span>Agent API</span>
              <span className="sb__pop-v">{service.agentApi}</span>
            </div>
            <div className="sb__pop-row">
              <span>{t('shell.popVersion')}</span>
              <span className="sb__pop-v mono">{service.version}</span>
            </div>
            {service.tone === 'bad' && (
              <div className="sb__pop-row sb__pop-actions">
                <button type="button" className="btn btn--small" onClick={onRecheck}>
                  {t('common.recheck')}
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    onNavigate('settings');
                  }}
                >
                  {t('shell.serviceSettings')}
                </button>
              </div>
            )}
          </div>
        </span>
      </div>

      <div className="sb__scroll" ref={railArea}>
        {projects === undefined ? (
          <div className="sb__grp" role="group" aria-label={t('shell.groupWorks')}>
            {item(ALL_WORKS)}
          </div>
        ) : (
          projects(rail)
        )}
        {GROUPS.map((g) => (
          <div key={g.id} className="sb__grp" role="group" aria-label={t(g.title)}>
            <div className="sb__grp-h" aria-hidden="true">
              {t(g.title)}
            </div>
            {g.items.map((it) => item(it))}
          </div>
        ))}
      </div>

      <div className="sb__foot" ref={railFoot}>
        {foot?.(rail)}
        {item(SETTINGS)}
      </div>
      {rail && tip !== null && (
        <div className="sb__railtip" role="tooltip" style={{ top: tip.y, left: tip.x }}>
          {tip.text}
        </div>
      )}

      {!rail && (
        <div
          className={limit === null ? 'sb__handle' : 'sb__handle sb__handle--lim'}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('shell.resizeSidebar')}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={prefs.width}
          tabIndex={0}
          title={t('shell.resizeSidebarTip')}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { startX: e.clientX, startWidth: prefs.width };
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d === null) return;
            setPrefs((p) => ({ ...p, width: clampWidth(d.startWidth + e.clientX - d.startX) }));
          }}
          onPointerUp={(e) => {
            if (drag.current === null) return;
            const d = drag.current;
            drag.current = null;
            setDragging(false);
            update({ width: d.startWidth + e.clientX - d.startX });
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => {
            update({ width: SIDEBAR_DEFAULT });
          }}
          onKeyDown={(e) => {
            const next = widthForKey(prefs.width, e.key);
            if (next === null) return;
            e.preventDefault();
            update({ width: next });
          }}
        >
          {limit !== null && <span className="sb__handle-tip">{limit}</span>}
        </div>
      )}
    </nav>
  );
}

/**
 * The 56 px rail's tooltip (QC-065): the rail scrolls when there are many
 * projects, which would clip a CSS ::after tooltip, so one fixed element shows
 * the hovered or keyboard-focused item's `data-tip` beside it instead.
 */
function useRailTip(
  rail: boolean,
  scroll: RefObject<HTMLElement | null>,
  foot: RefObject<HTMLElement | null>,
): { text: string; x: number; y: number } | null {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!rail) {
      setTip(null);
      return;
    }
    const show = (target: EventTarget | null, keyboard: boolean) => {
      if (!(target instanceof Element)) return;
      const el = target.closest<HTMLElement>('[data-tip]');
      if (el === null || (keyboard && !el.matches(':focus-visible'))) return;
      const box = el.getBoundingClientRect();
      // Just past the rail's edge, level with the item.
      const edge = el.closest('.sb')?.getBoundingClientRect().right ?? box.right;
      setTip({ text: el.dataset['tip'] ?? '', x: edge + 6, y: box.top + box.height / 2 });
    };
    const over = (e: PointerEvent) => {
      show(e.target, false);
    };
    const focus = (e: FocusEvent) => {
      show(e.target, true);
    };
    const hide = () => {
      setTip(null);
    };
    const nodes = [scroll.current, foot.current].filter((n): n is HTMLElement => n !== null);
    for (const n of nodes) {
      n.addEventListener('pointerover', over);
      n.addEventListener('pointerleave', hide);
      n.addEventListener('focusin', focus);
      n.addEventListener('focusout', hide);
      n.addEventListener('scroll', hide);
    }
    return () => {
      for (const n of nodes) {
        n.removeEventListener('pointerover', over);
        n.removeEventListener('pointerleave', hide);
        n.removeEventListener('focusin', focus);
        n.removeEventListener('focusout', hide);
        n.removeEventListener('scroll', hide);
      }
    };
  }, [rail, scroll, foot]);
  return tip;
}
