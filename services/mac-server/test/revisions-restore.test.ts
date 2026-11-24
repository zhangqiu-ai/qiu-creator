import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import type { ChangeEvent } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { authHeaders, startTestServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ jobs: { pollMs: 5 } });
  servers.push(s);
  return s;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const workEvents = (s: TestServer, id: string, action: string): ChangeEvent[] =>
  s.feed.since(0).filter((e) => e.entity_id === id && e.action === action);

/** A work with three revisions: v1 (create), v2 and v3 (edits). */
async function threeVersions(s: TestServer) {
  const v1 = await s.client.works.create({ title: '初稿', markdown: '# v1\n' });
  const v2 = await s.client.works.patch(v1.id, {
    base_revision: v1.current_revision_id,
    title: '二稿',
    markdown: '# v2\n',
  });
  const v3 = await s.client.works.patch(v1.id, {
    base_revision: v2.current_revision_id,
    markdown: '# v3\n',
  });
  return { v1, v2, v3 };
}

describe('GET /works/:id/revisions/:rid', () => {
  it('returns the snapshot Markdown and title of any revision', async () => {
    const s = await start();
    const { v1, v2, v3 } = await threeVersions(s);
    const r1 = await s.client.works.revision(v1.id, v1.current_revision_id);
    expect(r1).toMatchObject({ title: '初稿', markdown: '# v1\n', source: 'create' });
    expect(r1.parent_revision_id).toBeNull();
    const r2 = await s.client.works.revision(v1.id, v2.current_revision_id);
    expect(r2).toMatchObject({
      title: '二稿',
      markdown: '# v2\n',
      source: 'edit',
      parent_revision_id: v1.current_revision_id,
    });
    expect((await s.client.works.revision(v1.id, v3.current_revision_id)).markdown).toBe('# v3\n');
  });

  it('404s for an unknown revision or one belonging to another work', async () => {
    const s = await start();
    const a = await s.client.works.create({ title: 'A', markdown: 'a' });
    const b = await s.client.works.create({ title: 'B', markdown: 'b' });
    expect((await apiError(s.client.works.revision(a.id, b.current_revision_id))).status).toBe(404);
    expect(
      (await apiError(s.client.works.revision(a.id, '00000000-0000-4000-8000-000000000000')))
        .status,
    ).toBe(404);
  });

  it('rejects a non-uuid revision id with 400', async () => {
    const s = await start();
    const a = await s.client.works.create({ title: 'A' });
    const res = await fetch(`${s.baseUrl}/api/v1/works/${a.id}/revisions/..%2F..%2Fx`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /works/:id/revisions/:rid/restore', () => {
  it('appends a restore revision with the old Markdown and title; history is untouched', async () => {
    const s = await start();
    const { v1, v3 } = await threeVersions(s);
    const before = (await s.client.works.revisions(v1.id)).items;

    const restored = await s.client.works.restore(v1.id, v1.current_revision_id, {
      base_revision: v3.current_revision_id,
    });
    expect(restored.markdown).toBe('# v1\n');
    expect(restored.title).toBe('初稿');
    expect(restored.current_revision_id).not.toBe(v1.current_revision_id);
    expect(fs.readFileSync(path.join(s.home, 'library/works', v1.id, 'source.md'), 'utf8')).toBe(
      '# v1\n',
    );

    const after = (await s.client.works.revisions(v1.id)).items;
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({
      revision_id: restored.current_revision_id,
      source: 'restore',
      parent_revision_id: v3.current_revision_id,
    });
    // Older revisions are unchanged, including their snapshots.
    expect(after.slice(1)).toEqual(before);
    expect((await s.client.works.revision(v1.id, v3.current_revision_id)).markdown).toBe('# v3\n');

    const [event] = workEvents(s, v1.id, 'work.updated').slice(-1);
    expect(event?.data).toMatchObject({
      revision_id: restored.current_revision_id,
      source: 'restore',
      restored_from: v1.current_revision_id,
    });
  });

  it('keeps status, type and tags (they are not versioned)', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'T', markdown: 'one', tags: ['a'] });
    const w2 = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      markdown: 'two',
      status: 'ready',
      tags: ['b'],
    });
    const r = await s.client.works.restore(w.id, w.current_revision_id, {
      base_revision: w2.current_revision_id,
    });
    expect(r).toMatchObject({ markdown: 'one', status: 'ready', tags: ['b'] });
  });

  it('accepts If-Match instead of base_revision and returns the new ETag', async () => {
    const s = await start();
    const { v1, v3 } = await threeVersions(s);
    const res = await fetch(
      `${s.baseUrl}/api/v1/works/${v1.id}/revisions/${v1.current_revision_id}/restore`,
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/json',
          'if-match': `"${v3.current_revision_id}"`,
        }),
        body: '{}',
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current_revision_id: string };
    expect(res.headers.get('etag')).toBe(`"${body.current_revision_id}"`);
  });

  it('409s on a stale base and writes nothing', async () => {
    const s = await start();
    const { v1, v2, v3 } = await threeVersions(s);
    const count = (await s.client.works.revisions(v1.id)).items.length;
    const err = await apiError(
      s.client.works.restore(v1.id, v1.current_revision_id, {
        base_revision: v2.current_revision_id,
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('revision_conflict');
    expect(err.currentRevision).toBe(v3.current_revision_id);
    expect((await s.client.works.revisions(v1.id)).items).toHaveLength(count);
    expect((await s.client.works.get(v1.id)).markdown).toBe('# v3\n');
    const snapshots = fs.readdirSync(path.join(s.home, 'library/works', v1.id, 'revisions'));
    expect(snapshots).toHaveLength(count);
  });

  it('428s without any precondition', async () => {
    const s = await start();
    const { v1 } = await threeVersions(s);
    const err = await apiError(s.client.works.restore(v1.id, v1.current_revision_id, {}));
    expect(err.status).toBe(428);
  });

  it('can restore the current revision (an explicit no-op change still gets a revision)', async () => {
    const s = await start();
    const { v1, v3 } = await threeVersions(s);
    const r = await s.client.works.restore(v1.id, v3.current_revision_id, {
      base_revision: v3.current_revision_id,
    });
    expect(r.markdown).toBe('# v3\n');
    expect(r.current_revision_id).not.toBe(v3.current_revision_id);
  });

  it('can restore a restore, and the chain stays linear', async () => {
    const s = await start();
    const { v1, v2, v3 } = await threeVersions(s);
    const r1 = await s.client.works.restore(v1.id, v1.current_revision_id, {
      base_revision: v3.current_revision_id,
    });
    const r2 = await s.client.works.restore(v1.id, v2.current_revision_id, {
      base_revision: r1.current_revision_id,
    });
    expect(r2.markdown).toBe('# v2\n');
    const items = (await s.client.works.revisions(v1.id)).items;
    expect(items.map((r) => r.source)).toEqual(['restore', 'restore', 'edit', 'edit', 'create']);
    expect(items[0]?.parent_revision_id).toBe(r1.current_revision_id);
  });

  it('needs the write scope for agent tokens', async () => {
    const s = await start();
    const { v1, v3 } = await threeVersions(s);
    const reader = s.tokens.create({ name: 'reader', scopes: ['read'] });
    const url = `${s.baseUrl}/api/v1/works/${v1.id}/revisions/${v1.current_revision_id}/restore`;
    const init = (token: string): RequestInit => ({
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: v3.current_revision_id }),
    });
    expect((await fetch(url, init(reader.secret))).status).toBe(403);
    // Reading a single revision only needs read.
    const read = await fetch(
      `${s.baseUrl}/api/v1/works/${v1.id}/revisions/${v1.current_revision_id}`,
      { headers: { authorization: `Bearer ${reader.secret}` } },
    );
    expect(read.status).toBe(200);
    // QC-089: restoring changes the text, so a write token also needs the
    // owner's allow_direct_body_edit switch.
    const writer = s.tokens.create({ name: 'writer', scopes: ['write'] });
    const refused = await fetch(url, init(writer.secret));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'direct_edit_not_allowed',
    );
    const direct = s.tokens.create({
      name: 'direct',
      scopes: ['write'],
      allow_direct_body_edit: true,
    });
    expect((await fetch(url, init(direct.secret))).status).toBe(200);
  });

  it('restores an external work by writing back to the mounted file', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mount-')));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'note.md'), '# 外部 v1\n');
    const s = await start();
    const mount = await s.client.mounts.create({ path: dir });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const work = (await s.client.works.list()).items.find((w) => w.external_path === 'note.md');
    if (work === undefined) throw new Error('external work not indexed');
    const v2 = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '# 外部 v2\n',
    });
    const r = await s.client.works.restore(work.id, work.current_revision_id, {
      base_revision: v2.current_revision_id,
    });
    expect(r.markdown).toBe('# 外部 v1\n');
    expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toBe('# 外部 v1\n');

    // File gone: restore refuses with source_missing and keeps history.
    fs.rmSync(path.join(dir, 'note.md'));
    const err = await apiError(
      s.client.works.restore(work.id, v2.current_revision_id, {
        base_revision: r.current_revision_id,
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('source_missing');
    expect(fs.existsSync(path.join(dir, 'note.md'))).toBe(false);
  });
});

