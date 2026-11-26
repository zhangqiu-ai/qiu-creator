import fs from 'node:fs';
import path from 'node:path';
import {
  PatchWorkRequestSchema,
  type AssetRecord,
  type PatchWorkRequest,
  type WorkDetail,
} from '@qiu-creator/contracts';
import {
  FrontMatterError,
  parseWorkSource,
  resolveBaseRevision,
  writeWorkSource,
  type WorkCover,
} from '@qiu-creator/domain';
import type { AssetService } from '../assets/asset-service.js';
import type { Db } from '../db/database.js';
import { ServiceError } from '../errors.js';
import type { WorkMediaAttacher } from '../media/attach.js';
import { isTypedWork } from './typed-media.js';
import type { TypedWorkState, WorkService } from './work-service.js';

/**
 * `PATCH /api/v1/works/:id` (QC-045/046). Articles keep the plain path in
 * `WorkService.patch`, byte for byte as before. Image and video works are one
 * atomic, revisioned write of their front matter and description:
 *
 * 1. the revision is checked (428 without a base, 409 when stale);
 * 2. library assets named in `images`, `cover` or `video_asset_id` are copied
 *    into the work's `assets/` through QC-039 attach (same content is reused);
 *    external works only take files already in their own mount (409
 *    `attach_external_unsupported` otherwise) and never get files copied in;
 * 3. the new Markdown is built (unknown front-matter keys survive) and
 *    committed against the same revision, so a write that lands in between
 *    makes this one 409; files this request copied in are removed again.
 */
