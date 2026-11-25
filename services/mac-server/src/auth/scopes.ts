import type { TokenScope } from '@qiu-creator/contracts';
import { TUS_UPLOAD_PATH } from '@qiu-creator/contracts';

/**
 * `owner` = only the main token (token management).
 * `read_or_own_import` = `read`, or an `import` token reading a job it created
 * itself (the route checks ownership), so import-only agents can follow their work.
 * `any` = every valid token (QC-087: a token reading its own session).
 * `report` = an agent token with `import`, `write` or `propose` (QC-096:
 * reporting its own live status; any token that can change something may
 * say what it is doing).
 */
export type RequiredAccess = TokenScope | 'owner' | 'read_or_own_import' | 'any' | 'report';

/** Scopes that may report agent status (QC-096). */
export const REPORT_SCOPES: readonly TokenScope[] = ['import', 'write', 'propose'];

const WRITE_ROUTES = new Set([
  'PATCH /api/v1/works/:id',
  // QC-051: 最近刪除 keeps works for 30 days, so deleting is reversible. Purging
  // (`/api/v1/trash/works…`) and moving a file to the macOS Trash stay owner-only.
  'DELETE /api/v1/works/:id',
  'POST /api/v1/works/:id/restore',
  'POST /api/v1/works/batch',
  // QC-061: a captured video frame for a card image; writes only the cache.
  'PUT /api/v1/works/:id/thumbnail-frame',
  // QC-062: projects. Deleting one is reversible and never deletes works.
  'POST /api/v1/projects',
  'PUT /api/v1/projects/order',
  'PATCH /api/v1/projects/:id',
  'DELETE /api/v1/projects/:id',
  'POST /api/v1/projects/:id/restore',
  'POST /api/v1/works/batch/projects',
  'POST /api/v1/works/:id/assets',
  // QC-039: copies an asset into the work's own folder and links it (like linking an asset).
  'POST /api/v1/works/:id/media/attach',
  'DELETE /api/v1/works/:id/assets/:assetId',
  'PUT /api/v1/works/:id/assets/order',
  'POST /api/v1/works/:id/revisions/:rid/restore',
  'POST /api/v1/works/:id/variants',
  'PATCH /api/v1/works/:id/variants/:platform',
  'POST /api/v1/works/:id/variants/:platform/draft',
  'DELETE /api/v1/works/:id/variants/:platform',
]);

/** Non-GET routes that only read (they sign URLs for files the caller can already read). */
const READ_ROUTES = new Set([
  'POST /api/v1/media/signed-urls',
  // QC-092: scoring content against project rules writes nothing.
  'POST /api/v1/projects/suggestions',
  'POST /api/v1/projects/:id/rules/preview',
]);

/**
 * QC-089: proposing a change to a work's text. Accepting or discarding a
 * proposal is the user's decision, so those routes are not listed (owner only).
 */
const PROPOSE_ROUTES = new Set(['POST /api/v1/works/:id/proposals']);

const IMPORT_ROUTES = new Set([
  'POST /api/v1/works',
  'POST /api/v1/assets/uploads',
  'POST /api/v1/imports/urls',
  'POST /api/v1/jobs/:id/retry',
]);

/**
 * Access needed for an `/api` route, keyed by the matched route pattern.
 * Anything not listed (including future routes) is owner-only, so a new
 * endpoint is never silently opened to agent tokens.
 */
export function requiredAccess(method: string, routeUrl: string | undefined): RequiredAccess {
  if (routeUrl === undefined) return 'read'; // unmatched: authenticated 404
  if (routeUrl.startsWith('/api/v1/tokens')) return 'owner';
  // Backups and restore (QC-030) replace the whole database: the owner's alone, reads included.
  if (routeUrl === '/api/v1/backups' || routeUrl.startsWith('/api/v1/backups/')) return 'owner';
  // AI: keys, consent and anything that spends money are the owner's alone, reads included.
  if (routeUrl === '/api/v1/ai' || routeUrl.startsWith('/api/v1/ai/')) return 'owner';
  // Text AI on a work (QC-022) spends money and sends content to a third party.
  if (routeUrl.startsWith('/api/v1/works/:id/ai/')) return 'owner';
  // Video understanding (QC-023) uploads the user's video to Google and is billed.
  if (routeUrl.startsWith('/api/v1/assets/:id/ai/')) return 'owner';
  if (routeUrl === TUS_UPLOAD_PATH || routeUrl.startsWith(`${TUS_UPLOAD_PATH}/`)) return 'import';
  const key = `${method} ${routeUrl}`;
  // QC-096: agent live status. The app reads it; agents report their own.
  if (key === 'GET /api/v1/agents/activity' || key === 'HEAD /api/v1/agents/activity') {
    return 'owner';
  }
  if (key === 'POST /api/v1/agents/status') return 'report';
  if (key === 'GET /api/v1/session' || key === 'HEAD /api/v1/session') return 'any';
  if (key === 'GET /api/v1/jobs/:id' || key === 'HEAD /api/v1/jobs/:id')
    return 'read_or_own_import';
  if (PROPOSE_ROUTES.has(key)) return 'propose';
  if (IMPORT_ROUTES.has(key)) return 'import';
  if (WRITE_ROUTES.has(key)) return 'write';
  if (READ_ROUTES.has(key)) return 'read';
  if (method === 'GET' || method === 'HEAD') return 'read';
  return 'owner';
}
