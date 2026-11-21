import fs from 'node:fs';
import path from 'node:path';
import type {
  WorkListItem,
  WorkMedia,
  WorkMediaCover,
  WorkMediaItem,
  WorkThumbnail,
} from '@qiu-creator/contracts';
import { parseWorkSource, type ParsedWorkSource } from '@qiu-creator/domain';
import type { Db } from '../db/database.js';
import { normalizeContainedPath, openContainedFile } from '../fs/contained-file.js';
import { hashFile } from '../media/attach.js';
import type { Layout } from '../layout.js';

/** Work types whose Markdown carries front matter with their files (QC-045/046). */
export function isTypedWork(type: string): type is 'image' | 'video' {
  return type === 'image' || type === 'video';
}

/** Where a work's Markdown lives; enough to find the files its front matter names. */
export interface WorkLocation {
  id: string;
  type: string;
  storage_mode: string;
  mount_id: string | null;
  source_path: string;
  /** JSON object: front-matter path → library asset id. */
  media_index: string;
}

interface AssetMeta {
  id: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

type Summary = Pick<
  WorkListItem,
  'thumbnail' | 'image_count' | 'duration_seconds' | 'orientation' | 'missing_media'
>;

/**
 * Resolves the files named in a typed work's front matter: whether each is
 * on disk, which asset it corresponds to and its size. Managed works only
 * reach their own `assets/` folder; external works reach anything inside
 * their mount, never following symlinks (same rules as `WorkMediaService`).
 */
export class TypedWorkMedia {
  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
  ) {}

  describe(loc: WorkLocation, markdown: string): { description: string; media: WorkMedia } {
    const parsed = parseWorkSource(markdown);
    return { description: parsed.body, media: this.media(loc, parsed) };
  }

  /** Card fields for the library list. */
  summary(loc: WorkLocation, markdown: string): Summary {
    const media = this.media(loc, parseWorkSource(markdown));
    const video = media.video;
    const firstImage = media.images[0] ?? null;
    let thumbnail: WorkThumbnail | null = null;
    if (media.cover?.kind === 'image') thumbnail = thumb(media.cover.item);
    else if (media.cover?.kind === 'frame' && video !== null)
      thumbnail = { ...thumb(video), time_seconds: media.cover.time_seconds };
    else if (firstImage !== null) thumbnail = thumb(firstImage);
    else if (video !== null) thumbnail = thumb(video);

    const sized = video ?? (media.cover?.kind === 'image' ? media.cover.item : null) ?? firstImage;
    const files = new Map<string, WorkMediaItem>();
    for (const item of [
      ...media.images,
      video,
      media.cover?.kind === 'image' ? media.cover.item : null,
    ])
      if (item !== null) files.set(item.path, item);

    return {
      thumbnail,
      image_count: loc.type === 'image' ? media.images.length : null,
      duration_seconds: loc.type === 'video' ? (video?.duration_seconds ?? null) : null,
      orientation: orientation(sized),
      missing_media: [...files.values()].filter((i) => i.status === 'missing').length,
    };
  }

  private media(loc: WorkLocation, parsed: ParsedWorkSource): WorkMedia {
    const fm = parsed.frontMatter;
    const index = parseIndex(loc.media_index);
    const learned: Record<string, string> = {};
    const item = (rel: string, kind: 'image' | 'video'): WorkMediaItem =>
      this.item(loc, rel, kind, index, learned);
    const images = (fm?.images ?? []).map((p) => item(p, 'image'));
    let cover: WorkMediaCover | null = null;
    if (fm?.cover !== null && fm?.cover !== undefined) {
      cover =
        'path' in fm.cover
          ? { kind: 'image', item: item(fm.cover.path, 'image') }
          : { kind: 'frame', time_seconds: fm.cover.time_seconds };
    }
    const video = fm?.video == null ? null : item(fm.video, 'video');
    if (Object.keys(learned).length > 0) this.remember(loc.id, learned);
    return {
      images,
      cover,
      video,
      front_matter_invalid: parsed.invalid,
      warnings: parsed.warnings,
    };
  }

