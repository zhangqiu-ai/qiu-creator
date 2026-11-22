import { ApiError, videoUnderstandingOf, type CreatorHubClient } from '@qiu-creator/api-client';
import { codeText, formatBytes, t } from './i18n.js';
import {
  GEMINI_VIDEO_LIMITS,
  type AiFailureCode,
  type AiJobRecord,
  type AiProviderStatus,
  type AiUsageResponse,
  type AssetRecord,
  type VideoEstimate,
  type VideoResolution,
  type VideoUnderstandingResult,
} from '@qiu-creator/contracts';
import { JobWatch } from './ai-session.js';

export type VideoPhase =
  'idle' | 'estimating' | 'ready' | 'confirm' | 'reuse' | 'running' | 'done' | 'failed';

export interface VideoState {
  gemini: AiProviderStatus | null;
  /** No Gemini key: the page shows 「未設定 Gemini 金鑰」 with 前往設定. */
  noKey: boolean;
  asset: AssetRecord | null;
  model: string | null;
  resolution: VideoResolution;
  /** Low resolution was picked automatically because the video is longer than the default limit. */
  autoLow: boolean;
  estimate: VideoEstimate | null;
  /** Why the video cannot be estimated or sent (too large, unsupported, too long…). */
  estimateError: string | null;
  phase: VideoPhase;
  /** The confirm dialog came from 重新分析 (charges again). */
  reanalyze: boolean;
  /** Why 同意 or 上傳 failed; the confirm dialog stays open and shows it. */
  confirmError: string | null;
  /** The running job. */
  job: AiJobRecord | null;
  /** The job whose result is shown. */
  shown: AiJobRecord | null;
  result: VideoUnderstandingResult | null;
  /** Latest succeeded analysis of this asset (for 沿用 and 查看上次結果). */
  previous: AiJobRecord | null;
  failure: { code: AiFailureCode | null; message: string; detail?: string | null } | null;
}

/**
 * Interface text for a failed call: the error code, never the service's own
 * (English) message (QC-042). A failed fetch is reported as 「無法連線到服務」,
 * the wording this page has always used.
 */
function messageOf(err: unknown): string {
  return err instanceof ApiError ? codeText(err.code) : t('common.cannotConnect');
}

/** A number from an error's `details`, or null. */
function detail(err: ApiError, key: string): number | null {
  const value = err.body?.error.details?.[key];
  return typeof value === 'number' ? value : null;
}

/**
 * Why this video cannot be estimated or sent, worded from the code and the
 * `details` of the service's answer (QC-042): too large, too long for the
 * chosen resolution, or not a video Gemini reads.
 */
function estimateErrorText(err: unknown, asset: AssetRecord | null): string {
  if (!(err instanceof ApiError)) return t('common.cannotConnect');
  if (err.code === 'unsupported_media_type') {
    return asset !== null && asset.kind === 'video'
      ? t('ai.estErrUnsupportedFormat', { format: asset.mime_type })
      : t('ai.estErrNotVideo');
  }
  if (err.code === 'payload_too_large') {
    const size = detail(err, 'size_bytes');
    const max = detail(err, 'max_bytes');
    if (size !== null && max !== null) {
      return t('ai.estErrTooLarge', { size: formatBytes(size), max: formatBytes(max) });
    }
  }
  if (err.code === 'validation_error') {
    const seconds = detail(err, 'duration_seconds');
    const max = detail(err, 'max_seconds');
    if (seconds !== null && max !== null) {
      const minutes = Math.round(seconds / 6) / 10;
      return max <= GEMINI_VIDEO_LIMITS.maxDurationSeconds.default
        ? t('ai.estErrTooLongDefault', { minutes })
        : t('ai.estErrTooLongLow', { minutes });
    }
  }
  return codeText(err.code);
}

/** Job is a video analysis of this asset. */
export function isVideoJobOf(job: AiJobRecord, assetId: string): boolean {
  return job.task?.type === 'video_understanding' && job.task.asset_id === assetId;
}

