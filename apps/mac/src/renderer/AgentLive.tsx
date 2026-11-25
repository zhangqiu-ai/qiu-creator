import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import type { CreatorHubClient } from '@qiu-creator/api-client';
import { createPortal } from 'react-dom';
import {
  agentsName,
  ANIMATE_MAX,
  EMPTY_LIVE,
  type AgentLiveStore,
  type LiveAgent,
  type LiveSnapshot,
  type WorkLiveView,
} from './agent-live.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { moves, useMotionMode } from './motion-mode.js';
import { Avatar } from './ProposalView.js';
import './agent-live.css';

/** The window's live snapshot (QC-097); null outside the app (nothing is shown). */
export const AgentLiveContext = createContext<AgentLiveStore | null>(null);

const noSubscribe = (): (() => void) => () => undefined;
const empty = (): LiveSnapshot => EMPTY_LIVE;

export function useLive(): LiveSnapshot {
  const store = useContext(AgentLiveContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? empty);
}

export function useWorkLive(workId: string): WorkLiveView | undefined {
  return useLive().works.get(workId);
}

export function namesOf(agents: readonly LiveAgent[]): string {
  return agentsName(agents, (name, count) =>
    t('live.moreAgents', { name, count }),
  );
}

/** The state in words, as the tag's second line says it. */
export function statusText(v: WorkLiveView): string {
  switch (v.state) {
    case 'working':
      return v.step ?? t('live.working');
    case 'done':
      return v.step ?? t('live.done');
    case 'needs_attention': {
      const base = v.step ?? t('live.needsAttention');
      const { added, removed } = v.counts;
      return added === undefined && removed === undefined
        ? base
        : `${base} · +${String(added ?? 0)} −${String(removed ?? 0)}`;
    }
    case 'error':
      return v.step ?? t('live.error');
    case 'stale':
      return t('live.stale', { minutes: Math.max(1, v.silentMinutes) });
  }
}

/** Up to two avatars, overlapping (several agents on one work). */
export function AgentStack({ agents, size = 20 }: { agents: readonly LiveAgent[]; size?: number }) {
  return (
    <span className="lv-stack" aria-hidden="true">
      {agents.slice(0, 2).map((a) => (
        <Avatar key={a.token_id} name={a.name} size={size} />
      ))}
    </span>
  );
}

/**
 * Three dots lighting in turn. On a card or row they run only while its
 * ring does (`.lv-anim` on the card); `free` ones (banner, popover) run in
 * full motion. Static otherwise.
 */
