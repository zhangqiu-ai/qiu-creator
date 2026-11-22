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

export type ImageJobPhase = 'generating' | 'ready' | 'failed' | 'cancelled';

/** One generation: from the selection toolbar (in the text) or from the 圖片 panel. */
export interface ImageJobView {
  /** Local key (the job id is only known once the service queued it). */
  key: string;
  jobId: string | null;
  request: ImageRequest;
  origin: 'inline' | 'panel';
  /** Inline: the Markdown offset after which the placeholder stands (a block end). */
  anchor: number | null;
  phase: ImageJobPhase;
  candidates: ImageCandidateView[];
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
  /** The candidate being kept. */
  busy: number | null;
}

export interface ImageGenState {
  /** New API as the service reports it; null until read. */
  provider: AiProviderStatus | null;
  /** Why nothing can be generated yet (no key, or the notice not yet accepted). */
  block: AiBlock | null;
  /** The relay's image models (`kind: image`); null until read, [] when it offers none. */
  models: AiRelayModel[] | null;
  /** Cost of the request being composed; null until asked (or when it failed). */
  estimate: AiImageEstimateResponse | null;
  /** This editor's generations, newest first (the panel's 生成記錄; App restarts start empty). */
  jobs: ImageJobView[];
  /** The revision before the last keep that changed the work, for 復原. */
  undo: { revisionId: string; placement: 'insert' | 'cover' } | null;
}

export type KeepResult = 'kept' | 'conflict' | 'expired' | 'blocked';

