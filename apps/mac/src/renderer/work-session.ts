import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail, WorkStatus } from '@qiu-creator/contracts';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface Draft {
  title: string;
  markdown: string;
  status: WorkStatus;
  tags: readonly string[];
}

/** Why the work cannot be edited right now (external works only). */
export type ReadOnlyReason = 'missing' | 'unmounted';

/** A newer server revision that arrived while the user had unsaved edits. */
export interface RemoteChange {
  revisionId: string;
  /** `external` for an edit outside the app (Finder, VS Code), `edit`/`restore` for another client. */
  source: 'external' | 'edit' | 'restore' | 'other';
}

export interface WorkSessionState {
  workId: string;
  /** What the user sees and edits. Never replaced without their action. */
  draft: Draft;
  /** Last version known to be on the server. */
  saved: Draft;
  baseRevision: string;
  status: SaveStatus;
  /** Server revision that beat us (409). */
  conflictRevision: string | null;
  errorMessage: string | null;
  /** Non-null while the external file is missing or its folder unmounted: no saves, no restore. */
  readOnly: ReadOnlyReason | null;
  /** A newer revision exists on the server and the draft has unsaved edits; autosave is paused. */
  remote: RemoteChange | null;
  /** Bumped whenever the draft is replaced from the server, so the editor can reload it. */
  epoch: number;
}

export interface WorkSessionOptions {
  /** Autosave delay after the last edit. */
  autosaveMs?: number;
  /** Called after every successful save with the server's work. */
  onSaved?: (work: WorkDetail) => void;
}

export type RestoreResult = 'restored' | 'conflict' | 'blocked';

function draftOf(work: WorkDetail): Draft {
  return { title: work.title, markdown: work.markdown, status: work.status, tags: work.tags };
}

