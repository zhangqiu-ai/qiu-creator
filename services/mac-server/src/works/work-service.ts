import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CreateWorkRequestSchema,
  WORK_TRASH_RETENTION_DAYS,
  WorkRemovalSchema,
  ListWorksQuerySchema,
  WORK_EXCERPT_MAX_CHARS,
  WORK_REFS_MAX,
  WorkFacetsQuerySchema,
  WorkRefSchema,
  WorkRefsQuerySchema,
  WorkSchema,
  type CreateWorkRequest,
  type ProjectMatch,
  type ExternalState,
  type ListWorksQuery,
  type ListWorksResponse,
  type Revision,
  type RevisionDetail,
  type RevisionSource,
  type Work,
  type WorkDetail,
  type WorkCardImage,
  type WorkListItem,
  type WorkFacetsQuery,
  type WorkFacetsResponse,
  type WorkRef,
  type WorkRefsQuery,
  type WorkRefsResponse,
  type WorkRemoval,
} from '@qiu-creator/contracts';
import {
  checkRevision,
  isPathInside,
  parseWorkSource,
  resolveInside,
  sha256Hex,
  writeWorkSource,
} from '@qiu-creator/domain';
import { currentPrincipal } from '../auth/actor-context.js';
import { addMembership, requesterAddedBy, ruleAddedBy } from '../projects/membership.js';
import { workGroupsOf } from '../projects/project-groups.js';
import { currentProjectLimit, WORK_IN_LIMIT_SQL } from '../auth/project-scope.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import {
  atomicWriteFileSync,
  nodeFsOps,
  writeNewFileSync,
  type AtomicFsOps,
} from '../fs/atomic.js';
import type { Layout } from '../layout.js';
import { isTypedWork, TypedWorkMedia, type WorkLocation } from './typed-media.js';
import {
  foldForSearch,
  matchExcerpt,
  matchesSearch,
  PINYIN_LONG_TEXT_MIN_LENGTH,
  pinyinKey,
  searchKey,
} from '@qiu-creator/domain/search';
import {
  WorkCardImages,
  workExcerpt,
  workPlainText,
  type CardImageOptions,
} from './card-images.js';

interface WorkRow {
  id: string;
  title: string;
  type: string;
  status: string;
  tags: string;
  source: string;
  storage_mode: string;
  source_path: string;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
  mount_id: string | null;
  external_state: string | null;
  /** JSON object: front-matter path → library asset id (QC-045/046). */
  media_index: string;
  /** Set while the work is in 最近刪除 (QC-051). */
  deleted_at: string | null;
  removal: string | null;
}

/** The columns `refs` reads (QC-067); `project_ids` is a JSON array. */
interface WorkRefRow {
  id: string;
  title: string;
  type: string;
  status: string;
  tags: string;
  current_revision_id: string;
  storage_mode: string;
  external_state: string | null;
  project_ids: string;
}

/** What 最近刪除 needs to know about a work (QC-051). */
export interface WorkTrashTarget {
  id: string;
  storageMode: 'managed' | 'external';
  mountId: string | null;
  sourcePath: string;
  deletedAt: string | null;
  removal: WorkRemoval | null;
  currentRevision: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface RevisionRow {
  revision_id: string;
  work_id: string;
  parent_revision_id: string | null;
  content_hash: string;
  snapshot_path: string;
  title: string;
  source: string;
  created_at: string;
  /** Only for `ai_accepted` revisions. */
  ai_job_id?: string | null;
  /** QC-089: the agent behind it (an accepted proposal, or a direct edit). */
  agent_token_id?: string | null;
  agent_name?: string | null;
  agent_via?: string | null;
  proposal_id?: string | null;
}

/** Who an agent-made revision is from (QC-089). */
export interface RevisionAgent {
  tokenId: string;
  name: string;
  via: 'proposal' | 'direct';
  proposalId: string | null;
}

/** The agent making the current request, if any: its writes are direct edits. */
function requestAgent(): RevisionAgent | null {
  const p = currentPrincipal();
  return p?.kind === 'agent'
    ? { tokenId: p.id, name: p.name, via: 'direct', proposalId: null }
    : null;
}

export interface PatchWorkInput {
  /** Effective base revision (from body or If-Match); `null` when the client sent none. */
  baseRevision: string | null;
  title?: string | undefined;
  markdown?: string | undefined;
  type?: Work['type'] | undefined;
  status?: Work['status'] | undefined;
  tags?: string[] | undefined;
  /** Adopting an AI job's result (validated by the caller): an `ai_accepted` revision. */
  aiJobId?: string | undefined;
}

/** A write of an image or video work, built by `WorkComposer` (QC-045/046). */
export interface TypedWorkWrite {
  markdown: string;
  title?: string | undefined;
  type?: Work['type'] | undefined;
  status?: Work['status'] | undefined;
  tags?: string[] | undefined;
  aiJobId?: string | undefined;
  /** Fields the client changed, for the `work.updated` event. */
  fields: string[];
  /** Front-matter paths this write learned the asset of. */
  mediaIndex: Record<string, string>;
}

/** What `WorkComposer` needs to build a typed write. */
export interface TypedWorkState {
  location: WorkLocation;
  type: Work['type'];
  title: string;
  tags: string[];
  markdown: string;
  currentRevision: string;
}

/** See `WorkService.mediaContext`. Paths in `baseDir`/`allowedPrefix` use `/`. */
export interface MediaContext {
  workId: string;
  revisionId: string;
  markdown: string;
  mountId: string | null;
  root: string | null;
  baseDir: string;
  allowedPrefix: string | null;
}

/** Where an external file lives. `null` path = mount not active, or the file is not a safe regular file. */
interface ExternalLocation {
  root: string;
  file: string;
}

/** First Markdown ATX heading, else the file name without extension. */
export function titleFromMarkdown(markdown: string, fileName: string): string {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1]?.trim();
  const fallback = path.basename(fileName).replace(/\.(md|markdown)$/i, '');
  return (heading !== undefined && heading !== '' ? heading : fallback).slice(0, 500) || 'Untitled';
}

/**
 * Works and their revisions.
 *
 * - **Managed** works live in `library/works/<id>/source.md`.
 * - **External** works live in a mounted folder and are indexed in place:
 *   never moved or deleted. Their snapshots still go to
 *   `library/works/<id>/revisions/`, so history survives whatever happens
 *   to the original file. A missing file is a state, not an error.
 *
 * Every content change is an immutable snapshot plus an atomic replace of
 * the source file, recorded in SQLite. All filesystem and database work is
 * synchronous so requests and watcher events in this process cannot
 * interleave between the revision check and the write.
 */
