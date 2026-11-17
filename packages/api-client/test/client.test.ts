import { describe, expect, it } from 'vitest';
import { ApiError, createClient, type FetchLike } from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status: number, body: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

describe('createClient', () => {
  it('sends the bearer token and trims the base URL', async () => {
    const f = fakeFetch(200, { status: 'ok', service: 'creatorhub-mac-server', version: '0.0.0' });
    const client = createClient({ baseUrl: 'http://mac:7420///', token: 'tkn', fetch: f.fetch });
    await client.health();
    expect(f.calls[0]?.url).toBe('http://mac:7420/health');
    expect(new Headers(f.calls[0]?.init?.headers).get('authorization')).toBe('Bearer tkn');
  });

  it('encodes list queries and skips undefined values', async () => {
    const f = fakeFetch(200, { items: [], total: 0, limit: 5, offset: 0 });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    await client.works.list({ q: '旅行 筆記', limit: 5, status: undefined });
    expect(f.calls[0]?.url).toBe(
      'http://mac/api/v1/works?q=%E6%97%85%E8%A1%8C+%E7%AD%86%E8%A8%98&limit=5',
    );
  });

  it('sends If-Match as a strong ETag on patch', async () => {
    const f = fakeFetch(409, {
      error: {
        code: 'revision_conflict',
        message: 'stale',
        details: { current_revision: 'r2', base_revision: 'r1' },
      },
    });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    const err: unknown = await client.works
      .patch('id', { title: 'x' }, { ifMatch: 'r1' })
      .catch((e: unknown) => e);
    expect(new Headers(f.calls[0]?.init?.headers).get('if-match')).toBe('"r1"');
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('revision_conflict');
    expect((err as ApiError).currentRevision).toBe('r2');
  });

  it('restores a revision with base_revision or If-Match, and builds absolute media URLs', async () => {
    const f = fakeFetch(409, {
      error: {
        code: 'revision_conflict',
        message: 'stale',
        details: { current_revision: 'r3', base_revision: 'r2' },
      },
    });
    const client = createClient({ baseUrl: 'http://mac:7420/', token: 't', fetch: f.fetch });
    const err: unknown = await client.works
      .restore('w 1', 'r1', { base_revision: 'r2' }, { ifMatch: 'r2' })
      .catch((e: unknown) => e);
    expect(f.calls[0]?.url).toBe('http://mac:7420/api/v1/works/w%201/revisions/r1/restore');
    expect(f.calls[0]?.init?.method).toBe('POST');
    expect(f.calls[0]?.init?.body).toBe('{"base_revision":"r2"}');
    expect(new Headers(f.calls[0]?.init?.headers).get('if-match')).toBe('"r2"');
    expect((err as ApiError).currentRevision).toBe('r3');
    expect(client.media.absoluteUrl('/media/v1/x?sig=1')).toBe('http://mac:7420/media/v1/x?sig=1');
  });

  it('sends variant revisions as If-Match and exposes the numeric current revision', async () => {
    const f = fakeFetch(409, {
      error: {
        code: 'revision_conflict',
        message: 'stale',
        details: { current_revision: 4, base_revision: '3' },
      },
    });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    const err: unknown = await client.variants
      .patch('w', 'xiaohongshu', { title: 'x' }, { ifMatch: 3 })
      .catch((e: unknown) => e);
    expect(f.calls[0]?.url).toBe('http://mac/api/v1/works/w/variants/xiaohongshu');
    expect(new Headers(f.calls[0]?.init?.headers).get('if-match')).toBe('"3"');
    expect((err as ApiError).currentVariantRevision).toBe(4);
    expect((err as ApiError).currentRevision).toBeUndefined();
  });

  it('rejects responses that do not match the contract', async () => {
    const f = fakeFetch(200, { status: 'weird' });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    await expect(client.health()).rejects.toThrow();
  });
});
