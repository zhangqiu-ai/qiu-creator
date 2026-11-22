import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_IMAGE_CANDIDATE_TTL_HOURS,
  AI_IMAGE_MAX_BYTES,
  AiCostEstimateSchema,
  AiImageKeepRequestSchema,
  AiImageRequestSchema,
  AiImageResultSchema,
  PLATFORM_COVER_RATIOS,
  estimateTokens,
  type AiCostEstimate,
  type AiImageAspectRatio,
  type AiImageEstimateResponse,
  type AiImageKeepRequest,
  type AiImageKeepResponse,
  type AiImageRequest,
  type AiImageResult,
  type AiJobRecord,
  type AiTask,
  type Prompt,
  type WorkAiJobResponse,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { parseWorkSource, writeWorkSource } from '@qiu-creator/domain';
import sharp from 'sharp';
import type { AssetService } from '../assets/asset-service.js';
import { ServiceError } from '../errors.js';
import type { Layout } from '../layout.js';
import type { WorkMediaAttacher } from '../media/attach.js';
import { DownloadError, safeDownload, type DownloadOptions } from '../net/safe-download.js';
import { workPlainText } from '../works/card-images.js';
import type { WorkService } from '../works/work-service.js';
import type { AiService, AiTaskExecutor } from './ai-service.js';
import type { AiTextResult } from './provider.js';
import { providerError } from './provider.js';
import type { NewApiImageClient } from './providers/new-api-images.js';
import { PLATFORM_NAMES } from './language.js';
import { expandPrompt, usesSelection, type PromptService } from './prompt-service.js';

type ImageTask = Extract<AiTask, { type: 'image_generation' }>;

export interface ImageTaskOptions {
  /** How long unkept candidates stay (default `AI_IMAGE_CANDIDATE_TTL_HOURS`). */
  candidateTtlMs?: number;
  /** How often old candidates are swept (default hourly). */
  sweepIntervalMs?: number;
  /** Tests: DNS and socket seams for downloading image URLs (policy checks still run). */
  download?: Pick<DownloadOptions, 'resolver' | 'connectOverride'>;
  now?: () => Date;
}

/** Ratio as a number (width / height). */
function ratioOf(aspect: AiImageAspectRatio): number {
  const [w, h] = aspect.split(':').map(Number);
  return (w ?? 1) / (h ?? 1);
}

/**
 * The size asked of the relay: the nearest of the sizes OpenAI-compatible
 * image models accept everywhere (results are cropped to the exact ratio).
 */
export function generationSize(aspect: AiImageAspectRatio): string {
  const r = ratioOf(aspect);
  if (Math.abs(r - 1) < 0.1) return '1024x1024';
  return r < 1 ? '1024x1536' : '1536x1024';
}

const COVER_TEXT_CHARS = 500;

/**
 * AI image and cover generation through the New API relay (QC-070).
 *
 * - Sent only when the user asks, with the relay's first-use notice confirmed.
 * - Results are candidates in `cache/ai-images/` (cropped to the asked ratio,
 *   decoded and re-encoded, so only real images are kept); nothing touches the
 *   work until the user keeps one, which adds it to the library, copies it
 *   into the work's `assets/` and writes an `ai_accepted` revision.
 * - Unkept candidates are deleted after `AI_IMAGE_CANDIDATE_TTL_HOURS`.
 */