export function LiveDots({ free = false }: { free?: boolean }) {
  const mode = useMotionMode();
  return (
    <span className={free && moves(mode) ? 'lv-dots lv-dots--anim' : 'lv-dots'} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function StateIcon({ v }: { v: WorkLiveView }) {
  switch (v.state) {
    case 'working':
      return <LiveDots />;
    case 'done':
      return <Icon name="check" size={11} />;
    case 'needs_attention':
      return <Icon name="agentInbox" size={11} />;
    case 'error':
      return <Icon name="alert" size={11} />;
    case 'stale':
      return <Icon name="history" size={11} />;
  }
}

/**
 * Who is at work and on what (PT-20261125-001): avatar(s), the agent's
 * name (「X 等 N 個」), then the state — three dots and the agent's own step
 * while working, ✓ when done, the tray for a proposal, ⚠ for an error,
 * the clock when silent. The step is the agent's text, shown as data.
 */
export function AgentTag({ v, variant }: { v: WorkLiveView; variant: 'card' | 'row' }) {
  const names = namesOf(v.agents);
  const status = statusText(v);
  return (
    <span
      className={`lv-tag lv-tag--${variant} lv-tag--${v.state}`}
      role="status"
      aria-label={t('live.tagAria', { agents: names, status })}
      data-live-tag={v.state}
    >
      <AgentStack agents={v.agents} size={variant === 'card' ? 20 : 18} />
      <span className="lv-tag__text" aria-hidden="true">
        <span className="lv-tag__name">{names}</span>
        <span className="lv-tag__step">
          <StateIcon v={v} />
          <span className="lv-tag__step-text">{status}</span>
        </span>
      </span>
    </span>
  );
}

/**
 * Should this card's ring sweep and dots run? Only in full motion, only
 * while it is on screen, and only while at most {@link ANIMATE_MAX} works
 * are being worked on at once (beyond that every ring is static).
 */
export function useLiveAnimation(
  ref: RefObject<HTMLElement | null>,
  v: WorkLiveView | undefined,
): boolean {
  const mode = useMotionMode();
  const { workingWorks } = useLive();
  const wanted = v?.state === 'working' && moves(mode) && workingWorks <= ANIMATE_MAX;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!wanted || el === null || typeof IntersectionObserver === 'undefined') {
      setVisible(false);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      setVisible(entries.some((e) => e.isIntersecting));
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [ref, wanted]);
  return wanted && visible;
}

/**
 * The ring around a card or row: a light travelling the outline while
 * working (transform on a conic gradient inside a ring mask: no layout),
 * a green ring once when done, yellow/red/dashed outlines that never move.
 */
export function LiveRing({ v, animate }: { v: WorkLiveView; animate: boolean }) {
  return (
    <span
      className={`lv-ring lv-ring--${v.state}${animate ? ' lv-ring--anim' : ''}`}
      aria-hidden="true"
    >
      {v.state === 'working' && <span className="lv-ring__sweep" />}
    </span>
  );
}

/** Cover skeleton for a work an agent is still creating (no cover yet). */
export function LiveSkeleton({ animate }: { animate: boolean }) {
  return (
    <span className={animate ? 'lv-skel lv-skel--anim' : 'lv-skel'} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** A spot of breath (the editor tab, the header, the sidebar pill). */
export function LiveDot({ label }: { label?: string }) {
  const mode = useMotionMode();
  return (
    <span
      className={moves(mode) ? 'lv-dot lv-dot--anim' : 'lv-dot'}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  );
}

/**
 * 「● N」 beside 全部作品 or a project (PT-20261125-001 decision 5): how many
 * agents are working there; it opens a popover listing them, their works
 * and a link to the activity log. A span acting as a button, because the
 * sidebar row it sits in is a button.
 */
export function LivePill({
  count,
  projectId,
  onOpenActivity,
}: {
  count: number;
  /** Only agents working in this project; all when absent. */
  projectId?: string;
  onOpenActivity: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  if (count <= 0) return null;
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setOpen((o) => !o);
  };
  return (
    <>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        className="lv-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('live.pillAria', { count })}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle(e);
        }}
      >
        <LiveDot />
        <span className="num">{count}</span>
      </span>
      {open &&
        anchor.current !== null &&
        createPortal(
          <LivePopover
            anchor={anchor.current}
            projectId={projectId}
            onOpenActivity={() => {
              setOpen(false);
              onOpenActivity();
            }}
            onClose={() => {
              setOpen(false);
              anchor.current?.focus();
            }}
          />,
          document.body,
        )}
    </>
  );
}

const stop = (e: { stopPropagation: () => void }): void => {
  e.stopPropagation();
};

function LivePopover({
  anchor,
  projectId,
  onOpenActivity,
  onClose,
}: {
  anchor: HTMLElement;
  projectId: string | undefined;
  onOpenActivity: () => void;
  onClose: () => void;
}) {
  const snap = useLive();
  const box = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(rect.right + 8, window.innerWidth - 316);
  const top = Math.max(8, Math.min(rect.top - 12, window.innerHeight - 240));
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const rows = snap.agents
    .map((a) => ({
      agent: a.agent,
      works:
        projectId === undefined
          ? a.works
          : a.works.filter((w) => snap.works.get(w.id)?.projectIds.includes(projectId) === true),
    }))
    .filter((a) => a.works.length > 0);
  return (
    <div
      ref={box}
      className="lv-pop"
      role="dialog"
      aria-label={t('live.popTitle')}
      style={{ left, top }}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
    >
      <div className="lv-pop__title">{t('live.popTitle')}</div>
      <ul className="lv-pop__list">
        {rows.map(({ agent, works }) => (
          <li key={agent.token_id} className="lv-pop__row">
            <Avatar name={agent.name} size={26} />
            <span className="lv-pop__main">
              <b>{agent.name}</b>
              <span className="faint lv-pop__works">
                {t('live.popWorks', {
                  count: works.length,
                  titles: works.map((w) => w.title ?? t('live.untitled')).join(t('live.listSep')),
                })}
              </span>
            </span>
            <LiveDots free />
          </li>
        ))}
      </ul>
      <button type="button" className="link-btn lv-pop__link" onClick={onOpenActivity}>
        {t('live.activityLink')}
        <Icon name="chevronRight" size={12} />
      </button>
    </div>
  );
}

/**
 * Everything live on a work card (QC-097): the ring, the agent tag at the
 * cover's top left, and a skeleton over a cover not made yet. It watches
 * its own box to run the sweep only while on screen.
 */
export function LiveCardLayer({ v, hasCover }: { v: WorkLiveView; hasCover: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const animate = useLiveAnimation(ref, v);
  return (
    <span ref={ref} className={animate ? 'lv-layer lv-anim' : 'lv-layer'}>
      {v.state === 'working' && !hasCover && <LiveSkeleton animate={animate} />}
      <LiveRing v={v} animate={animate} />
      <AgentTag v={v} variant="card" />
    </span>
  );
}

/**
 * 審閱提案 / 重試 on a card or row that needs you (static). A span acting as
 * a button: the card it sits in is a button.
 */
export function LiveAction({
  v,
  onReview,
  onRetry,
}: {
  v: WorkLiveView;
  onReview: () => void;
  onRetry: () => void;
}) {
  if (v.state !== 'needs_attention' && v.state !== 'error') return null;
  const review = v.state === 'needs_attention';
  const failed = v.counts.failed;
  const label = review
    ? t('live.review')
    : failed === undefined
      ? t('live.retry')
      : t('live.retryCount', { count: failed });
  const act = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (review) onReview();
    else onRetry();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={review ? 'lv-act lv-act--warn' : 'lv-act lv-act--bad'}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') act(e);
      }}
    >
      {label}
    </span>
  );
}