/** Upload progress in percent, or null while there is no trustworthy number. */
export function uploadPercent(job: AiJobRecord | null): number | null {
  const p = job?.progress;
  if (p == null || p.phase !== 'uploading' || p.total_bytes === 0) return null;
  return Math.min(100, Math.round((p.uploaded_bytes / p.total_bytes) * 100));
}

/** Getters, so the labels follow the interface language (QC-042). */
export const PHASE_LABEL: Readonly<
  Record<'queued' | 'uploading' | 'processing' | 'analyzing', string>
> = {
  get queued() {
    return t('ai.phaseQueued');
  },
  get uploading() {
    return t('ai.phaseUploading');
  },
  get processing() {
    return t('ai.phaseProcessing');
  },
  get analyzing() {
    return t('ai.phaseAnalyzing');
  },
};

export function runLabel(job: AiJobRecord | null): string {
  const phase = job?.progress?.phase;
  if (phase !== undefined) return PHASE_LABEL[phase];
  return job?.status === 'running' ? PHASE_LABEL.analyzing : PHASE_LABEL.queued;
}

/**
 * AI 工作台 video understanding (QC-025): pick a library video, see the
 * estimate, confirm (and, the first time, the Gemini notice), follow upload
 * and analysis, cancel, retry, or reuse an earlier result for free.
 */
