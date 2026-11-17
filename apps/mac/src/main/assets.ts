import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssetResource = 'thumbnail' | 'stream';

/**
 * Map `qc-asset://thumbnail/<id>` or `qc-asset://stream/<id>` to the service
 * path it stands for. Anything else is refused, so the scheme cannot reach
 * other endpoints.
 */
export function assetServicePath(url: string): { resource: AssetResource; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'qc-asset:') return null;
  const resource = parsed.hostname;
  if (resource !== 'thumbnail' && resource !== 'stream') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!UUID.test(id)) return null;
  return { resource, path: `/api/v1/assets/${id.toLowerCase()}/${resource}` };
}

/** Only a single plain byte range is forwarded to the service. */
export function forwardableRange(header: string | null): string | null {
  return header !== null && /^bytes=\d*-\d*$/.test(header) && header !== 'bytes=-' ? header : null;
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
