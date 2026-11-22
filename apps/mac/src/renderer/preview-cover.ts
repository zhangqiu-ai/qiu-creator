import { ApiError, imageResultOf, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  PLATFORM_COVER_RATIOS,
  type AiFailureCode,
  type AiImageAspectRatio,
  type AiImageCandidate,
  type AiImageEstimateResponse,
  type AiJobRecord,
  type AiProviderStatus,
  type AiRelayModel,
  type Platform,
} from '@qiu-creator/contracts';
import { blockOf, JobWatch, messageOf, type AiBlock, type AiProviders } from './ai-session.js';
import { t } from './i18n.js';

/**
 * AI 封面 for one platform version (QC-076, PT-20261122-004). The ratio is the
 * platform's (`PLATFORM_COVER_RATIOS`), the prompt comes from that version's
 * title and text, and four candidates come back. 保留 only adds the picked
 * image to the library (`placement: library`), so the original is never
 * written; the panel then sets it as the variant's `cover_asset_id`, which is
 * undoable. Candidates not kept are discarded, like the editor's images.
 */

export interface CoverCandidate {
  index: number;
  /** Absolute URL for `<img src>`; null once it left the temporary cache. */
  src: string | null;
  fate: 'new' | 'kept' | 'discarded' | 'expired';
}

export interface CoverGenState {
  /** New API as the service reports it; null until read. */
  provider: AiProviderStatus | null;
  block: AiBlock | null;
  /** The relay's image models; null until read, [] when it offers none. */
  models: AiRelayModel[] | null;
  estimate: AiImageEstimateResponse | null;
  phase: 'idle' | 'generating' | 'ready' | 'failed' | 'cancelled';
  /** The platform this run is for; null while nothing has been asked for. */
  platform: Platform | null;
  jobId: string | null;
  candidates: CoverCandidate[];
  /** How many placeholders to draw while it runs. */
  pending: number;
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
  /** The candidate being kept. */
  busy: number | null;
}

const INITIAL: CoverGenState = {
  provider: null,
  block: null,
  models: null,
  estimate: null,
  phase: 'idle',
  platform: null,
  jobId: null,
  candidates: [],
  pending: 0,
  failure: null,
  busy: null,
};

/** What 保留 gave: the library asset, or why it could not be kept. */
export type KeepCover = { ok: true; assetId: string } | { ok: false; reason: 'expired' | 'failed' };

/** Images one run asks for (PT-20261122-004: 生成 4 張). */
export const COVER_COUNT = 4;

export function coverRatio(platform: Platform): AiImageAspectRatio {
  return PLATFORM_COVER_RATIOS[platform];
}

/** `aspect-ratio` for CSS, e.g. `3 / 4`. */
export function ratioStyle(platform: Platform): string {
  return coverRatio(platform).replace(':', ' / ');
}

/** The prompt the cover starts from: this platform's title, then its text. */
export function coverPromptFrom(title: string, body: string, max = 600): string {
  const text = `${title.trim()}\n${body.trim()}`.trim();
  return text.length > max ? text.slice(0, max) : text;
}