/** A list row's live bits: the bar's state for `data-live`, and whether it may flow. */
export function useRowLive(
  ref: RefObject<HTMLElement | null>,
  workId: string,
): { v: WorkLiveView | undefined; animate: boolean } {
  const v = useWorkLive(workId);
  const animate = useLiveAnimation(ref, v);
  return { v, animate };
}

/**
 * The list's Agent column (QC-097): the agent tag, and the row's left bar
 * state (`data-live` on its row; it flows only while on screen in full
 * motion, like a card's ring).
 */
export function LiveAgentCell({ workId }: { workId: string }) {
  const ref = useRef<HTMLTableCellElement>(null);
  const { v, animate } = useRowLive(ref, workId);
  const state = v?.state;
  useEffect(() => {
    const row = ref.current?.closest('tr');
    if (row == null) return;
    if (state === undefined) delete row.dataset['live'];
    else row.dataset['live'] = state;
    row.classList.toggle('lv-anim', animate);
    return () => {
      delete row.dataset['live'];
      row.classList.remove('lv-anim');
    };
  }, [state, animate]);
  return (
    <td ref={ref} className="tbl__live">
      {v === undefined ? (
        <span className="faint" aria-hidden="true">
          {t('live.noAgent')}
        </span>
      ) : (
        <AgentTag v={v} variant="row" />
      )}
    </td>
  );
}

/** 「● N 個 Agent 工作中」 beside a page title; nothing when none. */
export function LiveHeader({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <span aria-hidden="true"> · </span>
      <span className="lv-head">
        <LiveDot />
        {t('live.headerWorking', { count })}
      </span>
    </>
  );
}

/** Which agent tokens may edit text directly (read once per window; the owner's list). */
let directTokens: Promise<ReadonlySet<string>> | null = null;
function useDirectTokens(client: CreatorHubClient, wanted: boolean): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!wanted) return;
    directTokens ??= client.tokens.list().then(
      (r) => new Set(r.items.filter((x) => x.allow_direct_body_edit === true).map((x) => x.id)),
      () => {
        directTokens = null;
        return new Set<string>();
      },
    );
    let alive = true;
    void directTokens.then((s) => {
      if (alive) setIds(s);
    });
    return () => {
      alive = false;
    };
  }, [client, wanted]);
  return ids;
}

/** Forget the cached direct-edit tokens (the settings page changed one). */
export function forgetDirectTokens(): void {
  directTokens = null;
}

/**
 * The editor's 「X 正在處理這件作品」 bar (PT-20261125-001): who, each
 * agent's step, and what that means for your text — agents that can only
 * propose never change it; one that may edit directly writes through
 * base_revision, so while you type you get the yellow note that your
 * changes stay here and you will compare and merge (the existing 409 flow).
 */
export function LiveBanner({
  client,
  workId,
  typing,
  onSeeChanges,
  onOpenActivity,
}: {
  client: CreatorHubClient;
  workId: string;
  /** You have unsaved edits in this editor. */
  typing: boolean;
  onSeeChanges: () => void;
  onOpenActivity: () => void;
}) {
  const v = useWorkLive(workId);
  const working = v?.state === 'working';
  const direct = useDirectTokens(client, working);
  if (v === undefined || !working) return null;
  const names = v.agents.map((a) => a.name).join(t('live.listSep'));
  const anyDirect = v.agents.some((a) => direct.has(a.token_id));
  const steps =
    v.step === null ? null : t('live.stepOf', { name: v.agents[0]?.name ?? '', step: v.step });
  const tone = anyDirect ? (typing ? 'typing' : 'direct') : 'propose';
  return (
    <div className={`lv-banner lv-banner--${tone}`} role="status">
      <AgentStack agents={v.agents} size={26} />
      <div className="lv-banner__text">
        <span className="lv-banner__title">
          {t(anyDirect ? 'live.bannerDirect' : 'live.bannerWorking', { names })}
          <LiveDots free />
        </span>
        <span className="lv-banner__sub">
          {tone === 'typing'
            ? t('live.typing')
            : [
                steps,
                anyDirect
                  ? t('live.directHint')
                  : t(v.agents.length > 1 ? 'live.proposeOnlyMany' : 'live.proposeOnlyOne'),
              ]
                .filter((x): x is string => x !== null)
                .join(' ')}
        </span>
      </div>
      <div className="lv-banner__actions">
        {tone === 'typing' && (
          <button type="button" className="btn btn--small" onClick={onSeeChanges}>
            {t('live.seeChanges')}
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--small" onClick={onOpenActivity}>
          {t('live.activity')}
        </button>
      </div>
    </div>
  );
}
