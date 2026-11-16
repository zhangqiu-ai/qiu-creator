import { ApiError, createClient } from '@qiu-creator/api-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mp4Bytes, pngBytes, zipBytes } from './fixtures.js';
import { authHeaders, startTestServer, type StartOptions, type TestServer } from './helpers.js';
import { serve, startUpstream, type Upstream } from './upstream.js';

let up: Upstream;
let s: TestServer;

beforeEach(async () => {
  up = await startUpstream();
});
afterEach(async () => {
  await s.close();
  await up.close();
});

async function start(extra: StartOptions = {}): Promise<TestServer> {
  s = await startTestServer({
    download: up.download(),
    jobs: { retryBaseMs: 1, pollMs: 5 },
    ...extra,
  });
  return s;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('URL import jobs', () => {
  it('downloads into the asset library and links it to a work', async () => {
    await start();
    const png = await pngBytes(64, 48);
    up.routes.set('/photos/cover.png', serve(png, 'image/png'));
    const work = await s.client.works.create({ title: 'URL 匯入' });

    const queued = await s.client.imports.url(
      { url: 'http://cdn.example.com/photos/cover.png', work_id: work.id, role: 'cover' },
      { idempotencyKey: 'import-cover-0001' },
    );
    expect(queued).toMatchObject({
      method: 'url',
      status: 'queued',
      idempotency_key: 'import-cover-0001',
    });

    const done = await s.client.jobs.wait(queued.id, { intervalMs: 10, timeoutMs: 5000 });
    expect(done).toMatchObject({ status: 'succeeded', progress: 1, error: null });
    const asset = await s.client.assets.get(done.result_asset_id ?? '');
    expect(asset).toMatchObject({
      kind: 'image',
      origin: 'url',
      original_name: 'cover.png',
      bytes: png.length,
    });
    const links = await s.client.workAssets.list(work.id);
    expect(links.items.map((i) => [i.role, i.asset.id])).toEqual([['cover', asset.id]]);
    await s.jobs.drain();
    expect((await s.client.assets.get(asset.id)).thumbnail_status).toBe('ready');
  });

  it('replays the same job for a repeated Idempotency-Key without downloading again', async () => {
    await start();
    up.routes.set('/v.mp4', serve(mp4Bytes(), 'video/mp4'));
    const body = { url: 'http://cdn.example.com/v.mp4' };
    const first = await s.client.imports.url(body, { idempotencyKey: 'same-key-12345' });
    await s.client.jobs.wait(first.id, { intervalMs: 10 });

    const res = await fetch(`${s.baseUrl}/api/v1/imports/urls`, {
      method: 'POST',
      headers: authHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'same-key-12345',
      }),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('idempotent-replayed')).toBe('true');
    const replayed = (await res.json()) as { id: string; status: string };
    expect(replayed).toMatchObject({ id: first.id, status: 'succeeded' });
    expect(up.hits.filter((p) => p === '/v.mp4')).toHaveLength(1);
    expect((await s.client.jobs.list()).total).toBe(1);

    const reused = await apiError(
      s.client.imports.url(
        { url: 'http://cdn.example.com/other.mp4' },
        { idempotencyKey: 'same-key-12345' },
      ),
    );
    expect(reused.status).toBe(422);
    expect(reused.code).toBe('idempotency_key_reused');
  });

  it('makes POST /works idempotent too', async () => {
    await start();
    const a = await s.client.works.create({ title: '同一篇' }, { idempotencyKey: 'work-key-0001' });
    const b = await s.client.works.create({ title: '同一篇' }, { idempotencyKey: 'work-key-0001' });
    expect(b.id).toBe(a.id);
    expect((await s.client.works.list()).total).toBe(1);
    const other = await s.client.works.create(
      { title: '同一篇' },
      { idempotencyKey: 'work-key-0002' },
    );
    expect(other.id).not.toBe(a.id);
  });

  it('fails a 404 permanently, then succeeds on manual retry', async () => {
    await start();
    const job = await s.client.imports.url({ url: 'http://cdn.example.com/later.png' });
    const failed = await s.client.jobs.wait(job.id, { intervalMs: 10 });
    expect(failed).toMatchObject({ status: 'failed', error_code: 'http_error', retry_count: 0 });
    expect(up.hits.filter((p) => p === '/later.png')).toHaveLength(1); // no automatic retry for 404

    up.routes.set('/later.png', serve(await pngBytes(8, 8), 'image/png'));
    const retried = await s.client.jobs.retry(job.id);
    expect(retried).toMatchObject({ status: 'queued', retry_count: 1, error: null });
    const ok = await s.client.jobs.wait(job.id, { intervalMs: 10 });
    expect(ok.status).toBe('succeeded');

    const again = await apiError(s.client.jobs.retry(job.id));
    expect(again.status).toBe(409);
    expect(again.code).toBe('job_not_retryable');
  });

  it('retries transient upstream errors automatically', async () => {
    await start();
    let calls = 0;
    const png = await pngBytes(8, 8, '#ff00ff');
    up.routes.set('/flaky.png', (req, res) => {
      calls++;
      if (calls < 3) {
        res.writeHead(503);
        res.end();
        return;
      }
      serve(png, 'image/png')(req, res);
    });
    const job = await s.client.imports.url({ url: 'http://cdn.example.com/flaky.png' });
    const done = await s.client.jobs.wait(job.id, { intervalMs: 10 });
    expect(done.status).toBe('succeeded');
    expect(calls).toBe(3);
  });

  it.each([
    ['disguised content', '/fake.jpg', zipBytes(), 'image/jpeg', 'unsupported_media_type'],
    [
      'an HTML page',
      '/page',
      Buffer.from('<html></html>'),
      'text/html',
      'unsupported_content_type',
    ],
  ])('fails %s without retrying', async (_label, route, body, type, code) => {
    await start();
    up.routes.set(route, serve(body, type));
    const job = await s.client.imports.url({ url: `http://cdn.example.com${route}` });
    const done = await s.client.jobs.wait(job.id, { intervalMs: 10 });
    expect(done).toMatchObject({ status: 'failed', error_code: code });
    expect((await s.client.assets.list()).total).toBe(0);
  });

  it('fails a download over the size limit', async () => {
    await start({ limits: { image: 1000, video: 1000, audio: 1000, markdown: 1000 } });
    up.routes.set('/big.png', serve(await pngBytes(300, 300), 'image/png'));
    const job = await s.client.imports.url({ url: 'http://cdn.example.com/big.png' });
    expect((await s.client.jobs.wait(job.id, { intervalMs: 10 })).error_code).toBe(
      'payload_too_large',
    );
  });

  it('records SSRF blocks found during the job', async () => {
    await start();
    const job = await s.client.imports.url({ url: 'http://internal.example.com/admin' });
    const done = await s.client.jobs.wait(job.id, { intervalMs: 10 });
    expect(done).toMatchObject({ status: 'failed', error_code: 'blocked_address' });
    expect(up.connects).toEqual([]);
  });

  it('rejects obviously unsafe URLs up front with 400', async () => {
    await start();
    for (const url of [
      'http://127.0.0.1:7420/api/v1/works',
      'http://[::1]/',
      'http://169.254.169.254/',
    ]) {
      const err = await apiError(s.client.imports.url({ url }));
      expect(err.status).toBe(400);
      expect(err.code).toBe('url_rejected');
    }
    const ftp = await apiError(s.client.imports.url({ url: 'ftp://cdn.example.com/x' }));
    expect(ftp.status).toBe(400);
    expect((await s.client.jobs.list()).total).toBe(0);
  });

  it('lists and filters jobs', async () => {
    await start();
    up.routes.set('/ok.png', serve(await pngBytes(4, 4), 'image/png'));
    const ok = await s.client.imports.url({ url: 'http://cdn.example.com/ok.png' });
    const bad = await s.client.imports.url({ url: 'http://cdn.example.com/missing.png' });
    await s.client.jobs.wait(ok.id, { intervalMs: 10 });
    await s.client.jobs.wait(bad.id, { intervalMs: 10 });
    expect((await s.client.jobs.list({ status: 'failed' })).items.map((j) => j.id)).toEqual([
      bad.id,
    ]);
    expect((await s.client.jobs.list({ method: 'url' })).total).toBe(2);
  });
});