function readOnlyOf(work: Pick<WorkDetail, 'external_state'>): ReadOnlyReason | null {
  return work.external_state === 'missing' || work.external_state === 'unmounted'
    ? work.external_state
    : null;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Editing state for one open work: debounced autosave with `base_revision`,
 * no saves while an IME composition is active, and 409 handling that keeps
 * the user's draft instead of overwriting either side.
 *
 * QC-011 additions:
 * - Status and tags are part of the draft and saved through the same queue
 *   (every PATCH makes a revision and needs `base_revision`).
 * - Newer revisions from elsewhere (SSE) are adopted silently when nothing is
 *   unsaved, and otherwise held as `remote` until the user compares or discards.
 *   Our own revisions echoed back over SSE are recognised and ignored.
 * - A missing or unmounted external file makes the work read-only.
 * - Restoring an old revision appends a new revision; history is never rewritten.
 */
export class WorkSession {
  private state: WorkSessionState;
  private readonly listeners = new Set<(s: WorkSessionState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private composing = false;
  private inFlight: Promise<unknown> | null = null;
  private disposed = false;
  private readonly autosaveMs: number;
  /** Revisions this session created; SSE echoes of them are not "remote". */
  private readonly own = new Set<string>();
  /** Remote revision seen while a request was in flight; checked once it settles. */
  private pendingRemote: RemoteChange | null = null;

  constructor(
    private readonly client: CreatorHubClient,
    work: WorkDetail,
    private readonly options: WorkSessionOptions = {},
  ) {
    const draft = draftOf(work);
    this.autosaveMs = options.autosaveMs ?? 800;
    this.state = {
      workId: work.id,
      draft,
      saved: draft,
      baseRevision: work.current_revision_id,
      status: 'saved',
      conflictRevision: null,
      errorMessage: null,
      readOnly: readOnlyOf(work),
      remote: null,
      epoch: 0,
    };
  }

  get snapshot(): WorkSessionState {
    return this.state;
  }

  subscribe(listener: (s: WorkSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<WorkSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  hasUnsavedChanges(): boolean {
    const { draft, saved } = this.state;
    return (
      draft.title !== saved.title ||
      draft.markdown !== saved.markdown ||
      draft.status !== saved.status ||
      !sameTags(draft.tags, saved.tags)
    );
  }

  edit(change: Partial<Draft>): void {
    if (this.state.readOnly !== null || this.disposed) return;
    const draft = { ...this.state.draft, ...change };
    const status =
      this.state.status === 'conflict' || this.state.status === 'saving'
        ? this.state.status
        : 'dirty';
    this.set({ draft });
    if (!this.hasUnsavedChanges() && status === 'dirty') {
      this.set({ status: 'saved' });
      this.clearTimer();
      return;
    }
    this.set({ status });
    // Status and tags are deliberate one-click changes: save them right away.
    const immediate = change.status !== undefined || change.tags !== undefined;
    this.schedule(immediate ? 0 : this.autosaveMs);
  }

  setComposing(composing: boolean): void {
    this.composing = composing;
    if (composing) this.clearTimer();
    else this.schedule();
  }

  isComposing(): boolean {
    return this.composing;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private blocked(): boolean {
    return (
      this.disposed ||
      this.composing ||
      this.state.status === 'conflict' ||
      this.state.readOnly !== null ||
      this.state.remote !== null
    );
  }

  private schedule(delay: number = this.autosaveMs): void {
    this.clearTimer();
    if (this.blocked() || !this.hasUnsavedChanges()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, delay);
  }

  /** Run one request at a time; remote revisions seen meanwhile are checked afterwards. */
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    while (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
    const p = run();
    this.inFlight = p;
    try {
      return await p;
    } finally {
      this.inFlight = null;
      const pending = this.pendingRemote;
      this.pendingRemote = null;
      if (pending !== null) void this.remoteRevision(pending.revisionId, pending.source);
    }
  }

  /** Save now. Concurrent calls are serialised; nothing is sent during composition or a conflict. */
  async save(): Promise<void> {
    this.clearTimer();
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
      return this.save();
    }
    if (this.blocked()) return;
    if (this.state.draft.title.trim() === '') {
      this.set({ status: 'error', errorMessage: '標題不可空白' });
      return;
    }
    if (!this.hasUnsavedChanges()) {
      if (this.state.status !== 'saved') this.set({ status: 'saved', errorMessage: null });
      return;
    }
    await this.exclusive(() => this.doSave());
  }

  private adopt(work: WorkDetail, replaceDraft: boolean): void {
    this.own.add(work.current_revision_id);
    const saved = draftOf(work);
    this.set({
      saved,
      baseRevision: work.current_revision_id,
      readOnly: readOnlyOf(work),
      ...(replaceDraft
        ? {
            draft: saved,
            status: 'saved' as const,
            conflictRevision: null,
            errorMessage: null,
            remote: null,
            epoch: this.state.epoch + 1,
          }
        : {}),
    });
  }

  private async doSave(): Promise<void> {
    const sent = this.state.draft;
    const saved = this.state.saved;
    const changes: {
      title?: string;
      markdown?: string;
      status?: WorkStatus;
      tags?: string[];
    } = {};
    if (sent.title !== saved.title) changes.title = sent.title;
    if (sent.markdown !== saved.markdown) changes.markdown = sent.markdown;
    if (sent.status !== saved.status) changes.status = sent.status;
    if (!sameTags(sent.tags, saved.tags)) changes.tags = [...sent.tags];
    this.set({ status: 'saving', errorMessage: null });
    try {
      const work = await this.client.works.patch(this.state.workId, {
        base_revision: this.state.baseRevision,
        ...changes,
      });
      if (this.disposed) return;
      this.adopt(work, false);
      this.set({ status: this.hasUnsavedChanges() ? 'dirty' : 'saved' });
      this.options.onSaved?.(work);
      this.schedule();
    } catch (err) {
      if (this.disposed) return;
      if (err instanceof ApiError && err.code === 'source_missing') {
        // The file vanished under us: keep the edits in this window, stop saving.
        const state = err.body?.error.details?.['external_state'];
        this.set({
          status: 'dirty',
          readOnly: state === 'unmounted' ? 'unmounted' : 'missing',
          errorMessage: null,
        });
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        this.set({
          status: 'conflict',
          conflictRevision: err.currentRevision ?? null,
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
   * A newer revision exists on the server (SSE `work.updated`,
   * `work.external_revision`, or found after a reconnect). Adopted silently
   * when nothing is unsaved; otherwise held as `remote` and autosave pauses.
   * Never rejects.
   */
  async remoteRevision(revisionId: string, source: RemoteChange['source']): Promise<void> {
    if (this.disposed) return;
    if (revisionId === this.state.baseRevision || this.own.has(revisionId)) return;
    if (this.inFlight !== null) {
      this.pendingRemote = { revisionId, source };
      return;
    }
    if (this.state.status === 'conflict') return; // the conflict dialog already compares
    if (!this.hasUnsavedChanges() && !this.composing) {
      const before = this.state.draft;
      let work: WorkDetail;
      try {
        work = await this.exclusive(() => this.client.works.get(this.state.workId));
      } catch {
        // Offline: the next event or the reconnect catch-up tries again.
        return;
      }
      if (this.isDisposed()) return;
      // The user started typing while we fetched: do not replace their text.
      if (this.state.draft !== before) {
        this.adopt(work, false);
        this.set({ remote: { revisionId: work.current_revision_id, source } });
        this.clearTimer();
        return;
      }
      this.adopt(work, true);
      return;
    }
    this.clearTimer();
    this.set({ remote: { revisionId, source } });
  }

  /** 比對並合併: open the conflict flow against the newer server revision. */
  compareRemote(): void {
    const remote = this.state.remote;
    if (remote === null) return;
    this.clearTimer();
    this.set({ remote: null, status: 'conflict', conflictRevision: remote.revisionId });
  }

  /** The external file disappeared, came back, or its folder was (un)mounted. */
  async refreshExternalState(): Promise<void> {
    const work = await this.client.works.get(this.state.workId);
    if (this.disposed) return;
    const readOnly = readOnlyOf(work);
    const was = this.state.readOnly;
    this.set({ readOnly });
    if (readOnly !== null) {
      this.clearTimer();
      return;
    }
    if (was !== null) {
      // Back on disk; it may have been edited while it was away.
      if (work.current_revision_id !== this.state.baseRevision) {
        await this.remoteRevision(work.current_revision_id, 'external');
      }
      this.schedule();
    }
  }

  /**
   * 恢復此版本: save pending edits first, then append a `restore` revision
   * copied from `revisionId`. A stale base (someone else wrote meanwhile)
   * returns `conflict` and the newer revision is surfaced as `remote`.
   */
  async restore(revisionId: string): Promise<RestoreResult> {
    if (this.state.readOnly !== null || this.state.status === 'conflict') return 'blocked';
    await this.save();
    if (this.hasUnsavedChanges() || this.state.remote !== null) return 'blocked';
    try {
      const work = await this.exclusive(() =>
        this.client.works.restore(this.state.workId, revisionId, {
          base_revision: this.state.baseRevision,
        }),
      );
      if (this.disposed) return 'restored';
      this.adopt(work, true);
      this.options.onSaved?.(work);
      return 'restored';
    } catch (err) {
      if (err instanceof ApiError && err.code === 'source_missing') {
        await this.refreshExternalState();
        return 'blocked';
      }
      if (err instanceof ApiError && err.status === 409) {
        await this.remoteRevision(err.currentRevision ?? '', 'other');
        return 'conflict';
      }
      throw err;
    }
  }

  /** Fetch the server's current version (for the diff view). */
  fetchServerVersion(): Promise<WorkDetail> {
    return this.client.works.get(this.state.workId);
  }

  /** Discard the local draft and adopt the server version. */
  async reloadFromServer(): Promise<void> {
    this.clearTimer();
    const work = await this.fetchServerVersion();
    this.adopt(work, true);
  }

  /**
   * 保留雙方: store my draft as a new work, then let this work show the
   * server version. Returns the copy.
   */
  async keepBoth(): Promise<WorkDetail> {
    const { title, markdown } = this.state.draft;
    const copy = await this.client.works.create({
      title: `${title.trim() || '未命名'}（我的修改）`,
      markdown,
      source: 'mac-app',
    });
    await this.reloadFromServer();
    return copy;
  }

  /**
   * 手動合併: save the merged text on top of exactly the server revision the
   * user compared against. If the server moved on again, this is another 409
   * (status stays `conflict`) rather than a silent overwrite.
   */
  async resolveWithMerge(markdown: string, serverRevision: string): Promise<'saved' | 'conflict'> {
    this.clearTimer();
    try {
      const work = await this.exclusive(() =>
        this.client.works.patch(this.state.workId, {
          base_revision: serverRevision,
          title: this.state.draft.title,
          markdown,
        }),
      );
      this.adopt(work, true);
      this.options.onSaved?.(work);
      return 'saved';
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.set({ conflictRevision: err.currentRevision ?? null });
        return 'conflict';
      }
      throw err;
    }
  }

  /** Save pending edits (unless in conflict), then stop. */
  close(): void {
    this.clearTimer();
    if (!this.blocked() && this.hasUnsavedChanges()) {
      void this.save().finally(() => {
        this.dispose();
      });
      return;
    }
    this.dispose();
  }

  /** Read through a method: TypeScript would otherwise narrow `disposed` across awaits. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
  }
}
