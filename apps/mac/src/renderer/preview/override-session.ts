import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  PatchVariantOverridesRequest,
  Platform,
  VariantCover,
  VariantView,
} from '@qiu-creator/contracts';
import { serviceErrorText } from '../restoring.js';

/**
 * One platform's overrides (QC-084, PT-20261123-001): title, cover, image
 * order and tags, each a value or null to follow the work. The body is never
 * stored here; it is derived from the editor's draft.
 *
 * - Title typing autosaves after a pause (never while an input method is
 *   composing); the other fields save at once.
 * - Every save carries `base_revision`. A 409 never overwrites: the fields
 *   being saved go into `conflict`, shown inside that field, with 保留我的
 *   (write mine on top of the latest) or 使用對方的 (take the latest).
 * - A newer revision from elsewhere is adopted when nothing is pending.
 */

export type OverrideField = 'title' | 'cover' | 'images' | 'tags';

export interface Pending {
  title?: string | null;
  cover?: VariantCover | null;
  images?: readonly string[] | null;
  tags?: readonly string[] | null;
}

export type OverrideStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface OverrideState {
  platform: Platform;
  view: VariantView;
  /** Local changes not yet saved (shown at once). */
  pending: Pending;
  status: OverrideStatus;
  /** A 409: the fields I was saving and the latest view from the server. */
  conflict: { fields: OverrideField[]; theirs: VariantView } | null;
  errorMessage: string | null;
  /** Bumped when values are replaced from the server, so inputs reload. */
  epoch: number;
}

const FIELDS: readonly OverrideField[] = ['title', 'cover', 'images', 'tags'];

/** The override a view holds for a field (null while it follows the work). */
export function overrideOf(view: VariantView, field: OverrideField): Pending[OverrideField] {
  if (field === 'title') return view.title_source === 'override' ? view.title : null;
  if (field === 'cover') return view.cover_source === 'override' ? view.cover : null;
  if (field === 'images') return view.images_source === 'override' ? view.images : null;
  return view.tags_source === 'override' ? view.tags : null;
}

/** Is the field overridden, counting what is pending? */
export function isOwn(
  state: Pick<OverrideState, 'view' | 'pending'>,
  field: OverrideField,
): boolean {
  if (field in state.pending) return state.pending[field] !== null;
  return overrideOf(state.view, field) !== null;
}

function patchOf(pending: Pending): PatchVariantOverridesRequest {
  const out: PatchVariantOverridesRequest = {};
  if ('title' in pending) out.title = pending.title ?? null;
  if ('cover' in pending) out.cover = pending.cover ?? null;
  if ('images' in pending)
    out.images = pending.images === null ? null : [...(pending.images ?? [])];
  if ('tags' in pending) out.tags = pending.tags === null ? null : [...(pending.tags ?? [])];
  return out;
}

export class OverrideSession {
  private state: OverrideState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private composing = false;
  private saving: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly workId: string,
    view: VariantView,
    private readonly autosaveMs = 800,
  ) {
    this.state = {
      platform: view.platform,
      view,
      pending: {},
      status: 'saved',
      conflict: null,
      errorMessage: null,
      epoch: 0,
    };
  }

  get snapshot(): OverrideState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    // Flush a typed title that has not been sent yet.
    if (this.timer !== null && !this.composing) void this.save();
    this.clearTimer();
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<OverrideState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A method, so checks after an await are not narrowed away. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  hasPending(): boolean {
    return Object.keys(this.state.pending).length > 0;
  }

  /** Set a field (a value, or null to follow the work again). */
  edit(change: Pending, immediate = true): void {
    if (this.disposed) return;
    this.set({ pending: { ...this.state.pending, ...change } });
    if (this.state.status === 'conflict') return;
    this.set({ status: 'dirty' });
    this.schedule(immediate ? 0 : this.autosaveMs);
  }

  setComposing(composing: boolean): void {
    this.composing = composing;
    if (composing) this.clearTimer();
    else this.schedule(this.autosaveMs);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (this.disposed || this.composing || this.state.status === 'conflict') return;
    if (!this.hasPending()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, delay);
  }

  async save(): Promise<void> {
    this.clearTimer();
    while (this.saving !== null) await this.saving;
    if (this.composing || this.state.status === 'conflict' || !this.hasPending()) return;
    const sent = this.state.pending;
    const base = this.state.view.revision;
    this.set({ status: 'saving', errorMessage: null });
    const run = async () => {
      try {
        const view = await this.client.variants.patch(this.workId, this.state.platform, {
          base_revision: base,
          ...patchOf(sent),
        });
        if (this.disposed) return;
        // Keep what was typed while the request was out.
        const left: Pending = {};
        for (const f of FIELDS) {
          if (f in this.state.pending && this.state.pending[f] !== sent[f]) {
            Object.assign(left, { [f]: this.state.pending[f] });
          }
        }
        const more = Object.keys(left).length > 0;
        this.set({ view, pending: left, status: more ? 'dirty' : 'saved' });
        if (more) this.schedule(this.autosaveMs);
      } catch (err) {
        if (this.disposed) return;
        if (err instanceof ApiError && err.status === 409) {
          await this.enterConflict(Object.keys(sent) as OverrideField[]);
          return;
        }
        this.set({ status: 'error', errorMessage: serviceErrorText(err) });
      }
    };
    this.saving = run();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  private async enterConflict(fields: OverrideField[]): Promise<void> {
    try {
      const theirs = await this.client.variants.get(this.workId, this.state.platform);
      if (this.disposed) return;
      this.set({ status: 'conflict', conflict: { fields, theirs } });
    } catch (err) {
      if (!this.disposed) this.set({ status: 'error', errorMessage: serviceErrorText(err) });
    }
  }

  /** 保留我的: write my pending values on top of the latest revision. */
  async keepMine(): Promise<void> {
    const c = this.state.conflict;
    if (c === null) return;
    this.set({ view: c.theirs, conflict: null, status: 'dirty' });
    await this.save();
  }

  /** 使用對方的: drop my pending values and show the latest. */
  useTheirs(): void {
    const c = this.state.conflict;
    if (c === null) return;
    this.set({
      view: c.theirs,
      pending: {},
      conflict: null,
      status: 'saved',
      epoch: this.state.epoch + 1,
    });
  }

  /**
   * Another window or device changed the overrides (`work.variant_changed`),
   * or the work changed (`work.updated`: images or the followed values).
   * Adopted when nothing is pending; otherwise the next save meets the 409.
   * Never rejects.
   */
  async refresh(revision?: number): Promise<void> {
    if (this.disposed) return;
    if (revision !== undefined && revision <= this.state.view.revision) return;
    if (this.saving !== null) await this.saving;
    try {
      const view = await this.client.variants.get(this.workId, this.state.platform);
      if (this.isDisposed()) return;
      if (this.hasPending() || this.state.status === 'conflict') {
        // Mine wins on the screen until saved; the newer revision shows up as a 409 then.
        if (view.revision === this.state.view.revision) this.set({ view });
        return;
      }
      const replaced = view.revision !== this.state.view.revision;
      this.set({ view, ...(replaced ? { epoch: this.state.epoch + 1 } : {}) });
    } catch {
      // Keep what we have; the next event or save tries again.
    }
  }

  /** Retry after an error. */
  retry(): void {
    if (this.state.status !== 'error') return;
    this.set({ status: 'dirty' });
    void this.save();
  }
}
