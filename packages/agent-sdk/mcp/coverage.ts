import { TOOLS } from './tools.js';

/**
 * Route coverage of the MCP adapter (docs/mcp-plan.md §6). Every `/api/v1`
 * route the Mac server registers must be exactly one of:
 *
 * - called by an MCP tool (`routes` in `tools.ts`);
 * - listed in `MCP_EXCLUDED` (or under an `MCP_EXCLUDED_AREAS` prefix) with
 *   the reason agents do not get it;
 * - listed in `MCP_PENDING` with the task that adds its tool.
 *
 * `test/mcp-coverage.test.ts` compares this with the routes the server
 * actually registers, so a new route without a decision here fails
 * `pnpm test`. Keys are `METHOD /pattern`; HEAD follows GET.
 */

/** Routes called by MCP tools, with the tools that call them. */
export function toolRoutes(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const t of TOOLS) {
    for (const r of t.routes) map.set(r, [...(map.get(r) ?? []), t.name]);
  }
  return map;
}

/** Single routes agents do not get through MCP, and why. */
export const MCP_EXCLUDED: Readonly<Record<string, string>> = {
  // Streams and binary media: MCP tools return JSON metadata, never file bytes.
  'GET /api/v1/events': 'SSE stream for the app; agents poll changes_since instead',
  'GET /api/v1/assets/:id/stream': 'binary media bytes; asset_get returns metadata',
  'GET /api/v1/assets/:id/thumbnail': 'binary thumbnail for the app',
  'GET /api/v1/works/:id/thumbnail': 'binary card image for the app',
  'GET /api/v1/works/:id/files/*': 'binary file inside a work folder, served to the app',
  'GET /api/v1/works/:id/media':
    'signed URLs for the app to embed images and videos; work_get lists linked assets',
  'POST /api/v1/media/signed-urls': 'signed URLs for the app to embed media',
  // App helpers.
  'GET /api/v1/works/facets': 'filter-chip counts for the library UI; works_search covers search',
  'GET /api/v1/works/refs': 'id list for the library UI selection; works_search covers search',
  'PUT /api/v1/works/:id/thumbnail-frame': 'internal: caches a video frame for the card image',
  // External folder mounts are the owner's (docs/mcp-plan.md §4).
  'GET /api/v1/mounts': 'external folder mounts are managed by the owner in the app',
  'GET /api/v1/mounts/:id': 'external folder mounts are managed by the owner in the app',
  'POST /api/v1/mounts': 'owner only: mounting external folders',
  'DELETE /api/v1/mounts/:id': 'owner only: unmounting external folders',
  'POST /api/v1/mounts/:id/rescan': 'owner only: rescanning external folders',
  // Asset library management and permanent deletion stay with the owner.
  'PATCH /api/v1/assets/:id': 'owner only: editing asset library metadata',
  'DELETE /api/v1/assets/:id':
    'owner only: deleting library assets (may move files to the macOS Trash)',
  'POST /api/v1/assets/:id/restore': 'owner only: asset 回收站',
  'POST /api/v1/assets/batch': 'owner only: batch asset deletion and restore',
  'DELETE /api/v1/trash': 'owner only: permanent deletion (empty asset 回收站)',
  'DELETE /api/v1/trash/:id': 'owner only: permanent deletion of an asset',
  'DELETE /api/v1/trash/works': 'owner only: permanent deletion (empty work 回收站)',
  'DELETE /api/v1/trash/works/:id': 'owner only: permanent deletion of a work',
};

/** Whole areas agents do not get, by route prefix, and why. */
export const MCP_EXCLUDED_AREAS: readonly { prefix: string; reason: string }[] = [
  {
    prefix: '/api/v1/ai',
    reason:
      'cloud AI keys, consent, prompts and paid jobs are owner only; not offered to agents (decision 2026-11-24 #2)',
  },
  {
    prefix: '/api/v1/works/:id/ai/',
    reason:
      'cloud AI on a work spends money and sends content to a third party (decision 2026-11-24 #2)',
  },
  {
    prefix: '/api/v1/assets/:id/ai/',
    reason:
      'video understanding uploads the user’s video to a third party (decision 2026-11-24 #2)',
  },
  { prefix: '/api/v1/backups', reason: 'owner only: backups and restore replace the database' },
  { prefix: '/api/v1/tokens', reason: 'owner only: agent token management' },
];

