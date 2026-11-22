import { useEffect, useId, useSyncExternalStore } from 'react';
import { Icon, type IconName } from './Icon.js';
import { t } from './i18n.js';
import { Animated, Presence, springOf } from './motion.js';
import { moves, useMotionMode } from './motion-mode.js';

/**
 * One queue for every notice in the app (editor, tabs, assets, …): at most
 * `MAX_VISIBLE` show at once, stacked from the bottom with the newest lowest,
 * so two notices never cover each other. Pages keep their own notice state
 * and declare what they want shown with `useToast`; the queue only places it.
 */

/** DESIGN.md 動效 · Toast: at most three at once (QC-065; was two). */
export const MAX_VISIBLE = 3;

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** e.g. `Meta+Z` for 復原. */
  shortcut?: string;
}

export interface ToastSpec {
  message: string;
  tone?: 'neutral' | 'ok' | 'bad';
  /** Defaults by tone: check for ok, alert for bad, info otherwise. */
  icon?: IconName;
  actions?: readonly ToastAction[];
  /** The × button. */
  onClose: () => void;
  /** Accessible name of the × button. */
  closeLabel?: string;
}

export interface ToastEntry extends ToastSpec {
  id: string;
  /** Order of arrival; a toast keeps its place while its content updates. */
  seq: number;
}

function sameShown(a: ToastSpec, b: ToastSpec): boolean {
  const labels = (s: ToastSpec) => (s.actions ?? []).map((x) => x.label).join('\u0000');
  return (
    a.message === b.message &&
    a.tone === b.tone &&
    a.icon === b.icon &&
    a.closeLabel === b.closeLabel &&
    labels(a) === labels(b)
  );
}

export class ToastQueue {
  private entries: ToastEntry[] = [];
  private visibleCache: readonly ToastEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  /** The pointer or focus is on a toast: timed removals wait (DESIGN.md 動效 · Toast). */
  private held = false;
  private readonly waiting = new Set<string>();
  /** Closed by the person (×, 復原 …): goes at once even while held. */
  private readonly closing = new Set<string>();

  constructor(private readonly max: number = MAX_VISIBLE) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The toasts on screen, oldest first (drawn top to bottom). */
  getSnapshot = (): readonly ToastEntry[] => this.visibleCache;

  /** Everything waiting or shown, oldest first. */
  get all(): readonly ToastEntry[] {
    return this.entries;
  }

  private emit(): void {
    this.visibleCache = this.entries.slice(-this.max);
    for (const l of this.listeners) l();
  }

  /** Show or update the toast `id`. Updating keeps its place in the stack. */
  set(id: string, spec: ToastSpec): void {
    this.waiting.delete(id);
    this.closing.delete(id);
    const existing = this.entries.find((e) => e.id === id);
    if (existing === undefined) {
      this.entries = [...this.entries, { ...spec, id, seq: ++this.seq }];
      this.emit();
      return;
    }
    const changed = !sameShown(existing, spec);
    // Callbacks are refreshed silently: they change on every render of the page.
    this.entries = this.entries.map((e) => (e.id === id ? { ...spec, id, seq: e.seq } : e));
    if (changed) this.emit();
    else this.visibleCache = this.entries.slice(-this.max);
  }

  remove(id: string): void {
    if (!this.entries.some((e) => e.id === id)) return;
    if (this.held && !this.closing.has(id)) {
      // A toast someone is reading or about to use stays until they move away.
      this.waiting.add(id);
      return;
    }
    this.closing.delete(id);
    this.waiting.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit();
  }

  /** The person closes or uses this toast: its removal does not wait for `hold(false)`. */
  closingByHand(id: string): void {
    this.closing.add(id);
  }

  /** Hold timed removals while the pointer or keyboard focus is on the toasts. */
  hold(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    if (on) return;
    const due = [...this.waiting];
    this.waiting.clear();
    for (const id of due) this.remove(id);
  }
}

export const toastQueue = new ToastQueue();

/** Show `spec` while it is non-null; it leaves the queue when null or on unmount. */
export function useToast(spec: ToastSpec | null, queue: ToastQueue = toastQueue): void {
  const id = useId();
  useEffect(() => {
    if (spec === null) queue.remove(id);
    else queue.set(id, spec);
  });
  useEffect(
    () => () => {
      queue.remove(id);
    },
    [id, queue],
  );
}

/**
 * Where the queue is drawn: once, at the bottom centre of the window
 * (DESIGN.md 動效 · Toast). A toast rises in (`base`) and fades out (`fast`);
 * the others slide to their new places (`snappy`). While the pointer or focus
 * is on a toast its countdown waits, so a toast someone is reading stays.
 */
export function ToastHost({ queue = toastQueue }: { queue?: ToastQueue }) {
  const shown = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const mode = useMotionMode();
  // Nothing left to read: a hold must not outlive the toasts.
  useEffect(() => {
    if (shown.length === 0) queue.hold(false);
  }, [shown.length, queue]);
  return (
    <div className="toast-stack" aria-live="polite">
      <Presence>
        {shown.map((e) => {
          const entry = (): ToastEntry | undefined => queue.all.find((x) => x.id === e.id);
          const icon = e.icon ?? (e.tone === 'ok' ? 'check' : e.tone === 'bad' ? 'alert' : 'info');
          const byHand = () => {
            queue.closingByHand(e.id);
            queue.hold(false);
          };
          return (
            <Animated
              key={e.id}
              preset={{ kind: 'toast', stacked: shown.length > 1 }}
              layout={moves(mode) ? 'position' : false}
              transition={springOf('snappy')}
              className={e.tone === 'bad' ? 'toast toast--bad' : 'toast'}
              role="status"
              data-toast
              onPointerEnter={() => {
                queue.hold(true);
              }}
              onPointerLeave={() => {
                queue.hold(false);
              }}
              onFocus={() => {
                queue.hold(true);
              }}
              onBlur={(ev) => {
                if (!ev.currentTarget.contains(ev.relatedTarget)) queue.hold(false);
              }}
            >
              <Icon name={icon} size={16} />
              <span className="toast__msg">{e.message}</span>
              {(e.actions ?? []).map((a, i) => (
                <button
                  key={a.label}
                  type="button"
                  className="btn btn--ghost btn--small toast__undo"
                  aria-keyshortcuts={a.shortcut}
                  onClick={() => {
                    byHand();
                    // The latest callback, not the one from when this toast first rendered.
                    (entry()?.actions?.[i] ?? a).onClick();
                  }}
                >
                  {a.label}
                </button>
              ))}
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--small"
                aria-label={e.closeLabel ?? t('editor.dismissNotice')}
                onClick={() => {
                  byHand();
                  (entry() ?? e).onClose();
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </Animated>
          );
        })}
      </Presence>
    </div>
  );
}
