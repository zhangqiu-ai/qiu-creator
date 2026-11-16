import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import type { ChangeEvent, Mount } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type StartOptions, type TestServer } from './helpers.js';

const STABILITY_MS = 300;
const servers: TestServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(extra: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({
    jobs: { pollMs: 5 },
    // Polling: deterministic under parallel test load (FSEvents was seen arriving 12 s late).
    mounts: { stabilityMs: STABILITY_MS, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    ...extra,
  });
  servers.push(s);
  return s;
}

/** A throwaway "user folder" outside the CreatorHub home. */
function folder(files: Record<string, string> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mount-')));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** sha256 of every file under dir (incl. hidden), to prove a mount never changes the folder. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs}ms; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function mountAndScan(s: TestServer, dir: string): Promise<Mount> {
  const mount = await s.client.mounts.create({ path: dir });
  await s.jobs.drain();
  await s.mounts.ready(mount.id);
  return s.client.mounts.get(mount.id);
}

const byPath = async (s: TestServer, rel: string) =>
  (await s.client.works.list({ limit: 200 })).items.find((w) => w.external_path === rel);
const events = (s: TestServer, action: string, workId?: string): ChangeEvent[] =>
  s.feed
    .since(0)
    .filter((e) => e.action === action && (workId === undefined || e.entity_id === workId));

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('mount validation', () => {
  it('rejects relative, missing, file, root, home-folder and CreatorHub paths', async () => {
    const s = await start();
    const file = path.join(folder({ 'x.md': 'x' }), 'x.md');
    const inside = path.join(s.home, 'library');
    const linkToHome = path.join(folder(), 'link');
    fs.symlinkSync(s.home, linkToHome);
    const outside = folder();
    const traversal = path.join(outside, '..', path.basename(s.home)); // ".." that lands on the home

    for (const p of [
      'relative/notes',
      '/definitely/not/here',
      file,
      '/',
      os.homedir(),
      s.home,
      inside,
      path.dirname(s.home), // contains the CreatorHub home
      linkToHome, // symlink into the home
      traversal,
    ]) {
      const err = await apiError(s.client.mounts.create({ path: p }));
      expect(err.status, p).toBe(400);
      expect(err.code, p).toMatch(/mount_rejected|validation_error/);
    }
    expect((await s.client.mounts.list()).items).toEqual([]);
  });

  it('rejects overlapping mounts and double mounts', async () => {
    const s = await start();
    const dir = folder({ 'sub/a.md': '# a' });
    await s.client.mounts.create({ path: dir });
    expect((await apiError(s.client.mounts.create({ path: path.join(dir, 'sub') }))).status).toBe(
      400,
    );
    expect((await apiError(s.client.mounts.create({ path: dir }))).status).toBe(409);
  });

  it('is owner-only to manage; read tokens can list', async () => {
    const s = await start();
    const importer = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: 'i', scopes: ['import', 'write'] })).secret,
    });
    const reader = createClient({
      baseUrl: s.baseUrl,
      token: (await s.client.tokens.create({ name: 'r', scopes: ['read'] })).secret,
    });
    expect((await apiError(importer.mounts.create({ path: folder() }))).status).toBe(403);
    expect((await reader.mounts.list()).items).toEqual([]);
  });
});

