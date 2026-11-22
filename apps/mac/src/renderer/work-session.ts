import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { AiImagePlacement, WorkDetail, WorkMedia, WorkStatus } from '@qiu-creator/contracts';
import { t } from './i18n.js';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/**
 * Why the last save failed. QC-042: the reason, not a sentence — the page
 * words it in the current language, and the service's own (English) message
 * is never shown.
 */
export type SaveError =
  { kind: 'title_blank' } | { kind: 'offline' } | { kind: 'service'; code: string | null };

export interface Draft {
  title: string;
  /** Articles: the Markdown. Image and video works: the description (QC-045/046). */
  markdown: string;
  status: WorkStatus;
  tags: readonly string[];
  /** Image works: the images in order, as library asset ids. Always empty for articles. */
  images?: readonly string[];
  /** Image works: the cover image's asset id; video works may use a frame. Null: none. */
  cover?: DraftCover | null;
  /** Video works: the video's library asset id; null when none is chosen yet (QC-046). */
  video?: string | null;
}

/** The cover in a draft: an image asset, or a frame of the video (QC-046). */
export type DraftCover = { asset_id: string } | { time_seconds: number };

/** Image and video works keep their text as a description below front matter (QC-045/046). */
export function isTypedWork(work: Pick<WorkDetail, 'type'>): boolean {
  return work.type === 'image' || work.type === 'video';
}

/** Why the work cannot be edited right now (external works only). */
export type ReadOnlyReason = 'missing' | 'unmounted';

/** A newer server revision that arrived while the user had unsaved edits. */
export interface RemoteChange {
  revisionId: string;
  /** `external` for an edit outside the app (Finder, VS Code), `edit`/`restore` for another client. */
  source: 'external' | 'edit' | 'restore' | 'other';
  /**
   * The revision the unsaved draft was based on when the newer one arrived.
   * `baseRevision` may already point at the newer revision by then (QC-027).
   */
  draftBase: string;
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
  /**
   * The revision this window's draft was based on when the conflict began
   * (for 「你的修改基於 rN」). Not `baseRevision`, which can already have moved
   * to the server's revision (QC-027).
   */
  conflictBase: string | null;
  error: SaveError | null;
  /** Non-null while the external file is missing or its folder unmounted: no saves, no restore. */
  readOnly: ReadOnlyReason | null;
  /** A newer revision exists on the server and the draft has unsaved edits; autosave is paused. */
  remote: RemoteChange | null;
  /** Bumped whenever the draft is replaced from the server, so the editor can reload it. */
  epoch: number;
  /** Image and video works: their files as the server last reported them (status, size). */
  media: WorkMedia | null;
  /** The whole saved source file (front matter included), for comparing with history. */
  file: string;
}

export interface WorkSessionOptions {
  /** Autosave delay after the last edit. */
  autosaveMs?: number;
  /** Called after every successful save with the server's work. */
  onSaved?: (work: WorkDetail) => void;
}

export type RestoreResult = 'restored' | 'conflict' | 'blocked';
export type AcceptResult = 'accepted' | 'conflict' | 'blocked';

function coverOf(media: WorkMedia | null | undefined): DraftCover | null {
  const cover = media?.cover ?? null;
  if (cover === null) return null;
  if (cover.kind === 'frame') return { time_seconds: cover.time_seconds };
  return cover.item.asset_id === null ? null : { asset_id: cover.item.asset_id };
}

function draftOf(work: WorkDetail): Draft {
  if (!isTypedWork(work)) {
    return { title: work.title, markdown: work.markdown, status: work.status, tags: work.tags };
  }
  return {
    title: work.title,
    markdown: work.description ?? '',
    status: work.status,
    tags: work.tags,
    images: (work.media?.images ?? [])
      .map((i) => i.asset_id)
      .filter((id): id is string => id !== null),
    cover: coverOf(work.media),
    ...(work.type === 'video' ? { video: work.media?.video?.asset_id ?? null } : {}),
  };
}