const INITIAL: ImageGenState = {
  provider: null,
  block: null,
  models: null,
  estimate: null,
  jobs: [],
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

/** Candidates not yet kept or discarded (「有候選未保留」, and what closing the work asks about). */
export function pendingCandidates(s: ImageGenState): number {
  let n = 0;
  for (const j of s.jobs) for (const c of j.candidates) if (c.fate === 'new') n += 1;
  return n;
}

let nextKey = 0;

export class ImageGenSession {
  private state: ImageGenState = INITIAL;
  private readonly listeners = new Set<(s: ImageGenState) => void>();
  private readonly watches = new Map<string, JobWatch>();
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

  job(key: string): ImageJobView | undefined {
    return this.state.jobs.find((j) => j.key === key);
  }

  private patchJob(key: string, change: Partial<ImageJobView>): void {
    this.set({ jobs: this.state.jobs.map((j) => (j.key === key ? { ...j, ...change } : j)) });
  }

  private markCandidate(key: string, index: number, change: Partial<ImageCandidateView>): void {
    const j = this.job(key);
    if (j === undefined) return;
    this.patchJob(key, {
      candidates: j.candidates.map((c) => (c.index === index ? { ...c, ...change } : c)),
    });
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
  async estimate(r: ImageRequest): Promise<AiImageEstimateResponse | null> {
    const n = ++this.estimating;
    if (!canSend(r)) {
      this.set({ estimate: null });
      return null;
    }
    try {
      const res = await this.client.ai.images.estimate(this.work.snapshot.workId, toApiRequest(r));
      if (n === this.estimating) this.set({ estimate: res });
      return res;
    } catch {
      if (n === this.estimating) this.set({ estimate: null });
      return null;
    }
  }

  /**
   * Send `r` and return the new job's key. Pending edits are saved first, so
   * the prompt and the cover's text are current. An inline job stands after
   * the block ending at `anchor`; it replaces an earlier inline job there.
   */
  async generate(
    r: ImageRequest,
    where: { origin: 'inline'; anchor: number } | { origin: 'panel' } = { origin: 'panel' },
  ): Promise<string> {
    const key = `img-${String(++nextKey)}`;
    const job: ImageJobView = {
      key,
      jobId: null,
      request: r,
      origin: where.origin,
      anchor: where.origin === 'inline' ? where.anchor : null,
      phase: 'generating',
      candidates: [],
      failure: null,
      busy: null,
    };
    // One placeholder in the text at a time: a new one replaces the old.
    const replaced =
      where.origin === 'inline' ? this.state.jobs.filter((j) => j.origin === 'inline') : [];
    for (const old of replaced) void this.remove(old.key);
    this.set({
      jobs: [
        job,
        ...this.state.jobs.filter((j) => j.origin !== 'inline' || where.origin !== 'inline'),
      ],
    });
    await this.work.save();
    try {
      const res = await this.client.ai.images.create(
        this.work.snapshot.workId,
        toApiRequest(r, this.work.snapshot.baseRevision),
      );
      if (this.job(key) === undefined) {
        // Removed while it was being sent: stop it at once.
        await this.client.ai.stop(res.job.id).catch(() => undefined);
        return key;
      }
      this.patchJob(key, { jobId: res.job.id });
      this.follow(key, res.job.id);
    } catch (err) {
      const block = blockOf(err);
      if (block !== null) {
        this.providers.invalidate();
        this.set({ block, jobs: this.state.jobs.filter((j) => j.key !== key) });
        return key;
      }
      this.patchJob(key, { phase: 'failed', failure: { code: null, message: messageOf(err) } });
    }
    return key;
  }

  private follow(key: string, jobId: string): void {
    this.watches.get(key)?.stop();
    this.watches.set(
      key,
      new JobWatch(
        this.client,
        jobId,
        (job) => {
          this.onJob(key, job);
        },
        this.pollMs,
      ),
    );
  }

  /** SSE `ai_job.*`. */
  async jobChanged(jobId: string): Promise<void> {
    for (const w of this.watches.values()) if (w.id === jobId) await w.check();
  }

  private onJob(key: string, job: AiJobRecord): void {
    if (this.job(key)?.jobId !== job.id) return;
    switch (job.status) {
      case 'queued':
      case 'running':
        // Image jobs report no progress: queued or running is the placeholder state.
        return;
      case 'cancelled':
        this.patchJob(key, { phase: 'cancelled' });
        return;
      case 'failed':
        this.patchJob(key, {
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
      this.patchJob(key, {
        phase: 'failed',
        failure: { code: 'invalid_output', message: t('ai.failInvalidOutput') },
      });
      return;
    }
    this.patchJob(key, { phase: 'ready', candidates: result.candidates.map((c) => this.view(c)) });
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

  /** 取消: abort the relay call (a request already sent may still be charged). */
  async stop(key: string): Promise<void> {
    const j = this.job(key);
    this.watches.get(key)?.stop();
    this.watches.delete(key);
    if (j === undefined) return;
    this.patchJob(key, { phase: 'cancelled' });
    if (j.jobId !== null) await this.client.ai.stop(j.jobId).catch(() => undefined);
  }

  /** 重試／重新生成: run a failed job again, or send the same request anew in its place. */
  async retry(key: string): Promise<void> {
    const j = this.job(key);
    if (j === undefined) return;
    if (j.phase === 'failed' && j.jobId !== null) {
      this.patchJob(key, { phase: 'generating', failure: null });
      try {
        await this.client.ai.retry(j.jobId);
        this.follow(key, j.jobId);
      } catch (err) {
        this.patchJob(key, { phase: 'failed', failure: { code: null, message: messageOf(err) } });
      }
      return;
    }
    const where =
      j.origin === 'inline' && j.anchor !== null
        ? ({ origin: 'inline', anchor: j.anchor } as const)
        : ({ origin: 'panel' } as const);
    if (where.origin === 'panel') await this.remove(key);
    await this.generate(j.request, where);
  }

  /**
   * 保留 one candidate: insert it at `offset` in the saved Markdown, make it
   * the cover, or only put it in the library. Several candidates of one job
   * can be kept in turn.
   */
  async keep(key: string, index: number, placement: AiImagePlacement): Promise<KeepResult> {
    const j = this.job(key);
    const c = j?.candidates.find((x) => x.index === index);
    if (j?.jobId == null || c?.fate !== 'new' || j.busy !== null) return 'blocked';
    this.patchJob(key, { busy: index });
    let outcome: Awaited<ReturnType<WorkSession['keepAiImage']>>;
    try {
      outcome = await this.work.keepAiImage(j.jobId, index, placement);
    } catch (err) {
      this.patchJob(key, { busy: null, failure: { code: null, message: messageOf(err) } });
      return 'blocked';
    }
    this.patchJob(key, { busy: null });
    switch (outcome.result) {
      case 'accepted':
        this.markCandidate(key, index, { fate: 'kept', keptAs: placement.type });
        if (placement.type !== 'library' && outcome.previousRevision !== null)
          this.set({ undo: { revisionId: outcome.previousRevision, placement: placement.type } });
        return 'kept';
      case 'expired':
        this.markCandidate(key, index, { fate: 'expired', src: null });
        return 'expired';
      case 'conflict':
        return 'conflict';
      case 'blocked':
        return 'blocked';
    }
  }

  /** 捨棄 one candidate: its temporary file is deleted. */
  async discard(key: string, index: number): Promise<void> {
    const j = this.job(key);
    const c = j?.candidates.find((x) => x.index === index);
    if (j?.jobId == null || c?.fate !== 'new') return;
    this.markCandidate(key, index, { fate: 'discarded', src: null });
    await this.client.ai.images
      .discard(this.work.snapshot.workId, j.jobId, index)
      .catch(() => undefined);
  }

  /** Take a job off the screen: a running one is stopped, candidates not kept are discarded. */
  async remove(key: string): Promise<void> {
    const j = this.job(key);
    if (j === undefined) return;
    this.watches.get(key)?.stop();
    this.watches.delete(key);
    this.set({ jobs: this.state.jobs.filter((x) => x.key !== key) });
    if (j.jobId === null) return;
    if (j.phase === 'generating') {
      await this.client.ai.stop(j.jobId).catch(() => undefined);
      return;
    }
    for (const c of j.candidates)
      if (c.fate === 'new')
        await this.client.ai.images
          .discard(this.work.snapshot.workId, j.jobId, c.index)
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

  dispose(): void {
    for (const w of this.watches.values()) w.stop();
    this.watches.clear();
    this.disposed = true;
    this.listeners.clear();
  }
}
