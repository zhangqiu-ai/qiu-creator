import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a `qc-asset://thumbnail/<id>` URL to the service path it stands for.
 * Anything else is refused, so the scheme cannot reach other endpoints.
 */
export function thumbnailServicePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'qc-asset:' || parsed.hostname !== 'thumbnail') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!UUID.test(id)) return null;
  return `/api/v1/assets/${id.toLowerCase()}/thumbnail`;
}

/**
 * Absolute path of a managed asset for "在 Finder 顯示". Asset paths are
 * relative to CREATORHUB_HOME; anything that would leave it is refused.
 */
export function resolveInsideHome(home: string, relative: string): string | null {
  if (path.isAbsolute(relative)) return null;
  const root = path.resolve(home);
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** `/Users/me/CreatorHub` → `~/CreatorHub` for display. */
export function abbreviateHome(filePath: string, homedir: string): string {
  const rel = path.relative(homedir, filePath);
  if (rel === '') return '~';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return `~/${rel}`;
}