describe('scanning', () => {
  it('indexes Markdown in place and never changes the folder', async () => {
    const s = await start();
    const outsideSecret = folder({ 'secret.md': '# secret outside the mount' });
    const dir = folder({
      'a.md': '# 第一篇\n\n內容',
      'sub/deep/b.markdown': 'no heading here',
      '.hidden.md': '# hidden',
      '.obsidian/workspace.md': '# config',
      'node_modules/pkg/readme.md': '# dep',
      'notes.txt': 'not markdown',
    });
    fs.symlinkSync(path.join(outsideSecret, 'secret.md'), path.join(dir, 'link.md'));
    fs.symlinkSync(outsideSecret, path.join(dir, 'linked-dir'));
    const before = fingerprint(dir);

    const mount = await mountAndScan(s, dir);
    expect(mount).toMatchObject({ status: 'active', root_path: dir, work_count: 2 });
    expect(mount.last_scan_at).not.toBeNull();

    const items = (await s.client.works.list()).items;
    expect(
      items.map((w) => [w.external_path, w.title, w.storage_mode, w.external_state]).sort(),
    ).toEqual([
      ['a.md', '第一篇', 'external', 'present'],
      [path.join('sub', 'deep', 'b.markdown'), 'b', 'external', 'present'],
    ]);
    const a = await byPath(s, 'a.md');
    expect((await s.client.works.get(a?.id ?? '')).markdown).toBe('# 第一篇\n\n內容');
    expect((await s.client.works.list({ q: '第一篇' })).total).toBe(1);
    expect(fingerprint(dir)).toEqual(before);
    // Snapshots live in the CreatorHub library, not in the user folder.
    expect(
      fs.readdirSync(path.join(s.home, 'library', 'works', a?.id ?? '', 'revisions')),
    ).toHaveLength(1);
  });

  it('rescan is idempotent and catches changes made while the server was down', async () => {
    const dir = folder({ 'a.md': 'v1' });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-test-'));
    dirs.push(home);
    const first = await start({ home });
    const mount = await mountAndScan(first, dir);
    await first.client.mounts.rescan(mount.id);
    await first.jobs.drain();
    expect((await first.client.works.list()).total).toBe(1);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    fs.writeFileSync(path.join(dir, 'a.md'), 'v2 written while CreatorHub was off');
    fs.writeFileSync(path.join(dir, 'new.md'), '# new');
    const second = await start({ home });
    await second.jobs.drain();
    const a = await byPath(second, 'a.md');
    expect((await second.client.works.revisions(a?.id ?? '')).items.map((r) => r.source)).toEqual([
      'external',
      'create',
    ]);
    expect(await byPath(second, 'new.md')).toBeDefined();
  });
});

