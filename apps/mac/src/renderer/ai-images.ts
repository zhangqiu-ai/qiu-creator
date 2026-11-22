import { imageResultOf, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AiFailureCode,
  AiImageAspectRatio,
  AiImageCandidate,
  AiImageEstimateResponse,
  AiImagePlacement,
  AiImageRequest,
  AiJobRecord,
  AiProviderStatus,
  AiRelayModel,
} from '@qiu-creator/contracts';
import { blockOf, JobWatch, messageOf, type AiBlock, type AiProviders } from './ai-session.js';
import { t } from './i18n.js';
import type { WorkSession } from './work-session.js';

/**
 * AI 生成圖片與封面 (QC-070), the data layer under the editor's image panel.
 * New API only: the relay's image models, a cost estimate before sending, one
 * job at a time, and its candidates. Candidates live in the service's
 * temporary cache, never in the work; 保留 adds one to the library and (to
 * insert it or make it the cover) writes it into the work through
 * `WorkSession.keepAiImage`, so a stale base opens the usual conflict flow.
 * 捨棄 deletes the temporary file. The UI only renders this state.
 */

export type ImagePurpose = 'image' | 'cover';

export interface ImageRequest {
  purpose: ImagePurpose;
  model: string;
  /** Required for `image`; for `cover`, words added to the title and text. */
  prompt?: string;
  style?: string;
  aspectRatio: AiImageAspectRatio;
  /** 1–4 images. */
  count: number;
}

/** What became of a candidate on this screen. */
export type CandidateFate = 'new' | 'kept' | 'discarded' | 'expired';

export interface ImageCandidateView {
  index: number;
  width: number;
  height: number;
  /** Absolute URL for `<img src>`; null once the candidate left the cache. */
  src: string | null;
  fate: CandidateFate;
  /** How it was kept (inserted, made the cover, or only put in the library). */
  keptAs: AiImagePlacement['type'] | null;
}

export type ImagePhase = 'idle' | 'generating' | 'ready' | 'failed';

export interface ImageGenState {
  phase: ImagePhase;
  /** New API as the service reports it; null until read. */
  provider: AiProviderStatus | null;
  /** Why nothing can be generated yet (no key, or the notice not yet accepted). */
  block: AiBlock | null;
  /** The relay's image models (`kind: image`); null until read, [] when it offers none. */
  models: AiRelayModel[] | null;
  /** Cost of the request being composed; null until asked (or when it failed). */
  estimate: AiImageEstimateResponse | null;
  /** The request on screen (its count and ratio size the placeholders while generating). */
  request: ImageRequest | null;
  jobId: string | null;
  candidates: ImageCandidateView[];
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
  /** The candidate being kept or discarded. */
  busy: number | null;
  /** The revision before the last keep that changed the work, for 復原. */
  undo: { revisionId: string; index: number } | null;
}

export type KeepResult = 'kept' | 'conflict' | 'expired' | 'blocked';

const INITIAL: ImageGenState = {
  phase: 'idle',
  provider: null,
  block: null,
  models: null,
  estimate: null,
  request: null,
  jobId: null,
  candidates: [],
  failure: null,
  busy: null,
  undo: null,
};

/** The service's request body for an editor request. */
export function toApiRequest(r: ImageRequest, sourceRevision?: string): AiImageRequest {
  const prompt = r.prompt?.trim() ?? '';
  const style = r.style?.trim() ?? '';
  return {
    provider: 'new-api',
    model: r.model,
    purpose: r.purpose,
    ...(prompt === '' ? {} : { prompt }),
    ...(style === '' ? {} : { style }),
    aspect_ratio: r.aspectRatio,
    n: r.count,
    ...(sourceRevision === undefined ? {} : { source_revision: sourceRevision }),
  };
}

/** Whether the request can be sent: a model, and a prompt for an image (a cover can do without). */
export function canSend(r: ImageRequest): boolean {
  return r.model !== '' && (r.purpose === 'cover' || (r.prompt?.trim() ?? '') !== '');
}