export class WorkComposer {
  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
    private readonly attacher: WorkMediaAttacher,
    private readonly assets: AssetService,
  ) {}

  async patch(id: string, input: PatchWorkRequest, ifMatch?: string): Promise<WorkDetail> {
    const body = PatchWorkRequestSchema.parse(input);
    const current = this.works.get(id); // 404 for an unknown work
    const base = resolveBaseRevision(body.base_revision, ifMatch, current.current_revision_id);
    if (body.ai_job_id !== undefined) this.checkAiJob(id, body.ai_job_id, current);

    const targetType = body.type ?? current.type;
    const mediaFields =
      body.description !== undefined ||
      body.images !== undefined ||
      body.cover !== undefined ||
      body.video_asset_id !== undefined;
    if (!isTypedWork(targetType)) {
      if (mediaFields) {
        throw new ServiceError(
          400,
          'validation_error',
          'description, images, cover and video_asset_id are for image and video works',
        );
      }
      return this.works.patch(id, {
        baseRevision: base,
        title: body.title,
        markdown: body.markdown,
        type: body.type,
        status: body.status,
        tags: body.tags,
        aiJobId: body.ai_job_id,
      });
    }
    if (body.images !== undefined && targetType !== 'image') {
      throw new ServiceError(400, 'validation_error', 'images are for image works');
    }
    if (body.video_asset_id !== undefined && targetType !== 'video') {
      throw new ServiceError(400, 'validation_error', 'video_asset_id is for video works');
    }
    if (body.cover != null && 'time_seconds' in body.cover && targetType !== 'video') {
      throw new ServiceError(400, 'validation_error', 'a frame cover needs a video work');
    }
    if (body.markdown !== undefined && mediaFields) {
      throw new ServiceError(
        400,
        'validation_error',
        'send markdown, or description and media fields, not both',
      );
    }

    const state = this.works.typedState(id, base);
    const parsed = parseWorkSource(state.markdown);
    if (body.markdown === undefined && parsed.invalid) {
      throw new ServiceError(
        409,
        'front_matter_invalid',
        'the front matter of this work is not valid YAML; fix it in the file first',
      );
    }

    const copied: string[] = [];
    const mediaIndex: Record<string, string> = {};
    try {
      let markdown: string;
      let title = body.title;
      let tags = body.tags;
      if (body.markdown !== undefined) {
        // A whole file from the client: the front matter in it is the truth.
        markdown = body.markdown;
        const front = parseWorkSource(markdown).frontMatter;
        title ??= front?.title?.trim().slice(0, 500) || undefined;
        tags ??= front?.tags;
      } else {
        const resolve = (assetId: string, kind: 'image' | 'video') =>
          this.resolveFile(state, assetId, kind, copied, mediaIndex);
        const images =
          body.images === undefined
            ? undefined
            : await sequential(body.images, (a) => resolve(a, 'image'));
        let cover: WorkCover | null | undefined;
        if (body.cover === null) cover = null;
        else if (body.cover !== undefined)
          cover =
            'asset_id' in body.cover
              ? { path: await resolve(body.cover.asset_id, 'image') }
              : { time_seconds: body.cover.time_seconds };
        const video =
          body.video_asset_id === undefined
            ? undefined
            : body.video_asset_id === null
              ? null
              : await resolve(body.video_asset_id, 'video');
        markdown = writeWorkSource(state.markdown, {
          ...(parsed.frontMatter?.type === targetType ? {} : { type: targetType }),
          ...(title === undefined ? {} : { title }),
          ...(tags === undefined ? {} : { tags: [...new Set(tags)] }),
          ...(images === undefined ? {} : { images }),
          ...(cover === undefined ? {} : { cover }),
          ...(video === undefined ? {} : { video }),
          ...(body.description === undefined ? {} : { body: body.description }),
        });
      }
      const fields = (
        [
          'title',
          'markdown',
          'type',
          'status',
          'tags',
          'description',
          'images',
          'cover',
          'video_asset_id',
        ] as const
      ).filter((f) => body[f] !== undefined);
      return this.works.commitTyped(id, state.currentRevision, {
        markdown,
        title,
        type: body.type,
        status: body.status,
        tags,
        aiJobId: body.ai_job_id,
        fields,
        mediaIndex,
      });
    } catch (err) {
      // Files this request copied in are not referenced by anything that was saved.
      for (const file of copied) fs.rmSync(file, { force: true });
      if (err instanceof FrontMatterError) {
        throw new ServiceError(409, 'front_matter_invalid', err.message);
      }
      throw err;
    }
  }

  /**
   * Front-matter path for an asset, copying it into a managed work when needed.
   * A file this call creates is added to `copied`, its path to `mediaIndex`.
   */
  async resolveFile(
    state: TypedWorkState,
    assetId: string,
    kind: 'image' | 'video',
    copied: string[],
    mediaIndex: Record<string, string>,
    options: { link?: boolean } = {},
  ): Promise<string> {
    const asset = this.assets.get(assetId); // 404 for an unknown asset
    if (asset.kind !== kind) {
      throw new ServiceError(400, 'validation_error', `asset is not an ${kind}`, {
        asset_id: assetId,
        kind: asset.kind,
      });
    }
    if (asset.deleted_at != null) {
      throw new ServiceError(409, 'asset_in_trash', 'the asset is in 最近刪除; restore it first', {
        asset_id: assetId,
      });
    }
    const loc = state.location;
    if (loc.storage_mode === 'external') return externalPath(loc, asset);
    const res = await this.attacher.attach(loc.id, assetId, options);
    if (res.copied) {
      const located = this.works.locateMedia(state, res.src);
      if (located !== null) copied.push(path.join(located.root, located.rel));
    }
    mediaIndex[res.src] = assetId;
    return res.src;
  }

  /** The AI job must have succeeded and belong to this work (or analyse its video). */
  private checkAiJob(id: string, jobId: string, work: WorkDetail): void {
    const job = this.db
      .prepare<
        [string],
        { status: string; work_id: string | null; action: string; task: string | null }
      >('SELECT status, work_id, action, task FROM ai_jobs WHERE id = ?')
      .get(jobId);
    let taskAsset: unknown;
    try {
      taskAsset =
        job?.task == null ? null : (JSON.parse(job.task) as { asset_id?: unknown }).asset_id;
    } catch {
      taskAsset = null;
    }
    const forVideo =
      job?.action === 'video_understanding' &&
      typeof taskAsset === 'string' &&
      work.media?.video?.asset_id === taskAsset;
    if (job === undefined || job.status !== 'succeeded' || !(job.work_id === id || forVideo)) {
      throw new ServiceError(
        409,
        'ai_job_not_acceptable',
        'ai_job_id must name a succeeded AI job for this work or its video',
        { ai_job_id: jobId },
      );
    }
  }
}

/** An external work names files of its own mount relative to its Markdown file. */
function externalPath(loc: TypedWorkState['location'], asset: AssetRecord): string {
  if (asset.mount_id == null || asset.mount_id !== loc.mount_id) {
    throw new ServiceError(
      409,
      'attach_external_unsupported',
      'an external work can only use files inside its own folder; nothing is copied into it',
      { asset_id: asset.id },
    );
  }
  const dir = path.posix.dirname(loc.source_path.split(path.sep).join('/'));
  return path.posix.relative(dir === '.' ? '' : dir, asset.path);
}

async function sequential<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}
