import { randomUUID } from 'node:crypto';
import {
  checkVariantLimits,
  PLATFORM_LIMITS,
  PlatformSchema,
  PlatformVariantRecordSchema,
  VariantRevisionSchema,
  type Platform,
  type PlatformVariantRecord,
  type VariantCover,
  type VariantRevision,
  type VariantRevisionSource,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { checkRevision } from '@qiu-creator/domain';
import type { AssetService } from '../assets/asset-service.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { WorkMediaService } from '../media/work-media.js';
import type { WorkService } from '../works/work-service.js';
import { markdownForArticle, markdownToPlainText } from './draft.js';

const PLATFORM_ORDER: readonly Platform[] = PlatformSchema.options;

interface VariantRow {
  id: string;
  work_id: string;
  platform: string;
  title: string;
  body: string;
  cover_asset_id: string | null;
  image_asset_ids: string;
  tags: string;
  revision: number;
  source_work_revision_id: string | null;
  /** 1: follows the work's shared copy (QC-045/046). */
  inherit: number;
  /** A video frame as cover (QC-046); then `cover_asset_id` is null. */
  cover_time_seconds: number | null;
  created_at: string;
  updated_at: string;
  /** Set on a tombstone: the variant was deleted but its revision counter lives on. */
  deleted_at: string | null;
}

interface VariantRevisionRow {
  variant_id: string;
  revision: number;
  source: string;
  title: string;
  body: string;
  cover_asset_id: string | null;
  image_asset_ids: string;
  tags: string;
  created_at: string;
  inherit: number;
  cover_time_seconds: number | null;
}

export interface VariantFields {
  title: string;
  body: string;
  cover_asset_id: string | null;
  image_asset_ids: string[];
  tags: string[];
  /** Follow the work's shared copy (QC-045/046). Absent = false. */
  inherit?: boolean;
  /** A video frame as cover (QC-046). Absent = none. */
  cover_time_seconds?: number | null;
}

export type VariantPatch = Partial<VariantFields> & {
  /** Same as `image_asset_ids` (QC-045/046). */
  images?: string[] | undefined;
  /** An image asset or a video frame; null removes it (QC-046). */
  cover?: VariantCover | null | undefined;
};

/** The work's shared copy for a platform: what an inheriting variant shows (QC-045/046). */
function sharedCopy(
  work: WorkDetail,
  platform: Platform,
): Pick<VariantFields, 'title' | 'body' | 'tags'> {
  const body =
    work.description ??
    (PLATFORM_LIMITS[platform].bodyFormat === 'markdown'
      ? markdownForArticle(work.markdown, work.title)
      : markdownToPlainText(work.markdown, work.title));
  return { title: work.title, body, tags: [...work.tags] };
}

function jsonArray(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toRecord(row: VariantRow, work: WorkDetail): PlatformVariantRecord {
  const platform = PlatformSchema.parse(row.platform);
  const inherit = row.inherit === 1;
  const fields = {
    ...(inherit
      ? sharedCopy(work, platform)
      : { title: row.title, body: row.body, tags: jsonArray(row.tags) }),
    image_asset_ids: jsonArray(row.image_asset_ids),
  };
  const cover: VariantCover | null =
    row.cover_asset_id !== null
      ? { asset_id: row.cover_asset_id }
      : row.cover_time_seconds !== null
        ? { time_seconds: row.cover_time_seconds }
        : null;
  return PlatformVariantRecordSchema.parse({
    id: row.id,
    work_id: row.work_id,
    platform,
    ...fields,
    inherit,
    cover,
    cover_asset_id: row.cover_asset_id,
    revision: row.revision,
    source_work_revision_id: row.source_work_revision_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    warnings: checkVariantLimits(platform, fields, PLATFORM_LIMITS, work.type),
  });
}

/**
 * Platform variants: one per work per platform, each with its own integer
 * revision and append-only history in `platform_variant_revisions`.
 *
 * Variants live in SQLite, not as files: they are small structured records
 * (asset ids, ordering, tags) derived from the original, not originals the
 * user opens in Finder. The work's `source.md` stays the single original.
 *
 * All writes are synchronous (better-sqlite3), and every UPDATE is guarded by
 * `revision = <base>`, so two edits from the same base can never both land.
 */
export class VariantService {
  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
    private readonly assets: AssetService,
    private readonly media: WorkMediaService,
    private readonly feed?: ChangeFeed,
  ) {}

  list(workId: string): PlatformVariantRecord[] {
    const work = this.works.get(workId);
    const rows = this.db
      .prepare<[string], VariantRow>(
        'SELECT * FROM platform_variants WHERE work_id = ? AND deleted_at IS NULL',
      )
      .all(workId);
    return rows
      .map((r) => toRecord(r, work))
      .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
  }

  get(workId: string, platform: Platform): PlatformVariantRecord {
    const work = this.works.get(workId);
    const row = this.findRow(workId, platform);
    if (!row || row.deleted_at !== null) throw notFound('platform variant');
    return toRecord(row, work);
  }

  /** Create rule-based drafts for platforms that have no live variant yet; others are skipped. */
  async generate(
    workId: string,
    platforms: readonly Platform[],
    principalId: string,
  ): Promise<{ created: PlatformVariantRecord[]; skipped: Platform[] }> {
    const wanted = PLATFORM_ORDER.filter((p) => platforms.includes(p));
    const draft = await this.draftSource(workId, principalId);
    const created: PlatformVariantRecord[] = [];
    const skipped: Platform[] = [];
    for (const platform of wanted) {
      const row = this.findRow(workId, platform);
      if (row !== undefined && row.deleted_at === null) {
        skipped.push(platform);
        continue;
      }
      created.push(this.create(workId, platform, row, draft.fieldsFor(platform), draft.revisionId));
    }
    return { created, skipped };
  }

  /**
   * Regenerate one platform's draft from the current original. Creates the
   * variant when missing; otherwise needs the base revision and appends a
   * `draft` revision (the previous text stays in history).
   */
  async redraft(
    workId: string,
    platform: Platform,
    baseRevision: string | null,
    principalId: string,
  ): Promise<{ variant: PlatformVariantRecord; created: boolean }> {
    const draft = await this.draftSource(workId, principalId);
    const row = this.findRow(workId, platform);
    if (row === undefined || row.deleted_at !== null) {
      return {
        variant: this.create(workId, platform, row, draft.fieldsFor(platform), draft.revisionId),
        created: true,
      };
    }
    this.checkBase(row, baseRevision);
    return {
      variant: this.update(row, draft.fieldsFor(platform), 'draft', draft.revisionId),
      created: false,
    };
  }

  patch(
    workId: string,
    platform: Platform,
    baseRevision: string | null,
    change: VariantPatch,
  ): PlatformVariantRecord {
    const row = this.requireRow(workId, platform);
    this.checkBase(row, baseRevision);
    const images = change.images ?? change.image_asset_ids;
    let coverAsset =
      change.cover_asset_id === undefined ? row.cover_asset_id : change.cover_asset_id;
    let coverTime = change.cover_asset_id === undefined ? row.cover_time_seconds : null;
    if (change.cover !== undefined) {
      coverAsset =
        change.cover !== null && 'asset_id' in change.cover ? change.cover.asset_id : null;
      coverTime =
        change.cover !== null && 'time_seconds' in change.cover ? change.cover.time_seconds : null;
      if (coverTime !== null && this.works.get(workId).type !== 'video') {
        throw new ServiceError(400, 'validation_error', 'a frame cover needs a video work');
      }
    }
    this.validateAssets({ cover_asset_id: coverAsset, image_asset_ids: images });
    // The variant's own text, kept even while it inherits the shared copy.
    return this.update(
      row,
      {
        title: change.title ?? row.title,
        body: change.body ?? row.body,
        cover_asset_id: coverAsset,
        cover_time_seconds: coverTime,
        image_asset_ids: images ?? jsonArray(row.image_asset_ids),
        // Tags are a set: keep order, drop duplicates.
        tags: change.tags === undefined ? jsonArray(row.tags) : [...new Set(change.tags)],
        inherit: change.inherit ?? row.inherit === 1,
      },
      'edit',
      row.source_work_revision_id,
    );
  }

  /**
   * Delete a variant by turning it into a tombstone: content cleared, history
   * kept, and the tombstone takes the next revision number. The counter for
   * this work and platform therefore never goes back, so a client still
   * holding a pre-delete revision gets 409 after the variant is recreated
   * instead of silently overwriting the new draft (QC-019). Reads treat a
   * tombstone as 404. The work's original is never touched.
   */
  delete(workId: string, platform: Platform, baseRevision: string | null): void {
    const row = this.requireRow(workId, platform);
    this.checkBase(row, baseRevision);
    const tombstone = row.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE platform_variants SET title = '', body = '', cover_asset_id = NULL,
             image_asset_ids = '[]', tags = '[]', revision = ?, deleted_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        )
        .run(tombstone, now, now, row.id, row.revision);
      if (updated.changes !== 1) throw this.conflict(row.id, String(row.revision));
      this.feed?.record('work', workId, 'work.variant_deleted', {
        platform,
        revision: tombstone,
      });
    })();
  }

  revisions(workId: string, platform: Platform): VariantRevision[] {
    const row = this.requireRow(workId, platform);
    return this.db
      .prepare<[string], VariantRevisionRow>(
        'SELECT * FROM platform_variant_revisions WHERE variant_id = ? ORDER BY revision DESC',
      )
      .all(row.id)
      .map((r) => toRevision(r, platform));
  }

  revision(workId: string, platform: Platform, revision: number): VariantRevision {
    const row = this.requireRow(workId, platform);
    const r = this.db
      .prepare<[string, number], VariantRevisionRow>(
        'SELECT * FROM platform_variant_revisions WHERE variant_id = ? AND revision = ?',
      )
      .get(row.id, revision);
    if (!r) throw notFound('variant revision');
    return toRevision(r, platform);
  }

  // ---- internals --------------------------------------------------------------

  /**
   * Everything a rule-based draft copies from the work: title, tags, cover
   * (first `cover` link, else the first image), and images in order (images
   * referenced in the Markdown, then other linked `body` images). No AI.
   */
  private async draftSource(
    workId: string,
    principalId: string,
  ): Promise<{ revisionId: string; fieldsFor: (p: Platform) => VariantFields }> {
    const work = this.works.get(workId);
    const resolved = await this.media.resolve(workId, principalId);
    const links = this.assets.workAssets(workId);
    const isImage = (id: string): boolean =>
      links.some((l) => l.asset.id === id && l.asset.kind === 'image') ||
      resolved.items.some((i) => i.asset_id === id && i.kind === 'image');
    const images: string[] = [];
    for (const item of resolved.items) {
      if (item.status === 'resolved' && item.kind === 'image' && item.asset_id !== null) {
        if (!images.includes(item.asset_id)) images.push(item.asset_id);
      }
    }
    for (const link of links) {
      if (link.role === 'body' && link.asset.kind === 'image' && !images.includes(link.asset.id)) {
        images.push(link.asset.id);
      }
    }
    const cover =
      links.find((l) => l.role === 'cover' && isImage(l.asset.id))?.asset.id ?? images[0] ?? null;
    if (work.media != null) {
      // Image and video works (QC-045/046): their front matter is the source.
      const media = work.media;
      const own = media.images.flatMap((i) => (i.asset_id === null ? [] : [i.asset_id]));
      const typedCover =
        media.cover?.kind === 'image' ? media.cover.item.asset_id : (own[0] ?? null);
      const frame = media.cover?.kind === 'frame' ? media.cover.time_seconds : null;
      return {
        revisionId: work.current_revision_id,
        fieldsFor: (platform) => ({
          ...sharedCopy(work, platform),
          cover_asset_id: frame === null ? typedCover : null,
          cover_time_seconds: frame,
          image_asset_ids: [...new Set(own)],
        }),
      };
    }
    return {
      revisionId: work.current_revision_id,
      fieldsFor: (platform) => ({
        title: work.title,
        body:
          PLATFORM_LIMITS[platform].bodyFormat === 'markdown'
            ? markdownForArticle(work.markdown, work.title)
            : markdownToPlainText(work.markdown, work.title),
        cover_asset_id: cover,
        image_asset_ids: [...images],
        tags: [...work.tags],
      }),
    };
  }

  /** New variant, or a tombstone brought back at the next revision (history kept). */
  private create(
    workId: string,
    platform: Platform,
    tombstone: VariantRow | undefined,
    fields: VariantFields,
    sourceRevision: string | null,
  ): PlatformVariantRecord {
    return tombstone === undefined
      ? this.insert(workId, platform, fields, sourceRevision)
      : this.revive(tombstone, fields, sourceRevision);
  }

  private revive(
    row: VariantRow,
    fields: VariantFields,
    sourceRevision: string | null,
  ): PlatformVariantRecord {
    const next = row.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE platform_variants SET title = ?, body = ?, cover_asset_id = ?, image_asset_ids = ?,
             tags = ?, inherit = ?, cover_time_seconds = ?, revision = ?, source_work_revision_id = ?,
             deleted_at = NULL, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL`,
        )
        .run(
          fields.title,
          fields.body,
          fields.cover_asset_id,
          JSON.stringify(fields.image_asset_ids),
          JSON.stringify(fields.tags),
          fields.inherit === true ? 1 : 0,
          fields.cover_time_seconds ?? null,
          next,
          sourceRevision,
          now,
          row.id,
          row.revision,
        );
      if (updated.changes !== 1) throw this.conflict(row.id, String(row.revision));
      this.insertRevision(row.id, next, 'draft', fields, now);
      this.feed?.record('work', row.work_id, 'work.variant_created', {
        platform: row.platform,
        revision: next,
        source: 'draft',
      });
    })();
    return this.get(row.work_id, PlatformSchema.parse(row.platform));
  }

  private insert(
    workId: string,
    platform: Platform,
    fields: VariantFields,
    sourceRevision: string | null,
  ): PlatformVariantRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO platform_variants (id, work_id, platform, title, body, cover_asset_id, tags,
             revision, created_at, updated_at, image_asset_ids, source_work_revision_id,
             inherit, cover_time_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workId,
          platform,
          fields.title,
          fields.body,
          fields.cover_asset_id,
          JSON.stringify(fields.tags),
          now,
          now,
          JSON.stringify(fields.image_asset_ids),
          sourceRevision,
          fields.inherit === true ? 1 : 0,
          fields.cover_time_seconds ?? null,
        );
      this.insertRevision(id, 1, 'draft', fields, now);
      this.feed?.record('work', workId, 'work.variant_created', {
        platform,
        revision: 1,
        source: 'draft',
      });
    })();
    return this.get(workId, platform);
  }

  private update(
    row: VariantRow,
    fields: VariantFields,
    source: VariantRevisionSource,
    sourceRevision: string | null,
  ): PlatformVariantRecord {
    const next = row.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE platform_variants SET title = ?, body = ?, cover_asset_id = ?, image_asset_ids = ?,
             tags = ?, inherit = ?, cover_time_seconds = ?, revision = ?,
             source_work_revision_id = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        )
        .run(
          fields.title,
          fields.body,
          fields.cover_asset_id,
          JSON.stringify(fields.image_asset_ids),
          JSON.stringify(fields.tags),
          fields.inherit === true ? 1 : 0,
          fields.cover_time_seconds ?? null,
          next,
          sourceRevision,
          now,
          row.id,
          row.revision,
        );
      if (updated.changes !== 1) throw this.conflict(row.id, String(row.revision));
      this.insertRevision(row.id, next, source, fields, now);
      this.feed?.record('work', row.work_id, 'work.variant_updated', {
        platform: row.platform,
        revision: next,
        source,
      });
    })();
    return this.get(row.work_id, PlatformSchema.parse(row.platform));
  }

  private insertRevision(
    variantId: string,
    revision: number,
    source: VariantRevisionSource,
    f: VariantFields,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO platform_variant_revisions (variant_id, revision, source, title, body,
           cover_asset_id, image_asset_ids, tags, created_at, inherit, cover_time_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        variantId,
        revision,
        source,
        f.title,
        f.body,
        f.cover_asset_id,
        JSON.stringify(f.image_asset_ids),
        JSON.stringify(f.tags),
        at,
        f.inherit === true ? 1 : 0,
        f.cover_time_seconds ?? null,
      );
  }

  /** 428 without a base, 409 with `current_revision` (a number) when stale. */
  private checkBase(row: VariantRow, base: string | null): void {
    const check = checkRevision(base, String(row.revision));
    if (check.ok) return;
    if (check.reason === 'missing_base') {
      throw new ServiceError(
        428,
        'precondition_required',
        'base_revision or If-Match is required to change a platform variant',
        { current_revision: row.revision },
      );
    }
    throw this.conflict(row.id, check.base);
  }

  private conflict(variantId: string, base: string): ServiceError {
    const current = this.db
      .prepare<[string], { revision: number }>(
        'SELECT revision FROM platform_variants WHERE id = ?',
      )
      .get(variantId);
    return new ServiceError(
      409,
      'revision_conflict',
      'platform variant was changed since base_revision; reload and merge before saving',
      { current_revision: current?.revision ?? null, base_revision: base },
    );
  }

  /** Cover and images must be existing image assets. */
  private validateAssets(change: VariantPatch): void {
    const ids = [
      ...(change.cover_asset_id ? [change.cover_asset_id] : []),
      ...(change.image_asset_ids ?? []),
    ];
    const bad: string[] = [];
    for (const id of new Set(ids)) {
      const row = this.db
        .prepare<[string], { kind: string }>('SELECT kind FROM assets WHERE id = ?')
        .get(id);
      if (row?.kind !== 'image') bad.push(id);
    }
    if (bad.length > 0) {
      throw new ServiceError(
        400,
        'validation_error',
        'cover_asset_id and image_asset_ids must be existing image assets',
        { invalid_asset_ids: bad },
      );
    }
  }

  /** The variant row for a platform, including a tombstone. */
  private findRow(workId: string, platform: Platform): VariantRow | undefined {
    return this.db
      .prepare<[string, string], VariantRow>(
        'SELECT * FROM platform_variants WHERE work_id = ? AND platform = ?',
      )
      .get(workId, platform);
  }

  private requireRow(workId: string, platform: Platform): VariantRow {
    this.works.get(workId);
    const row = this.findRow(workId, platform);
    if (!row || row.deleted_at !== null) throw notFound('platform variant');
    return row;
  }
}

function toRevision(r: VariantRevisionRow, platform: Platform): VariantRevision {
  return VariantRevisionSchema.parse({
    variant_id: r.variant_id,
    platform,
    revision: r.revision,
    source: r.source,
    title: r.title,
    body: r.body,
    cover_asset_id: r.cover_asset_id,
    image_asset_ids: jsonArray(r.image_asset_ids),
    tags: jsonArray(r.tags),
    inherit: r.inherit === 1,
    cover:
      r.cover_asset_id !== null
        ? { asset_id: r.cover_asset_id }
        : r.cover_time_seconds !== null
          ? { time_seconds: r.cover_time_seconds }
          : null,
    created_at: r.created_at,
  });
}
