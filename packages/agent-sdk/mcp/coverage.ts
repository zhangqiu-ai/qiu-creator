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
  'PUT /api/v1/projects/order':
    '側欄排序屬於使用者介面偏好 (sidebar order is a UI preference of the user)',
  'POST /api/v1/works/:id/variants':
    'deprecated since QC-084 (QC-084 後已棄用): variants are overrides; variant_update writes them',
  'POST /api/v1/works/:id/variants/:platform/draft':
    'deprecated since QC-084 (QC-084 後已棄用): variant_update with reset_all follows the work again',
  // QC-089: accepting or discarding a proposal is the user's decision.
  'POST /api/v1/proposals/:id/accept':
    "owner only: accepting a proposal is the user's decision (使用者確認), never an agent's",
  'POST /api/v1/proposals/:id/discard':
    "owner only: discarding a proposal is the user's decision (使用者確認)",
  'POST /api/v1/assets/uploads':
    'single-request upload for the app; asset_upload_file always uses the resumable tus path',
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
  {
    prefix: '/api/v1/assets/uploads/tus',
    reason:
      'tus protocol methods asset_upload_file does not call (it uses POST to create and PATCH to send)',
  },
];

/**
 * Routes whose tools come in a later task. Empty since QC-088; keep the
 * mechanism for routes added before their tools.
 */
export const MCP_PENDING: Readonly<Record<string, string>> = {};

export const MCP_PENDING_AREAS: readonly { prefix: string; reason: string }[] = [];

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
