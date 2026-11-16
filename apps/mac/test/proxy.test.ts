import { describe, expect, it } from 'vitest';
import { performProxyRequest, ProxyRejected, validateProxyRequest } from '../src/main/proxy.js';
import type { ProxyRequest } from '../src/shared/bridge.js';

const BASE = 'http://127.0.0.1:7420';
const req = (patch: Partial<ProxyRequest>): ProxyRequest => ({
  url: `${BASE}/api/v1/works`,
  method: 'GET',
  headers: { authorization: 'Bearer t', accept: 'application/json' },
  body: null,
  ...patch,
});

describe('validateProxyRequest', () => {
  it('allows the service API and health check', () => {
    expect(validateProxyRequest(BASE, req({})).pathname).toBe('/api/v1/works');
    expect(validateProxyRequest(BASE, req({ url: `${BASE}/health` })).pathname).toBe('/health');
  });

  it.each([
    ['another host', { url: 'http://example.com/api/v1/works' }],
    ['another port', { url: 'http://127.0.0.1:7421/api/v1/works' }],
    ['the docs', { url: `${BASE}/docs` }],
    ['path traversal', { url: `${BASE}/api/v1/../../docs` }],
    ['credentials in url', { url: 'http://u:p@127.0.0.1:7420/api/v1/works' }],
    ['an odd method', { method: 'TRACE' }],
    ['an unexpected header', { headers: { cookie: 'x' } }],
    ['a non-url', { url: 'not a url' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => validateProxyRequest(BASE, req(patch))).toThrow(ProxyRejected);
  });
});

describe('performProxyRequest', () => {
  it('forwards method, headers and body and returns status, headers and text', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const res = await performProxyRequest(
      BASE,
      req({ method: 'PATCH', body: '{"title":"x"}', headers: { 'if-match': '"r1"' } }),
      (url, init) => {
        seen = { url, init };
        return Promise.resolve(
          new Response('{"ok":1}', { status: 409, headers: { etag: '"r2"' } }),
        );
      },
    );
    expect(seen).toMatchObject({
      url: `${BASE}/api/v1/works`,
      init: { method: 'PATCH', body: '{"title":"x"}', redirect: 'error' },
    });
    expect(res).toMatchObject({ status: 409, body: '{"ok":1}', headers: { etag: '"r2"' } });
  });
});
