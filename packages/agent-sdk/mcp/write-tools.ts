import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BatchWorkProjectsRequestSchema,
  BatchWorksRequestSchema,
  CreateProjectRequestSchema,
  CreateWorkRequestSchema,
  IdempotencyKeySchema,
  ImportUrlRequestSchema,
  LinkWorkAssetRequestSchema,
  ListJobsQuerySchema,
  PatchProjectRequestSchema,
  PatchVariantOverridesRequestSchema,
  PatchWorkRequestSchema,
  PlatformSchema,
  ReorderWorkAssetsRequestSchema,
  WorkAssetRoleSchema,
  WorkStatusSchema,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { id, tool, ToolInputError, USER_DATA_NOTE, type McpToolDef } from './define.js';

const idempotencyKey = IdempotencyKeySchema.describe(
  'Your own unique key for this request (8–200 printable ASCII, e.g. a UUID). Reuse the SAME key when retrying the same request so it is not done twice; use a new key for a new request.',
);

const workBase = id('revision').describe(
  "The work's current_revision_id you last read (work_get). 409 with details.current_revision if it changed since.",
);

const BATCH_ITEMS = BatchWorksRequestSchema.options[0].shape.items;

/** How long `job_wait` may block, in seconds. */
export const JOB_WAIT_MAX_SECONDS = 300;

const TERMINAL_JOB: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_POLL_MS = 250;

/** Bytes per tus PATCH when uploading a local file. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Open a local path for upload: only regular files (no folders, devices,
 * sockets or pipes); the server checks type and size. Read a chunk at a time,
 * so large videos are never held in memory.
 */