describe('agent tokens', () => {
  it('stores only a hash, lists by prefix, and never shows the secret again', async () => {
    await start();
    const created = await s.client.tokens.create({
      name: 'Claude agent',
      scopes: ['import', 'read'],
    });
    expect(created.secret).toMatch(/^chk_[A-Za-z0-9_-]{43}$/);
    expect(created.token).toMatchObject({
      name: 'Claude agent',
      scopes: ['import', 'read'],
      revoked_at: null,
    });
    expect(created.secret.startsWith(created.token.prefix)).toBe(true);
    expect(created.token.prefix).toHaveLength(12);

    const listed = await s.client.tokens.list();
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    const row = s.db.prepare('SELECT * FROM api_tokens').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(created.secret);
    expect(row['token_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enforces scopes: import-only can import but not read or edit; read-only cannot create', async () => {
    await start();
    up.routes.set('/a.png', serve(await pngBytes(4, 4), 'image/png'));
    const work = await s.client.works.create({ title: 't', markdown: 'v1' });
    const importer = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: 'importer', scopes: ['import'] })).secret,
    });
    const reader = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: 'reader', scopes: ['read'] })).secret,
    });

    const job = await importer.imports.url(
      { url: 'http://cdn.example.com/a.png' },
      { idempotencyKey: 'agent-key-0001' },
    );
    expect(job.status).toBe('queued');
    expect((await apiError(importer.works.list())).status).toBe(403);
    // An import-only agent can follow its own job, but not list or see other jobs.
    expect((await importer.jobs.get(job.id)).created_by).not.toBe('owner');
    expect((await apiError(importer.jobs.list())).status).toBe(403);
    const ownerJob = await s.client.imports.url({ url: 'http://cdn.example.com/a.png' });
    expect((await apiError(importer.jobs.get(ownerJob.id))).status).toBe(404);
    expect(
      (
        await apiError(
          importer.works.patch(work.id, { base_revision: work.current_revision_id, title: 'x' }),
        )
      ).code,
    ).toBe('forbidden');
    expect((await apiError(importer.tokens.list())).status).toBe(403);

    expect((await reader.works.list()).total).toBe(1);
    expect((await reader.jobs.get(job.id)).id).toBe(job.id);
    expect(
      (await apiError(reader.works.create({ title: 'no' }, { idempotencyKey: 'reader-key-01' })))
        .status,
    ).toBe(403);
    expect((await apiError(reader.tokens.create({ name: 'x', scopes: ['read'] }))).status).toBe(
      403,
    );
  });

  it('requires an Idempotency-Key from agent tokens on creating endpoints', async () => {
    await start();
    const agent = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: 'a', scopes: ['import'] })).secret,
    });
    const err = await apiError(agent.works.create({ title: 'no key' }));
    expect(err.status).toBe(428);
    expect(
      (await apiError(agent.imports.url({ url: 'http://cdn.example.com/a.png' }))).status,
    ).toBe(428);
    expect(
      (await agent.works.create({ title: 'with key' }, { idempotencyKey: 'agent-work-01' })).title,
    ).toBe('with key');
  });

  it('keeps idempotency keys separate per token', async () => {
    await start();
    const t1 = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: '1', scopes: ['import'] })).secret,
    });
    const t2 = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: '2', scopes: ['import'] })).secret,
    });
    const a = await t1.works.create({ title: 'a' }, { idempotencyKey: 'shared-key-001' });
    const b = await t2.works.create({ title: 'b' }, { idempotencyKey: 'shared-key-001' });
    expect(a.id).not.toBe(b.id);
  });

  it('returns 401 immediately after revocation; the owner token keeps working', async () => {
    await start();
    const { token, secret } = await s.client.tokens.create({ name: 'temp', scopes: ['read'] });
    const agent = createClient({ baseUrl: s.baseUrl, token: secret });
    expect((await agent.works.list()).total).toBe(0);

    const revoked = await s.client.tokens.revoke(token.id);
    expect(revoked.revoked_at).not.toBeNull();
    const err = await apiError(agent.works.list());
    expect(err.status).toBe(401);
    expect((await s.client.works.list()).total).toBe(0);
    expect((await s.client.tokens.list()).items[0]?.last_used_at).not.toBeNull();
  });

  it('lets an import token upload (direct and tus) but not read the SSE stream', async () => {
    await start();
    const secret = (await s.client.tokens.create({ name: 'up', scopes: ['import'] })).secret;
    const importer = createClient({ baseUrl: s.baseUrl, token: secret });
    const direct = await importer.assets.uploadDirect({
      data: await pngBytes(6, 6),
      filename: 'x.png',
    });
    expect(direct.asset.kind).toBe('image');
    const tus = await importer.assets.uploadResumable({ data: mp4Bytes(), filename: 'v.mp4' });
    expect(tus.asset.kind).toBe('video');

    const res = await fetch(`${s.baseUrl}/api/v1/events`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });
});
