import path from 'node:path';
import { resolveInsideHome } from './assets.js';

/**
 * The built renderer is served from `qc-app://renderer/` instead of
 * `file://` (QC-031). file:// pages get no response headers, so the CSP used
 * to be baked into index.html at build time with the default service address
 * (127.0.0.1:7420); a service on another host or port then had its images and
 * media blocked. Served through this scheme, every page carries the CSP the
 * main process computes from the actual service address.
 */
export const APP_SCHEME = 'qc-app';
export const APP_ORIGIN = `${APP_SCHEME}://renderer`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export function contentTypeOf(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The file inside `root` that a `qc-app://renderer/...` URL names, or null
 * for another host, a path outside `root`, or a malformed URL. `/` is
 * index.html. Query and hash are ignored.
 */
export function appFilePath(url: string, root: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== 'renderer') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const relative = pathname.replace(/^\/+/, '');
  return resolveInsideHome(root, relative === '' ? 'index.html' : relative);
}

/** Response headers for a renderer file. */
export function appResponseHeaders(file: string, csp: string): Record<string, string> {
  return {
    'content-type': contentTypeOf(file),
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  };
}

/** Whether an IPC sender is our own renderer. */
export function isAppUrl(url: string, devServerUrl: string | null): boolean {
  if (devServerUrl !== null) return url.startsWith(devServerUrl);
  return url.startsWith(`${APP_ORIGIN}/`);
}
