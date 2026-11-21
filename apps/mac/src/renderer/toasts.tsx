import { useEffect, useId, useSyncExternalStore } from 'react';
import { Icon, type IconName } from './Icon.js';
import { t } from './i18n.js';

/**
 * One queue for every notice in the app (editor, tabs, assets, …): at most
 * `MAX_VISIBLE` show at once, stacked from the bottom with the newest lowest,
 * so two notices never cover each other. Pages keep their own notice state
 * and declare what they want shown with `useToast`; the queue only places it.
 */

export const MAX_VISIBLE = 2;

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
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit();
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

/** Where the queue is drawn: once, at the bottom centre of the window. */
export function ToastHost({ queue = toastQueue }: { queue?: ToastQueue }) {
  const shown = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  if (shown.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {shown.map((e) => {
        const entry = (): ToastEntry | undefined => queue.all.find((x) => x.id === e.id);
        const icon = e.icon ?? (e.tone === 'ok' ? 'check' : e.tone === 'bad' ? 'alert' : 'info');
        return (
          <div
            key={e.id}
            className={e.tone === 'bad' ? 'toast toast--bad' : 'toast'}
            role="status"
            data-toast
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
                (entry() ?? e).onClose();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