/** Routes whose tools come in a later task (write and import tools). */
export const MCP_PENDING: Readonly<Record<string, string>> = {
  'POST /api/v1/works': 'QC-088 work_create',
  'PATCH /api/v1/works/:id': 'QC-088 work_update_meta',
  'DELETE /api/v1/works/:id': 'QC-088 work_trash',
  'POST /api/v1/works/:id/restore': 'QC-088 work_restore',
  'POST /api/v1/works/batch': 'QC-088 works_batch',
  'POST /api/v1/works/:id/revisions/:rid/restore':
    'QC-088 decide: revision restore tool or exclusion',
  'POST /api/v1/works/:id/assets': 'QC-088 work_attach_asset',
  'POST /api/v1/works/:id/media/attach': 'QC-088 work_attach_asset (copy into the work folder)',
  'DELETE /api/v1/works/:id/assets/:assetId': 'QC-088 work_detach_asset',
  'PUT /api/v1/works/:id/assets/order': 'QC-088 work_reorder_assets',
  'POST /api/v1/assets/uploads': 'QC-088 asset_upload_file',
  'POST /api/v1/imports/urls': 'QC-088 asset_import_url',
  'GET /api/v1/jobs': 'QC-088 job_get',
  'GET /api/v1/jobs/:id': 'QC-088 job_get / job_wait',
  'POST /api/v1/jobs/:id/retry': 'QC-088 job retry',
  'POST /api/v1/projects': 'QC-088 project_create',
  'PATCH /api/v1/projects/:id': 'QC-088 project_update',
  'PUT /api/v1/projects/order': 'QC-088 decide: project reorder tool or exclusion',
  'DELETE /api/v1/projects/:id': 'QC-088 decide: project delete tool or exclusion',
  'POST /api/v1/projects/:id/restore': 'QC-088 decide: project restore tool or exclusion',
  'POST /api/v1/works/batch/projects': 'QC-088 works_assign_projects',
  'PATCH /api/v1/works/:id/variants/:platform': 'QC-088 variant_update',
  'POST /api/v1/works/:id/variants': 'QC-088 decide: deprecated by QC-084 overrides',
  'POST /api/v1/works/:id/variants/:platform/draft':
    'QC-088 decide: deprecated by QC-084 overrides',
  'DELETE /api/v1/works/:id/variants/:platform': 'QC-088 variant_update (clear all overrides)',
};

/** tus resumable uploads (all methods): used by QC-088 asset_upload_file. */
export const MCP_PENDING_AREAS: readonly { prefix: string; reason: string }[] = [
  {
    prefix: '/api/v1/assets/uploads/tus',
    reason: 'QC-088 asset_upload_file (resumable upload protocol)',
  },
];

export type Coverage =
  | { kind: 'tool'; tools: string[] }
  | { kind: 'excluded'; reason: string }
  | { kind: 'pending'; reason: string };

/** How one route is covered, or null when it is not classified. */
export function coverageOf(method: string, url: string): Coverage | null {
  const key = `${method === 'HEAD' ? 'GET' : method} ${url}`;
  const tools = toolRoutes().get(key);
  if (tools !== undefined) return { kind: 'tool', tools };
  const excluded = MCP_EXCLUDED[key];
  if (excluded !== undefined) return { kind: 'excluded', reason: excluded };
  const pending = MCP_PENDING[key];
  if (pending !== undefined) return { kind: 'pending', reason: pending };
  const area = MCP_EXCLUDED_AREAS.find((a) => url === a.prefix || url.startsWith(a.prefix));
  if (area !== undefined) return { kind: 'excluded', reason: area.reason };
  const pendingArea = MCP_PENDING_AREAS.find((a) => url === a.prefix || url.startsWith(a.prefix));
  if (pendingArea !== undefined) return { kind: 'pending', reason: pendingArea.reason };
  return null;
}
