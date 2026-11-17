import type { ProxyRequest, ProxyResponse } from '../shared/bridge.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const ALLOWED_HEADERS = new Set([
  'authorization',
  'accept',
  'content-type',
  'if-match',
  'idempotency-key',
]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class ProxyRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyRejected';
  }
}

/**
 * The renderer may only reach the configured Mac service's API. Anything
 * else (other hosts, other paths, odd methods or headers) is rejected so a
 * compromised renderer cannot use the main process as an open proxy.
 */
export function validateProxyRequest(baseUrl: string, req: ProxyRequest): URL {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new ProxyRejected('invalid url');
  }
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) throw new ProxyRejected('origin not allowed');
  if (url.username !== '' || url.password !== '') throw new ProxyRejected('credentials in url');
  if (url.pathname !== '/health' && !url.pathname.startsWith('/api/v1/')) {
    throw new ProxyRejected('path not allowed');
  }
  if (!ALLOWED_METHODS.has(req.method.toUpperCase())) throw new ProxyRejected('method not allowed');
  for (const name of Object.keys(req.headers)) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase()))
      throw new ProxyRejected(`header not allowed: ${name}`);
  }
  if (req.body !== null && Buffer.byteLength(req.body) > MAX_BODY_BYTES) {
    throw new ProxyRejected('body too large');
  }
  return url;
}

export type NodeFetch = (input: string, init: RequestInit) => Promise<Response>;

export async function performProxyRequest(
  baseUrl: string,
  req: ProxyRequest,
  doFetch: NodeFetch = (input, init) => fetch(input, init),
): Promise<ProxyResponse> {
  const url = validateProxyRequest(baseUrl, req);
  const res = await doFetch(url.toString(), {
    method: req.method.toUpperCase(),
    headers: req.headers,
    body: req.body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, statusText: res.statusText, headers, body: await res.text() };
}
