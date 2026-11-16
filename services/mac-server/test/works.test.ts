import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import { sha256Hex } from '@qiu-creator/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
beforeEach(async () => {
  s = await startTestServer();
});
afterEach(async () => {
  await s.close();
});

const sourcePath = (id: string): string => path.join(s.home, 'library', 'works', id, 'source.md');
const snapshotDir = (id: string): string => path.join(s.home, 'library', 'works', id, 'revisions');

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('auth', () => {
  it('rejects /api requests without a token with 401 and the uniform error body', async () => {
    const res = await fetch(`${s.baseUrl}/api/v1/works`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'missing or invalid bearer token' },
    });
  });

  it('rejects a wrong token', async () => {
    const res = await fetch(`${s.baseUrl}/api/v1/works`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('keeps /health public', async () => {
    expect(await s.client.health()).toEqual({
      status: 'ok',
      service: 'creatorhub-mac-server',
      version: '0.0.0',
    });
  });
});

describe('create and read works', () => {
  it('writes a real source.md that Finder can open, plus a first snapshot', async () => {
    const markdown = '# 標題\n\n正文第一段。\n';
    const work = await s.client.works.create({ title: '第一篇', markdown, tags: ['草稿'] });

    expect(fs.readFileSync(sourcePath(work.id), 'utf8')).toBe(markdown);
    expect(fs.readdirSync(snapshotDir(work.id))).toEqual([`${work.current_revision_id}.md`]);
    expect(work).toMatchObject({
      title: '第一篇',
      markdown,
      storage_mode: 'managed',
      status: 'drafting',
      tags: ['草稿'],
    });

    const read = await s.client.works.get(work.id);
    expect(read.markdown).toBe(markdown);
    const revisions = await s.client.works.revisions(work.id);
    expect(revisions.items).toHaveLength(1);
    expect(revisions.items[0]).toMatchObject({
      source: 'create',
      content_hash: sha256Hex(markdown),
    });
  });

  it('returns the revision as an ETag', async () => {
    const work = await s.client.works.create({ title: 't' });
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}`, { headers: authHeaders() });
    expect(res.headers.get('etag')).toBe(`"${work.current_revision_id}"`);
  });

  it('lists, filters and searches (including Chinese full-text)', async () => {
    await s.client.works.create({
      title: '旅行筆記',
      markdown: '京都的楓葉非常漂亮',
      tags: ['旅行'],
    });
    await s.client.works.create({ title: 'Recipe', markdown: 'pasta', status: 'ready' });

    expect((await s.client.works.list()).total).toBe(2);
    expect((await s.client.works.list({ status: 'ready' })).items.map((w) => w.title)).toEqual([
      'Recipe',
    ]);
    expect((await s.client.works.list({ tag: '旅行' })).items.map((w) => w.title)).toEqual([
      '旅行筆記',
    ]);
    expect((await s.client.works.list({ q: '的楓葉' })).items.map((w) => w.title)).toEqual([
      '旅行筆記',
    ]);
    expect((await s.client.works.list({ q: '旅行' })).items.map((w) => w.title)).toEqual([
      '旅行筆記',
    ]);
    expect((await s.client.works.list({ q: 'pasta' })).items.map((w) => w.title)).toEqual([
      'Recipe',
    ]);
    expect((await s.client.works.list({ q: '"OR' })).total).toBe(0);
  });

  it('returns 404 with the uniform error body for an unknown work', async () => {
    const err = await expectApiError(s.client.works.get(crypto.randomUUID()));
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
  });

  it('rejects invalid bodies with validation_error', async () => {
    const res = await fetch(`${s.baseUrl}/api/v1/works`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error');
  });
});

describe('PATCH with revision control', () => {
  it('creates a new revision and snapshot on success', async () => {
    const work = await s.client.works.create({ title: 't', markdown: 'v1' });
    const updated = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: 'v2',
    });

    expect(updated.current_revision_id).not.toBe(work.current_revision_id);
    expect(fs.readFileSync(sourcePath(work.id), 'utf8')).toBe('v2');
    const snapshots = fs.readdirSync(snapshotDir(work.id)).sort();
    expect(snapshots).toEqual(
      [`${work.current_revision_id}.md`, `${updated.current_revision_id}.md`].sort(),
    );
    expect(
      fs.readFileSync(path.join(snapshotDir(work.id), `${work.current_revision_id}.md`), 'utf8'),
    ).toBe('v1');

    const revisions = (await s.client.works.revisions(work.id)).items;
    expect(revisions.map((r) => r.source)).toEqual(['edit', 'create']);
    expect(revisions[0]?.parent_revision_id).toBe(work.current_revision_id);
  });

  it('returns 409 with the current revision for a stale base and leaves the file untouched', async () => {
    const work = await s.client.works.create({ title: 't', markdown: 'v1' });
    const v2 = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: 'v2 from iPhone',
    });

    const err = await expectApiError(
      s.client.works.patch(work.id, {
        base_revision: work.current_revision_id,
        markdown: 'v2 from Mac',
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('revision_conflict');
    expect(err.currentRevision).toBe(v2.current_revision_id);
    expect(fs.readFileSync(sourcePath(work.id), 'utf8')).toBe('v2 from iPhone');
    expect((await s.client.works.revisions(work.id)).items).toHaveLength(2);
  });

  it('accepts If-Match instead of base_revision and rejects a stale one', async () => {
    const work = await s.client.works.create({ title: 't', markdown: 'v1' });
    const ok = await s.client.works.patch(
      work.id,
      { title: 'renamed' },
      { ifMatch: work.current_revision_id },
    );
    expect(ok.title).toBe('renamed');

    const err = await expectApiError(
      s.client.works.patch(work.id, { title: 'again' }, { ifMatch: work.current_revision_id }),
    );
    expect(err.status).toBe(409);
  });

  it('requires a precondition (428) and does not accept If-Match: *', async () => {
    const work = await s.client.works.create({ title: 't', markdown: 'v1' });
    const err = await expectApiError(s.client.works.patch(work.id, { markdown: 'blind write' }));
    expect(err.status).toBe(428);

    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}`, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json', 'if-match': '*' }),
      body: JSON.stringify({ markdown: 'blind write' }),
    });
    expect(res.status).toBe(428);
    expect(fs.readFileSync(sourcePath(work.id), 'utf8')).toBe('v1');
  });

  it('records an external Finder edit as a revision so stale clients get 409 instead of overwriting it', async () => {
    const work = await s.client.works.create({ title: 't', markdown: 'v1' });
    fs.writeFileSync(sourcePath(work.id), 'edited in another editor');

    const err = await expectApiError(
      s.client.works.patch(work.id, {
        base_revision: work.current_revision_id,
        markdown: 'app edit',
      }),
    );
    expect(err.status).toBe(409);
    expect(fs.readFileSync(sourcePath(work.id), 'utf8')).toBe('edited in another editor');

    const revisions = (await s.client.works.revisions(work.id)).items;
    expect(revisions.map((r) => r.source)).toEqual(['external', 'create']);
    expect(err.currentRevision).toBe(revisions[0]?.revision_id);
  });
});
