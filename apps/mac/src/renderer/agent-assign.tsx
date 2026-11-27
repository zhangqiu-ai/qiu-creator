import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Project, WorkProjectMembership } from '@qiu-creator/contracts';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { formatWhen } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { ProjectLabel } from './LibraryProjects.js';
import { projectColor, projectLabel } from './projects-store.js';
import { reasonsText, scoreText } from './project-rules-ui.js';
import { Avatar } from './ProposalView.js';
import './agents-settings.css';

/**
 * Who put works into projects (QC-091 on the QC-092 API), read once per work
 * that has projects and kept until its memberships change. A few requests
 * at a time, so a long library does not flood the service.
 */
export class MembershipCache {
  private readonly items = new Map<string, readonly WorkProjectMembership[]>();
  private readonly asked = new Set<string>();
  private readonly queue: string[] = [];
  private running = 0;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly load: (workId: string) => Promise<readonly WorkProjectMembership[]>,
    private readonly parallel = 4,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  get(workId: string): readonly WorkProjectMembership[] | undefined {
    return this.items.get(workId);
  }

  /** Read this work's memberships if they are not known yet. */
  want(workId: string): void {
    if (this.asked.has(workId)) return;
    this.asked.add(workId);
    this.queue.push(workId);
    this.pump();
  }

  /** Its memberships changed (an event): read them again next time they are wanted. */
  invalidate(workId: string): void {
    if (!this.asked.has(workId)) return;
    this.asked.delete(workId);
    this.want(workId);
  }

  set(workId: string, items: readonly WorkProjectMembership[]): void {
    this.items.set(workId, items);
    this.asked.add(workId);
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private pump(): void {
    while (this.running < this.parallel && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      this.running++;
      this.load(id)
        .then(
          (items) => {
            this.items.set(id, items);
            this.bump();
          },
          () => {
            // Asked again on the next change event; nothing to show meanwhile.
            this.asked.delete(id);
          },
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

export const MembershipContext = createContext<{
  cache: MembershipCache;
  client: CreatorHubClient;
  notifyError: (message: string) => void;
} | null>(null);

/** Agent or rule put it there (not the user's own choice). */
export function byAgent(m: WorkProjectMembership): boolean {
  return m.added_by.kind !== 'user';
}

/**
 * A card's project label (QC-069), with QC-091's mark when an agent or a
 * rule put the work in that project: a blue outline and the agent icon,
 * and a popover saying who, when, how sure and why, with 保留（改為手動）
 * and 復原歸入.
 */
export function WorkProjectLabel({
  workId,
  projectIds,
  projects,
  currentId,
}: {
  workId: string;
  projectIds: readonly string[] | undefined;
  projects: readonly Project[];
  currentId: string | null;
}) {
  const ctx = useContext(MembershipContext);
  const has = (projectIds ?? []).length > 0;
  useEffect(() => {
    if (ctx !== null && has) ctx.cache.want(workId);
  }, [ctx, has, workId]);
  useSyncExternalStore(ctx?.cache.subscribe ?? noSubscribe, ctx?.cache.getVersion ?? zero);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  const members = ctx?.cache.get(workId) ?? [];
  const label = projectLabel(projectIds, projects, currentId);
  const agentMember =
    label === null
      ? undefined
      : members.find(
          (m) => byAgent(m) && [label.first, ...label.others].some((p) => p.id === m.project_id),
        );
  if (ctx === null || label === null || agentMember === undefined) {
    return <ProjectLabel projectIds={projectIds} projects={projects} currentId={currentId} />;
  }
  const project = projects.find((p) => p.id === agentMember.project_id) ?? label.first;
  const others = [label.first, ...label.others].filter((p) => p.id !== project.id);
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    // The card itself opens the work: this only opens the explanation.
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
        className="plabel plabel--agent"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('agents.assignedAria', { project: project.name })}
        title={[project, ...others].map((p) => p.name).join('、')}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle(e);
        }}
      >
        <Icon name="robot" size={11} />
        <span className="plabel__name">{project.name}</span>
        {others.length > 0 && <span className="plabel__more num">+{others.length}</span>}
      </span>
      {open &&
        anchor.current !== null &&
        createPortal(
          <AssignPopover
            anchor={anchor.current}
            workId={workId}
            member={agentMember}
            color={projectColor(project.color)}
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

const noSubscribe = (): (() => void) => () => undefined;
const stop = (e: { stopPropagation: () => void }): void => {
  e.stopPropagation();
};
const zero = (): number => 0;

function AssignPopover({
  anchor,
  workId,
  member,
  color,
  onClose,
}: {
  anchor: HTMLElement;
  workId: string;
  member: WorkProjectMembership;
  color: string;
  onClose: () => void;
}) {
  const ctx = useContext(MembershipContext);
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340));
  const top = Math.min(rect.bottom + 6, window.innerHeight - 200);

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
    // Only a scroll that moves the label (the popover is fixed to where it was).
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && e.target.contains(anchor)) onClose();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose, anchor]);

  if (ctx === null) return null;
  const by = member.added_by;
  const who = by.token_name;
  const act = (kind: 'keep' | 'undo') => {
    if (busy) return;
    setBusy(true);
    const run =
      kind === 'keep'
        ? ctx.client.projects.keepMembership(workId, member.project_id)
        : ctx.client.projects.undoMembership(workId, member.project_id);
    run
      .then((res) => {
        ctx.cache.set(workId, res.items);
        onClose();
      })
      .catch((err: unknown) => {
        setBusy(false);
        ctx.notifyError(
          err instanceof ApiError && err.code === 'membership_manual'
            ? t('agents.assignManualAlready')
            : t('agents.assignFailed'),
        );
      });
  };

  return (
    <div
      ref={box}
      className="as-pop"
      role="dialog"
      aria-label={
        who === null
          ? t('agents.assignedByRule', { project: member.project_name })
          : t('agents.assignedBy', { who, project: member.project_name })
      }
      style={{ left, top }}
      // A portal still bubbles through the React tree: keep clicks from reaching the card.
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
      onDoubleClick={stop}
    >
      <div className="as-pop__head">
        {who === null ? (
          <span className="as-pop__dot" style={{ background: color }} />
        ) : (
          <Avatar name={who} size={24} />
        )}
        <b>
          {who === null
            ? t('agents.assignedByRule', { project: member.project_name })
            : t('agents.assignedBy', { who, project: member.project_name })}
        </b>
      </div>
      <p className="faint as-pop__meta">
        {formatWhen(by.at)}
        {' · '}
        {by.score === null
          ? t('agents.assignedAgent')
          : t('agents.assignedAuto', { score: scoreText(by.score) })}
      </p>
      {by.reasons.length > 0 && (
        <p className="as-pop__why">
          {t('agents.assignedReasons', { reasons: reasonsText(by.reasons) })}
        </p>
      )}
      <div className="as-pop__actions">
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() => {
            act('keep');
          }}
        >
          {t('agents.keepManual')}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          disabled={busy}
          onClick={() => {
            act('undo');
          }}
        >
          <Icon name="undo" size={12} />
          {t('agents.undoAssign')}
        </button>
      </div>
    </div>
  );
}
