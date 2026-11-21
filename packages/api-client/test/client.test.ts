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

  it('sends ids as one comma-separated value (QC-045/046)', async () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const f = fakeFetch(200, { items: [], total: 0, limit: 0, offset: 0, missing_ids: [a] });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    expect((await client.works.list({ ids: [a, b] })).missing_ids).toEqual([a]);
    expect(f.calls[0]?.url).toBe(`http://mac/api/v1/works?ids=${a}%2C${b}`);
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

  it('attaches an asset to a work and keeps attach_external_unsupported (QC-039)', async () => {
    const asset = {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'image',
      path: 'library/assets/00000000-0000-4000-8000-000000000001/a.png',
      sha256: 'a'.repeat(64),
      mime_type: 'image/png',
      bytes: 10,
      duration: null,
      width: 1,
      height: 1,
      codec: null,
      origin: 'upload',
      created_at: '2026-11-19T00:00:00.000Z',
      original_name: 'a.png',
      metadata_status: 'ready',
      thumbnail_status: 'ready',
      updated_at: '2026-11-19T00:00:00.000Z',
    };
    const ok = fakeFetch(200, { src: 'assets/a.png', copied: true, asset });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: ok.fetch });
    const res = await client.works.attachMedia('00000000-0000-4000-8000-0000000000aa', asset.id);
    expect(res.src).toBe('assets/a.png');
    expect(ok.calls[0]?.url).toBe(
      'http://mac/api/v1/works/00000000-0000-4000-8000-0000000000aa/media/attach',
    );
    expect(ok.calls[0]?.init?.method).toBe('POST');
    const body = ok.calls[0]?.init?.body;
    expect(typeof body === 'string' ? JSON.parse(body) : null).toEqual({ asset_id: asset.id });
    const no = fakeFetch(409, { error: { code: 'attach_external_unsupported', message: 'x' } });
    const c2 = createClient({ baseUrl: 'http://mac', token: 't', fetch: no.fetch });
    const err: unknown = await c2.works.attachMedia('w', asset.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('attach_external_unsupported');
  });

  it('keeps the backup error codes (QC-030)', async () => {
    const cases = [
      [409, 'restore_in_progress'],
      [409, 'backup_not_restorable'],
      [409, 'backup_failed'],
      [500, 'backup_failed'],
      [503, 'restoring'],
    ] as const;
    for (const [status, code] of cases) {
      const f = fakeFetch(status, { error: { code, message: 'x' } });
      const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
      const err: unknown = await client.backups
        .restore('20261118T030000000Z-manual')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      expect((err as ApiError).body?.error.code).toBe(code);
    }
  });

  it('sends asset edits, deletes and trash calls to the right routes (QC-037)', async () => {
    const asset = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'image',
      path: 'library/assets/x/a.png',
      sha256: 'a'.repeat(64),
      mime_type: 'image/png',
      bytes: 1,
      duration: null,
      width: null,
      height: null,
      origin: 'upload',
      created_at: '2026-11-19T00:00:00.000Z',
      original_name: 'a.png',
      codec: null,
      metadata_status: 'none',
      thumbnail_status: 'none',
      updated_at: '2026-11-19T00:00:00.000Z',
      revision: 2,
      tags: ['旅行'],
    };
    const f = fakeFetch(200, asset);
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    expect(
      await client.assets.update(asset.id, { base_revision: 1, tags: ['旅行'] }),
    ).toMatchObject({
      revision: 2,
      tags: ['旅行'],
    });
    await client.assets.restore(asset.id);
    const del = fakeFetch(200, { asset, references: { works: [], variants: [] } });
    await createClient({ baseUrl: 'http://mac', token: 't', fetch: del.fetch }).assets.trash(
      asset.id,
      { confirm: true, move_original_to_trash: true },
    );
    const empty = fakeFetch(200, { purged: [] });
    await createClient({ baseUrl: 'http://mac', token: 't', fetch: empty.fetch }).trash.empty();
    expect(
      [...f.calls, ...del.calls, ...empty.calls].map((c) => [
        c.init?.method,
        c.url,
        JSON.parse(typeof c.init?.body === 'string' ? c.init.body : 'null') as unknown,
      ]),
    ).toEqual([
      ['PATCH', `http://mac/api/v1/assets/${asset.id}`, { base_revision: 1, tags: ['旅行'] }],
      ['POST', `http://mac/api/v1/assets/${asset.id}/restore`, {}],
      [
        'DELETE',
        `http://mac/api/v1/assets/${asset.id}`,
        { confirm: true, move_original_to_trash: true },
      ],
      ['DELETE', 'http://mac/api/v1/trash', { confirm: true }],
    ]);
  });

  it('keeps the asset error codes and their details (QC-037)', async () => {
    const references = {
      works: [{ work_id: 'w', title: '京都', role: 'cover', position: 0 }],
      variants: [],
    };
    const cases = [
      [409, 'asset_in_use', { references }],
      [409, 'asset_in_trash', undefined],
      [409, 'asset_file_missing', { path: 'a.png' }],
      [500, 'trash_failed', { detail: 'x' }],
    ] as const;
    for (const [status, code, details] of cases) {
      const f = fakeFetch(status, {
        error: { code, message: '無法移到系統垃圾桶，原檔未變動', details },
      });
      const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
      const err: unknown = await client.assets
        .trash('11111111-1111-4111-8111-111111111111')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      expect((err as ApiError).body?.error).toEqual({
        code,
        message: '無法移到系統垃圾桶，原檔未變動',
        ...(details === undefined ? {} : { details }),
      });
    }
  });

  it('rejects responses that do not match the contract', async () => {
    const f = fakeFetch(200, { status: 'weird' });
    const client = createClient({ baseUrl: 'http://mac', token: 't', fetch: f.fetch });
    await expect(client.health()).rejects.toThrow();
  });
});