export class WorkService {
  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly fsOps: AtomicFsOps = nodeFsOps,
    private readonly feed?: ChangeFeed,
    cardOptions: CardImageOptions = { ffmpeg: null },
  ) {
    this.typed = new TypedWorkMedia(db, layout);
    this.cards = new WorkCardImages(layout, this.typed, cardOptions);
  }

  private readonly typed: TypedWorkMedia;
  private readonly cards: WorkCardImages;

  create(
    input: CreateWorkRequest,
    options: { autoAssigned?: readonly ProjectMatch[] } = {},
  ): WorkDetail {
    const req = CreateWorkRequestSchema.parse(input);
    if (req.description !== undefined && !isTypedWork(req.type)) {
      throw new ServiceError(400, 'validation_error', 'description is for image and video works');
    }
    if (req.description !== undefined && req.markdown !== '') {
      throw new ServiceError(400, 'validation_error', 'send markdown or description, not both');
    }
    if (isTypedWork(req.type) && req.markdown === '') {
      // QC-045/046: a new image or video work starts as front matter plus its description.
      req.markdown = writeWorkSource('', {
        type: req.type,
        title: req.title,
        ...(req.type === 'image' ? { images: [] } : {}),
        tags: req.tags,
        body: req.description ?? '',
      });
    }
    // QC-062: projects are checked before anything is written.
    this.requireLiveProjects(req.project_ids);
    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const sourceRel = this.layout.sourceRel(id);
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    const workDir = this.layout.abs(this.layout.workDirRel(id));

    fs.mkdirSync(path.join(workDir, 'revisions'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
    try {
      writeNewFileSync(this.layout.abs(snapshotRel), req.markdown);
      atomicWriteFileSync(this.layout.abs(sourceRel), req.markdown, this.fsOps);
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
               current_revision_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'managed', ?, ?, ?, ?)`,
          )
          .run(
            id,
            req.title,
            req.type,
            req.status,
            JSON.stringify(req.tags),
            req.source,
            sourceRel,
            revisionId,
            now,
            now,
          );
        this.insertRevision({
          revision_id: revisionId,
          work_id: id,
          parent_revision_id: null,
          content_hash: sha256Hex(req.markdown),
          snapshot_path: snapshotRel,
          title: req.title,
          source: 'create',
          created_at: now,
        });
        this.indexFts(id, req.title, req.tags, req.markdown);
        // QC-092: record who put it there; rule assignments carry score and reasons.
        const by = requesterAddedBy();
        for (const projectId of req.project_ids) addMembership(this.db, id, projectId, by, now);
        for (const m of options.autoAssigned ?? []) {
          addMembership(this.db, id, m.project_id, ruleAddedBy(m.score, m.reasons), now);
        }
        const projectIds = [
          ...req.project_ids,
          ...(options.autoAssigned ?? [])
            .map((m) => m.project_id)
            .filter((p) => !req.project_ids.includes(p)),
        ];
        this.feed?.record('work', id, 'work.created', {
          revision_id: revisionId,
          ...(projectIds.length > 0 ? { project_ids: projectIds } : {}),
        });
      })();
    } catch (err) {
      // Nothing references this directory yet; remove it so a failed create leaves no orphan.
      fs.rmSync(workDir, { recursive: true, force: true });
      throw err;
    }
    return this.get(id);
  }

  get(id: string): WorkDetail {
    const row = this.reconcileExternalChange(this.requireRow(id));
    const markdown = this.readCurrent(row);
    if (!isTypedWork(row.type)) return { ...this.workOf(row), markdown };
    return { ...this.workOf(row), markdown, ...this.typed.describe(location(row), markdown) };
  }

  list(query: ListWorksQuery = {}): ListWorksResponse {
    const q = ListWorksQuerySchema.parse(
      query.ids === undefined ? query : { ...query, ids: query.ids.join(',') },
    );
    const { where, params } = this.filterSql(q);
    if (q.ids !== undefined) {
      where.push(`w.id IN (${q.ids.map(() => '?').join(', ')})`);
      params.push(...q.ids);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    if (q.ids !== undefined) {
      // Restoring tabs (QC-045/046): exactly these works, in the order asked, no paging.
      const found = new Map(
        this.db
          .prepare<(string | number)[], WorkRow>(`SELECT w.* FROM works w ${whereSql}`)
          .all(...params)
          .map((r) => [r.id, r]),
      );
      const rows = q.ids.flatMap((wid) => {
        const r = found.get(wid);
        return r === undefined ? [] : [r];
      });
      return {
        items: rows.map((r) => this.listItem(r, q.q)),
        total: rows.length,
        limit: rows.length,
        offset: 0,
        missing_ids: q.ids.filter((wid) => !found.has(wid)),
        next_cursor: null,
      };
    }
    const total = this.db
      .prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n FROM works w ${whereSql}`)
      .get(...params);
    // QC-067: keyset paging on the list order; the key column is never null in its scope.
    const key = q.scope === 'trash' ? 'deleted_at' : 'updated_at';
    const pageWhere = [...where];
    const pageParams = [...params];
    if (q.cursor !== undefined) {
      const after = decodeWorkCursor(q.cursor, q.scope);
      pageWhere.push(`(w.${key} < ? OR (w.${key} = ? AND w.id > ?))`);
      pageParams.push(after.key, after.key, after.id);
    }
    const rows = this.db
      .prepare<(string | number)[], WorkRow>(
        `SELECT w.* FROM works w WHERE ${pageWhere.join(' AND ')}
         ORDER BY w.${key} DESC, w.id LIMIT ? OFFSET ?`,
      )
      .all(...pageParams, q.limit + 1, q.cursor === undefined ? q.offset : 0);
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((r) => this.listItem(r, q.q)),
      total: total?.n ?? 0,
      limit: q.limit,
      offset: q.cursor === undefined ? q.offset : 0,
      next_cursor:
        more && last !== undefined
          ? encodeWorkCursor(q.scope, cursorKey(last, q.scope), last.id)
          : null,
    };
  }

  /** Work counts by type and status for the library filter chips (QC-067). */
  facets(query: WorkFacetsQuery = {}): WorkFacetsResponse {
    const q = WorkFacetsQuerySchema.parse(query);
    const { where, params } = this.filterSql(q);
    const rows = this.db
      .prepare<(string | number)[], { type: string; status: string; n: number }>(
        `SELECT w.type, w.status, count(*) AS n FROM works w
         WHERE ${where.join(' AND ')} GROUP BY w.type, w.status`,
      )
      .all(...params);
    const byTypeStatus: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const r of rows) {
      byTypeStatus[r.type] = { ...byTypeStatus[r.type], [r.status]: r.n };
      total += r.n;
    }
    return { total, by_type_status: byTypeStatus };
  }

  /**
   * Every work matching the filters, light fields only, for 全選 and batch
   * actions over the whole filtered set (QC-067). 413 above `WORK_REFS_MAX`.
   */
  refs(query: WorkRefsQuery = {}): WorkRefsResponse {
    const q = WorkRefsQuerySchema.parse(query);
    const { where, params } = this.filterSql(q);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total =
      this.db
        .prepare<(string | number)[], { n: number }>(
          `SELECT count(*) AS n FROM works w ${whereSql}`,
        )
        .get(...params)?.n ?? 0;
    if (total > WORK_REFS_MAX) {
      throw new ServiceError(413, 'payload_too_large', 'too many works match; narrow the filters', {
        total,
        max: WORK_REFS_MAX,
      });
    }
    const order = q.scope === 'trash' ? 'w.deleted_at DESC, w.id' : 'w.updated_at DESC, w.id';
    const rows = this.db
      .prepare<(string | number)[], WorkRefRow>(
        `SELECT w.id, w.title, w.type, w.status, w.tags, w.current_revision_id,
                w.storage_mode, w.external_state,
                (SELECT json_group_array(id) FROM (
                   SELECT p.id FROM work_projects wp JOIN projects p ON p.id = wp.project_id
                   WHERE wp.work_id = w.id AND p.deleted_at IS NULL
                   ORDER BY p.sort_order, p.id)) AS project_ids
         FROM works w ${whereSql} ORDER BY ${order}`,
      )
      .all(...params);
    return { items: rows.map(toWorkRef), total };
  }

  /** The list filters shared by `list`, `facets` and `refs` (all but `ids` and paging). */
  private filterSql(q: {
    scope: 'active' | 'trash';
    project_id?: string | undefined;
    unassigned?: '0' | '1' | undefined;
    type?: string | undefined;
    status?: string | undefined;
    tag?: string | undefined;
    q?: string | undefined;
  }): { where: string[]; params: (string | number)[] } {
    const where: string[] = [
      q.scope === 'trash' ? 'w.deleted_at IS NOT NULL' : 'w.deleted_at IS NULL',
    ];
    const params: (string | number)[] = [];
    // QC-089: a token limited to projects only sees works in them.
    const limit = currentProjectLimit();
    if (limit !== null) {
      where.push(WORK_IN_LIMIT_SQL);
      params.push(JSON.stringify(limit));
    }
    // QC-062: one project, or works in no live project (archived ones count).
    if (q.project_id !== undefined && q.unassigned === '1') {
      throw new ServiceError(400, 'validation_error', 'send project_id or unassigned, not both');
    }
    if (q.project_id !== undefined) {
      this.requireLiveProjects([q.project_id]);
      where.push('w.id IN (SELECT work_id FROM work_projects WHERE project_id = ?)');
      params.push(q.project_id);
    }
    if (q.unassigned === '1') {
      where.push(
        `NOT EXISTS (SELECT 1 FROM work_projects wp JOIN projects p ON p.id = wp.project_id
                     WHERE wp.work_id = w.id AND p.deleted_at IS NULL)`,
      );
    }
    if (q.type) {
      where.push('w.type = ?');
      params.push(q.type);
    }
    if (q.status) {
      where.push('w.status = ?');
      params.push(q.status);
    }
    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(w.tags) WHERE value = ?)');
      params.push(q.tag);
    }
    // QC-068: the index holds folded text; fold the query the same way.
    const key = q.q === undefined ? '' : searchKey(q.q);
    if (key !== '') {
      const any: string[] = [];
      if (Array.from(key).length >= 3) {
        // trigram FTS: quote as a phrase so user input is never parsed as FTS syntax.
        any.push('w.id IN (SELECT work_id FROM works_fts WHERE works_fts MATCH ?)');
        params.push(`"${key.replaceAll('"', '""')}"`);
      } else {
        // trigram needs 3+ characters; scan the folded title, tags and body instead.
        any.push(
          `w.id IN (SELECT work_id FROM works_fts
                    WHERE instr(title, ?) > 0 OR instr(tags, ?) > 0 OR instr(body, ?) > 0)`,
        );
        params.push(key, key, key);
      }
      // QC-079: letters may be pinyin (`cy` → 常用). Titles and tags from 2
      // letters, the body from 4 (two initials occur in almost any article).
      const py = q.q === undefined ? null : pinyinKey(q.q);
      if (py !== null) {
        const body = py.length >= PINYIN_LONG_TEXT_MIN_LENGTH;
        any.push(
          `w.id IN (SELECT work_id FROM works_fts
                    WHERE search_pinyin(title, ?) OR search_pinyin(tags, ?)
                      ${body ? 'OR search_pinyin(body, ?)' : ''})`,
        );
        params.push(py, py, ...(body ? [py] : []));
      }
      where.push(`(${any.join(' OR ')})`);
    }
    return { where, params };
  }

  /**
   * A list row; image and video works add their card fields (QC-045/046), and
   * every work its card image and excerpt (QC-061).
   */
  private listItem(row: WorkRow, query?: string): WorkListItem {
    const work = this.workOf(row);
    let markdown: string;
    try {
      markdown = this.readCurrent(row);
    } catch {
      return work;
    }
    const loc = location(row);
    const card = {
      card_image: this.cards.cardImage(loc, markdown),
      excerpt: workExcerpt(row.type, markdown),
      ...(query === undefined ? {} : { match_excerpt: matchExcerptOf(row, markdown, query) }),
    };
    if (!isTypedWork(row.type)) {
      const image = card.card_image === null ? null : this.articleThumbnail(loc, markdown);
      return { ...work, ...card, ...(image === null ? {} : { thumbnail: image }) };
    }
    return { ...work, ...this.typed.summary(loc, markdown), ...card };
  }

  /** Articles' `thumbnail` mirrors their card image source (QC-061). */
  private articleThumbnail(loc: WorkLocation, markdown: string): WorkListItem['thumbnail'] {
    const path = this.cards.sourcePath(loc, markdown);
    return path === null ? null : { asset_id: null, path, kind: 'image' };
  }

  /** The card image file (QC-061), rendered if it is not cached. */
  cardImageFile(id: string): Promise<{ file: string; version: string }> {
    const row = this.reconcileExternalChange(this.requireRow(id));
    return this.cards.file(location(row), this.readCurrent(row));
  }

  /** Store a frame the app captured for a video card (QC-061). */
  async putCardFrame(
    id: string,
    frame: { version: string; source: string; timeSeconds: number; bytes: Buffer },
  ): Promise<WorkCardImage> {
    const row = this.reconcileExternalChange(this.requireRow(id));
    this.requireActiveRow(row);
    return this.cards.putFrame(location(row), this.readCurrent(row), frame);
  }

  /** Current state of an image or video work for a write, after the revision check. */
  typedState(id: string, baseRevision: string | null): TypedWorkState {
    const row = this.checkedRow(id, baseRevision, 'edit a work');
    return {
      location: location(row),
      type: WorkSchema.shape.type.parse(row.type),
      title: row.title,
      tags: parseTags(row.tags),
      markdown: this.readCurrent(row),
      currentRevision: row.current_revision_id,
    };
  }

  /** Front-matter path → root folder and root-relative path (see `TypedWorkMedia.locate`). */
  locateMedia(state: TypedWorkState, reference: string): { root: string; rel: string } | null {
    return this.typed.locate(state.location, reference);
  }

  /**
   * Commit a write built from `typedState` (QC-045/046). The revision is
   * checked again here: anything committed since the state was read makes
   * this 409, and nothing is written.
   */
  commitTyped(id: string, baseRevision: string, write: TypedWorkWrite): WorkDetail {
    const row = this.checkedRow(id, baseRevision, 'edit a work');
    return this.commitRevision(row, {
      markdown: write.markdown,
      title: write.title,
      type: write.type,
      status: write.status,
      tags: write.tags === undefined ? undefined : [...new Set(write.tags)],
      source: write.aiJobId === undefined ? 'edit' : 'ai_accepted',
      ...(write.aiJobId === undefined ? {} : { aiJobId: write.aiJobId }),
      mediaIndex: write.mediaIndex,
      event: {
        fields: write.fields,
        ...(write.aiJobId === undefined ? {} : { ai_job_id: write.aiJobId }),
      },
    });
  }

  patch(id: string, input: PatchWorkInput): WorkDetail {
    const row = this.checkedRow(id, input.baseRevision, 'edit a work');
    const fields = (['title', 'markdown', 'type', 'status', 'tags'] as const).filter(
      (f) => input[f] !== undefined,
    );
    return this.commitRevision(row, {
      markdown: input.markdown,
      title: input.title,
      type: input.type,
      status: input.status,
      // Order kept, duplicates dropped: tags are a set.
      tags: input.tags === undefined ? undefined : [...new Set(input.tags)],
      source: input.aiJobId === undefined ? 'edit' : 'ai_accepted',
      ...(input.aiJobId === undefined ? {} : { aiJobId: input.aiJobId }),
      event: {
        fields,
        ...(input.aiJobId === undefined ? {} : { ai_job_id: input.aiJobId }),
      },
    });
  }

  /** One historical revision with its Markdown snapshot. */
  revision(id: string, revisionId: string): RevisionDetail {
    this.reconcileExternalChange(this.requireRow(id));
    const r = this.requireRevision(id, revisionId);
    return { ...toRevision(r), title: r.title, markdown: this.readSnapshot(r) };
  }

  /**
   * Restore an old revision: append a new `restore` revision whose Markdown
   * and title are copied from `revisionId`. History is never rewritten; the
   * restored-from revision and everything after it stay readable. Status,
   * type and tags are not versioned and are left as they are.
   */
  restore(id: string, revisionId: string, baseRevision: string | null): WorkDetail {
    const row = this.checkedRow(id, baseRevision, 'restore a revision');
    const target = this.requireRevision(id, revisionId);
    return this.commitRevision(row, {
      markdown: this.readSnapshot(target),
      title: target.title,
      source: 'restore',
      event: { restored_from: revisionId, fields: ['title', 'markdown'] },
    });
  }

  /**
   * Write the text the user composed from an AI candidate (QC-022) as an
   * `ai_accepted` revision, against the revision the candidate was made from.
   * If the work changed since, 409 and nothing is written. Restorable like
   * any other revision.
   */
  acceptAi(
    id: string,
    baseRevision: string,
    change: { markdown: string; title?: string | undefined; aiJobId: string },
  ): WorkDetail {
    const row = this.checkedRow(id, baseRevision, 'accept an AI candidate');
    return this.commitRevision(row, {
      markdown: change.markdown,
      title: change.title,
      source: 'ai_accepted',
      aiJobId: change.aiJobId,
      event: {
        ai_job_id: change.aiJobId,
        fields: change.title === undefined ? ['markdown'] : ['title', 'markdown'],
      },
    });
  }

  /**
   * Write the text the user accepted from an agent's proposal (QC-089) as a
   * new `edit` revision naming the agent and the proposal. 409 when the work
   * changed since `baseRevision`.
   */
  applyProposal(
    id: string,
    baseRevision: string,
    markdown: string,
    agent: RevisionAgent,
  ): WorkDetail {
    const row = this.checkedRow(id, baseRevision, 'accept a proposal');
    return this.commitRevision(row, {
      markdown,
      source: 'edit',
      agent,
      event: { fields: ['markdown'], proposal_id: agent.proposalId },
    });
  }

  /** Markdown of one revision (for AI prompts built from a fixed source revision). */
  revisionMarkdown(id: string, revisionId: string): string {
    return this.readSnapshot(this.requireRevision(id, revisionId));
  }

  /**
   * Reconcile, then enforce the revision precondition (428 when absent, 409
   * when stale). Works in 最近刪除 are 409 `work_in_trash` unless `inTrash`.
   */
  private checkedRow(
    id: string,
    baseRevision: string | null,
    action: string,
    inTrash = false,
  ): WorkRow {
    const row = this.reconcileExternalChange(this.requireRow(id));
    if (!inTrash) this.requireActiveRow(row);
    const check = checkRevision(baseRevision, row.current_revision_id);
    if (!check.ok) {
      if (check.reason === 'missing_base') {
        throw new ServiceError(
          428,
          'precondition_required',
          `base_revision or If-Match is required to ${action}`,
          { current_revision: row.current_revision_id },
        );
      }
      throw new ServiceError(
        409,
        'revision_conflict',
        'work was changed since base_revision; reload and merge before saving',
        { current_revision: row.current_revision_id, base_revision: check.base },
      );
    }
    return row;
  }

  /**
   * Write a new revision: immutable snapshot first, then an atomic replace of
   * the source file (only when the Markdown changed), then the database row.
   * On failure the source file is rolled back and the snapshot removed.
   */
  private commitRevision(
    row: WorkRow,
    change: {
      markdown?: string | undefined;
      title?: string | undefined;
      type?: Work['type'] | undefined;
      status?: Work['status'] | undefined;
      tags?: string[] | undefined;
      source: RevisionSource;
      event: Record<string, unknown>;
      aiJobId?: string;
      /** Front-matter paths → library asset ids to remember (QC-045/046). */
      mediaIndex?: Record<string, string>;
      /** QC-089: set for accepted proposals; otherwise the requesting agent, if any. */
      agent?: RevisionAgent;
    },
  ): WorkDetail {
    const agent = change.agent ?? requestAgent();
    const id = row.id;
    const sourceAbs = this.writableSource(row);
    const previous = this.readCurrent(row);
    const markdown = change.markdown ?? previous;
    const title = change.title ?? row.title;
    const tags = change.tags ?? parseTags(row.tags);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    const contentChanged = markdown !== previous;

    fs.mkdirSync(path.dirname(this.layout.abs(snapshotRel)), { recursive: true });
    writeNewFileSync(this.layout.abs(snapshotRel), markdown);
    try {
      if (contentChanged) atomicWriteFileSync(sourceAbs, markdown, this.fsOps);
      this.db.transaction(() => {
        const updated = this.db
          .prepare(
            `UPDATE works SET title = ?, type = ?, status = ?, tags = ?, current_revision_id = ?,
               updated_at = ? WHERE id = ? AND current_revision_id = ?`,
          )
          .run(
            title,
            change.type ?? row.type,
            change.status ?? row.status,
            JSON.stringify(tags),
            revisionId,
            now,
            id,
            row.current_revision_id,
          );
        if (updated.changes !== 1) {
          throw new ServiceError(409, 'revision_conflict', 'work was changed concurrently', {
            current_revision: this.requireRow(id).current_revision_id,
            base_revision: row.current_revision_id,
          });
        }
        if (change.mediaIndex !== undefined && Object.keys(change.mediaIndex).length > 0) {
          this.db
            .prepare('UPDATE works SET media_index = json_patch(media_index, ?) WHERE id = ?')
            .run(JSON.stringify(change.mediaIndex), id);
        }
        this.insertRevision({
          revision_id: revisionId,
          work_id: id,
          parent_revision_id: row.current_revision_id,
          content_hash: sha256Hex(markdown),
          snapshot_path: snapshotRel,
          title,
          source: change.source,
          created_at: now,
          ai_job_id: change.aiJobId ?? null,
          agent_token_id: agent?.tokenId ?? null,
          agent_name: agent?.name ?? null,
          agent_via: agent?.via ?? null,
          proposal_id: agent?.proposalId ?? null,
        });
        this.indexFts(id, title, tags, markdown);
        this.feed?.record('work', id, 'work.updated', {
          revision_id: revisionId,
          source: change.source,
          ...change.event,
          ...(agent === null
            ? {}
            : { agent: { token_id: agent.tokenId, name: agent.name, via: agent.via } }),
        });
      })();
    } catch (err) {
      // Roll the file back so disk and database keep agreeing.
      if (
        contentChanged &&
        fs.existsSync(sourceAbs) &&
        fs.readFileSync(sourceAbs, 'utf8') !== previous
      ) {
        atomicWriteFileSync(sourceAbs, previous);
      }
      fs.rmSync(this.layout.abs(snapshotRel), { force: true });
      throw err;
    }
    return this.get(id);
  }

  private requireRevision(workId: string, revisionId: string): RevisionRow {
    const r = this.db
      .prepare<[string, string], RevisionRow>(
        'SELECT * FROM revisions WHERE work_id = ? AND revision_id = ?',
      )
      .get(workId, revisionId);
    if (!r) throw notFound('revision');
    return r;
  }

  private readSnapshot(r: RevisionRow): string {
    try {
      return fs.readFileSync(this.layout.abs(r.snapshot_path), 'utf8');
    } catch (err) {
      throw new ServiceError(500, 'internal_error', 'revision snapshot is missing or unreadable', {
        revision_id: r.revision_id,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Where a work's relative media references resolve from, plus the Markdown
   * to scan. Managed: the work folder (only `assets/…` is servable). External:
   * the mount root, with references relative to the note's own folder.
   * `root` is null when an external work's mount is not active.
   */
  mediaContext(id: string): MediaContext {
    const row = this.reconcileExternalChange(this.requireRow(id));
    const markdown = this.readCurrent(row);
    if (row.storage_mode !== 'external') {
      return {
        workId: id,
        revisionId: row.current_revision_id,
        markdown,
        mountId: null,
        root: this.layout.abs(this.layout.workDirRel(id)),
        baseDir: '',
        allowedPrefix: 'assets/',
      };
    }
    const location =
      row.mount_id === null ? null : this.externalLocation(row.mount_id, row.source_path);
    const dir = path.posix.dirname(row.source_path.split(path.sep).join('/'));
    return {
      workId: id,
      revisionId: row.current_revision_id,
      markdown,
      mountId: row.mount_id,
      root: location?.root ?? null,
      baseDir: dir === '.' ? '' : dir,
      allowedPrefix: null,
    };
  }

  revisions(id: string): Revision[] {
    this.reconcileExternalChange(this.requireRow(id));
    return this.db
      .prepare<[string], RevisionRow>(
        'SELECT * FROM revisions WHERE work_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(id)
      .map(toRevision);
  }

  // ---- Projects (QC-062) --------------------------------------------------------

  /** Live (not deleted) projects of a work, in sidebar order. Archived ones are included. */
  projectIds(workId: string): string[] {
    return this.db
      .prepare<[string], { id: string }>(
        `SELECT p.id FROM work_projects wp JOIN projects p ON p.id = wp.project_id
         WHERE wp.work_id = ? AND p.deleted_at IS NULL ORDER BY p.sort_order, p.id`,
      )
      .all(workId)
      .map((r) => r.id);
  }

  /** 404 `not_found` (with `details.project_id`) for any unknown or deleted project. */
  requireLiveProjects(ids: readonly string[]): void {
    for (const projectId of ids) {
      const row = this.db
        .prepare<[string], { deleted_at: string | null }>(
          'SELECT deleted_at FROM projects WHERE id = ?',
        )
        .get(projectId);
      if (row === undefined || row.deleted_at !== null) {
        throw new ServiceError(404, 'not_found', 'project not found', { project_id: projectId });
      }
    }
  }

  private workOf(row: WorkRow): Work {
    return {
      ...toWork(row),
      project_ids: this.projectIds(row.id),
      project_groups: workGroupsOf(this.db, row.id),
    };
  }

  // ---- 最近刪除 (QC-051) -------------------------------------------------------

  /** 409 `work_in_trash` when the work is in 最近刪除; 404 when unknown. */
  requireActive(id: string): void {
    this.requireActiveRow(this.requireRow(id));
  }

  /** The work for a delete or restore, after reconciling and the revision check. */
  trashTarget(id: string, baseRevision: string | null, action: string): WorkTrashTarget {
    return toTrashTarget(this.checkedRow(id, baseRevision, action, true));
  }

  /** A work in 最近刪除, without a revision check (purging). 404 when it is not there. */
  trashedTarget(id: string): WorkTrashTarget {
    const row = this.requireRow(id);
    if (row.deleted_at === null)
      throw new ServiceError(404, 'not_found', 'work is not in 最近刪除');
    return toTrashTarget(row);
  }

  /** Works in 最近刪除, oldest deletion first; `before` limits to deletions at or before it. */
  trashedTargets(before?: string): WorkTrashTarget[] {
    const rows =
      before === undefined
        ? this.db
            .prepare<[], WorkRow>(
              'SELECT * FROM works WHERE deleted_at IS NOT NULL ORDER BY deleted_at, id',
            )
            .all()
        : this.db
            .prepare<[string], WorkRow>(
              'SELECT * FROM works WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY deleted_at, id',
            )
            .all(before);
    return rows.map(toTrashTarget);
  }

  /**
   * Absolute path of an external work's file, when it is present and safe to
   * hand to the Trash; 409 `source_missing` otherwise.
   */
  externalSourceFile(id: string): string {
    const row = this.reconcileExternalChange(this.requireRow(id));
    if (row.storage_mode !== 'external') {
      throw new ServiceError(400, 'validation_error', 'not an external work');
    }
    return this.writableSource(row);
  }

  /** Whether an external work's file is readable right now. */
  externalSourcePresent(id: string): boolean {
    const row = this.reconcileExternalChange(this.requireRow(id));
    return row.storage_mode === 'external' && this.readSourceFile(row) !== null;
  }

  /** One work as a list row (any scope). */
  listItemById(id: string): WorkListItem {
    return this.listItem(this.reconcileExternalChange(this.requireRow(id)));
  }

  /**
   * Remove a work's database records for good: revisions, links and variants
   * go through the foreign keys; the search index by hand. A permanently
   * deleted external file is excluded from later rescans. Files are the
   * caller's to remove. Must run inside the caller's transaction.
   */
  deleteRecords(target: WorkTrashTarget): void {
    this.db.prepare('DELETE FROM works_fts WHERE work_id = ?').run(target.id);
    this.db.prepare('DELETE FROM works WHERE id = ?').run(target.id);
    if (target.storageMode === 'external' && target.mountId !== null) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO work_exclusions (mount_id, source_path, created_at)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM mounts WHERE id = ?)`,
        )
        .run(target.mountId, target.sourcePath, new Date().toISOString(), target.mountId);
    }
  }

  private requireActiveRow(row: WorkRow): void {
    if (row.deleted_at !== null) {
      throw new ServiceError(409, 'work_in_trash', 'the work is in 最近刪除; restore it first', {
        deleted_at: row.deleted_at,
      });
    }
  }

  // ---- External (mounted) works ---------------------------------------------

  /**
   * Index or refresh the external file at `rel` in `mountId`. Creates the work
   * on first sight; otherwise reconciles (new content → `external` revision,
   * reappeared file → `present`). Content identical to the current revision
   * is a no-op, which is what keeps the app's own writes from echoing back.
   * Returns the work id, or `null` when the file is not a readable regular file.
   */
  syncExternalFile(mountId: string, rel: string, sourceLabel: string): string | null {
    const existing = this.db
      .prepare<[string, string], WorkRow>(
        'SELECT * FROM works WHERE mount_id = ? AND source_path = ?',
      )
      .get(mountId, rel);
    if (existing) {
      this.reconcileExternalChange(existing);
      return existing.id;
    }
    // QC-051: deleted permanently from the library; the file stays, unindexed.
    const excluded = this.db
      .prepare<[string, string], { n: number }>(
        'SELECT count(*) AS n FROM work_exclusions WHERE mount_id = ? AND source_path = ?',
      )
      .get(mountId, rel);
    if ((excluded?.n ?? 0) > 0) return null;
    const location = this.externalLocation(mountId, rel);
    if (location === null) return null;
    const content = readRegularFile(location.file);
    if (content === null) return null;

    // A file that reappears elsewhere with the content of a missing work is a rename/move.
    const moved = this.findMissingByHash(mountId, sha256Hex(content));
    if (moved !== undefined) {
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE works SET source_path = ?, external_state = 'present', updated_at = ? WHERE id = ?",
          )
          .run(rel, new Date().toISOString(), moved.id);
        this.feed?.record('work', moved.id, 'work.source_restored', {
          from: moved.source_path,
          to: rel,
          reason: 'moved',
        });
      })();
      return moved.id;
    }

    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    // QC-045/046: a note whose front matter says image or video is that type, titled from it.
    const front = parseWorkSource(content).frontMatter;
    const type = front?.type === 'image' || front?.type === 'video' ? front.type : 'article';
    const title =
      type !== 'article' && front?.title != null
        ? front.title.trim().slice(0, 500)
        : titleFromMarkdown(content, rel);
    // Only tags the contract accepts (1–64 characters, at most 64 of them).
    const tags =
      type === 'article'
        ? []
        : [...new Set((front?.tags ?? []).map((t) => t.trim()))]
            .filter((t) => t !== '' && t.length <= 64)
            .slice(0, 64);
    fs.mkdirSync(path.dirname(this.layout.abs(snapshotRel)), { recursive: true });
    writeNewFileSync(this.layout.abs(snapshotRel), content);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
             current_revision_id, created_at, updated_at, mount_id, external_state)
           VALUES (?, ?, ?, 'drafting', ?, ?, 'external', ?, ?, ?, ?, ?, 'present')`,
        )
        .run(
          id,
          title,
          type,
          JSON.stringify(tags),
          sourceLabel,
          rel,
          revisionId,
          now,
          now,
          mountId,
        );
      this.insertRevision({
        revision_id: revisionId,
        work_id: id,
        parent_revision_id: null,
        content_hash: sha256Hex(content),
        snapshot_path: snapshotRel,
        title,
        source: 'create',
        created_at: now,
      });
      this.indexFts(id, title, tags, content);
      this.feed?.record('work', id, 'work.created', {
        revision_id: revisionId,
        mount_id: mountId,
        path: rel,
      });
    })();
    return id;
  }

  /** Re-check one external work by path (e.g. after a watcher `unlink`). Unknown paths are ignored. */
  checkExternalPath(mountId: string, rel: string): void {
    const row = this.db
      .prepare<[string, string], WorkRow>(
        'SELECT * FROM works WHERE mount_id = ? AND source_path = ?',
      )
      .get(mountId, rel);
    if (row) this.reconcileExternalChange(row);
  }

  /** Paths of all works indexed from a mount, for rescans. */
  externalPaths(mountId: string): string[] {
    return this.db
      .prepare<[string], { source_path: string }>(
        'SELECT source_path FROM works WHERE mount_id = ?',
      )
      .all(mountId)
      .map((r) => r.source_path);
  }

  /** Set every work of a mount to `state` (used for unmount / unavailable), with events. */
  setMountState(mountId: string, state: ExternalState): void {
    const rows = this.db
      .prepare<[string, string], WorkRow>(
        "SELECT * FROM works WHERE mount_id = ? AND coalesce(external_state, '') != ?",
      )
      .all(mountId, state);
    if (rows.length === 0) return;
    this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const row of rows) {
        this.db
          .prepare('UPDATE works SET external_state = ?, updated_at = ? WHERE id = ?')
          .run(state, now, row.id);
        this.feed?.record(
          'work',
          row.id,
          state === 'present' ? 'work.source_restored' : 'work.source_missing',
          { state },
        );
      }
    })();
  }

  private findMissingByHash(mountId: string, hash: string): WorkRow | undefined {
    return this.db
      .prepare<[string, string], WorkRow>(
        `SELECT w.* FROM works w JOIN revisions r ON r.revision_id = w.current_revision_id
         WHERE w.mount_id = ? AND w.external_state = 'missing' AND w.deleted_at IS NULL
           AND r.content_hash = ?
         ORDER BY w.updated_at DESC LIMIT 1`,
      )
      .get(mountId, hash);
  }

  /** Resolve a mount-relative path; `null` if the mount is not active. Rejects traversal. */
  private externalLocation(mountId: string, rel: string): ExternalLocation | null {
    const mount = this.db
      .prepare<[string], { root_path: string; status: string }>(
        'SELECT root_path, status FROM mounts WHERE id = ?',
      )
      .get(mountId);
    if (!mount || mount.status !== 'active') return null;
    return { root: mount.root_path, file: resolveInside(mount.root_path, rel) };
  }

  // ---- Source files -----------------------------------------------------------

  private requireRow(id: string): WorkRow {
    const row = this.db.prepare<[string], WorkRow>('SELECT * FROM works WHERE id = ?').get(id);
    if (!row) throw notFound('work');
    return row;
  }

  /**
   * Current content of the source file, or `null` if it cannot be read
   * safely. External files must be regular files (not symlinks) whose real
   * path stays inside the real mount root.
   */
  private readSourceFile(row: WorkRow): string | null {
    if (row.storage_mode !== 'external') {
      try {
        return fs.readFileSync(this.layout.abs(row.source_path), 'utf8');
      } catch (err) {
        throw new ServiceError(500, 'internal_error', 'work source file is missing or unreadable', {
          work_id: row.id,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (row.mount_id === null) return null;
    const location = this.externalLocation(row.mount_id, row.source_path);
    if (location === null) return null;
    try {
      const realRoot = fs.realpathSync(location.root);
      if (!isPathInside(realRoot, fs.realpathSync(path.dirname(location.file)))) return null;
    } catch {
      return null;
    }
    return readRegularFile(location.file);
  }

  /** Disk content when readable, otherwise the latest snapshot (missing/unmounted external works). */
  private readCurrent(row: WorkRow): string {
    const disk = this.readSourceFile(row);
    if (disk !== null) return disk;
    const snap = this.db
      .prepare<[string], { snapshot_path: string }>(
        'SELECT snapshot_path FROM revisions WHERE revision_id = ?',
      )
      .get(row.current_revision_id);
    if (!snap)
      throw new ServiceError(500, 'internal_error', 'current revision snapshot is missing');
    return fs.readFileSync(this.layout.abs(snap.snapshot_path), 'utf8');
  }

  /** Path a PATCH may write to. External works can only be written while their file is present. */
  private writableSource(row: WorkRow): string {
    if (row.storage_mode !== 'external') return this.layout.abs(row.source_path);
    const location =
      row.mount_id === null ? null : this.externalLocation(row.mount_id, row.source_path);
    if (
      location === null ||
      row.external_state !== 'present' ||
      this.readSourceFile(row) === null
    ) {
      throw new ServiceError(
        409,
        'source_missing',
        'the external file is missing or its folder is not mounted; nothing was written',
        { external_state: row.external_state, path: row.source_path },
      );
    }
    return location.file;
  }

  /**
   * Bring the database in line with the file on disk:
   * - content differs from the current revision → snapshot it as an
   *   `external` revision (clients holding the old revision then get 409
   *   instead of overwriting the outside edit);
   * - external file gone → mark `missing` (history and snapshots are kept);
   * - external file back → mark `present`.
   * Identical content is a no-op, so the app's own writes never echo back.
   */
  private reconcileExternalChange(row: WorkRow): WorkRow {
    const onDisk = this.readSourceFile(row);
    const external = row.storage_mode === 'external';
    if (onDisk === null) {
      if (external && row.external_state === 'present' && this.mountActive(row.mount_id)) {
        const now = new Date().toISOString();
        this.db.transaction(() => {
          this.db
            .prepare("UPDATE works SET external_state = 'missing', updated_at = ? WHERE id = ?")
            .run(now, row.id);
          this.feed?.record('work', row.id, 'work.source_missing', { path: row.source_path });
        })();
        return { ...row, external_state: 'missing', updated_at: now };
      }
      return row;
    }

    let current = row;
    if (external && row.external_state !== 'present') {
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE works SET external_state = 'present', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.feed?.record('work', row.id, 'work.source_restored', { path: row.source_path });
      })();
      current = { ...row, external_state: 'present', updated_at: now };
    }

    const hash = sha256Hex(onDisk);
    const head = this.db
      .prepare<[string], { content_hash: string }>(
        'SELECT content_hash FROM revisions WHERE revision_id = ?',
      )
      .get(current.current_revision_id);
    if (head?.content_hash === hash) return current;

    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(current.id, revisionId);
    fs.mkdirSync(path.dirname(this.layout.abs(snapshotRel)), { recursive: true });
    writeNewFileSync(this.layout.abs(snapshotRel), onDisk);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE works SET current_revision_id = ?, updated_at = ? WHERE id = ?')
        .run(revisionId, now, current.id);
      this.insertRevision({
        revision_id: revisionId,
        work_id: current.id,
        parent_revision_id: current.current_revision_id,
        content_hash: hash,
        snapshot_path: snapshotRel,
        title: current.title,
        source: 'external',
        created_at: now,
      });
      this.indexFts(current.id, current.title, parseTags(current.tags), onDisk);
      this.feed?.record('work', current.id, 'work.external_revision', { revision_id: revisionId });
    })();
    return { ...current, current_revision_id: revisionId, updated_at: now };
  }

  private mountActive(mountId: string | null): boolean {
    if (mountId === null) return false;
    const m = this.db
      .prepare<[string], { status: string }>('SELECT status FROM mounts WHERE id = ?')
      .get(mountId);
    return m?.status === 'active';
  }

  private insertRevision(r: RevisionRow): void {
    this.db
      .prepare(
        `INSERT INTO revisions (revision_id, work_id, parent_revision_id, content_hash, snapshot_path,
           title, source, created_at, ai_job_id, agent_token_id, agent_name, agent_via, proposal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.revision_id,
        r.work_id,
        r.parent_revision_id,
        r.content_hash,
        r.snapshot_path,
        r.title,
        r.source,
        r.created_at,
        r.ai_job_id ?? null,
        r.agent_token_id ?? null,
        r.agent_name ?? null,
        r.agent_via ?? null,
        r.proposal_id ?? null,
      );
  }

  private indexFts(id: string, title: string, tags: string[], body: string): void {
    this.db.prepare('DELETE FROM works_fts WHERE work_id = ?').run(id);
    this.db
      .prepare('INSERT INTO works_fts (work_id, title, tags, body) VALUES (?, ?, ?, ?)')
      .run(id, foldForSearch(title), foldForSearch(tags.join(' ')), foldForSearch(body));
  }
}

/** UTF-8 content of a regular file (symlinks and other types are refused), or `null`. */
function readRegularFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function toRevision(r: RevisionRow): Revision {
  return {
    work_id: r.work_id,
    revision_id: r.revision_id,
    parent_revision_id: r.parent_revision_id,
    content_hash: r.content_hash,
    created_at: r.created_at,
    source: r.source as RevisionSource,
    ai_job_id: r.ai_job_id ?? null,
    agent:
      r.agent_token_id === null || r.agent_token_id === undefined
        ? null
        : {
            token_id: r.agent_token_id,
            name: r.agent_name ?? '',
            via: r.agent_via === 'proposal' ? 'proposal' : 'direct',
            proposal_id: r.proposal_id ?? null,
            restore_to: r.parent_revision_id,
          },
  };
}

/**
 * The passage of a card's plain text around the first hit (QC-068), only when
 * the title does not show the hit; null when the title matches or the hit is
 * somewhere the card text does not show (tags, Markdown syntax, front matter).
 */
function matchExcerptOf(row: WorkRow, markdown: string, query: string): string | null {
  if (matchesSearch(row.title, query)) return null;
  const text = workPlainText(row.type, markdown);
  // Body text: pinyin from 4 letters, the same rule the list uses (QC-079).
  return text === null
    ? null
    : matchExcerpt(text, query, WORK_EXCERPT_MAX_CHARS, {
        pinyinMinLength: PINYIN_LONG_TEXT_MIN_LENGTH,
      });
}

function toWorkRef(row: WorkRefRow): WorkRef {
  return WorkRefSchema.parse({
    ...row,
    tags: parseTags(row.tags),
    project_ids: parseTags(row.project_ids),
  });
}

/** Where a list page ended (QC-067): the scope's sort key and id of its last work. */
interface WorkCursor {
  key: string;
  id: string;
}

function cursorKey(row: WorkRow, scope: 'active' | 'trash'): string {
  return scope === 'trash' ? (row.deleted_at ?? '') : row.updated_at;
}

/** Opaque to clients: base64url JSON `{ s, k, i }`, `s` being the scope it belongs to. */
function encodeWorkCursor(scope: 'active' | 'trash', key: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: scope, k: key, i: id }), 'utf8').toString('base64url');
}

function decodeWorkCursor(raw: string, scope: 'active' | 'trash'): WorkCursor {
  const invalid = (): ServiceError =>
    new ServiceError(400, 'validation_error', 'invalid cursor; list again without one', {
      field: 'cursor',
    });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof value !== 'object' || value === null) throw invalid();
  const s: unknown = Reflect.get(value, 's');
  const k: unknown = Reflect.get(value, 'k');
  const i: unknown = Reflect.get(value, 'i');
  if (s !== scope || typeof k !== 'string' || k === '' || typeof i !== 'string' || i === '') {
    throw invalid();
  }
  return { key: k, id: i };
}

function parseTags(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function location(row: WorkRow): WorkLocation {
  return {
    id: row.id,
    type: row.type,
    storage_mode: row.storage_mode,
    mount_id: row.mount_id,
    source_path: row.source_path,
    media_index: row.media_index,
  };
}

function toWork(row: WorkRow): Work {
  const external = row.storage_mode === 'external';
  return WorkSchema.parse({
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    tags: parseTags(row.tags),
    source: row.source,
    storage_mode: row.storage_mode,
    current_revision_id: row.current_revision_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    mount_id: row.mount_id,
    external_state: row.external_state,
    external_path: external ? row.source_path : null,
    deleted_at: row.deleted_at,
    purge_at:
      row.deleted_at === null
        ? null
        : new Date(Date.parse(row.deleted_at) + WORK_TRASH_RETENTION_DAYS * DAY_MS).toISOString(),
    removal: row.removal,
  });
}

function toTrashTarget(row: WorkRow): WorkTrashTarget {
  return {
    id: row.id,
    storageMode: row.storage_mode === 'external' ? 'external' : 'managed',
    mountId: row.mount_id,
    sourcePath: row.source_path,
    deletedAt: row.deleted_at,
    removal: row.removal === null ? null : WorkRemovalSchema.parse(row.removal),
    currentRevision: row.current_revision_id,
  };
}