export class ImageAiService {
  private readonly ttlMs: number;
  private readonly sweepMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ai: AiService,
    private readonly works: WorkService,
    private readonly assets: AssetService,
    private readonly attacher: WorkMediaAttacher,
    private readonly layout: Layout,
    private readonly client: NewApiImageClient,
    private readonly prompts: PromptService,
    private readonly options: ImageTaskOptions = {},
  ) {
    this.ttlMs = options.candidateTtlMs ?? AI_IMAGE_CANDIDATE_TTL_HOURS * 3600_000;
    this.sweepMs = options.sweepIntervalMs ?? 3600_000;
    this.now = options.now ?? (() => new Date());
    ai.registerExecutor('image_generation', (ctx) => this.execute(ctx));
    ai.registerFinalizer('image_generation', (output, task, job) =>
      this.finalize(output.text, task, job.source_revision),
    );
  }

  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---- Submit ---------------------------------------------------------------------------

  estimate(workId: string, body: AiImageRequest): AiImageEstimateResponse {
    const plan = this.plan(workId, body);
    return {
      estimate: plan.estimate,
      budget: this.ai.budget(undefined, plan.estimate.max_cost_usd ?? 0),
    };
  }

  create(workId: string, body: AiImageRequest): WorkAiJobResponse {
    const plan = this.plan(workId, body);
    const result = this.ai.submitOnce(
      {
        provider: 'new-api',
        model: plan.model,
        action: 'image_generation',
        work_id: workId,
        source_revision: plan.sourceRevision,
        input: { prompt: plan.prompt, max_output_tokens: 16 },
      },
      { task: plan.task, estimate: plan.estimate, maxAttempts: 1 },
    );
    if (plan.library?.model == null) this.ai.rememberModel('image', 'new-api', plan.model);
    if (plan.library !== null) this.prompts.markUsed(plan.library.id);
    return result;
  }

  private plan(
    workId: string,
    body: AiImageRequest,
  ): {
    model: string;
    prompt: string;
    sourceRevision: string;
    task: ImageTask;
    estimate: AiCostEstimate;
    library: Prompt | null;
  } {
    const req = AiImageRequestSchema.parse(body);
    const work = this.works.get(workId);
    if (work.type !== 'article') {
      throw new ServiceError(400, 'validation_error', 'AI images are for articles', {
        field: 'type',
      });
    }
    if (work.storage_mode === 'external') {
      throw new ServiceError(
        409,
        'attach_external_unsupported',
        'an external work cannot take copied-in files; add the image to its own folder',
      );
    }
    const sourceRevision = req.source_revision ?? work.current_revision_id;
    const source = this.works.revision(workId, sourceRevision);
    const style = req.style === undefined ? '' : `\n風格：${req.style}`;
    const plain = workPlainText(work.type, source.markdown) ?? '';
    // QC-075: an `image` prompt from the library, its variables expanded; the
    // built-in cover prompt is what `cover` already does.
    const library =
      req.prompt_id === undefined ? null : this.prompts.resolve(req.prompt_id, ['image']);
    const libraryText =
      library === null || library.id === 'builtin-cover'
        ? null
        : expandPrompt(library.content, {
            selection: req.prompt ?? plain,
            title: source.title,
            text: plain,
            ...(req.platform === undefined ? {} : { platform: PLATFORM_NAMES[req.platform] }),
          });
    const embedsPrompt = library !== null && usesSelection(library.content);
    // QC-076: a platform's cover uses its ratio unless one is asked for.
    const aspect: AiImageAspectRatio =
      req.aspect_ratio ??
      (req.platform === undefined ? '1:1' : PLATFORM_COVER_RATIOS[req.platform]);
    // A prompt's own (New API) model wins over the request's (PT-20261122-003).
    const model =
      library?.model != null && library.model.provider === 'new-api'
        ? library.model.model
        : req.model;
    let prompt: string;
    if (req.purpose === 'cover') {
      const text = Array.from(plain).slice(0, COVER_TEXT_CHARS).join('');
      prompt = [
        `為下面這篇文章生成一張${req.platform === undefined ? '' : `${PLATFORM_NAMES[req.platform]}的`}封面圖。畫面要能概括主題，不要在圖中放文字。`,
        `標題：${source.title}`,
        ...(text === '' ? [] : [`內容摘要：${text}`]),
      ].join('\n');
      if (libraryText !== null) prompt += `\n要求：${libraryText}`;
      if (req.prompt !== undefined) prompt += `\n補充要求：${req.prompt}`;
      prompt += style;
    } else if (libraryText !== null) {
      const extra = req.prompt !== undefined && !embedsPrompt ? `\n${req.prompt}` : '';
      prompt = `${libraryText}${extra}${style}`;
    } else {
      prompt = `${req.prompt ?? ''}${style}`;
    }
    const task: ImageTask = {
      type: 'image_generation',
      purpose: req.purpose,
      aspect_ratio: aspect,
      n: req.n,
      size: generationSize(aspect),
      prompt_id: library?.id ?? null,
      platform: req.platform ?? null,
    };
    const price = this.ai.price(model, 'new-api');
    const estimate = AiCostEstimateSchema.parse({
      provider: 'new-api',
      model,
      input_tokens: estimateTokens(prompt),
      max_output_tokens: 0,
      image_count: req.n,
      max_cost_usd: price?.per_image_usd === undefined ? null : price.per_image_usd * req.n,
      price,
      estimated: true,
    });
    return { model, prompt, sourceRevision, task, estimate, library };
  }

  // ---- Run ------------------------------------------------------------------------------

  private readonly execute: AiTaskExecutor = async (ctx) => {
    const task = ctx.job.task;
    if (task.type !== 'image_generation') throw providerError('invalid_output');
    const result = await this.client.generate(
      {
        model: ctx.job.model,
        prompt: ctx.input.prompt,
        n: task.n,
        size: task.size,
        signal: ctx.signal,
      },
      ctx.apiKey,
      ctx.baseUrl,
    );
    const dir = this.layout.aiImageJobDir(ctx.job.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ratio = ratioOf(task.aspect_ratio as AiImageAspectRatio);
    const meta: Omit<AiImageResult['candidates'][number], 'url' | 'expires_at' | 'expired'>[] = [];
    try {
      for (const [index, image] of result.images.entries()) {
        let bytes: Buffer;
        if (image.kind === 'bytes') {
          bytes = image.data;
        } else {
          bytes = await this.download(image.url, dir, this.client.base(ctx.baseUrl), ctx.signal);
        }
        meta.push(await writeCandidate(bytes, ratio, dir, index));
      }
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const price = this.ai.price(ctx.job.model, 'new-api');
    // Per-image price when set; else tokens (when the relay reported them) at the token price.
    const costUsd =
      price?.per_image_usd !== undefined
        ? price.per_image_usd * meta.length
        : price !== null && result.usage !== null
          ? undefined
          : null;
    const out: AiTextResult = {
      text: JSON.stringify(meta),
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      model: ctx.job.model,
      finish: 'stop',
      ...(costUsd === undefined ? {} : { costUsd }),
    };
    return out;
  };

  /** Fetch an image URL from the relay's answer, SSRF-safe; the relay's own origin is trusted. */
  private async download(
    url: string,
    dir: string,
    relayBase: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const temp = path.join(dir, `${randomUUID()}.download`);
    try {
      await safeDownload(url, temp, {
        ...this.options.download,
        maxBytes: AI_IMAGE_MAX_BYTES,
        maxRedirects: 3,
        connectTimeoutMs: 15_000,
        idleTimeoutMs: 30_000,
        totalTimeoutMs: 120_000,
        allowedContentTypes: [/^image\//, /^application\/octet-stream$/, /^binary\/octet-stream$/],
        trustedOrigin: new URL(relayBase).origin,
        signal,
      });
      return fs.readFileSync(temp);
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof DownloadError) {
        throw providerError(
          err.retryable ? 'provider_unavailable' : 'invalid_output',
          `image download failed: ${err.code}`,
        );
      }
      throw err;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private finalize(
    text: string,
    task: AiTask,
    sourceRevision: string | null,
  ): { text: string; json: AiImageResult } {
    if (task.type !== 'image_generation' || sourceRevision === null) {
      throw providerError('invalid_output');
    }
    const meta = JSON.parse(text) as AiImageResult['candidates'];
    const json = AiImageResultSchema.parse({
      type: 'image_generation',
      source_revision: sourceRevision,
      purpose: task.purpose,
      aspect_ratio: task.aspect_ratio,
      candidates: meta.map((m) => ({ ...m, expired: false, url: null, expires_at: null })),
    });
    return { text: `${String(json.candidates.length)} image(s)`, json };
  }

  // ---- Candidates -----------------------------------------------------------------------

  /**
   * An image job's result with each candidate's `expired` brought up to date
   * and, when `sign` is given, a signed URL for the ones still there.
   */
  decorate(
    job: AiJobRecord,
    sign?: (pathname: string) => { url: string; expiresAt: Date },
  ): AiJobRecord {
    if (job.task?.type !== 'image_generation' || job.result === null) return job;
    const parsed = AiImageResultSchema.safeParse(job.result.json);
    if (!parsed.success) return job;
    const candidates = parsed.data.candidates.map((c) => {
      const there = this.candidatePath(job.id, c.index, c.mime) !== null;
      if (!there) return { ...c, expired: true, url: null, expires_at: null };
      const signed = sign?.(aiImageMediaPath(job.id, c.index));
      return {
        ...c,
        expired: false,
        url: signed?.url ?? null,
        expires_at: signed === undefined ? null : signed.expiresAt.toISOString(),
      };
    });
    return { ...job, result: { ...job.result, json: { ...parsed.data, candidates } } };
  }

  /** The candidate's file and type; 404 when the job, the candidate or its file is gone. */
  candidateFile(jobId: string, index: number, workId?: string): { file: string; mime: string } {
    const { candidate } = this.candidate(jobId, index, workId);
    const file = this.candidatePath(jobId, index, candidate.mime);
    if (file === null) throw new ServiceError(404, 'not_found', 'the candidate is no longer kept');
    return { file, mime: candidate.mime };
  }

  discard(workId: string, jobId: string, index: number): void {
    const { candidate } = this.candidate(jobId, index, workId);
    const file = this.candidatePath(jobId, index, candidate.mime);
    if (file !== null) fs.rmSync(file, { force: true });
    this.removeEmptyDir(jobId);
  }

  async keep(
    workId: string,
    jobId: string,
    body: AiImageKeepRequest,
  ): Promise<AiImageKeepResponse> {
    const req = AiImageKeepRequestSchema.parse(body);
    const { job, candidate } = this.candidate(jobId, req.index, workId, true);
    const file = this.candidatePath(jobId, req.index, candidate.mime);
    if (file === null) {
      throw new ServiceError(409, 'ai_job_not_acceptable', 'the candidate is no longer kept', {
        expired: true,
      });
    }
    // Check the base before anything is copied, so a stale keep leaves no files behind.
    const current = this.works.get(workId);
    if (req.placement.type !== 'library' && current.current_revision_id !== req.base_revision) {
      throw new ServiceError(409, 'revision_conflict', 'the work changed since', {
        current_revision: current.current_revision_id,
        base_revision: req.base_revision,
      });
    }
    const ext = candidate.mime === 'image/png' ? 'png' : 'jpg';
    const temp = path.join(this.layout.incomingDir, `${randomUUID()}.${ext}`);
    fs.copyFileSync(file, temp);
    const stamp = this.now().toISOString().replace(/[-:]/g, '').slice(0, 15);
    let assetId: string;
    try {
      const { asset } = await this.assets.ingest(
        temp,
        `ai-${stamp}-${String(req.index + 1)}.${ext}`,
        'manual',
      );
      assetId = asset.id;
    } finally {
      fs.rmSync(temp, { force: true });
    }
    const attached = await this.attacher.attach(workId, assetId);
    let work: WorkDetail = current;
    if (req.placement.type !== 'library') {
      const markdown =
        req.placement.type === 'cover'
          ? writeWorkSource(current.markdown, { cover: { path: attached.src } })
          : insertImage(current.markdown, req.placement.offset, attached.src, req.placement.alt);
      work = this.works.acceptAi(workId, req.base_revision, { markdown, aiJobId: job.id });
      this.ai.markAccepted(job.id, work.current_revision_id);
    }
    fs.rmSync(file, { force: true });
    this.removeEmptyDir(jobId);
    return { work, asset_id: assetId, src: attached.src };
  }

  /** Delete candidates older than the TTL; returns how many job folders went. */
  sweep(): number {
    let removed = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.layout.aiImagesDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const cutoff = this.now().getTime() - this.ttlMs;
    for (const entry of entries) {
      const dir = path.join(this.layout.aiImagesDir, entry.name);
      try {
        if (!entry.isDirectory() || fs.statSync(dir).mtimeMs > cutoff) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Gone already or unreadable: try again next sweep.
      }
    }
    return removed;
  }

  private candidate(
    jobId: string,
    index: number,
    workId: string | undefined,
    conflict = false,
  ): { job: AiJobRecord; candidate: AiImageResult['candidates'][number] } {
    const job = this.ai.get(jobId);
    const result =
      job.task?.type === 'image_generation' && job.status === 'succeeded'
        ? AiImageResultSchema.safeParse(job.result?.json)
        : null;
    if ((workId !== undefined && job.work_id !== workId) || result === null || !result.success) {
      if (conflict) {
        throw new ServiceError(
          409,
          'ai_job_not_acceptable',
          'only a succeeded image job of this work can be kept',
          { status: job.status, task: job.task?.type ?? null },
        );
      }
      throw new ServiceError(404, 'not_found', 'no such image job');
    }
    const candidate = result.data.candidates.find((c) => c.index === index);
    if (candidate === undefined) throw new ServiceError(404, 'not_found', 'no such candidate');
    return { job, candidate };
  }

  private candidatePath(jobId: string, index: number, mime: string): string | null {
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const file = path.join(this.layout.aiImageJobDir(jobId), `${String(index)}.${ext}`);
    return fs.existsSync(file) ? file : null;
  }

  private removeEmptyDir(jobId: string): void {
    const dir = this.layout.aiImageJobDir(jobId);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // Already gone.
    }
  }
}

/** Signed path of a candidate (QC-070), under the media prefix. */
export function aiImageMediaPath(jobId: string, index: number): string {
  return `/media/v1/image-candidates/${jobId}/${String(index)}`;
}

/**
 * Decode (rejecting anything that is not an image), crop to `ratio` around
 * the centre, and write PNG when the image has transparency, JPEG otherwise.
 */
async function writeCandidate(
  bytes: Buffer,
  ratio: number,
  dir: string,
  index: number,
): Promise<Omit<AiImageResult['candidates'][number], 'url' | 'expires_at' | 'expired'>> {
  let image: ReturnType<typeof sharp>;
  let width: number;
  let height: number;
  let alpha: boolean;
  try {
    image = sharp(bytes, { failOn: 'error' }).rotate();
    const meta = await image.metadata();
    width = meta.autoOrient.width;
    height = meta.autoOrient.height;
    alpha = meta.hasAlpha;
  } catch {
    throw providerError('invalid_output', 'the relay returned something that is not an image');
  }
  let cropW = width;
  let cropH = height;
  if (width / height > ratio) cropW = Math.max(1, Math.round(height * ratio));
  else cropH = Math.max(1, Math.round(width / ratio));
  const cropped = image.extract({
    left: Math.floor((width - cropW) / 2),
    top: Math.floor((height - cropH) / 2),
    width: cropW,
    height: cropH,
  });
  const mime = alpha ? 'image/png' : 'image/jpeg';
  const out = await (alpha ? cropped.png() : cropped.jpeg({ quality: 90 })).toBuffer();
  const file = path.join(dir, `${String(index)}.${alpha ? 'png' : 'jpg'}`);
  fs.writeFileSync(`${file}.tmp`, out, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return { index, width: cropW, height: cropH, mime, bytes: out.length };
}

/**
 * The Markdown with `![alt](src)` as its own paragraph at the end of the line
 * holding `offset` (never inside the front matter).
 */
export function insertImage(markdown: string, offset: number, src: string, alt?: string): string {
  const bodyStart = markdown.length - parseWorkSource(markdown).body.length;
  const label = (alt ?? '').replace(/[[\]\n\r]/g, ' ').trim();
  const target = /[\s()<>]/.test(src) ? `<${src}>` : src;
  const image = `![${label}](${target})\n`;
  if (offset <= bodyStart) {
    // At the top of the body: right after the front matter.
    const rest = markdown.slice(bodyStart).replace(/^\n+/, '');
    return `${markdown.slice(0, bodyStart)}${image}${rest === '' ? '' : `\n${rest}`}`;
  }
  const lineEnd = markdown.indexOf('\n', Math.min(offset, markdown.length));
  const at = lineEnd === -1 ? markdown.length : lineEnd;
  const before = markdown.slice(0, at).replace(/\n+$/, '');
  const after = markdown.slice(at).replace(/^\n+/, '');
  return `${before}\n\n${image}${after === '' ? '' : `\n${after}`}`;
}
