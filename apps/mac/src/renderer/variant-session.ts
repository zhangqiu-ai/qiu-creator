import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Platform, PlatformVariantRecord } from '@qiu-creator/contracts';

export interface VariantDraft {
  title: string;
  body: string;
  cover_asset_id: string | null;
  image_asset_ids: readonly string[];
  tags: readonly string[];
}

export type VariantStatus = 'none' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface VariantSessionState {
  platform: Platform;
  /** Last version known on the server; null when this platform has no variant yet. */
  record: PlatformVariantRecord | null;
  draft: VariantDraft | null;
  status: VariantStatus;
  /** Server revision that beat us (409) or that arrived while we had unsaved edits. */
  conflictRevision: number | null;
  errorMessage: string | null;
  /** Bumped when the draft is replaced from the server, so inputs reload. */
  epoch: number;
}

function draftOf(r: PlatformVariantRecord): VariantDraft {
  return {
    title: r.title,
    body: r.body,
    cover_asset_id: r.cover_asset_id,
    image_asset_ids: r.image_asset_ids,
    tags: r.tags,
  };
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Fields of `draft` that differ from `saved`, ready for a PATCH. */
export function changedFields(
  draft: VariantDraft,
  saved: VariantDraft,
): Partial<{
  title: string;
  body: string;
  cover_asset_id: string | null;
  image_asset_ids: string[];
  tags: string[];
}> {
  const out: ReturnType<typeof changedFields> = {};
  if (draft.title !== saved.title) out.title = draft.title;
  if (draft.body !== saved.body) out.body = draft.body;
  if (draft.cover_asset_id !== saved.cover_asset_id) out.cover_asset_id = draft.cover_asset_id;
  if (!same(draft.image_asset_ids, saved.image_asset_ids)) {
    out.image_asset_ids = [...draft.image_asset_ids];
  }
  if (!same(draft.tags, saved.tags)) out.tags = [...draft.tags];
  return out;
}

/**
 * Editing state for one platform version of a work. Each platform has its own
 * session and its own revision counter, so editing 小紅書 never touches 抖音.
 *
 * - Autosave after a pause, with `base_revision`; nothing is sent while an
 *   input method is composing.
 * - A 409 never overwrites: the draft is kept and the user chooses
 *   載入最新 (discard mine) or 以我的修改覆蓋 (explicitly write on top of the latest).
 * - Newer revisions from elsewhere (SSE) are adopted when nothing is unsaved;
 *   otherwise they become the same choice.
 */
export class VariantSession {
  private state: VariantSessionState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private composing = false;
  private inFlight: Promise<unknown> | null = null;
  private pendingRemote: number | null = null;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly workId: string,
    platform: Platform,
    record: PlatformVariantRecord | null,
    private readonly autosaveMs = 800,
  ) {
    this.state = {
      platform,
      record,
      draft: record === null ? null : draftOf(record),
      status: record === null ? 'none' : 'saved',
      conflictRevision: null,
      errorMessage: null,
      epoch: 0,
    };
  }

  get snapshot(): VariantSessionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<VariantSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  hasUnsavedChanges(): boolean {
    const { draft, record } = this.state;
    if (draft === null || record === null) return false;
    return Object.keys(changedFields(draft, draftOf(record))).length > 0;
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  edit(change: Partial<VariantDraft>, immediate = false): void {
    const { draft } = this.state;
    if (draft === null || this.disposed) return;
    this.set({ draft: { ...draft, ...change } });
    if (this.state.status === 'conflict' || this.state.status === 'saving') return;
    if (!this.hasUnsavedChanges()) {
      this.clearTimer();
      this.set({ status: 'saved' });
      return;
    }
    this.set({ status: 'dirty' });
    this.schedule(immediate ? 0 : this.autosaveMs);
  }

  setComposing(composing: boolean): void {
    this.composing = composing;
    if (composing) this.clearTimer();
    else this.schedule();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay = this.autosaveMs): void {
    this.clearTimer();
    if (this.disposed || this.composing || this.state.status === 'conflict') return;
    if (!this.hasUnsavedChanges()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, delay);
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    while (this.inFlight !== null) await this.inFlight.catch(() => undefined);
    const p = run();
    this.inFlight = p;
    try {
      return await p;
    } finally {
      this.inFlight = null;
      const pending = this.pendingRemote;
      this.pendingRemote = null;
      if (pending !== null) void this.remoteRevision(pending);
    }
  }

  private adopt(record: PlatformVariantRecord, replaceDraft: boolean): void {
    this.set({
      record,
      ...(replaceDraft || this.state.draft === null
        ? {
            draft: draftOf(record),
            status: 'saved' as const,
            conflictRevision: null,
            errorMessage: null,
            epoch: this.state.epoch + 1,
          }
        : {}),
    });
  }

  async save(): Promise<void> {
    this.clearTimer();
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
      return this.save();
    }
    const { draft, record } = this.state;
    if (this.disposed || this.composing || draft === null || record === null) return;
    if (this.state.status === 'conflict') return;
    const changes = changedFields(draft, draftOf(record));
    if (Object.keys(changes).length === 0) {
      if (this.state.status !== 'saved') this.set({ status: 'saved', errorMessage: null });
      return;
    }
    this.set({ status: 'saving', errorMessage: null });
    try {
      const saved = await this.exclusive(() =>
        this.client.variants.patch(this.workId, this.state.platform, {
          base_revision: record.revision,
          ...changes,
        }),
      );
      if (this.isDisposed()) return;
      this.adopt(saved, false);
      this.set({ status: this.hasUnsavedChanges() ? 'dirty' : 'saved' });
      this.schedule();
    } catch (err) {
      if (this.isDisposed()) return;
      if (err instanceof ApiError && err.status === 409) {
        this.set({
          status: 'conflict',
          conflictRevision: err.currentVariantRevision ?? null,
          errorMessage: null,
        });
        return;
      }
      this.set({
        status: 'error',
        errorMessage: err instanceof ApiError ? err.message : '無法連線到服務',
      });
    }
  }

  /**
   * A newer revision of this platform exists (SSE `work.variant_updated` /
   * `work.variant_created`). Never rejects.
   */
  async remoteRevision(revision: number): Promise<void> {
    if (this.disposed) return;
    const current = this.state.record?.revision ?? 0;
    if (revision <= current) return;
    if (this.inFlight !== null) {
      this.pendingRemote = Math.max(this.pendingRemote ?? 0, revision);
      return;
    }
    if (this.state.status === 'conflict') {
      this.set({ conflictRevision: Math.max(this.state.conflictRevision ?? 0, revision) });
      return;
    }
    if (this.hasUnsavedChanges() || this.composing) {
      this.clearTimer();
      this.set({ status: 'conflict', conflictRevision: revision });
      return;
    }
    try {
      const record = await this.exclusive(() =>
        this.client.variants.get(this.workId, this.state.platform),
      );
      if (this.isDisposed()) return;
      if (this.hasUnsavedChanges()) {
        this.set({ record, status: 'conflict', conflictRevision: record.revision });
        return;
      }
      this.adopt(record, true);
    } catch {
      // Offline or deleted; the next event or a reload tries again.
    }
  }

  /** 載入最新: discard my draft and show the server version. */
  async takeLatest(): Promise<void> {
    this.clearTimer();
    const record = await this.exclusive(() =>
      this.client.variants.get(this.workId, this.state.platform),
    );
    this.adopt(record, true);
  }

  /**
   * 以我的修改覆蓋: the user saw the conflict and chose their version. Writes
   * the whole draft on top of the latest revision; if that moved again, it is
   * another 409 rather than a blind overwrite.
   */
  async keepMine(): Promise<'saved' | 'conflict'> {
    this.clearTimer();
    const draft = this.state.draft;
    if (draft === null) return 'saved';
    try {
      const latest = await this.exclusive(() =>
        this.client.variants.get(this.workId, this.state.platform),
      );
      const saved = await this.exclusive(() =>
        this.client.variants.patch(this.workId, this.state.platform, {
          base_revision: latest.revision,
          title: draft.title,
          body: draft.body,
          cover_asset_id: draft.cover_asset_id,
          image_asset_ids: [...draft.image_asset_ids],
          tags: [...draft.tags],
        }),
      );
      this.adopt(saved, true);
      return 'saved';
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.set({ conflictRevision: err.currentVariantRevision ?? null });
        return 'conflict';
      }
      throw err;
    }
  }

  /** 從原稿建立 (no variant yet) or 重新從原稿產生 (replaces fields; history is kept). */
  async draftFromSource(): Promise<void> {
    await this.save();
    if (this.hasUnsavedChanges() || this.state.status === 'conflict') return;
    const record = await this.exclusive(() =>
      this.client.variants.redraft(this.workId, this.state.platform, this.state.record?.revision),
    );
    this.adopt(record, true);
  }

  /** 複製某平台版本: create this platform from another platform's current fields. */
  async copyFrom(source: VariantDraft): Promise<void> {
    if (this.state.record !== null) return;
    const created = await this.exclusive(() =>
      this.client.variants.redraft(this.workId, this.state.platform),
    );
    const copied = await this.exclusive(() =>
      this.client.variants.patch(this.workId, this.state.platform, {
        base_revision: created.revision,
        title: source.title,
        body: source.body,
        cover_asset_id: source.cover_asset_id,
        image_asset_ids: [...source.image_asset_ids],
        tags: [...source.tags],
      }),
    );
    this.adopt(copied, true);
  }

  /** Save pending edits, then stop. */
  close(): void {
    this.clearTimer();
    if (!this.composing && this.state.status !== 'conflict' && this.hasUnsavedChanges()) {
      void this.save().finally(() => {
        this.dispose();
      });
      return;
    }
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
  }
}
