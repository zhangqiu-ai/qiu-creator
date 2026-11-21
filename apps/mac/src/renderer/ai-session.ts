import { ApiError, rewriteOf, suggestionsOf, type CreatorHubClient } from '@qiu-creator/api-client';
import { codeText, t } from './i18n.js';
import {
  charCount,
  PLATFORM_LIMITS,
  type AiFailureCode,
  type AiJobRecord,
  type AiProvider,
  type AiProviderStatus,
  type Platform,
  type RewriteMode,
  type RewriteResult,
  type TextCandidate,
} from '@qiu-creator/contracts';
import { countWords } from './format.js';
import {
  composeSegments,
  diffSentences,
  hunkCount,
  insertAfter,
  splice,
  type Segment,
} from './rewrite-diff.js';
import type { WorkSession } from './work-session.js';

/** Default order when the user has not chosen a provider in this editor. */
export const PROVIDER_ORDER: readonly AiProvider[] = ['anthropic', 'gemini', 'openai', 'new-api'];

/** Why AI cannot be used right now; the panel shows a 「前往設定」 notice. */
export type AiBlock = 'key' | 'consent';

/** Getters, so the labels follow the interface language (QC-042). */
export const AI_BLOCK_LABEL: Readonly<Record<AiBlock, string>> = {
  get key() {
    return t('ai.blockKey');
  },
  get consent() {
    return t('ai.blockConsent');
  },
};

export const FAILURE_LABEL: Readonly<Record<AiFailureCode, string>> = {
  get rate_limited() {
    return t('ai.failRateLimited');
  },
  get invalid_key() {
    return t('ai.failInvalidKey');
  },
  get missing_key() {
    return t('ai.failMissingKey');
  },
  get consent_required() {
    return t('ai.failConsentRequired');
  },
  get timeout() {
    return t('ai.failTimeout');
  },
  get content_blocked() {
    return t('ai.failContentBlocked');
  },
  get provider_unavailable() {
    return t('ai.failProviderUnavailable');
  },
  get bad_request() {
    return t('ai.failBadRequest');
  },
  get invalid_output() {
    return t('ai.failInvalidOutput');
  },
  get file_processing_failed() {
    return t('ai.failFileProcessing');
  },
  get credential_changed() {
    return t('ai.failCredentialChanged');
  },
  get source_unavailable() {
    return t('ai.failSourceUnavailable');
  },
  get unknown() {
    return t('ai.failUnknown');
  },
};

/** First ready provider in `PROVIDER_ORDER`, or why none is. */
export function pickProvider(
  items: readonly AiProviderStatus[],
): { provider: AiProviderStatus; block: null } | { provider: null; block: AiBlock } {
  for (const id of PROVIDER_ORDER) {
    const p = items.find((x) => x.provider === id);
    if (p?.ready === true) return { provider: p, block: null };
  }
  return { provider: null, block: items.some((p) => p.key_configured) ? 'consent' : 'key' };
}

function blockOf(err: unknown): AiBlock | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'ai_key_missing') return 'key';
  if (err.code === 'ai_consent_required') return 'consent';
  return null;
}

/**
 * Interface text for a failed call: the error code, never the service's own
 * (English) message (QC-042). A failed fetch is reported as 「無法連線到服務」,
 * the wording these panels have always used.
 */
