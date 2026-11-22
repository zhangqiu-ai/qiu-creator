import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
  AssetRecord,
  MarkdownReferrer,
  MediaRef,
  WorkMediaResponse,
} from '@qiu-creator/contracts';
import { SIGNED_MEDIA_PREFIX } from '@qiu-creator/contracts';
import { fileTypeFromBuffer } from 'file-type';
import { fdStreamTarget, type AssetService, type StreamTarget } from '../assets/asset-service.js';
import { ServiceError } from '../errors.js';
import {
  ContainedPathError,
  normalizeContainedPath,
  openContainedFile,
  readHead,
  type ContainedFile,
} from '../fs/contained-file.js';
import type { Layout } from '../layout.js';
import type { MediaContext, WorkService } from '../works/work-service.js';
import { allowedMedia, type DetectedMedia, type SizeLimits } from './detect.js';
import { classifyRef, extractMediaRefs } from './markdown-refs.js';
import { encodePathSegments, type MediaUrlSigner } from './url-signer.js';

/** Bytes `file-type` needs to identify every allowed format. */
const SNIFF_BYTES = 4100;

type Opened =
  | { ok: true; file: ContainedFile; media: DetectedMedia }
  | { ok: false; status: 'missing' | 'rejected' | 'unsupported' };

/** Canonical (signed) path of a work-relative media file. */
export function workFilePath(workId: string, rel: string): string {
  return `${SIGNED_MEDIA_PREFIX}/works/${workId}/files/${encodePathSegments(rel)}`;
}

/** Signed path of a work's library card image (QC-061). */
export function workThumbnailPath(workId: string): string {
  return `${SIGNED_MEDIA_PREFIX}/works/${workId}/thumbnail`;
}

export function assetMediaPath(assetId: string, variant: 'stream' | 'thumbnail'): string {
  return `${SIGNED_MEDIA_PREFIX}/assets/${assetId}/${variant}`;
}

/**
 * Resolves media referenced from a work's Markdown to files that are safe to
 * serve, and serves them.
 *
 * - Managed works: references resolve against the work folder and only
 *   `assets/…` is servable (never `source.md` or `revisions/`).
 * - External works: references resolve against the note's own folder and
 *   may point anywhere inside the mount root, but never outside it.
 * - No symlink below the root is followed; only image/video/audio identified
 *   by magic bytes is served (no SVG/HTML, which could carry script).
 * - Referenced external files are registered as assets in place (never moved
 *   or copied) and linked to the work.
 */
export class WorkMediaService {
  constructor(
    private readonly works: WorkService,
    private readonly assets: AssetService,
    private readonly layout: Layout,
    private readonly signer: MediaUrlSigner,
    private readonly limits: SizeLimits,
  ) {}