describe('watching', () => {
  it('indexes a new file only after it stops changing (half-written files never enter)', async () => {
    const s = await start();
    const dir = folder();
    await mountAndScan(s, dir);
    const file = path.join(dir, 'draft.md');

    fs.writeFileSync(file, '# 草稿\n\n第一段');
    await new Promise((r) => setTimeout(r, STABILITY_MS / 3));
    fs.appendFileSync(file, '\n\n第二段');
    await new Promise((r) => setTimeout(r, STABILITY_MS / 3));
    expect(await byPath(s, 'draft.md')).toBeUndefined(); // still being written
    fs.appendFileSync(file, '\n\n完。');

    const work = await waitFor(
      () => byPath(s, 'draft.md'),
      (w) => w !== undefined,
    );
    expect((await s.client.works.get(work?.id ?? '')).markdown).toBe(
      '# 草稿\n\n第一段\n\n第二段\n\n完。',
    );
    expect((await s.client.works.revisions(work?.id ?? '')).items).toHaveLength(1);
  });

  it('records outside edits as external revisions and emits an event', async () => {
    const s = await start();
    const dir = folder({ 'a.md': 'v1' });
    await mountAndScan(s, dir);
    const a = await byPath(s, 'a.md');
    fs.writeFileSync(path.join(dir, 'a.md'), 'edited in Typora');
    await waitFor(
      () => events(s, 'work.external_revision', a?.id),
      (e) => e.length === 1,
    );
    expect((await s.client.works.get(a?.id ?? '')).markdown).toBe('edited in Typora');
  });

  it("does not echo the app's own write-back as an external revision", async () => {
    const s = await start();
    const dir = folder({ 'a.md': 'v1' });
    const file = path.join(dir, 'a.md');
    fs.chmodSync(file, 0o600);
    await mountAndScan(s, dir);
    const a = await byPath(s, 'a.md');

    const saved = await s.client.works.patch(a?.id ?? '', {
      base_revision: a?.current_revision_id,
      markdown: 'v2 from the app',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('v2 from the app');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600); // permissions kept
    expect(fs.readdirSync(dir)).toEqual(['a.md']); // no temp files left behind

    await new Promise((r) => setTimeout(r, STABILITY_MS * 3));
    expect(events(s, 'work.external_revision', a?.id)).toEqual([]);
    const revs = (await s.client.works.revisions(a?.id ?? '')).items;
    expect(revs.map((r) => r.source)).toEqual(['edit', 'create']);
    expect(revs[0]?.revision_id).toBe(saved.current_revision_id);
  });

  it('refuses a stale write-back after an outside edit (409, file untouched)', async () => {
    const s = await start();
    const dir = folder({ 'a.md': 'v1' });
    await mountAndScan(s, dir);
    const a = await byPath(s, 'a.md');
    fs.writeFileSync(path.join(dir, 'a.md'), 'outside edit');
    const err = await apiError(
      s.client.works.patch(a?.id ?? '', {
        base_revision: a?.current_revision_id,
        markdown: 'app edit',
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('revision_conflict');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('outside edit');
  });

  it('marks a deleted file missing, keeps history, refuses writes, and restores when it returns', async () => {
    const s = await start();
    const dir = folder({ 'a.md': '# keep me' });
    await mountAndScan(s, dir);
    const a = await byPath(s, 'a.md');
    const id = a?.id ?? '';
    fs.rmSync(path.join(dir, 'a.md'));

    await waitFor(
      () => events(s, 'work.source_missing', id),
      (e) => e.length === 1,
    );
    const missing = await s.client.works.get(id);
    expect(missing).toMatchObject({ external_state: 'missing', markdown: '# keep me' });
    expect((await s.client.works.revisions(id)).items).toHaveLength(1);
    const err = await apiError(
      s.client.works.patch(id, { base_revision: missing.current_revision_id, markdown: 'x' }),
    );
    expect(err).toMatchObject({ status: 409, code: 'source_missing' });
    expect(fs.existsSync(path.join(dir, 'a.md'))).toBe(false); // nothing recreated

    fs.writeFileSync(path.join(dir, 'a.md'), '# keep me');
    await waitFor(
      () => events(s, 'work.source_restored', id),
      (e) => e.length === 1,
    );
    expect((await s.client.works.get(id)).external_state).toBe('present');
  });

  it('follows a rename as the same work (no duplicate)', async () => {
    const s = await start();
    const dir = folder({ 'old-name.md': '# 改名測試\n\n內容不變' });
    await mountAndScan(s, dir);
    const before = await byPath(s, 'old-name.md');
    fs.renameSync(path.join(dir, 'old-name.md'), path.join(dir, 'new-name.md'));

    const after = await waitFor(
      () => byPath(s, 'new-name.md'),
      (w) => w !== undefined,
    );
    expect(after?.id).toBe(before?.id);
    expect(after?.external_state).toBe('present');
    expect((await s.client.works.list()).total).toBe(1);
    expect(events(s, 'work.source_restored', before?.id).at(-1)?.data).toMatchObject({
      from: 'old-name.md',
      to: 'new-name.md',
      reason: 'moved',
    });
  });

  it('never follows a symlink swapped in for an indexed file', async () => {
    const s = await start();
    const secret = folder({ 'secret.md': 'TOP SECRET' });
    const dir = folder({ 'a.md': 'v1' });
    await mountAndScan(s, dir);
    const a = await byPath(s, 'a.md');
    fs.rmSync(path.join(dir, 'a.md'));
    fs.symlinkSync(path.join(secret, 'secret.md'), path.join(dir, 'a.md'));
    await s.client.mounts.rescan(a?.mount_id ?? '');
    await s.jobs.drain();

    const work = await s.client.works.get(a?.id ?? '');
    expect(work.external_state).toBe('missing');
    expect(work.markdown).toBe('v1');
    expect(JSON.stringify(await s.client.works.list({ q: 'SECRET' }))).not.toContain('TOP SECRET');
  });
});

describe('unmount and remount', () => {
  it('keeps works as "unmounted", leaves files alone, and reconnects on remount', async () => {
    const s = await start();
    const dir = folder({ 'a.md': '# a', 'b.md': '# b' });
    const before = fingerprint(dir);
    const mount = await mountAndScan(s, dir);

    const removed = await s.client.mounts.remove(mount.id);
    expect(removed.status).toBe('removed');
    expect((await s.client.works.list()).items.map((w) => w.external_state)).toEqual([
      'unmounted',
      'unmounted',
    ]);
    expect(fingerprint(dir)).toEqual(before);
    fs.writeFileSync(path.join(dir, 'a.md'), '# a, edited while unmounted');
    await new Promise((r) => setTimeout(r, STABILITY_MS * 2));
    expect(events(s, 'work.external_revision')).toEqual([]); // not watched any more

    const again = await mountAndScan(s, dir);
    expect(again.id).toBe(mount.id);
    const items = (await s.client.works.list()).items;
    expect(items.map((w) => w.external_state)).toEqual(['present', 'present']);
    const a = items.find((w) => w.external_path === 'a.md');
    expect((await s.client.works.get(a?.id ?? '')).markdown).toBe('# a, edited while unmounted');
  });
});
