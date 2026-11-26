import path from 'node:path';
import { ASSET_TEXT_MAX_BYTES, type AssetText } from '../shared/bridge.js';

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

/**
 * Read the start of a text asset for the 素材庫 reader (QC-108): at most
 * `maxBytes`, asked for with a byte range and cut off there in case the
 * service sends more. The id must be an asset id; null when it is not or the
 * file cannot be read.
 */
export async function readAssetText(
  doFetch: typeof fetch,
  conn: { baseUrl: string; token: string },
  assetId: unknown,
  maxBytes: number = ASSET_TEXT_MAX_BYTES,
): Promise<AssetText | null> {
  if (typeof assetId !== 'string' || !UUID.test(assetId)) return null;
  let res: Response;
  try {
    res = await doFetch(`${conn.baseUrl}/api/v1/assets/${assetId.toLowerCase()}/stream`, {
      headers: { authorization: `Bearer ${conn.token}`, range: `bytes=0-${String(maxBytes)}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!res.ok || res.body === null) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const truncated = size > maxBytes;
  // A cut may split the last character; the decoder's streaming mode drops that partial one.
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(size, maxBytes)), {
    stream: truncated,
  });
  return { text, truncated };
}