function sameCover(a: DraftCover | null | undefined, b: DraftCover | null | undefined): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  if ('asset_id' in a) return 'asset_id' in b && a.asset_id === b.asset_id;
  return 'time_seconds' in b && a.time_seconds === b.time_seconds;
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
      conflictBase: null,
      error: null,
      readOnly: readOnlyOf(work),
      remote: null,
      epoch: 0,
      media: work.media ?? null,
      file: work.markdown,
    };
    this.typed = isTypedWork(work);
    this.kind = work.type;
  }

  private readonly kind: WorkDetail['type'];

  /** Image or video work: the text is a description and media fields are saved too. */
  private readonly typed: boolean;

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
      !sameTags(draft.tags, saved.tags) ||
      !sameTags(draft.images ?? [], saved.images ?? []) ||
      !sameCover(draft.cover, saved.cover) ||
      (draft.video ?? null) !== (saved.video ?? null)
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
    // Status, tags, images and cover are deliberate one-click changes: save them right away.
    const immediate =
      change.status !== undefined ||
      change.tags !== undefined ||
      change.images !== undefined ||
      change.cover !== undefined ||
      change.video !== undefined;
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
      // On the next task, not now: the caller first adopts the work this request returned
      // (restore, AI accept, adopting suggestions), so an SSE echo of our own revision that
      // arrived meanwhile is recognised as ours instead of becoming a "changed elsewhere".
      if (pending !== null) {
        setTimeout(() => {
          void this.remoteRevision(pending.revisionId, pending.source);
        }, 0);
      }
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
      this.set({ status: 'error', error: { kind: 'title_blank' } });
      return;
    }
    if (!this.hasUnsavedChanges()) {
      if (this.state.status !== 'saved') this.set({ status: 'saved', error: null });
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
      media: work.media ?? null,
      file: work.markdown,
      ...(replaceDraft
        ? {
            draft: saved,
            status: 'saved' as const,
            conflictRevision: null,
            conflictBase: null,
            error: null,
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
      description?: string;
      status?: WorkStatus;
      tags?: string[];
      images?: string[];
      cover?: DraftCover | null;
      video_asset_id?: string | null;
    } = {};
    if (sent.title !== saved.title) changes.title = sent.title;
    if (sent.markdown !== saved.markdown) {
      // Image and video works: the front matter belongs to the service; send the description only.
      if (this.typed) changes.description = sent.markdown;
      else changes.markdown = sent.markdown;
    }
    if (sent.status !== saved.status) changes.status = sent.status;
    if (!sameTags(sent.tags, saved.tags)) changes.tags = [...sent.tags];
    if (this.typed && !sameTags(sent.images ?? [], saved.images ?? [])) {
      changes.images = [...(sent.images ?? [])];
    }
    if (this.typed && !sameCover(sent.cover, saved.cover)) changes.cover = sent.cover ?? null;
    if (this.typed && (sent.video ?? null) !== (saved.video ?? null)) {
      changes.video_asset_id = sent.video ?? null;
    }
    const sentBase = this.state.baseRevision;
    this.set({ status: 'saving', error: null });
    try {
      const work = await this.client.works.patch(this.state.workId, {
        base_revision: sentBase,
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
          error: null,
        });
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        this.set({
          status: 'conflict',
          conflictRevision: err.currentRevision ?? null,
          conflictBase: sentBase,
          error: null,
        });
        return;
      }
      this.set({
        status: 'error',
        error:
          err instanceof ApiError
            ? { kind: 'service', code: err.code ?? null }
            : { kind: 'offline' },
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
      this.pendingRemote = { revisionId, source, draftBase: this.state.baseRevision };
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
        // The draft is still based on the revision it was before this fetch.
        const draftBase = this.state.baseRevision;
        this.adopt(work, false);
        this.set({ remote: { revisionId: work.current_revision_id, source, draftBase } });
        this.clearTimer();
        return;
      }
      this.adopt(work, true);
      return;
    }
    this.clearTimer();
    this.set({ remote: { revisionId, source, draftBase: this.state.baseRevision } });
  }

  /** 比對並合併: open the conflict flow against the newer server revision. */
  compareRemote(): void {
    const remote = this.state.remote;
    if (remote === null) return;
    this.clearTimer();
    this.set({
      remote: null,
      status: 'conflict',
      conflictRevision: remote.revisionId,
      conflictBase: remote.draftBase,
    });
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

  /**
   * 採用 an AI rewrite (QC-024): save pending edits, then write the composed
   * full text as an `ai_accepted` revision based on the job's source revision.
   * If the work moved on since the candidate was generated (409), the composed
   * text becomes this window's draft and the existing conflict flow opens:
   * nothing on the server is overwritten and the user's choice is kept.
   */
  async acceptAi(jobId: string, markdown: string, sourceRevision: string): Promise<AcceptResult> {
    if (this.state.readOnly !== null || this.state.status === 'conflict') return 'blocked';
    await this.save();
    // Read through a method: TypeScript would otherwise keep the narrowing from before the await.
    const now = this.current();
    if (now.readOnly !== null || now.status === 'conflict') return 'blocked';
    if (this.state.remote !== null) {
      this.toConflict(markdown, this.state.remote.revisionId, sourceRevision);
      return 'conflict';
    }
    if (this.hasUnsavedChanges()) return 'blocked';
    try {
      const work = await this.exclusive(() =>
        this.client.ai.accept(this.state.workId, jobId, { markdown }),
      );
      if (this.disposed) return 'accepted';
      this.adopt(work, true);
      this.options.onSaved?.(work);
      return 'accepted';
    } catch (err) {
      if (err instanceof ApiError && err.code === 'source_missing') {
        await this.refreshExternalState();
        return 'blocked';
      }
      if (err instanceof ApiError && err.code === 'revision_conflict') {
        const latest = err.currentRevision ?? (await this.fetchServerVersion()).current_revision_id;
        this.toConflict(markdown, latest, sourceRevision);
        return 'conflict';
      }
      throw err;
    }
  }

  /**
   * 採用 AI video suggestions (QC-046): save pending edits, then write the
   * chosen title / description / cover as one `ai_accepted` revision tied to
   * the analysis job. Returns the revision it replaced, for 復原 (restore it).
   * A stale base (409) is not overwritten: the newer revision is surfaced.
   */
  async acceptSuggestion(
    jobId: string,
    change: { title?: string; description?: string; cover?: DraftCover | null },
  ): Promise<{ result: AcceptResult; previousRevision: string | null }> {
    if (this.state.readOnly !== null || this.state.status === 'conflict') {
      return { result: 'blocked', previousRevision: null };
    }
    await this.save();
    if (this.hasUnsavedChanges() || this.current().remote !== null) {
      return { result: 'blocked', previousRevision: null };
    }
    const previous = this.state.baseRevision;
    try {
      const work = await this.exclusive(() =>
        this.client.works.patch(this.state.workId, {
          base_revision: previous,
          ai_job_id: jobId,
          ...change,
        }),
      );
      if (this.disposed) return { result: 'accepted', previousRevision: previous };
      this.adopt(work, true);
      this.options.onSaved?.(work);
      return { result: 'accepted', previousRevision: previous };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'revision_conflict') {
        await this.remoteRevision(err.currentRevision ?? '', 'other');
        return { result: 'conflict', previousRevision: null };
      }
      throw err;
    }
  }

  /**
   * Keep an AI image candidate (QC-070): save pending edits, then let the
   * service add it to the library and (insert, cover) write it into the work
   * as an `ai_accepted` revision on the current base. An insert's `offset` is
   * in the saved Markdown, which is the draft once saved. A stale base (409)
   * is not overwritten: the newer revision is surfaced. A candidate that left
   * the temporary cache (kept, discarded, or too old) comes back `expired`.
   */
  async keepAiImage(
    jobId: string,
    index: number,
    placement: AiImagePlacement,
  ): Promise<{
    result: AcceptResult | 'expired';
    previousRevision: string | null;
    assetId: string | null;
  }> {
    const none = { previousRevision: null, assetId: null };
    if (this.state.readOnly !== null || this.state.status === 'conflict') {
      return { result: 'blocked', ...none };
    }
    await this.save();
    if (this.hasUnsavedChanges() || this.current().remote !== null) {
      return { result: 'blocked', ...none };
    }
    const previous = this.state.baseRevision;
    try {
      const kept = await this.exclusive(() =>
        this.client.ai.images.keep(this.state.workId, jobId, {
          index,
          base_revision: previous,
          placement,
        }),
      );
      if (this.disposed)
        return { result: 'accepted', previousRevision: previous, assetId: kept.asset_id };
      if (kept.work.current_revision_id !== previous) {
        this.adopt(kept.work, true);
        this.options.onSaved?.(kept.work);
      }
      return { result: 'accepted', previousRevision: previous, assetId: kept.asset_id };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'revision_conflict') {
        await this.remoteRevision(err.currentRevision ?? '', 'other');
        return { result: 'conflict', ...none };
      }
      if (err instanceof ApiError && err.code === 'ai_job_not_acceptable') {
        return { result: 'expired', ...none };
      }
      if (err instanceof ApiError && err.code === 'source_missing') {
        await this.refreshExternalState();
        return { result: 'blocked', ...none };
      }
      throw err;
    }
  }

  /** The composed text was written from `draftBase` (the candidate's source revision). */
  private toConflict(markdown: string, serverRevision: string, draftBase: string): void {
    this.clearTimer();
    this.set({
      draft: { ...this.state.draft, markdown },
      remote: null,
      status: 'conflict',
      conflictRevision: serverRevision,
      conflictBase: draftBase,
      error: null,
      epoch: this.state.epoch + 1,
    });
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
    const copyTitle = t('editor.keepBothCopy', { title: title.trim() || t('editor.untitled') });
    // Image and video works: the copy keeps the text; their files stay with this work.
    const copy = await this.client.works.create(
      this.typed
        ? { title: copyTitle, type: this.kind, description: markdown, source: 'mac-app' }
        : { title: copyTitle, markdown, source: 'mac-app' },
    );
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
          ...(this.typed ? { description: markdown } : { markdown }),
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

  private current(): WorkSessionState {
    return this.state;
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
