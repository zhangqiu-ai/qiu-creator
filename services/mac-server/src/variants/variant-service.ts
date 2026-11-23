import { randomUUID } from 'node:crypto';
import {
  PLATFORM_LIMITS,
  PlatformSchema,
  VariantCoverSchema,
  VariantOverrideRevisionSchema,
  VariantViewSchema,
  type PatchVariantOverridesRequest,
  type Platform,
  type VariantCover,
  type VariantOverrideRevision,
  type VariantView,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { checkRevision } from '@qiu-creator/domain';
import {
  checkDerivedLimits,
  deriveWorkVariantBody,
  type DerivedBody,
} from '@qiu-creator/platform-preview';
import type { AssetService } from '../assets/asset-service.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { WorkMediaService } from '../media/work-media.js';
import type { WorkService } from '../works/work-service.js';

const PLATFORM_ORDER: readonly Platform[] = PlatformSchema.options;

/** Signs nothing anyone uses: source images are read for their asset ids only. */
const SYSTEM_PRINCIPAL = 'system:variants';

interface VariantRow {
  id: string;
  work_id: string;
  platform: string;
  // Pre-QC-084 values, kept untouched for rollback; read only by the backfill.
  title: string;
  body: string;
  cover_asset_id: string | null;
  image_asset_ids: string;
  tags: string;
  inherit: number;
  cover_time_seconds: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
  /** Set on a tombstone: the variant was deleted but its revision counter lives on. */
  deleted_at: string | null;
  // QC-084 overrides (null = follow the work).
  title_override: string | null;
  cover_override: string | null;
  image_order_override: string | null;
  tags_override: string | null;
  body_override: string | null;
  /** 0 until the old values were turned into overrides (`backfill`). */
  overrides_ready: number;
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
  title_override: string | null;
  cover_override: string | null;
  image_order_override: string | null;
  tags_override: string | null;
  body_override: string | null;
  overrides_format: number;
}

/** Stored image override: shown ids in order, work images hidden, ids not in the work. */
interface ImageOrder {
  order: string[];
  hidden: string[];
  extra: string[];
}

interface Overrides {
  title: string | null;
  cover: VariantCover | null;
  images: ImageOrder | null;
  tags: string[] | null;
  body: string | null;
}

type OverrideField = keyof Overrides;
const FIELDS: readonly OverrideField[] = ['title', 'cover', 'images', 'tags', 'body'];

const NO_OVERRIDES: Overrides = { title: null, cover: null, images: null, tags: null, body: null };

/** What the work gives a platform before overrides. */
interface WorkSource {
  work: WorkDetail;
  cover: VariantCover | null;
  images: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function jsonArray(raw: string): string[] {
  return stringArray(JSON.parse(raw));
}

function parseCover(raw: string | null): VariantCover | null {
  if (raw === null) return null;
  const parsed = VariantCoverSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

function parseImages(raw: string | null): ImageOrder | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  return {
    order: stringArray(o.order),
    hidden: stringArray(o.hidden),
    extra: stringArray(o.extra),
  };
}

function readOverrides(r: {
  title_override: string | null;
  cover_override: string | null;
  image_order_override: string | null;
  tags_override: string | null;
  body_override: string | null;
}): Overrides {
  return {
    title: r.title_override,
    cover: parseCover(r.cover_override),
    images: parseImages(r.image_order_override),
    tags: r.tags_override === null ? null : jsonArray(r.tags_override),
    body: r.body_override,
  };
}

function columns(o: Overrides): (string | null)[] {
  return [
    o.title,
    o.cover === null ? null : JSON.stringify(o.cover),
    o.images === null ? null : JSON.stringify(o.images),
    o.tags === null ? null : JSON.stringify(o.tags),
    o.body,
  ];
}

const coverFromColumns = (asset: string | null, time: number | null): VariantCover | null =>
  asset !== null ? { asset_id: asset } : time !== null ? { time_seconds: time } : null;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Images a platform shows: the override's order first, then work images it does not mention. */
function applyImages(source: readonly string[], o: ImageOrder | null): string[] {
  if (o === null) return [...source];
  const inWork = new Set(source);
  const extra = new Set(o.extra);
  const hidden = new Set(o.hidden);
  const listed = o.order.filter((id) => inWork.has(id) || extra.has(id));
  const rest = source.filter((id) => !o.order.includes(id) && !hidden.has(id));
  return [...listed, ...rest];
}

/**
 * Platform variants as overrides (QC-084): per work and platform, a title,
 * cover, image order and tags that differ from the work, each null while it
 * follows the work. The body is never stored; it is derived from the saved
 * work with `deriveVariantBody`, the same function the Mac app runs on the
 * unsaved draft. Variants edited before QC-084 may keep a legacy body
 * override, which can only be cleared.
 *
 * Every platform always resolves, with or without a row; a row exists once
 * something was overridden (revision 1 and up). Each override change takes
 * the next revision and a history row, guarded by `revision = <base>`, so
 * two changes from the same base never both land. A deleted row stays as a
 * tombstone so revisions never repeat (QC-019).
 */
export class VariantService {
  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
    private readonly assets: AssetService,
    private readonly media: WorkMediaService,
    private readonly feed?: ChangeFeed,
  ) {}

  /** All four platforms, in platform order. */
  async list(workId: string): Promise<VariantView[]> {
    const src = await this.source(workId);
    return PLATFORM_ORDER.map((p) => this.view(src, p, this.readyRow(src, p)));
  }

  async get(workId: string, platform: Platform): Promise<VariantView> {
    const src = await this.source(workId);
    return this.view(src, platform, this.readyRow(src, platform));
  }

  /** Current revision per platform that has a live row (for AI suggestions). */
  liveRevisions(workId: string): Map<Platform, number> {
    this.works.get(workId);
    const rows = this.db
      .prepare<[string], { platform: string; revision: number }>(
        'SELECT platform, revision FROM platform_variants WHERE work_id = ? AND deleted_at IS NULL',
      )
      .all(workId);
    return new Map(rows.map((r) => [PlatformSchema.parse(r.platform), r.revision]));
  }

  /** Revision a write must be based on: the row's, or 0 when there is none. */
  currentRevision(workId: string, platform: Platform): number {
    this.works.get(workId);
    return this.findRow(workId, platform)?.revision ?? 0;
  }

  async patch(
    workId: string,
    platform: Platform,
    baseRevision: string | null,
    change: Omit<PatchVariantOverridesRequest, 'base_revision'>,
  ): Promise<VariantView> {
    if (typeof change.body === 'string') {
      throw new ServiceError(
        400,
        'body_not_editable',
        'the platform body follows the work; edit the work, or send body: null to drop a legacy body override',
      );
    }
    const src = await this.source(workId);
    const row = this.readyRow(src, platform);
    this.checkBase(row, baseRevision);
    const current =
      row === undefined || row.deleted_at !== null ? NO_OVERRIDES : readOverrides(row);
    const next: Overrides = { ...current };
    if (change.title !== undefined) next.title = change.title;
    if (change.tags !== undefined)
      next.tags = change.tags === null ? null : [...new Set(change.tags)];
    if (change.body !== undefined) next.body = null;
    if (change.cover !== undefined) next.cover = this.checkCover(src, change.cover);
    if (change.images !== undefined) {
      next.images = change.images === null ? null : this.imageOrder(src, current, change.images);
    }
    const fields = FIELDS.filter((f) => !same(current[f], next[f]));
    if (fields.length === 0) return this.view(src, platform, row);
    this.write(workId, platform, row, next, (revision) => {
      this.feed?.record('work', workId, 'work.variant_changed', { platform, revision, fields });
    });
    return this.get(workId, platform);
  }

  /**
   * Drop every override: the row becomes a tombstone that takes the next
   * revision and keeps the history, so pre-delete revisions get 409 later.
   */
  async delete(workId: string, platform: Platform, baseRevision: string | null): Promise<void> {
    const src = await this.source(workId);
    const row = this.readyRow(src, platform);
    if (row === undefined || row.deleted_at !== null) throw notFound('platform variant');
    this.checkBase(row, baseRevision);
    const tombstone = row.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE platform_variants SET title_override = NULL, cover_override = NULL,
             image_order_override = NULL, tags_override = NULL, body_override = NULL,
             revision = ?, deleted_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        )
        .run(tombstone, now, now, row.id, row.revision);
      if (updated.changes !== 1) throw this.conflict(row.id, String(row.revision));
      this.insertRevision(row.id, tombstone, NO_OVERRIDES, now);
      this.feed?.record('work', workId, 'work.variant_deleted', {
        platform,
        revision: tombstone,
      });
    })();
  }

  /**
   * Deprecated `POST …/variants` (QC-084): give platforms without a live row
   * a row with no overrides (everything follows the work).
   */
  async generate(
    workId: string,
    platforms: readonly Platform[],
  ): Promise<{ created: VariantView[]; skipped: Platform[] }> {
    const src = await this.source(workId);
    const created: VariantView[] = [];
    const skipped: Platform[] = [];
    for (const platform of PLATFORM_ORDER.filter((p) => platforms.includes(p))) {
      const row = this.readyRow(src, platform);
      if (row !== undefined && row.deleted_at === null) {
        skipped.push(platform);
        continue;
      }
      this.write(workId, platform, row, NO_OVERRIDES, (revision) => {
        this.feed?.record('work', workId, 'work.variant_created', { platform, revision });
      });
      created.push(this.view(src, platform, this.findRow(workId, platform)));
    }
    return { created, skipped };
  }

  /**
   * Deprecated `POST …/variants/:platform/draft` (QC-084): follow the work
   * again in every field. Creates an empty row when there is none.
   */
  async redraft(
    workId: string,
    platform: Platform,
    baseRevision: string | null,
  ): Promise<{ variant: VariantView; created: boolean }> {
    const src = await this.source(workId);
    const row = this.readyRow(src, platform);
    if (row === undefined || row.deleted_at !== null) {
      const { created } = await this.generate(workId, [platform]);
      const variant = created[0];
      if (variant === undefined) throw notFound('platform variant');
      return { variant, created: true };
    }
    return {
      variant: await this.patch(workId, platform, baseRevision, {
        title: null,
        cover: null,
        images: null,
        tags: null,
        body: null,
      }),
      created: false,
    };
  }

  revisions(workId: string, platform: Platform): VariantOverrideRevision[] {
    const row = this.requireRow(workId, platform);
    return this.db
      .prepare<[string], VariantRevisionRow>(
        'SELECT * FROM platform_variant_revisions WHERE variant_id = ? ORDER BY revision DESC',
      )
      .all(row.id)
      .map((r) => toRevision(r, platform));
  }

  revision(workId: string, platform: Platform, revision: number): VariantOverrideRevision {
    const row = this.requireRow(workId, platform);
    const r = this.db
      .prepare<[string, number], VariantRevisionRow>(
        'SELECT * FROM platform_variant_revisions WHERE variant_id = ? AND revision = ?',
      )
      .get(row.id, revision);
    if (!r) throw notFound('variant revision');
    return toRevision(r, platform);
  }

  // ---- resolution ---------------------------------------------------------------

  /**
   * What the work gives every platform: title and tags, the body source, the
   * cover (the `cover` link, else the first image; for image and video works
   * their front-matter cover) and the images in order (Markdown images that
   * are assets, then other linked `body` images; or the front-matter images).
   */
  private async source(workId: string): Promise<WorkSource> {
    const work = this.works.get(workId);
    if (work.media != null) {
      const own = [
        ...new Set(work.media.images.flatMap((i) => (i.asset_id === null ? [] : [i.asset_id]))),
      ];
      const c = work.media.cover;
      const cover: VariantCover | null =
        c?.kind === 'frame'
          ? { time_seconds: c.time_seconds }
          : c?.kind === 'image' && c.item.asset_id !== null
            ? { asset_id: c.item.asset_id }
            : own[0] === undefined
              ? null
              : { asset_id: own[0] };
      return { work, cover, images: own };
    }
    const resolved = await this.media.resolve(workId, SYSTEM_PRINCIPAL);
    const links = this.assets.workAssets(workId);
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
    const linkedCover = links.find(
      (l) =>
        l.role === 'cover' &&
        (l.asset.kind === 'image' ||
          resolved.items.some((i) => i.asset_id === l.asset.id && i.kind === 'image')),
    )?.asset.id;
    const coverId = linkedCover ?? images[0] ?? null;
    return { work, cover: coverId === null ? null : { asset_id: coverId }, images };
  }

  private view(src: WorkSource, platform: Platform, row: VariantRow | undefined): VariantView {
    const live = row !== undefined && row.deleted_at === null;
    const o = live ? readOverrides(row) : NO_OVERRIDES;
    const work = src.work;
    const body: DerivedBody =
      o.body !== null
        ? {
            format: PLATFORM_LIMITS[platform].bodyFormat,
            text: o.body,
            blocks: [],
            map: [],
          }
        : deriveWorkVariantBody(work, platform);
    const title = o.title ?? work.title;
    const tags = o.tags ?? [...work.tags];
    const images = applyImages(src.images, o.images);
    const hidden = o.images === null ? [] : src.images.filter((id) => !images.includes(id));
    return VariantViewSchema.parse({
      work_id: work.id,
      platform,
      exists: live,
      revision: row?.revision ?? 0,
      title,
      title_source: o.title === null ? 'work' : 'override',
      body: body.text,
      body_source: o.body === null ? 'work' : 'legacy_override',
      body_format: body.format,
      cover: o.cover ?? src.cover,
      cover_source: o.cover === null ? 'work' : 'override',
      images,
      images_source: o.images === null ? 'work' : 'override',
      hidden_images: hidden,
      tags,
      tags_source: o.tags === null ? 'work' : 'override',
      warnings: checkDerivedLimits(
        platform,
        { title, body, image_asset_ids: images, tags },
        work.type,
      ),
      updated_at: live ? row.updated_at : null,
    });
  }

  // ---- migration of pre-QC-084 rows ------------------------------------------------

  /** The row for a platform with its old values turned into overrides (see `backfill`). */
  private readyRow(src: WorkSource, platform: Platform): VariantRow | undefined {
    const row = this.findRow(src.work.id, platform);
    if (row === undefined || row.overrides_ready === 1) return row;
    this.backfill(src, platform, row);
    return this.findRow(src.work.id, platform);
  }

  /**
   * Turn a pre-QC-084 row into overrides (migration 0020, run on first access
   * because it needs the work's files). A field becomes an override only if
   * its value differs from what the work gives now AND the user changed it
   * after the last rule-based draft; a value that only differs because the
   * work changed later follows the work. `inherit` rows follow the work in
   * title, body and tags. The old columns are left as they were, the
   * revision does not move and no event is sent.
   */
  private backfill(src: WorkSource, platform: Platform, row: VariantRow): void {
    let o: Overrides = NO_OVERRIDES;
    if (row.deleted_at === null) {
      const draft = this.db
        .prepare<[string], VariantRevisionRow>(
          `SELECT * FROM platform_variant_revisions
           WHERE variant_id = ? AND source = 'draft' AND overrides_format = 0
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(row.id);
      const old = {
        title: row.title,
        body: row.body.trim(),
        cover: coverFromColumns(row.cover_asset_id, row.cover_time_seconds),
        images: jsonArray(row.image_asset_ids),
        tags: jsonArray(row.tags),
      };
      const drafted =
        draft === undefined
          ? undefined
          : {
              title: draft.title,
              body: draft.body.trim(),
              cover: coverFromColumns(draft.cover_asset_id, draft.cover_time_seconds),
              images: jsonArray(draft.image_asset_ids),
              tags: jsonArray(draft.tags),
            };
      const inherit = row.inherit === 1;
      const keep = (field: keyof typeof old, now: unknown): boolean =>
        !same(old[field], now) && (drafted === undefined || !same(old[field], drafted[field]));
      const work = src.work;
      o = {
        title: !inherit && keep('title', work.title) ? old.title : null,
        body:
          !inherit && keep('body', deriveWorkVariantBody(work, platform).text) ? row.body : null,
        tags: !inherit && keep('tags', [...work.tags]) ? old.tags : null,
        cover: old.cover !== null && keep('cover', src.cover) ? old.cover : null,
        images: keep('images', src.images)
          ? {
              order: old.images,
              hidden: src.images.filter((id) => !old.images.includes(id)),
              extra: old.images.filter((id) => !src.images.includes(id)),
            }
          : null,
      };
    }
    this.db
      .prepare(
        `UPDATE platform_variants SET title_override = ?, cover_override = ?,
           image_order_override = ?, tags_override = ?, body_override = ?, overrides_ready = 1
         WHERE id = ? AND overrides_ready = 0`,
      )
      .run(...columns(o), row.id);
  }

  // ---- writes ---------------------------------------------------------------------

  /** Write overrides as the next revision (new row, revived tombstone, or update). */
  private write(
    workId: string,
    platform: Platform,
    row: VariantRow | undefined,
    o: Overrides,
    record: (revision: number) => void,
  ): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (row === undefined) {
        const id = randomUUID();
        try {
          this.db
            .prepare(
              `INSERT INTO platform_variants (id, work_id, platform, revision, created_at, updated_at,
                 title_override, cover_override, image_order_override, tags_override, body_override,
                 overrides_ready)
               VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1)`,
            )
            .run(id, workId, platform, now, now, ...columns(o));
        } catch (err) {
          // Another write created the row from the same base (0).
          if (err instanceof Error && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw new ServiceError(
              409,
              'revision_conflict',
              'platform variant was changed since base_revision; reload and merge before saving',
              {
                current_revision: this.findRow(workId, platform)?.revision ?? null,
                base_revision: '0',
              },
            );
          }
          throw err;
        }
        this.insertRevision(id, 1, o, now);
        record(1);
        return;
      }
      const next = row.revision + 1;
      const updated = this.db
        .prepare(
          `UPDATE platform_variants SET title_override = ?, cover_override = ?,
             image_order_override = ?, tags_override = ?, body_override = ?,
             revision = ?, deleted_at = NULL, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(...columns(o), next, now, row.id, row.revision);
      if (updated.changes !== 1) throw this.conflict(row.id, String(row.revision));
      this.insertRevision(row.id, next, o, now);
      record(next);
    })();
  }

  /** History row in the QC-084 format; the old content columns are left empty. */
  private insertRevision(variantId: string, revision: number, o: Overrides, at: string): void {
    this.db
      .prepare(
        `INSERT INTO platform_variant_revisions (variant_id, revision, source, title, body,
           cover_asset_id, image_asset_ids, tags, created_at, title_override, cover_override,
           image_order_override, tags_override, body_override, overrides_format)
         VALUES (?, ?, 'edit', '', '', NULL, '[]', '[]', ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(variantId, revision, at, ...columns(o));
  }

  /** A cover override must be an image asset, or a frame of a video work. */
  private checkCover(src: WorkSource, cover: VariantCover | null): VariantCover | null {
    if (cover === null) return null;
    if ('time_seconds' in cover) {
      if (src.work.type !== 'video') {
        throw new ServiceError(400, 'validation_error', 'a frame cover needs a video work');
      }
      return cover;
    }
    this.requireImages([cover.asset_id]);
    return cover;
  }

  /**
   * An images override from the ids to show: they must be images of the work,
   * or extra images the variant already had before QC-084. Work images left
   * out are hidden.
   */
  private imageOrder(src: WorkSource, current: Overrides, ids: readonly string[]): ImageOrder {
    const allowedExtra = new Set(current.images?.extra ?? []);
    const foreign = ids.filter((id) => !src.images.includes(id) && !allowedExtra.has(id));
    if (foreign.length > 0) {
      throw new ServiceError(
        400,
        'validation_error',
        'images must be images of the work; add an image to the work first',
        { invalid_asset_ids: foreign },
      );
    }
    this.requireImages(ids);
    return {
      order: [...ids],
      hidden: src.images.filter((id) => !ids.includes(id)),
      extra: ids.filter((id) => !src.images.includes(id)),
    };
  }

  private requireImages(ids: readonly string[]): void {
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
        'cover and images must be existing image assets',
        {
          invalid_asset_ids: bad,
        },
      );
    }
  }

  /** 428 without a base, 409 with `current_revision` (a number) when stale. */
  private checkBase(row: VariantRow | undefined, base: string | null): void {
    const current = row?.revision ?? 0;
    const check = checkRevision(base, String(current));
    if (check.ok) return;
    if (check.reason === 'missing_base') {
      throw new ServiceError(
        428,
        'precondition_required',
        'base_revision or If-Match is required to change a platform variant',
        { current_revision: current },
      );
    }
    if (row === undefined) {
      throw new ServiceError(
        409,
        'revision_conflict',
        'platform variant was changed since base_revision; reload and merge before saving',
        { current_revision: 0, base_revision: check.base },
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

  /** The variant row for a platform, including a tombstone. */
  private findRow(workId: string, platform: Platform): VariantRow | undefined {
    return this.db
      .prepare<[string, string], VariantRow>(
        'SELECT * FROM platform_variants WHERE work_id = ? AND platform = ?',
      )
      .get(workId, platform);
  }

  /** A row with history (live or tombstone); 404 for platforms never overridden. */
  private requireRow(workId: string, platform: Platform): VariantRow {
    this.works.get(workId);
    const row = this.findRow(workId, platform);
    if (!row) throw notFound('platform variant');
    return row;
  }
}

function toRevision(r: VariantRevisionRow, platform: Platform): VariantOverrideRevision {
  const modern = r.overrides_format === 1;
  const o = readOverrides(r);
  return VariantOverrideRevisionSchema.parse({
    platform,
    revision: r.revision,
    source: modern ? 'override' : r.source,
    overrides: modern
      ? {
          title: o.title,
          cover: o.cover,
          images: o.images?.order ?? null,
          hidden_images: o.images?.hidden ?? [],
          tags: o.tags,
          body: o.body,
        }
      : null,
    legacy: modern
      ? null
      : {
          title: r.title,
          body: r.body,
          cover: coverFromColumns(r.cover_asset_id, r.cover_time_seconds),
          image_asset_ids: jsonArray(r.image_asset_ids),
          tags: jsonArray(r.tags),
          inherit: r.inherit === 1,
        },
    created_at: r.created_at,
  });
}