async function openLocalFile(filePath: string) {
  if (!path.isAbsolute(filePath)) {
    throw new ToolInputError('path must be an absolute path to a file on this Mac');
  }
  const stat = await fs.stat(filePath).catch((err: unknown) => {
    throw new ToolInputError(
      `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (!stat.isFile()) throw new ToolInputError(`${filePath} is not a regular file`);
  if (stat.size === 0) throw new ToolInputError(`${filePath} is empty`);
  const handle = await fs.open(filePath, 'r');
  return {
    handle,
    source: {
      size: stat.size,
      read: async (start: number, end: number): Promise<Uint8Array> => {
        const buffer = new Uint8Array(end - start);
        let done = 0;
        while (done < buffer.length) {
          const { bytesRead } = await handle.read(buffer, done, buffer.length - done, start + done);
          if (bytesRead === 0) throw new Error(`${filePath} changed while uploading`);
          done += bytesRead;
        }
        return buffer;
      },
    },
  };
}

export const WRITE_TOOLS: readonly McpToolDef[] = [
  // ---- Works ------------------------------------------------------------------
  tool({
    name: 'work_create',
    group: 'works',
    access: 'import',
    routes: ['POST /api/v1/works'],
    description:
      'Create a work in the library: an article (Markdown), an image post or a video (type image/video; their text goes in description). Optionally put it in projects (project_ids) and give tags. Retrying with the same idempotency_key returns the work created the first time instead of a duplicate. Returns the work with current_revision_id (the base_revision for later edits).',
    inputSchema: { ...CreateWorkRequestSchema.shape, idempotency_key: idempotencyKey },
    run: async (client, { idempotency_key, ...input }) =>
      client.works.create(
        { ...input, source: input.source === 'api' ? 'mcp' : input.source },
        { idempotencyKey: idempotency_key },
      ),
  }),
  tool({
    name: 'work_update_meta',
    group: 'works',
    access: 'write',
    routes: ['PATCH /api/v1/works/:id'],
    description:
      "Change a work's title, tags or status, never its text (the Markdown and descriptions are the user's original). base_revision is required: the current_revision_id you read; a stale one returns 409 and nothing is written. Each change becomes a new revision the user can restore.",
    inputSchema: {
      id: id('work'),
      base_revision: workBase,
      title: PatchWorkRequestSchema.shape.title,
      tags: PatchWorkRequestSchema.shape.tags,
      status: WorkStatusSchema.optional(),
    },
    run: async (client, { id: workId, base_revision, ...change }) => {
      if (change.title === undefined && change.tags === undefined && change.status === undefined) {
        throw new ToolInputError('give at least one of title, tags or status');
      }
      return client.works.patch(workId, { base_revision, ...change });
    },
  }),
  tool({
    name: 'work_trash',
    group: 'works',
    access: 'write',
    routes: ['DELETE /api/v1/works/:id'],
    destructive: true,
    description:
      'Move a work to 回收站 (kept 30 days, restorable with work_restore; works in linked external folders are only removed from the library, their files stay). Needs base_revision. Never deletes permanently.',
    inputSchema: { id: id('work'), base_revision: workBase },
    run: (client, args) => client.works.trash(args.id, { base_revision: args.base_revision }),
  }),
  tool({
    name: 'work_restore',
    group: 'works',
    access: 'write',
    routes: ['POST /api/v1/works/:id/restore'],
    description:
      'Bring a work back from 回收站 with its history, links and platform versions. Needs base_revision (its current_revision_id, see works_search with scope=trash).',
    inputSchema: { id: id('work'), base_revision: workBase },
    run: (client, args) =>
      client.works.restoreFromTrash(args.id, { base_revision: args.base_revision }),
  }),
  tool({
    name: 'work_restore_revision',
    group: 'works',
    access: 'write',
    routes: ['POST /api/v1/works/:id/revisions/:rid/restore'],
    description:
      "Make an earlier revision current again (work_revisions lists them). History is never rewritten: this adds a new 'restore' revision. base_revision is the current revision you read.",
    inputSchema: {
      id: id('work'),
      revision_id: id('revision to restore'),
      base_revision: workBase,
    },
    run: (client, args) =>
      client.works.restore(args.id, args.revision_id, { base_revision: args.base_revision }),
  }),
  tool({
    name: 'works_batch',
    group: 'works',
    access: 'write',
    routes: ['POST /api/v1/works/batch'],
    description:
      'Act on up to 200 works at once: trash, restore, set_status (needs status), add_tags or remove_tags (need tags). Each item is {id, base_revision} (the current_revision_id you read); an item changed since then fails alone with revision_conflict. Items succeed or fail one by one: check results[].ok. Retry with the same idempotency_key.',
    inputSchema: {
      action: z.enum(['trash', 'restore', 'set_status', 'add_tags', 'remove_tags']),
      items: BATCH_ITEMS,
      status: WorkStatusSchema.optional(),
      tags: z.array(z.string()).optional(),
      idempotency_key: idempotencyKey,
    },
    run: async (client, { idempotency_key, ...input }) => {
      const parsed = BatchWorksRequestSchema.safeParse(input);
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.works.batch(parsed.data, { idempotencyKey: idempotency_key });
    },
  }),

  // ---- Assets and jobs --------------------------------------------------------------
  tool({
    name: 'asset_upload_file',
    group: 'assets',
    access: 'import',
    routes: ['POST /api/v1/assets/uploads/tus', 'PATCH /api/v1/assets/uploads/tus/*'],
    description:
      'Upload a file from this Mac into the asset library (resumable, so large videos work). path must be an absolute path to a regular file; the server checks its real type and size limits. Returns the asset; deduplicated=true when the same content was already in the library (that asset is returned). Link it to a work with work_attach_asset.',
    inputSchema: {
      path: z.string().min(1).max(4096).describe('absolute path of a local file'),
      filename: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe('name to store (default: the file name)'),
    },
    run: async (client, args) => {
      const { handle, source } = await openLocalFile(args.path);
      try {
        return await client.assets.uploadResumable({
          source,
          filename: args.filename ?? path.basename(args.path),
          chunkSize: UPLOAD_CHUNK_BYTES,
        });
      } finally {
        await handle.close();
      }
    },
  }),
  tool({
    name: 'asset_import_url',
    group: 'assets',
    access: 'import',
    routes: ['POST /api/v1/imports/urls'],
    description:
      'Download a public http(s) URL into the asset library as a background job (private and local addresses are refused; size, time and content type are limited). Optionally link it to a work (work_id, role). Returns the job: follow it with job_wait. Retry with the same idempotency_key.',
    inputSchema: { ...ImportUrlRequestSchema.shape, idempotency_key: idempotencyKey },
    run: (client, { idempotency_key, ...input }) =>
      client.imports.url(input, { idempotencyKey: idempotency_key }),
  }),
  tool({
    name: 'jobs_list',
    group: 'assets',
    access: 'read',
    routes: ['GET /api/v1/jobs'],
    description: 'Import jobs, newest first, by status and method. Paged with limit and offset.',
    inputSchema: ListJobsQuerySchema.shape,
    run: (client, args) => client.jobs.list(args),
  }),
  tool({
    name: 'job_get',
    group: 'assets',
    access: 'read_or_own_import',
    routes: ['GET /api/v1/jobs/:id'],
    description:
      'One import job: status (queued, running, succeeded, failed, cancelled), the asset it made, or the error. An import-only token sees only jobs it started.',
    inputSchema: { id: id('job') },
    run: (client, args) => client.jobs.get(args.id),
  }),
  tool({
    name: 'job_wait',
    group: 'assets',
    access: 'read_or_own_import',
    routes: ['GET /api/v1/jobs/:id'],
    description: `Wait until an import job succeeds or fails (at most timeout_seconds, up to ${String(JOB_WAIT_MAX_SECONDS)}), then return it. On timeout, call again.`,
    inputSchema: {
      id: id('job'),
      timeout_seconds: z.number().int().min(1).max(JOB_WAIT_MAX_SECONDS).default(60),
    },
    run: async (client, args) => {
      const deadline = Date.now() + args.timeout_seconds * 1000;
      for (;;) {
        const job = await client.jobs.get(args.id);
        if (TERMINAL_JOB.has(job.status)) return { timed_out: false, job };
        if (Date.now() >= deadline) return { timed_out: true, job };
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      }
    },
  }),
  tool({
    name: 'job_retry',
    group: 'assets',
    access: 'import',
    routes: ['POST /api/v1/jobs/:id/retry'],
    description: 'Run a failed import job again (only failed jobs can be retried).',
    inputSchema: { id: id('job') },
    run: (client, args) => client.jobs.retry(args.id),
  }),
  tool({
    name: 'work_attach_asset',
    group: 'assets',
    access: 'write',
    routes: ['POST /api/v1/works/:id/assets', 'POST /api/v1/works/:id/media/attach'],
    description:
      "Link a library asset to a work as cover, body (images) or video, optionally at a position. With copy_into_work=true (body images of articles), the file is also copied into the work's own folder and the response gives the src to reference from Markdown; works in linked external folders cannot take copies. Does not edit the text.",
    inputSchema: {
      work_id: id('work'),
      ...LinkWorkAssetRequestSchema.shape,
      copy_into_work: z.boolean().default(false),
    },
    run: async (client, { work_id, copy_into_work, ...link }) => {
      if (!copy_into_work) return client.workAssets.link(work_id, link);
      if (link.role !== 'body') throw new ToolInputError('copy_into_work is for body images');
      return client.works.attachMedia(work_id, link.asset_id);
    },
  }),
  tool({
    name: 'work_detach_asset',
    group: 'assets',
    access: 'write',
    routes: ['DELETE /api/v1/works/:id/assets/:assetId'],
    description:
      'Unlink an asset from a work for one role. The asset stays in the library; Markdown that references its file is not changed.',
    inputSchema: { work_id: id('work'), asset_id: id('asset'), role: WorkAssetRoleSchema },
    run: (client, args) => client.workAssets.unlink(args.work_id, args.asset_id, args.role),
  }),
  tool({
    name: 'work_reorder_assets',
    group: 'assets',
    access: 'write',
    routes: ['PUT /api/v1/works/:id/assets/order'],
    description:
      "Set the order of a work's assets for one role (all of that role's asset ids, in order).",
    inputSchema: { work_id: id('work'), ...ReorderWorkAssetsRequestSchema.shape },
    run: (client, { work_id, ...order }) => client.workAssets.reorder(work_id, order),
  }),

  // ---- Projects ---------------------------------------------------------------------
  tool({
    name: 'project_create',
    group: 'projects',
    access: 'write',
    routes: ['POST /api/v1/projects'],
    description:
      'Create a project (a group of works; it never moves files). Check projects_list first so you do not make a duplicate.',
    inputSchema: CreateProjectRequestSchema.shape,
    run: (client, args) => client.projects.create(args),
  }),
  tool({
    name: 'project_update',
    group: 'projects',
    access: 'write',
    routes: ['PATCH /api/v1/projects/:id'],
    description:
      "Rename, recolor or archive a project. base_revision is the project's revision you read (project_get); a stale one returns 409.",
    inputSchema: {
      id: id('project'),
      base_revision: z.number().int().positive(),
      name: PatchProjectRequestSchema.shape.name,
      color: PatchProjectRequestSchema.shape.color,
      archived: PatchProjectRequestSchema.shape.archived,
    },
    run: async (client, { id: projectId, ...change }) => {
      const parsed = PatchProjectRequestSchema.safeParse(change);
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.projects.patch(projectId, parsed.data);
    },
  }),
  tool({
    name: 'project_delete',
    group: 'projects',
    access: 'write',
    routes: ['DELETE /api/v1/projects/:id'],
    destructive: true,
    description:
      'Delete a project. Its works are not deleted (they only leave the project), and the project can be restored with project_restore for 30 days.',
    inputSchema: { id: id('project') },
    run: (client, args) => client.projects.remove(args.id),
  }),
  tool({
    name: 'project_restore',
    group: 'projects',
    access: 'write',
    routes: ['POST /api/v1/projects/:id/restore'],
    description: 'Bring back a deleted project with its works.',
    inputSchema: { id: id('project') },
    run: (client, args) => client.projects.restore(args.id),
  }),
  tool({
    name: 'works_assign_projects',
    group: 'projects',
    access: 'write',
    routes: ['POST /api/v1/works/batch/projects'],
    description:
      "Put works into projects (add) or take them out (remove); works can be in several projects and their files are not touched. Results are per work: check results[].ok. Read the projects' descriptions and the works first and only assign what clearly fits.",
    inputSchema: BatchWorkProjectsRequestSchema.shape,
    run: async (client, args) => {
      const parsed = BatchWorkProjectsRequestSchema.safeParse(args);
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.projects.batchWorks(parsed.data);
    },
  }),

  // ---- Platforms --------------------------------------------------------------------
  tool({
    name: 'variant_update',
    group: 'platforms',
    access: 'write',
    routes: [
      'PATCH /api/v1/works/:id/variants/:platform',
      'DELETE /api/v1/works/:id/variants/:platform',
    ],
    description: `Override how one platform shows a work: title, cover ({asset_id} or a video {time_seconds}), images (ids to show, in order; work images left out are hidden) and tags. null follows the work again; reset_all=true clears every override. The body cannot be set: it always follows the work (only body: null, to drop an old separate body). base_revision is the platform's revision from variant_get (0 before the first override); a stale one returns 409. ${USER_DATA_NOTE}`,
    inputSchema: {
      id: id('work'),
      platform: PlatformSchema,
      base_revision: z.number().int().nonnegative(),
      title: PatchVariantOverridesRequestSchema.shape.title,
      cover: PatchVariantOverridesRequestSchema.shape.cover,
      images: PatchVariantOverridesRequestSchema.shape.images,
      tags: PatchVariantOverridesRequestSchema.shape.tags,
      body: z.null().optional().describe('null drops an old separate body; nothing else'),
      reset_all: z.boolean().default(false),
    },
    run: async (client, { id: workId, platform, base_revision, reset_all, ...change }) => {
      if (reset_all) {
        if (Object.keys(change).length > 0) {
          throw new ToolInputError('reset_all cannot be combined with field changes');
        }
        await client.variants.remove(workId, platform, base_revision);
        return client.variants.get(workId, platform);
      }
      const parsed = PatchVariantOverridesRequestSchema.safeParse({ base_revision, ...change });
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.variants.patch(workId, platform, parsed.data);
    },
  }),
];
