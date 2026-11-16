import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface Draft {
  title: string;
  markdown: string;
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
}

export interface WorkSessionOptions {
  /** Autosave delay after the last edit. */
  autosaveMs?: number;
  /** Called after every successful save with the server's work. */
  onSaved?: (work: WorkDetail) => void;
}

/**
 * Editing state for one open work: debounced autosave with `base_revision`,
 * no saves while an IME composition is active, and 409 handling that keeps
 * the user's draft instead of overwriting either side.
 */
export class WorkSession {
  private state: WorkSessionState;
  private readonly listeners = new Set<(s: WorkSessionState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private composing = false;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private readonly autosaveMs: number;

  constructor(
    private readonly client: CreatorHubClient,
    work: WorkDetail,
    private readonly options: WorkSessionOptions = {},
  ) {
    const draft = { title: work.title, markdown: work.markdown };
    this.autosaveMs = options.autosaveMs ?? 800;
    this.state = {
      workId: work.id,
      draft,
      saved: draft,
      baseRevision: work.current_revision_id,
      status: 'saved',
      conflictRevision: null,
      errorMessage: null,
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

  private hasUnsavedChanges(): boolean {
    const { draft, saved } = this.state;
    return draft.title !== saved.title || draft.markdown !== saved.markdown;
  }

  edit(change: Partial<Draft>): void {
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
    this.schedule();
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

  private schedule(): void {
    this.clearTimer();
    if (this.disposed || this.composing || this.state.status === 'conflict') return;
    if (!this.hasUnsavedChanges()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.autosaveMs);
  }

  /** Save now. Concurrent calls are serialised; nothing is sent during composition or a conflict. */
  async save(): Promise<void> {
    this.clearTimer();
    if (this.inFlight !== null) {
      await this.inFlight;
      return this.save();
    }
    if (this.disposed || this.composing || this.state.status === 'conflict') return;
    if (this.state.draft.title.trim() === '') {
      this.set({ status: 'error', errorMessage: '標題不可空白' });
      return;
    }
    if (!this.hasUnsavedChanges()) {
      if (this.state.status !== 'saved') this.set({ status: 'saved', errorMessage: null });
      return;
    }
    this.inFlight = this.doSave().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doSave(): Promise<void> {
    const sent = this.state.draft;
    const changes: { title?: string; markdown?: string } = {};
    if (sent.title !== this.state.saved.title) changes.title = sent.title;
    if (sent.markdown !== this.state.saved.markdown) changes.markdown = sent.markdown;
    this.set({ status: 'saving', errorMessage: null });
    try {
      const work = await this.client.works.patch(this.state.workId, {
        base_revision: this.state.baseRevision,
        ...changes,
      });
      if (this.disposed) return;
      this.set({
        saved: { title: work.title, markdown: work.markdown },
        baseRevision: work.current_revision_id,
      });
      this.set({ status: this.hasUnsavedChanges() ? 'dirty' : 'saved' });
      this.options.onSaved?.(work);
      this.schedule();
    } catch (err) {
      if (this.disposed) return;
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

  /** Fetch the server's current version (for the diff view). */
  fetchServerVersion(): Promise<WorkDetail> {
    return this.client.works.get(this.state.workId);
  }

  /** Discard the local draft and adopt the server version. */
  async reloadFromServer(): Promise<void> {
    this.clearTimer();
    const work = await this.fetchServerVersion();
    const draft = { title: work.title, markdown: work.markdown };
    this.set({
      draft,
      saved: draft,
      baseRevision: work.current_revision_id,
      status: 'saved',
      conflictRevision: null,
      errorMessage: null,
    });
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
      const work = await this.client.works.patch(this.state.workId, {
        base_revision: serverRevision,
        title: this.state.draft.title,
        markdown,
      });
      const draft = { title: work.title, markdown: work.markdown };
      this.set({
        draft,
        saved: draft,
        baseRevision: work.current_revision_id,
        status: 'saved',
        conflictRevision: null,
        errorMessage: null,
      });
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