function messageOf(err: unknown): string {
  return err instanceof ApiError ? codeText(err.code) : t('common.cannotConnect');
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Follows one AI job: on SSE nudges (`check`) and a slow poll as a fallback. */
export class JobWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly client: CreatorHubClient,
    readonly id: string,
    private readonly onUpdate: (job: AiJobRecord) => void | Promise<void>,
    private readonly pollMs: number,
  ) {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, this.pollMs);
  }

  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.checking ??= (async () => {
      try {
        const job = await this.client.ai.job(this.id);
        if (this.stopped) return;
        await this.onUpdate(job);
        if (TERMINAL.has(job.status)) this.stop();
        else this.schedule();
      } catch {
        // Offline: the poll tries again.
        this.schedule();
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Shared provider lookup for the panel's two tabs. */
export class AiProviders {
  private cached: Promise<AiProviderStatus[]> | null = null;
  private selected: AiProvider | null = null;

  constructor(private readonly client: CreatorHubClient) {}

  /** Re-read from the server next time (after a key or consent error, or returning from settings). */
  invalidate(): void {
    this.cached = null;
  }

  select(provider: AiProvider): void {
    this.selected = provider;
  }

  async list(): Promise<AiProviderStatus[]> {
    this.cached ??= this.client.ai.providers().then((r) => r.items);
    try {
      return await this.cached;
    } catch (err) {
      this.cached = null;
      throw err;
    }
  }

  async pick(): Promise<ReturnType<typeof pickProvider>> {
    const items = await this.list();
    return pickProvider(
      this.selected === null ? items : items.filter((item) => item.provider === this.selected),
    );
  }
}

// ---- Rewrite ---------------------------------------------------------------------------------

export interface RewriteInput {
  mode: RewriteMode;
  tone?: string;
  instruction?: string;
  /** Markdown range of the current revision; null = the whole text. */
  range: { start: number; end: number } | null;
}

export interface RewriteCandidate {
  jobId: string;
  result: RewriteResult;
  /** Full Markdown of the source revision. */
  source: string;
  /** The rewritten part of `source`. */
  original: string;
  segments: Segment[];
  hunks: number;
}

export type RewritePhase = 'idle' | 'loading' | 'pending' | 'failed' | 'busy';

export interface RewriteState {
  phase: RewritePhase;
  provider: AiProviderStatus | null;
  block: AiBlock | null;
  candidate: RewriteCandidate | null;
  picks: boolean[];
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
  /** Shown after 採用／插入 with 復原. */
  done: { label: string; revisionId: string; previousRevisionId: string } | null;
  /** One-line note in the idle state (no changes, could not accept, …). */
  notice: string | null;
}

export type ApplyResult = 'accepted' | 'conflict' | 'blocked';

/**
 * 改寫 tab (QC-024): one candidate at a time. Nothing reaches the work until
 * 採用 or 插入, which go through `WorkSession.acceptAi` (409 → the conflict
 * flow). 復原 restores the previous revision as a new one.
 */
export class RewriteSession {
  private state: RewriteState = {
    phase: 'idle',
    provider: null,
    block: null,
    candidate: null,
    picks: [],
    failure: null,
    done: null,
    notice: null,
  };
  private readonly listeners = new Set<(s: RewriteState) => void>();
  private watch: JobWatch | null = null;
  private lastInput: RewriteInput | null = null;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly work: WorkSession,
    private readonly providers: AiProviders,
    private readonly pollMs = 3000,
  ) {}

  get snapshot(): RewriteState {
    return this.state;
  }

  subscribe(listener: (s: RewriteState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<RewriteState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Check which provider would be used (for the header chip and the 「前往設定」 notice). */
  async loadProvider(): Promise<void> {
    try {
      const picked = await this.providers.pick();
      this.set({ provider: picked.provider, block: picked.block });
    } catch {
      // Offline: generating reports it.
    }
  }

  async generate(input: RewriteInput): Promise<void> {
    this.stopWatch();
    this.lastInput = input;
    this.set({ phase: 'loading', candidate: null, failure: null, done: null, notice: null });
    // The candidate is based on the saved revision: save pending edits first.
    await this.work.save();
    let picked: Awaited<ReturnType<AiProviders['pick']>>;
    try {
      picked = await this.providers.pick();
    } catch (err) {
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      return;
    }
    if (picked.provider === null) {
      this.set({ phase: 'idle', provider: null, block: picked.block });
      return;
    }
    this.set({ provider: picked.provider, block: null });
    try {
      const { job } = await this.client.ai.rewrite(this.work.snapshot.workId, {
        provider: picked.provider.provider,
        mode: input.mode,
        ...(input.tone === undefined ? {} : { tone: input.tone }),
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        ...(input.range === null ? {} : { selection: input.range }),
      });
      this.follow(job.id);
    } catch (err) {
      const block = blockOf(err);
      if (block !== null) {
        this.providers.invalidate();
        this.set({ phase: 'idle', block });
        return;
      }
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
    }
  }

  private follow(jobId: string): void {
    this.stopWatch();
    this.watch = new JobWatch(this.client, jobId, (job) => this.onJob(job), this.pollMs);
  }

  private stopWatch(): void {
    this.watch?.stop();
    this.watch = null;
  }

  /** Read through a method: TypeScript would otherwise keep the narrowing from before an await. */
  private watchedId(): string | null {
    return this.watch?.id ?? null;
  }

  /** SSE `ai_job.*` for this job. */
  jobChanged(jobId: string): Promise<void> {
    return this.watch?.id === jobId ? this.watch.check() : Promise.resolve();
  }

  private async onJob(job: AiJobRecord): Promise<void> {
    if (this.watch?.id !== job.id) return;
    switch (job.status) {
      case 'queued':
      case 'running':
        if (this.state.phase !== 'loading') this.set({ phase: 'loading' });
        return;
      case 'cancelled':
        this.set({ phase: 'idle' });
        return;
      case 'failed':
        this.set({
          phase: 'failed',
          failure: {
            code: job.error_code,
            message: t('ai.generateFailed'),
            detail: job.error_detail ?? null,
          },
        });
        return;
      case 'succeeded':
        break;
    }
    const result = rewriteOf(job);
    if (result === null) {
      this.set({
        phase: 'failed',
        failure: { code: 'invalid_output', message: t('ai.failInvalidOutput') },
      });
      return;
    }
    let source: string;
    try {
      source = (await this.client.works.revision(this.work.snapshot.workId, result.source_revision))
        .markdown;
    } catch (err) {
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      return;
    }
    if (this.watchedId() !== job.id) return;
    const original = source.slice(result.range.start, result.range.end);
    const segments = diffSentences(original, result.text);
    const hunks = hunkCount(segments);
    if (hunks === 0) {
      this.set({ phase: 'idle', candidate: null, notice: t('ai.noChanges') });
      return;
    }
    this.set({
      phase: 'pending',
      candidate: { jobId: job.id, result, source, original, segments, hunks },
      picks: Array.from({ length: hunks }, () => true),
    });
  }

  toggle(index: number): void {
    const picks = this.state.picks.slice();
    picks[index] = picks[index] !== true;
    this.set({ picks });
  }

  /** 停止: abort the provider call. */
  async stop(): Promise<void> {
    const id = this.watch?.id;
    this.stopWatch();
    this.set({ phase: 'idle' });
    if (id !== undefined) await this.client.ai.stop(id).catch(() => undefined);
  }

  /** 重試: re-run a failed job; with a candidate on screen, ask for a new one. */
  async retry(): Promise<void> {
    const id = this.watch?.id ?? null;
    if (this.state.phase === 'failed' && id !== null) {
      this.set({ phase: 'loading', failure: null });
      try {
        await this.client.ai.retry(id);
        this.follow(id);
      } catch (err) {
        this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      }
      return;
    }
    if (this.lastInput !== null) await this.generate(this.lastInput);
  }

  /** 捨棄 (esc). */
  discard(): void {
    this.stopWatch();
    this.set({ phase: 'idle', candidate: null, failure: null, notice: null });
  }

  /** The text the selected hunks give, for counts and preview. */
  composed(): string | null {
    const c = this.state.candidate;
    return c === null ? null : composeSegments(c.segments, this.state.picks);
  }

  lengths(): { before: number; after: number } | null {
    const c = this.state.candidate;
    const after = this.composed();
    return c === null || after === null
      ? null
      : { before: countWords(c.original), after: countWords(after) };
  }

  /** 採用 (⌘↩): the picked hunks replace the rewritten range. */
  accept(): Promise<ApplyResult> {
    const c = this.state.candidate;
    const text = this.composed();
    if (c === null || text === null || !this.state.picks.some(Boolean)) {
      return Promise.resolve('blocked');
    }
    const all = this.state.picks.every(Boolean);
    return this.apply(
      c,
      splice(c.source, c.result.range, text),
      all ? t('ai.accepted') : t('ai.acceptedPartial'),
    );
  }

  /** 插入: keep the original and add the whole candidate after it. */
  insert(): Promise<ApplyResult> {
    const c = this.state.candidate;
    if (c === null) return Promise.resolve('blocked');
    return this.apply(c, insertAfter(c.source, c.result.range, c.result.text), t('ai.inserted'));
  }

  private async apply(c: RewriteCandidate, markdown: string, label: string): Promise<ApplyResult> {
    this.set({ phase: 'busy', notice: null });
    let result: ApplyResult;
    try {
      result = await this.work.acceptAi(c.jobId, markdown, c.result.source_revision);
    } catch (err) {
      this.set({ phase: 'pending', notice: t('ai.cannotApply', { reason: messageOf(err) }) });
      return 'blocked';
    }
    if (result === 'accepted') {
      this.set({
        phase: 'idle',
        candidate: null,
        done: {
          label,
          revisionId: this.work.snapshot.baseRevision,
          previousRevisionId: c.result.source_revision,
        },
      });
    } else if (result === 'conflict') {
      // The conflict dialog takes over with the composed text as this window's draft.
      this.set({ phase: 'idle', candidate: null });
    } else {
      this.set({ phase: 'pending', notice: t('ai.applyBlocked') });
    }
    return result;
  }

  /** 復原: restore the revision before 採用 as a new revision. */
  async undo(): Promise<'restored' | 'conflict' | 'blocked'> {
    const done = this.state.done;
    if (done === null) return 'blocked';
    const r = await this.work.restore(done.previousRevisionId);
    // The candidate was based on the text before 採用; it is stale now.
    if (r === 'restored') this.set({ done: null, notice: t('ai.undoneStale') });
    else if (r === 'conflict') this.set({ done: null, notice: t('ai.undoConflict') });
    return r;
  }

  dispose(): void {
    this.stopWatch();
    this.disposed = true;
    this.listeners.clear();
  }
}

// ---- Platform title candidates ---------------------------------------------------------------

export const TITLE_PLATFORMS: readonly Platform[] = [
  'xiaohongshu',
  'wechat_mp',
  'douyin',
  'wechat_channels',
];

export type WriteOutcome = 'updated' | 'created' | 'conflict' | 'error';

export interface TitleState {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  provider: AiProviderStatus | null;
  block: AiBlock | null;
  titles: Partial<Record<Platform, TextCandidate[]>>;
  picks: Partial<Record<Platform, number>>;
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
  writing: boolean;
  written: Partial<Record<Platform, WriteOutcome>> | null;
}

/** Characters as the platform limits count them (code points). */
export function titleLength(text: string): number {
  return charCount(text);
}

export function titleLimit(platform: Platform): number | null {
  return PLATFORM_LIMITS[platform].titleMaxChars;
}

/**
 * 標題 tab (QC-024): one suggestions job for the four platforms' titles; the
 * picked title is written to each platform variant with its current
 * `base_revision` (a platform without a variant is first drafted from the original).
 */
export class TitleSession {
  private state: TitleState = {
    phase: 'idle',
    provider: null,
    block: null,
    titles: {},
    picks: {},
    failure: null,
    writing: false,
    written: null,
  };
  private readonly listeners = new Set<(s: TitleState) => void>();
  private watch: JobWatch | null = null;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly workId: string,
    private readonly providers: AiProviders,
    private readonly pollMs = 3000,
  ) {}

  get snapshot(): TitleState {
    return this.state;
  }

  subscribe(listener: (s: TitleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<TitleState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  async loadProvider(): Promise<void> {
    try {
      const picked = await this.providers.pick();
      this.set({ provider: picked.provider, block: picked.block });
    } catch {
      // Offline: generating reports it.
    }
  }

  async generate(): Promise<void> {
    this.stopWatch();
    this.set({ phase: 'loading', failure: null, written: null });
    let picked: Awaited<ReturnType<AiProviders['pick']>>;
    try {
      picked = await this.providers.pick();
    } catch (err) {
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      return;
    }
    if (picked.provider === null) {
      this.set({ phase: 'idle', provider: null, block: picked.block });
      return;
    }
    this.set({ provider: picked.provider, block: null });
    try {
      const { job } = await this.client.ai.suggest(this.workId, {
        provider: picked.provider.provider,
        platforms: [...TITLE_PLATFORMS],
        fields: ['title'],
        count: 3,
      });
      this.follow(job.id);
    } catch (err) {
      const block = blockOf(err);
      if (block !== null) {
        this.providers.invalidate();
        this.set({ phase: 'idle', block });
        return;
      }
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
    }
  }

  private follow(jobId: string): void {
    this.stopWatch();
    this.watch = new JobWatch(
      this.client,
      jobId,
      (job) => {
        this.onJob(job);
      },
      this.pollMs,
    );
  }

  private stopWatch(): void {
    this.watch?.stop();
    this.watch = null;
  }

  jobChanged(jobId: string): Promise<void> {
    return this.watch?.id === jobId ? this.watch.check() : Promise.resolve();
  }

  private onJob(job: AiJobRecord): void {
    if (this.watch?.id !== job.id) return;
    if (job.status === 'queued' || job.status === 'running') return;
    if (job.status === 'cancelled') {
      this.set({ phase: 'idle' });
      return;
    }
    if (job.status === 'failed') {
      this.set({
        phase: 'failed',
        failure: {
          code: job.error_code,
          message: t('ai.generateFailed'),
          detail: job.error_detail ?? null,
        },
      });
      return;
    }
    const result = suggestionsOf(job);
    if (result === null) {
      this.set({
        phase: 'failed',
        failure: { code: 'invalid_output', message: t('ai.failInvalidOutput') },
      });
      return;
    }
    const titles: Partial<Record<Platform, TextCandidate[]>> = {};
    const picks: Partial<Record<Platform, number>> = {};
    for (const p of result.platforms) {
      const list = (p.titles ?? []).filter((t) => t.text.trim() !== '');
      if (list.length === 0) continue;
      titles[p.platform] = list;
      picks[p.platform] = 0;
    }
    this.set({ phase: Object.keys(titles).length === 0 ? 'idle' : 'ready', titles, picks });
  }

  pick(platform: Platform, index: number): void {
    this.set({ picks: { ...this.state.picks, [platform]: index }, written: null });
  }

  async stop(): Promise<void> {
    const id = this.watch?.id;
    this.stopWatch();
    this.set({ phase: this.hasTitles() ? 'ready' : 'idle' });
    if (id !== undefined) await this.client.ai.stop(id).catch(() => undefined);
  }

  async retry(): Promise<void> {
    const id = this.watch?.id ?? null;
    if (this.state.phase === 'failed' && id !== null) {
      this.set({ phase: 'loading', failure: null });
      try {
        await this.client.ai.retry(id);
        this.follow(id);
      } catch (err) {
        this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      }
      return;
    }
    await this.generate();
  }

  hasTitles(): boolean {
    return Object.keys(this.state.titles).length > 0;
  }

  /** 寫入平台版本: each picked title, one PATCH per platform with its current revision. */
  async write(): Promise<Partial<Record<Platform, WriteOutcome>>> {
    this.set({ writing: true, written: null });
    const written: Partial<Record<Platform, WriteOutcome>> = {};
    for (const platform of TITLE_PLATFORMS) {
      const list = this.state.titles[platform];
      const title = list?.[this.state.picks[platform] ?? 0]?.text;
      if (title === undefined) continue;
      written[platform] = await this.writeOne(platform, title);
    }
    this.set({ writing: false, written });
    return written;
  }

  private async writeOne(platform: Platform, title: string): Promise<WriteOutcome> {
    let created = false;
    try {
      let variant;
      try {
        variant = await this.client.variants.get(this.workId, platform);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        variant = await this.client.variants.redraft(this.workId, platform);
        created = true;
      }
      await this.client.variants.patch(this.workId, platform, {
        base_revision: variant.revision,
        title,
      });
      return created ? 'created' : 'updated';
    } catch (err) {
      return err instanceof ApiError && err.status === 409 ? 'conflict' : 'error';
    }
  }

  dispose(): void {
    this.stopWatch();
    this.disposed = true;
    this.listeners.clear();
  }
}