describe('PATCH status and tags', () => {
  it('validates status and tags', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'T' });
    const send = (body: unknown) =>
      fetch(`${s.baseUrl}/api/v1/works/${w.id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ base_revision: w.current_revision_id, ...(body as object) }),
      });
    expect((await send({ status: 'archived' })).status).toBe(400);
    expect((await send({ tags: [''] })).status).toBe(400);
    expect((await send({ tags: ['x'.repeat(65)] })).status).toBe(400);
    expect(
      (await send({ tags: Array.from({ length: 65 }, (_, i) => `t${String(i)}`) })).status,
    ).toBe(400);
    expect((await send({ tags: 'a,b' })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    // Nothing was written by the rejected requests.
    expect((await s.client.works.revisions(w.id)).items).toHaveLength(1);
  });

  it('updates status and tags (trimmed, de-duplicated), keeps the Markdown, emits work.updated', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'T', markdown: 'body' });
    const p = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      status: 'in_review',
      tags: [' 旅行 ', '美食', '旅行'],
    });
    expect(p).toMatchObject({ status: 'in_review', tags: ['旅行', '美食'], markdown: 'body' });
    const [event] = workEvents(s, w.id, 'work.updated');
    expect(event?.data).toMatchObject({
      revision_id: p.current_revision_id,
      source: 'edit',
      fields: ['status', 'tags'],
    });
    expect((await s.client.works.list({ status: 'in_review' })).items.map((x) => x.id)).toEqual([
      w.id,
    ]);
    expect((await s.client.works.list({ tag: '美食' })).items.map((x) => x.id)).toEqual([w.id]);
  });

  it('a metadata-only change on a stale base is still a 409', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'T' });
    await s.client.works.patch(w.id, { base_revision: w.current_revision_id, status: 'ready' });
    const err = await apiError(
      s.client.works.patch(w.id, { base_revision: w.current_revision_id, tags: ['x'] }),
    );
    expect(err.status).toBe(409);
    expect((await s.client.works.get(w.id)).tags).toEqual([]);
  });
});