export class ImageGenSession {
  private state: ImageGenState = INITIAL;
  private readonly listeners = new Set<(s: ImageGenState) => void>();
  private watch: JobWatch | null = null;
  private estimating = 0;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly work: WorkSession,
    private readonly providers: AiProviders,
    private readonly pollMs = 3000,
  ) {}

  get snapshot(): ImageGenState {
    return this.state;
  }

  subscribe(listener: (s: ImageGenState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<ImageGenState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Is New API ready, and which image models does it offer? */
  async load(): Promise<void> {
    let provider: AiProviderStatus | undefined;
    try {
      provider = (await this.providers.list()).find((p) => p.provider === 'new-api');
    } catch {
      // Offline: generating reports it.
      return;
    }
    const block: AiBlock | null =
      provider?.ready === true ? null : provider?.key_configured === true ? 'consent' : 'key';
    this.set({ provider: provider ?? null, block });
    if (block === 'key') {
      this.set({ models: [] });
      return;
    }
    try {
      const res = await this.client.ai.newApiModels();
      this.set({ models: res.models.filter((m) => m.kind === 'image') });
    } catch {
      this.set({ models: [] });
    }
  }

  /** The cost of `r` before sending (`max_cost_usd` null: 無法預估). Late answers are dropped. */
  async estimate(r: ImageRequest): Promise<void> {
    const n = ++this.estimating;
    if (!canSend(r)) {
      this.set({ estimate: null });
      return;
    }
    try {
      const res = await this.client.ai.images.estimate(this.work.snapshot.workId, toApiRequest(r));
      if (n === this.estimating) this.set({ estimate: res });
    } catch {
      if (n === this.estimating) this.set({ estimate: null });
    }
  }

  /** Send `r`: pending edits are saved first, so the prompt and the cover's text are current. */
  async generate(r: ImageRequest): Promise<void> {
    this.stopWatch();
    this.set({
      phase: 'generating',
      request: r,
      jobId: null,
      candidates: [],
      failure: null,
      undo: null,
    });
    await this.work.save();
    try {
      const { job } = await this.client.ai.images.create(
        this.work.snapshot.workId,
        toApiRequest(r, this.work.snapshot.baseRevision),
      );
      this.set({ jobId: job.id });
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

  /** SSE `ai_job.*` for this job. */
  jobChanged(jobId: string): Promise<void> {
    return this.watch?.id === jobId ? this.watch.check() : Promise.resolve();
  }

  private onJob(job: AiJobRecord): void {
    if (this.watch?.id !== job.id) return;
    switch (job.status) {
      case 'queued':
      case 'running':
        // Image jobs report no progress: queued or running is the placeholder state.
        if (this.state.phase !== 'generating') this.set({ phase: 'generating' });
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
    const result = imageResultOf(job);
    if (result === null) {
      this.set({
        phase: 'failed',
        failure: { code: 'invalid_output', message: t('ai.failInvalidOutput') },
      });
      return;
    }
    this.set({ phase: 'ready', candidates: result.candidates.map((c) => this.view(c)) });
  }

  private view(c: AiImageCandidate): ImageCandidateView {
    return {
      index: c.index,
      width: c.width,
      height: c.height,
      src: c.expired || c.url === null ? null : this.client.media.absoluteUrl(c.url),
      fate: c.expired ? 'expired' : 'new',
      keptAs: null,
    };
  }

  private mark(index: number, change: Partial<ImageCandidateView>): void {
    this.set({
      candidates: this.state.candidates.map((c) => (c.index === index ? { ...c, ...change } : c)),
    });
  }

  /** 停止: abort the relay call (never retried on its own, so nothing is paid twice). */
  async stop(): Promise<void> {
    const id = this.watch?.id;
    this.stopWatch();
    this.set({ phase: 'idle' });
    if (id !== undefined) await this.client.ai.stop(id).catch(() => undefined);
  }

  /** 重試: run the failed job again, or send the same request anew. */
  async retry(): Promise<void> {
    const id = this.state.jobId;
    if (this.state.phase === 'failed' && id !== null) {
      this.set({ phase: 'generating', failure: null });
      try {
        await this.client.ai.retry(id);
        this.follow(id);
      } catch (err) {
        this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
      }
      return;
    }
    if (this.state.request !== null) await this.generate(this.state.request);
  }

  /**
   * 保留 one candidate: insert it at `offset` in the saved Markdown, make it
   * the cover, or only put it in the library. Several candidates of one job
   * can be kept in turn.
   */
  async keep(index: number, placement: AiImagePlacement): Promise<KeepResult> {
    const jobId = this.state.jobId;
    const c = this.state.candidates.find((x) => x.index === index);
    if (jobId === null || c?.fate !== 'new' || this.state.busy !== null) return 'blocked';
    this.set({ busy: index });
    let outcome: Awaited<ReturnType<WorkSession['keepAiImage']>>;
    try {
      outcome = await this.work.keepAiImage(jobId, index, placement);
    } catch (err) {
      this.set({ busy: null, failure: { code: null, message: messageOf(err) } });
      return 'blocked';
    }
    this.set({ busy: null });
    switch (outcome.result) {
      case 'accepted':
        this.mark(index, { fate: 'kept', keptAs: placement.type, src: null });
        if (placement.type !== 'library' && outcome.previousRevision !== null)
          this.set({ undo: { revisionId: outcome.previousRevision, index } });
        return 'kept';
      case 'expired':
        this.mark(index, { fate: 'expired', src: null });
        return 'expired';
      case 'conflict':
        return 'conflict';
      case 'blocked':
        return 'blocked';
    }
  }

  /** 捨棄 one candidate: its temporary file is deleted. */
  async discard(index: number): Promise<void> {
    const jobId = this.state.jobId;
    const c = this.state.candidates.find((x) => x.index === index);
    if (jobId === null || c?.fate !== 'new') return;
    this.mark(index, { fate: 'discarded', src: null });
    await this.client.ai.images
      .discard(this.work.snapshot.workId, jobId, index)
      .catch(() => undefined);
  }

  /** 復原 the last keep that changed the work: restore the revision before it. */
  async undo(): Promise<'restored' | 'conflict' | 'blocked'> {
    const u = this.state.undo;
    if (u === null) return 'blocked';
    const r = await this.work.restore(u.revisionId);
    if (r !== 'blocked') this.set({ undo: null });
    return r;
  }

  /** Close the results: the candidates not kept are discarded. */
  async clear(): Promise<void> {
    this.stopWatch();
    const left = this.state.candidates.filter((c) => c.fate === 'new').map((c) => c.index);
    const jobId = this.state.jobId;
    this.set({ phase: 'idle', jobId: null, candidates: [], failure: null, undo: null });
    if (jobId === null) return;
    for (const index of left)
      await this.client.ai.images
        .discard(this.work.snapshot.workId, jobId, index)
        .catch(() => undefined);
  }

  dispose(): void {
    this.stopWatch();
    this.disposed = true;
    this.listeners.clear();
  }
}