  /** Root folder and root-relative path of a front-matter path, or null when it leaves the root. */
  locate(loc: WorkLocation, reference: string): { root: string; rel: string } | null {
    if (loc.storage_mode !== 'external') {
      const rel = normalizeContainedPath('', reference);
      // Managed Markdown only reaches the work's own assets/ (as in WorkMediaService).
      if (rel === null || !rel.startsWith('assets/')) return null;
      return { root: this.layout.abs(this.layout.workDirRel(loc.id)), rel };
    }
    if (loc.mount_id === null) return null;
    const mount = this.db
      .prepare<[string], { root_path: string; status: string }>(
        'SELECT root_path, status FROM mounts WHERE id = ?',
      )
      .get(loc.mount_id);
    if (mount === undefined || mount.status !== 'active') return null;
    const dir = path.posix.dirname(loc.source_path.split(path.sep).join('/'));
    const rel = normalizeContainedPath(dir === '.' ? '' : dir, reference);
    return rel === null ? null : { root: mount.root_path, rel };
  }

  private item(
    loc: WorkLocation,
    reference: string,
    kind: 'image' | 'video',
    index: Record<string, string>,
    learned: Record<string, string>,
  ): WorkMediaItem {
    const where = this.locate(loc, reference);
    let present = false;
    let absPath: string | null = null;
    let size = 0;
    if (where !== null) {
      try {
        const file = openContainedFile(where.root, where.rel);
        fs.closeSync(file.fd);
        present = true;
        absPath = file.absPath;
        size = file.size;
      } catch {
        present = false;
      }
    }
    let asset: AssetMeta | undefined;
    if (where !== null && loc.storage_mode === 'external' && loc.mount_id !== null) {
      asset = this.db
        .prepare<[string, string], AssetMeta>(
          'SELECT id, width, height, duration FROM assets WHERE mount_id = ? AND path = ?',
        )
        .get(loc.mount_id, where.rel);
    } else if (where !== null) {
      const known = index[reference];
      if (known !== undefined) asset = this.assetById(known);
      if (asset === undefined && present && absPath !== null) {
        // Not written by this app's PATCH (e.g. a restored revision): match by content once.
        asset = this.assetByContent(absPath, size);
        if (asset !== undefined) learned[reference] = asset.id;
      }
    }
    return {
      path: reference,
      asset_id: asset?.id ?? null,
      kind,
      status: present ? 'present' : 'missing',
      width: asset?.width ?? null,
      height: asset?.height ?? null,
      duration_seconds: asset?.duration ?? null,
    };
  }

  private assetById(id: string): AssetMeta | undefined {
    return this.db
      .prepare<[string], AssetMeta>('SELECT id, width, height, duration FROM assets WHERE id = ?')
      .get(id);
  }

  private assetByContent(absPath: string, size: number): AssetMeta | undefined {
    const candidates = this.db
      .prepare<[number], { id: string }>(
        'SELECT id FROM assets WHERE bytes = ? AND mount_id IS NULL LIMIT 1',
      )
      .all(size);
    if (candidates.length === 0) return undefined;
    const sha = hashFile(absPath);
    return this.db
      .prepare<[string], AssetMeta>(
        `SELECT id, width, height, duration FROM assets
         WHERE sha256 = ? AND mount_id IS NULL
         ORDER BY deleted_at IS NOT NULL, created_at LIMIT 1`,
      )
      .get(sha);
  }

  private remember(workId: string, learned: Record<string, string>): void {
    if (!this.db.open) return;
    this.db
      .prepare('UPDATE works SET media_index = json_patch(media_index, ?) WHERE id = ?')
      .run(JSON.stringify(learned), workId);
  }
}

function parseIndex(raw: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function thumb(item: WorkMediaItem): WorkThumbnail {
  return { asset_id: item.asset_id, path: item.path, kind: item.kind };
}

function orientation(item: WorkMediaItem | null): WorkListItem['orientation'] {
  if (item === null || item.width === null || item.height === null) return null;
  if (item.width === item.height) return 'square';
  return item.height > item.width ? 'portrait' : 'landscape';
}