  async resolve(workId: string, principalId: string): Promise<WorkMediaResponse> {
    const ctx = this.works.mediaContext(workId);
    const expiresAt = this.signer.expiry();
    const items: MediaRef[] = [];
    for (const src of extractMediaRefs(ctx.markdown)) {
      items.push(await this.resolveOne(ctx, src, principalId, expiresAt));
    }
    return {
      work_id: workId,
      revision_id: ctx.revisionId,
      items,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Works whose current Markdown links to a managed asset's file (QC-037).
   * Managed Markdown can only reach its own work folder, so only the work
   * that holds the file is checked. External files are never deleted.
   */
  markdownReferrers(asset: AssetRecord): MarkdownReferrer[] {
    if (asset.mount_id !== null && asset.mount_id !== undefined) return [];
    const parts = asset.path.split(path.sep);
    if (parts.length < 4 || parts[0] !== 'library' || parts[1] !== 'works') return [];
    const workId = parts[2] ?? '';
    let ctx;
    try {
      ctx = this.works.mediaContext(workId);
    } catch {
      return [];
    }
    const prefix = this.layout.workDirRel(workId);
    const linked = extractMediaRefs(ctx.markdown).some((src) => {
      const cls = classifyRef(src);
      if (cls.type !== 'local') return false;
      const rel = normalizeContainedPath(ctx.baseDir, cls.path);
      return rel !== null && path.join(prefix, ...rel.split('/')) === asset.path;
    });
    return linked ? [{ work_id: workId, title: this.works.get(workId).title }] : [];
  }

  /** Open a root-relative media file of a work for streaming (bearer and signed routes). */
  async openWorkFile(workId: string, rel: string): Promise<StreamTarget> {
    const ctx = this.works.mediaContext(workId);
    if (normalizeContainedPath('', rel) !== rel || !allowedByPrefix(ctx, rel)) {
      throw new ServiceError(403, 'path_rejected', 'this path is not servable for the work');
    }
    const opened = await this.open(ctx, rel);
    if (!opened.ok) {
      if (opened.status === 'rejected') {
        throw new ServiceError(403, 'path_rejected', 'path crosses a symbolic link');
      }
      if (opened.status === 'unsupported') {
        throw new ServiceError(
          415,
          'unsupported_media_type',
          'only image, video and audio files are served',
        );
      }
      throw new ServiceError(404, 'not_found', 'file not found');
    }
    return fdStreamTarget(opened.file.fd, opened.file.size, opened.media.mime);
  }

  private async resolveOne(
    ctx: MediaContext,
    src: string,
    principalId: string,
    expiresAt: Date,
  ): Promise<MediaRef> {
    const ref: MediaRef = {
      src,
      status: 'rejected',
      path: null,
      asset_id: null,
      kind: null,
      mime_type: null,
      bytes: null,
      url: null,
    };
    const cls = classifyRef(src);
    if (cls.type !== 'local') return { ...ref, status: cls.type };
    const rel = normalizeContainedPath(ctx.baseDir, cls.path);
    if (rel === null || !allowedByPrefix(ctx, rel)) return ref;

    const opened = await this.open(ctx, rel);
    if (!opened.ok) return { ...ref, status: opened.status, path: rel };
    const { file, media } = opened;
    try {
      let assetId: string | null = null;
      if (ctx.mountId !== null) {
        const asset = await this.assets.registerExternal(ctx.workId, {
          mountId: ctx.mountId,
          rel,
          kind: media.kind,
          mime: media.mime,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
          sha256: () => hashFd(file.fd),
        });
        assetId = asset.id;
      } else {
        const managedRel = path.join(this.layout.workDirRel(ctx.workId), ...rel.split('/'));
        assetId = this.assets.findManagedByPath(managedRel)?.id ?? null;
      }
      return {
        src,
        status: 'resolved',
        path: rel,
        asset_id: assetId,
        kind: media.kind,
        mime_type: media.mime,
        bytes: file.size,
        url: this.signer.sign(workFilePath(ctx.workId, rel), principalId, expiresAt).url,
      };
    } finally {
      fs.closeSync(file.fd);
    }
  }

  private async open(ctx: MediaContext, rel: string): Promise<Opened> {
    if (ctx.root === null) return { ok: false, status: 'missing' };
    let file: ContainedFile;
    try {
      file = openContainedFile(ctx.root, rel);
    } catch (err) {
      if (err instanceof ContainedPathError) return { ok: false, status: err.reason };
      throw err;
    }
    let media: DetectedMedia | undefined;
    try {
      media = await sniff(file.fd);
    } catch (err) {
      fs.closeSync(file.fd);
      throw err;
    }
    if (media === undefined || file.size > this.limits[media.kind]) {
      fs.closeSync(file.fd);
      return { ok: false, status: 'unsupported' };
    }
    return { ok: true, file, media };
  }
}

function allowedByPrefix(ctx: MediaContext, rel: string): boolean {
  return ctx.allowedPrefix === null || rel.startsWith(ctx.allowedPrefix);
}

async function hashFd(fd: number): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream('', { fd, start: 0, autoClose: false }), hash);
  return hash.digest('hex');
}

/** Identify image/video/audio by magic bytes; anything else (SVG, HTML, text…) is `undefined`. */
async function sniff(fd: number): Promise<DetectedMedia | undefined> {
  const type = await fileTypeFromBuffer(readHead(fd, SNIFF_BYTES));
  return type === undefined ? undefined : allowedMedia(type.mime);
}