export class VideoSession {
  private state: VideoState = {
    gemini: null,
    noKey: false,
    asset: null,
    model: null,
    resolution: 'default',
    autoLow: false,
    estimate: null,
    estimateError: null,
    phase: 'idle',
    reanalyze: false,
    confirmError: null,
    job: null,
    shown: null,
    result: null,
    previous: null,
    failure: null,
  };
  private readonly listeners = new Set<(s: VideoState) => void>();
  private watch: JobWatch | null = null;
  private disposed = false;
  private estimateRequest = 0;
  private modelPicked = false;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly pollMs = 3000,
    /** The work the analysis belongs to (QC-046): its suggestions can then be adopted there. */
    private readonly workId: string | null = null,
  ) {}

  get snapshot(): VideoState {
    return this.state;
  }

  subscribe(listener: (s: VideoState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<VideoState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Read through a method so TypeScript does not keep narrowing across awaits. */
  private now(): VideoState {
    return this.state;
  }

  async loadProvider(): Promise<void> {
    try {
      const { items } = await this.client.ai.providers();
      const gemini = items.find((p) => p.provider === 'gemini') ?? null;
      this.set({
        gemini,
        noKey: gemini?.key_configured !== true,
        // A model picked in this panel stays; otherwise follow 設定.
        model: this.modelPicked ? this.state.model : (gemini?.video_model ?? null),
      });
    } catch {
      // The estimate reports connectivity.
    }
  }

  /**
   * Read the status again (key, consent or model may have changed in 設定) and,
   * when something that affects the estimate changed, estimate again.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const before = this.state;
    await this.loadProvider();
    const after = this.state;
    const busy = after.phase === 'running' || after.phase === 'confirm' || after.phase === 'reuse';
    if (after.asset === null || busy) return;
    const keyArrived = before.noKey && !after.noKey;
    const modelChanged = before.model !== after.model && !after.noKey;
    if (keyArrived || modelChanged) await this.estimate();
  }

  async select(asset: AssetRecord): Promise<void> {
    this.stopWatch();
    // Longer than the default-resolution limit: low resolution is the only way to send it.
    const autoLow =
      asset.duration !== null && asset.duration > GEMINI_VIDEO_LIMITS.maxDurationSeconds.default;
    this.set({
      asset,
      phase: 'estimating',
      estimate: null,
      estimateError: null,
      result: null,
      shown: null,
      previous: null,
      failure: null,
      job: null,
      resolution: autoLow ? 'low' : 'default',
      autoLow,
    });
    await this.findPrevious(asset.id);
    await this.estimate();
    if (this.now().asset?.id !== asset.id) return;
    // Show what is already known for this video.
    const cached = this.now().estimate?.cached_job_id ?? null;
    const prev = this.now().previous;
    const shown = cached !== null ? await this.jobOrNull(cached) : prev;
    if (shown !== null && this.now().asset?.id === asset.id) this.show(shown);
  }

  private async jobOrNull(id: string): Promise<AiJobRecord | null> {
    try {
      return await this.client.ai.job(id);
    } catch {
      return null;
    }
  }

  private async findPrevious(assetId: string): Promise<void> {
    try {
      const { items } = await this.client.ai.jobs({ status: 'succeeded', limit: 200 });
      const prev = items.find((j) => isVideoJobOf(j, assetId)) ?? null;
      if (this.now().asset?.id === assetId) this.set({ previous: prev });
    } catch {
      // History is optional here.
    }
  }

  private show(job: AiJobRecord): void {
    const result = videoUnderstandingOf(job);
    if (result === null) return;
    this.set({ phase: 'done', shown: job, result, failure: null });
  }

  async estimate(): Promise<void> {
    const asset = this.state.asset;
    if (asset === null) return;
    const id = ++this.estimateRequest;
    this.set({ estimateError: null });
    try {
      const estimate = await this.client.ai.estimateVideo(asset.id, {
        ...(this.state.model === null ? {} : { model: this.state.model }),
        resolution: this.state.resolution,
      });
      if (id !== this.estimateRequest) return;
      const phase = this.now().phase;
      this.set({ estimate, phase: phase === 'estimating' ? 'ready' : phase });
    } catch (err) {
      if (id !== this.estimateRequest) return;
      if (err instanceof ApiError && err.code === 'ai_key_missing') {
        this.set({ noKey: true, phase: 'ready' });
        return;
      }
      const phase = this.now().phase;
      this.set({
        estimate: null,
        estimateError: estimateErrorText(err, asset),
        phase: phase === 'estimating' ? 'ready' : phase,
      });
    }
  }

  async setModel(model: string): Promise<void> {
    this.modelPicked = true;
    this.set({ model });
    await this.estimate();
  }

  async setResolution(resolution: VideoResolution): Promise<void> {
    this.set({ resolution, autoLow: false });
    await this.estimate();
  }

  /** 分析／重新分析: ask to reuse when a result exists, otherwise confirm the cost. */
  analyze(): void {
    if (this.state.asset === null || this.state.estimate === null) return;
    const cached = this.state.estimate.cached_job_id !== null;
    this.set({ phase: cached ? 'reuse' : 'confirm', reanalyze: false, confirmError: null });
  }

  /** 沿用結果: free, nothing is sent. */
  async reuse(): Promise<void> {
    const id = this.state.estimate?.cached_job_id ?? null;
    const job = id === null ? null : await this.jobOrNull(id);
    if (job !== null) this.show(job);
    else this.closeDialog();
  }

  /** 重新分析 from the reuse dialog: confirm again, this time it is charged. */
  rerun(): void {
    this.set({ phase: 'confirm', reanalyze: true, confirmError: null });
  }

  closeDialog(): void {
    this.set({
      phase: this.state.result !== null ? 'done' : 'ready',
      reanalyze: false,
      confirmError: null,
    });
  }

  /**
   * 上傳並分析. When the Gemini notice is not confirmed yet, 同意 is sent
   * first and nothing is analysed unless it succeeds; a failure keeps the
   * dialog open with the reason.
   */
  async confirm(): Promise<void> {
    const { asset, gemini } = this.state;
    if (asset === null) return;
    this.set({ confirmError: null });
    if (gemini !== null && gemini.consent === null) {
      try {
        const updated = await this.client.ai.consent('gemini', gemini.notice.version);
        this.set({ gemini: updated });
      } catch (err) {
        this.set({
          phase: 'confirm',
          confirmError: t('ai.consentFailed', { reason: messageOf(err) }),
        });
        return;
      }
      if (this.now().gemini?.consent == null) {
        this.set({ phase: 'confirm', confirmError: t('ai.consentFailedNothingSent') });
        return;
      }
    }
    try {
      const res = await this.client.ai.analyzeVideo(asset.id, {
        ...(this.state.model === null ? {} : { model: this.state.model }),
        resolution: this.state.resolution,
        reanalyze: this.state.reanalyze,
        ...(this.workId === null ? {} : { work_id: this.workId }),
      });
      if (res.cached) {
        this.show(res.job);
        return;
      }
      this.set({
        phase: 'running',
        job: res.job,
        failure: null,
        reanalyze: false,
        confirmError: null,
      });
      this.follow(res.job.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ai_key_missing') {
        this.set({ noKey: true, phase: 'ready' });
        return;
      }
      this.set({
        phase: 'failed',
        failure: { code: null, message: estimateErrorText(err, asset) },
      });
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

  /** SSE `ai_job.*` (including `ai_job.progress`) for the running job. */
  jobChanged(jobId: string): Promise<void> {
    return this.watch?.id === jobId ? this.watch.check() : Promise.resolve();
  }

  private onJob(job: AiJobRecord): void {
    if (this.watch?.id !== job.id) return;
    switch (job.status) {
      case 'queued':
      case 'running':
        this.set({ phase: 'running', job });
        return;
      case 'succeeded':
        this.set({ job: null, previous: job });
        this.show(job);
        void this.estimate();
        return;
      case 'failed':
        this.set({
          phase: 'failed',
          job,
          failure: {
            code: job.error_code,
            message: t('ai.analyzeFailed'),
            detail: job.error_detail ?? null,
          },
        });
        return;
      case 'cancelled':
        this.set({ job: null, phase: this.state.result !== null ? 'done' : 'ready' });
    }
  }

  /** 取消: aborts the upload or the request; Gemini's copy is deleted where possible. */
  async cancel(): Promise<void> {
    const job = this.state.job;
    if (job === null) return;
    this.stopWatch();
    this.set({ job: null, phase: this.state.result !== null ? 'done' : 'ready' });
    await this.client.ai.cancel(job.id).catch(() => undefined);
  }

  /** 重試 a failed analysis (an uploaded file is reused, not uploaded again). */
  async retry(): Promise<void> {
    const job = this.state.job;
    if (job === null) return;
    this.set({ phase: 'running', failure: null });
    try {
      const again = await this.client.ai.retry(job.id);
      this.set({ job: again });
      this.follow(job.id);
    } catch (err) {
      this.set({ phase: 'failed', failure: { code: null, message: messageOf(err) } });
    }
  }

  /** 查看上次結果 after a failure. */
  showPrevious(): void {
    const prev = this.state.previous;
    if (prev !== null) {
      this.stopWatch();
      this.set({ job: null });
      this.show(prev);
    }
  }

  /** Open a past job from the history list. */
  async open(job: AiJobRecord, asset: AssetRecord | null): Promise<void> {
    if (asset !== null && this.state.asset?.id !== asset.id) await this.select(asset);
    this.show(job);
  }

  dispose(): void {
    this.stopWatch();
    this.disposed = true;
    this.listeners.clear();
  }
}

/** Recent AI jobs and this month's usage for the 用量 card. */
export interface ActivityState {
  jobs: AiJobRecord[] | null;
  usage: AiUsageResponse | null;
  failed: boolean;
}

export class AiActivity {
  private state: ActivityState = { jobs: null, usage: null, failed: false };
  private readonly listeners = new Set<(s: ActivityState) => void>();

  constructor(private readonly client: CreatorHubClient) {}

  get snapshot(): ActivityState {
    return this.state;
  }

  subscribe(listener: (s: ActivityState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<void> {
    try {
      const [jobs, usage] = await Promise.all([
        this.client.ai.jobs({ limit: 20 }),
        this.client.ai.usage(),
      ]);
      this.state = { jobs: jobs.items, usage, failed: false };
    } catch {
      this.state = { ...this.state, failed: true };
    }
    for (const l of this.listeners) l(this.state);
  }
}

export const ACTION_LABEL: Readonly<Record<string, string>> = {
  get video_understanding() {
    return t('ai.actionVideoUnderstanding');
  },
  get platform_suggestions() {
    return t('ai.actionPlatformSuggestions');
  },
  get rewrite() {
    return t('ai.actionRewrite');
  },
};

export function jobActionLabel(job: AiJobRecord): string {
  return ACTION_LABEL[job.task?.type ?? ''] ?? t('ai.actionOther');
}