export class CoverGenSession {
  private state: CoverGenState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private watch: JobWatch | null = null;
  private estimating = 0;
  private disposed = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly workId: string,
    private readonly providers: AiProviders,
    private readonly pollMs = 3000,
  ) {}

  get snapshot(): CoverGenState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<CoverGenState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
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

  private request(platform: Platform, model: string, prompt: string) {
    const text = prompt.trim();
    return {
      provider: 'new-api' as const,
      model,
      purpose: 'cover' as const,
      ...(text === '' ? {} : { prompt: text.slice(0, 4000) }),
      platform,
      aspect_ratio: coverRatio(platform),
      n: COVER_COUNT,
    };
  }

  /** The cost before sending (`max_cost_usd` null: 費用無法預估). Late answers are dropped. */
  async estimate(platform: Platform, model: string, prompt: string): Promise<boolean> {
    const n = ++this.estimating;
    if (model === '') {
      this.set({ estimate: null });
      return false;
    }
    try {
      const res = await this.client.ai.images.estimate(
        this.workId,
        this.request(platform, model, prompt),
      );
      if (n === this.estimating) this.set({ estimate: res });
      return res.estimate.max_cost_usd === null;
    } catch {
      if (n === this.estimating) this.set({ estimate: null });
      return false;
    }
  }

  /** Send one run; an earlier run's candidates are discarded first. */
  async generate(platform: Platform, model: string, prompt: string): Promise<void> {
    await this.discardAll();
    this.set({
      phase: 'generating',
      platform,
      jobId: null,
      candidates: [],
      pending: COVER_COUNT,
      failure: null,
      busy: null,
    });
    try {
      const res = await this.client.ai.images.create(
        this.workId,
        this.request(platform, model, prompt),
      );
      if (this.state.phase !== 'generating') {
        await this.client.ai.stop(res.job.id).catch(() => undefined);
        return;
      }
      this.set({ jobId: res.job.id });
      this.follow(res.job.id);
    } catch (err) {
      const block = blockOf(err);
      if (block !== null) {
        this.providers.invalidate();
        this.set({ phase: 'idle', block, pending: 0 });
        return;
      }
      this.set({
        phase: 'failed',
        pending: 0,
        failure: { code: null, message: messageOf(err) },
      });
    }
  }

  private follow(jobId: string): void {
    this.watch?.stop();
    this.watch = new JobWatch(
      this.client,
      jobId,
      (job) => {
        this.onJob(job);
      },
      this.pollMs,
    );
  }

  /** SSE `ai_job.*`. */
  jobChanged(jobId: string): Promise<void> {
    return this.watch?.id === jobId ? this.watch.check() : Promise.resolve();
  }

  private onJob(job: AiJobRecord): void {
    if (this.state.jobId !== job.id) return;
    switch (job.status) {
      case 'queued':
      case 'running':
        // Image jobs report no progress: queued or running is the placeholder state.
        return;
      case 'cancelled':
        this.set({ phase: 'cancelled', pending: 0 });
        return;
      case 'failed':
        this.set({
          phase: 'failed',
          pending: 0,
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
        pending: 0,
        failure: { code: 'invalid_output', message: t('ai.failInvalidOutput') },
      });
      return;
    }
    this.set({
      phase: 'ready',
      pending: 0,
      candidates: result.candidates.map((c) => this.view(c)),
    });
  }

  private view(c: AiImageCandidate): CoverCandidate {
    return {
      index: c.index,
      src: c.expired || c.url === null ? null : this.client.media.absoluteUrl(c.url),
      fate: c.expired ? 'expired' : 'new',
    };
  }

  /** 取消: abort the relay call (a request already sent may still be charged). */
  async stop(): Promise<void> {
    const id = this.state.jobId;
    this.watch?.stop();
    this.watch = null;
    this.set({ phase: 'cancelled', pending: 0 });
    if (id !== null) await this.client.ai.stop(id).catch(() => undefined);
  }

  /**
   * 保留: put the picked candidate in the library and return its asset id. The
   * work itself is not written (`placement: library`), so `baseRevision` is
   * only what the API asks for; the panel sets the variant's cover from the id.
   */
  async keep(index: number, baseRevision: string): Promise<KeepCover> {
    const jobId = this.state.jobId;
    const candidate = this.state.candidates.find((c) => c.index === index);
    if (jobId === null || candidate?.fate !== 'new' || this.state.busy !== null) {
      return { ok: false, reason: 'failed' };
    }
    this.set({ busy: index });
    try {
      const kept = await this.client.ai.images.keep(this.workId, jobId, {
        index,
        base_revision: baseRevision,
        placement: { type: 'library' },
      });
      this.set({
        busy: null,
        candidates: this.state.candidates.map((c) =>
          c.index === index ? { ...c, fate: 'kept' } : c,
        ),
      });
      return { ok: true, assetId: kept.asset_id };
    } catch (err) {
      this.set({ busy: null });
      if (err instanceof ApiError && err.code === 'ai_job_not_acceptable') {
        this.set({
          candidates: this.state.candidates.map((c) =>
            c.index === index ? { ...c, fate: 'expired', src: null } : c,
          ),
        });
        return { ok: false, reason: 'expired' };
      }
      this.set({ failure: { code: null, message: messageOf(err) } });
      return { ok: false, reason: 'failed' };
    }
  }

  /** 捨棄: delete the temporary files of every candidate not kept, and clear the run. */
  async discardAll(): Promise<void> {
    const { jobId, candidates } = this.state;
    this.watch?.stop();
    this.watch = null;
    this.set({ phase: 'idle', jobId: null, candidates: [], pending: 0, busy: null });
    if (jobId === null) return;
    for (const c of candidates) {
      if (c.fate === 'new') {
        await this.client.ai.images.discard(this.workId, jobId, c.index).catch(() => undefined);
      }
    }
  }

  dispose(): void {
    this.watch?.stop();
    this.watch = null;
    this.disposed = true;
    this.listeners.clear();
  }
}
