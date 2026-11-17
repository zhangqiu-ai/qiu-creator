import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaRef, Mount, WorkMediaResponse } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { pngBytes } from './fixtures.js';
import { authHeaders, startTestServer, type StartOptions, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(extra: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({
    jobs: { pollMs: 5 },
    mounts: { stabilityMs: 300, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    ...extra,
  });
  servers.push(s);
  return s;
}

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

function bySrc(res: WorkMediaResponse, src: string): MediaRef {
  const item = res.items.find((i) => i.src === src);
  if (item === undefined) throw new Error(`no item for ${src}: ${JSON.stringify(res.items)}`);
  return item;
}

async function getSigned(s: TestServer, url: string, headers: Record<string, string> = {}) {
  return fetch(s.client.media.absoluteUrl(url), { headers });
}

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

describe('managed work media', () => {
  async function setup() {
    const s = await start();
    const outside = tempDir('creatorhub-outside-');
    write(path.join(outside, 'secret.png'), await pngBytes(4, 4));
    const markdown = [
      '# 圖文',
      '![封面](./assets/cover.png)',
      '![中文](assets/%E5%9C%96%E7%89%87.png "標題")',
      '![raw](<assets/圖片 2.png>)',
      '![ref][logo]',
      '<img src="assets/cover.png?v=2" alt="dup-ish">',
      '<p><img alt="x" src=\'assets/html.png\'></p>',
      '', // an HTML block runs until a blank line (CommonMark)
      '![](assets/missing.png)',
      '![](assets/evil.svg)',
      '![](assets/link.png)',
      '![](assets/linkdir/inner.png)',
      '![](../other-work/x.png)',
      '![](source.md)',
      '![](revisions/abc.md)',
      '![](/etc/passwd)',
      '![](file:///etc/passwd)',
      '![](https://example.com/a.png)',
      '![](data:image/png;base64,AAAA)',
      '![](assets/%E0%A4%A.png)',
      '',
      '```md',
      '![in code](assets/code-only.png)',
      '```',
      '',
      '[logo]: assets/logo.png',
    ].join('\n');
    const work = await s.client.works.create({ title: '圖文', markdown });
    const dir = path.join(s.home, 'library/works', work.id, 'assets');
    const cover = await pngBytes(64, 48, '#ff0000');
    write(path.join(dir, 'cover.png'), cover);
    write(path.join(dir, '圖片.png'), await pngBytes(8, 8));
    write(path.join(dir, '圖片 2.png'), await pngBytes(9, 9));
    write(path.join(dir, 'logo.png'), await pngBytes(10, 10));
    write(path.join(dir, 'html.png'), await pngBytes(11, 11));
    write(path.join(dir, 'code-only.png'), await pngBytes(12, 12));
    write(path.join(dir, 'evil.svg'), SVG);
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'link.png'));
    fs.symlinkSync(outside, path.join(dir, 'linkdir'));
    write(path.join(outside, 'inner.png'), await pngBytes(4, 4));
    return { s, work, cover, outside };
  }

  it('classifies every reference and resolves only safe files inside assets/', async () => {
    const { s, work } = await setup();
    const res = await s.client.works.media(work.id);
    expect(res.revision_id).toBe(work.current_revision_id);

    const resolved = (src: string, rel: string): void => {
      expect(bySrc(res, src)).toMatchObject({
        status: 'resolved',
        path: rel,
        kind: 'image',
        mime_type: 'image/png',
      });
    };
    resolved('./assets/cover.png', 'assets/cover.png');
    resolved('assets/%E5%9C%96%E7%89%87.png', 'assets/圖片.png');
    resolved('assets/圖片 2.png', 'assets/圖片 2.png');
    resolved('assets/logo.png', 'assets/logo.png'); // reference-style definition
    resolved('assets/cover.png?v=2', 'assets/cover.png');
    resolved('assets/html.png', 'assets/html.png');

    expect(bySrc(res, 'assets/missing.png')).toMatchObject({ status: 'missing', url: null });
    expect(bySrc(res, 'assets/evil.svg')).toMatchObject({ status: 'unsupported', url: null });
    for (const src of [
      'assets/link.png',
      'assets/linkdir/inner.png',
      '../other-work/x.png',
      'source.md',
      'revisions/abc.md',
      '/etc/passwd',
      'file:///etc/passwd',
      'assets/%E0%A4%A.png',
    ]) {
      expect(bySrc(res, src), src).toMatchObject({ status: 'rejected', url: null });
    }
    expect(bySrc(res, 'https://example.com/a.png').status).toBe('remote');
    expect(bySrc(res, 'data:image/png;base64,AAAA').status).toBe('inline');
    // Code blocks are not images.
    expect(res.items.some((i) => i.src.includes('code-only'))).toBe(false);
  });

  it('serves resolved files through signed URLs without a bearer token, with Range', async () => {
    const { s, work, cover } = await setup();
    const res = await s.client.works.media(work.id);
    const url = bySrc(res, './assets/cover.png').url;
    if (url === null) throw new Error('no url');
    expect(url.startsWith('/media/v1/works/')).toBe(true);
    expect(url).not.toContain('test-token');

    const full = await getSigned(s, url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('image/png');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('referrer-policy')).toBe('no-referrer');
    expect(Buffer.from(await full.arrayBuffer()).equals(cover)).toBe(true);

    const part = await getSigned(s, url, { range: 'bytes=0-7' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-7/${String(cover.length)}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(cover.subarray(0, 8))).toBe(true);

    const bad = await getSigned(s, url, { range: `bytes=${String(cover.length + 10)}-` });
    expect(bad.status).toBe(416);

    // A Chinese file name round-trips through the canonical encoding.
    const zh = bySrc(res, 'assets/%E5%9C%96%E7%89%87.png').url;
    expect((await getSigned(s, zh ?? '')).status).toBe(200);
  });

  it('refuses tampered, re-targeted, unsigned and expired URLs', async () => {
    let now = Date.now();
    const s = await start({ signedUrls: { ttlMs: 60_000, now: () => now } });
    const work = await s.client.works.create({
      title: 'x',
      markdown: '![](assets/a.png)\n![](assets/b.png)',
    });
    const dir = path.join(s.home, 'library/works', work.id, 'assets');
    write(path.join(dir, 'a.png'), await pngBytes(4, 4));
    write(path.join(dir, 'b.png'), await pngBytes(5, 5));
    const res = await s.client.works.media(work.id);
    const a = bySrc(res, 'assets/a.png').url ?? '';
    expect((await getSigned(s, a)).status).toBe(200);

    const u = new URL(a, s.baseUrl);
    const sig = u.searchParams.get('sig') ?? '';
    const tampered = new URL(u);
    tampered.searchParams.set('sig', `${sig.slice(0, -2)}AA`);
    expect((await fetch(tampered)).status).toBe(403);

    const retargeted = new URL(u);
    retargeted.pathname = retargeted.pathname.replace('a.png', 'b.png');
    expect((await fetch(retargeted)).status).toBe(403);

    const longer = new URL(u);
    longer.searchParams.set('exp', String(Number(u.searchParams.get('exp')) + 30));
    expect((await fetch(longer)).status).toBe(403);

    const otherPrincipal = new URL(u);
    otherPrincipal.searchParams.set('p', '00000000-0000-4000-8000-000000000000');
    expect((await fetch(otherPrincipal)).status).toBe(403);

    expect((await fetch(new URL(u.pathname, s.baseUrl))).status).toBe(403);

    now += 61_000;
    const expired = await fetch(u);
    expect(expired.status).toBe(403);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it("stops serving an agent's signed URLs once its token is revoked", async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'x', markdown: '![](assets/a.png)' });
    write(path.join(s.home, 'library/works', work.id, 'assets/a.png'), await pngBytes(4, 4));
    const agent = s.tokens.create({ name: 'viewer', scopes: ['read'] });
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/media`, {
      headers: { authorization: `Bearer ${agent.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkMediaResponse;
    const url = body.items[0]?.url ?? '';
    expect((await getSigned(s, url)).status).toBe(200);
    s.tokens.revoke(agent.token.id);
    expect((await getSigned(s, url)).status).toBe(403);
  });

  it('serves the same files to bearer clients and enforces the same rules', async () => {
    const { s, work, cover } = await setup();
    const base = `${s.baseUrl}/api/v1/works/${work.id}/files`;
    const ok = await fetch(`${base}/assets/cover.png`, { headers: authHeaders() });
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(cover)).toBe(true);
    expect((await fetch(`${base}/assets/cover.png`)).status).toBe(401);
    expect((await fetch(`${base}/source.md`, { headers: authHeaders() })).status).toBe(403);
    expect((await fetch(`${base}/revisions/x.md`, { headers: authHeaders() })).status).toBe(403);
    expect((await fetch(`${base}/assets/link.png`, { headers: authHeaders() })).status).toBe(403);
    expect(
      (await fetch(`${base}/assets/linkdir/inner.png`, { headers: authHeaders() })).status,
    ).toBe(403);
    expect((await fetch(`${base}/assets/evil.svg`, { headers: authHeaders() })).status).toBe(415);
    expect((await fetch(`${base}/assets/missing.png`, { headers: authHeaders() })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(`${base}/assets/..%2F..%2F..%2Fdata%2Fcreatorhub.sqlite`, {
          headers: authHeaders(),
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/assets/.%2F.%2Fcover.png`, { headers: authHeaders() })).status,
    ).toBe(403);
  });

  it('signed asset URLs stream the file and the thumbnail', async () => {
    const s = await start();
    const png = await pngBytes(300, 200);
    const up = await s.client.assets.upload({ filename: 'p.png', data: png });
    await s.jobs.drain();
    const signed = await s.client.media.signedAssetUrls({ asset_ids: [up.asset.id] });
    const stream = await getSigned(s, signed.items[0]?.url ?? '');
    expect(stream.status).toBe(200);
    expect(Buffer.from(await stream.arrayBuffer()).equals(png)).toBe(true);
    const thumbs = await s.client.media.signedAssetUrls({
      asset_ids: [up.asset.id],
      variant: 'thumbnail',
    });
    const thumb = await getSigned(s, thumbs.items[0]?.url ?? '');
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    // A stream signature does not open the thumbnail route, and vice versa.
    const swapped = (signed.items[0]?.url ?? '').replace('/stream?', '/thumbnail?');
    expect((await getSigned(s, swapped)).status).toBe(403);
  });
});

describe('external work media', () => {
  async function mounted() {
    const s = await start();
    const outside = tempDir('creatorhub-outside-');
    write(path.join(outside, 'secret.png'), await pngBytes(4, 4));
    const root = tempDir('creatorhub-mount-');
    const cover = await pngBytes(40, 30, '#00aa00');
    write(path.join(root, 'images/cover.png'), cover);
    write(path.join(root, 'notes/pic.png'), await pngBytes(20, 20));
    write(path.join(root, 'notes/bad.svg'), SVG);
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'notes/link.png'));
    write(
      path.join(root, 'notes/post.md'),
      [
        '# 外部筆記',
        '![](../images/cover.png)',
        '![](./pic.png)',
        '![](pic.png)',
        '![](bad.svg)',
        '![](link.png)',
        '![](../../outside.png)',
        `![](${path.join(outside, 'secret.png')})`,
      ].join('\n'),
    );
    const before = fingerprint(root);
    const mount: Mount = await s.client.mounts.create({ path: root });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const work = (await s.client.works.list()).items.find(
      (w) => w.external_path === 'notes/post.md',
    );
    if (work === undefined) throw new Error('not indexed');
    return { s, root, mount, work, cover, before };
  }

  it('resolves relative to the note, stays inside the mount, never follows symlinks', async () => {
    const { s, work, mount } = await mounted();
    const res = await s.client.works.media(work.id);
    expect(bySrc(res, '../images/cover.png')).toMatchObject({
      status: 'resolved',
      path: 'images/cover.png',
    });
    expect(bySrc(res, './pic.png')).toMatchObject({ status: 'resolved', path: 'notes/pic.png' });
    expect(bySrc(res, 'pic.png').path).toBe('notes/pic.png');
    expect(bySrc(res, 'bad.svg').status).toBe('unsupported');
    expect(bySrc(res, 'link.png').status).toBe('rejected');
    expect(bySrc(res, '../../outside.png').status).toBe('rejected');
    expect(res.items.find((i) => i.src.endsWith('secret.png'))?.status).toBe('rejected');
    expect(mount.id).toBeTruthy();
  });

  it('registers referenced files as in-place assets linked to the work, without moving anything', async () => {
    const { s, root, mount, work, cover, before } = await mounted();
    const res = await s.client.works.media(work.id);
    const coverRef = bySrc(res, '../images/cover.png');
    const picRef = bySrc(res, './pic.png');
    expect(coverRef.asset_id).not.toBeNull();
    expect(bySrc(res, 'pic.png').asset_id).toBe(picRef.asset_id);

    const asset = await s.client.assets.get(coverRef.asset_id ?? '');
    expect(asset).toMatchObject({
      origin: 'folder',
      mount_id: mount.id,
      path: 'images/cover.png',
      bytes: cover.length,
      sha256: createHash('sha256').update(cover).digest('hex'),
    });
    const links = await s.client.workAssets.list(work.id);
    expect(links.items.map((l) => [l.role, l.asset.id])).toEqual([
      ['body', coverRef.asset_id],
      ['body', picRef.asset_id],
    ]);

    // Idempotent: a second resolve creates no new assets, links or events.
    const assetEvents = () => s.feed.since(0).filter((e) => e.action === 'asset.created').length;
    const linkEvents = () =>
      s.feed.since(0).filter((e) => e.action === 'work.assets_changed').length;
    const counts = [assetEvents(), linkEvents()];
    const again = await s.client.works.media(work.id);
    expect(bySrc(again, '../images/cover.png').asset_id).toBe(coverRef.asset_id);
    expect([assetEvents(), linkEvents()]).toEqual(counts);

    // Thumbnails are built from the file in place; the mount is never modified.
    await s.jobs.drain();
    expect((await s.client.assets.get(coverRef.asset_id ?? '')).thumbnail_status).toBe('ready');
    expect(fingerprint(root)).toEqual(before);

    // Streams through the regular asset route and signed URLs.
    const stream = await fetch(`${s.baseUrl}/api/v1/assets/${coverRef.asset_id ?? ''}/stream`, {
      headers: authHeaders(),
    });
    expect(Buffer.from(await stream.arrayBuffer()).equals(cover)).toBe(true);
    const signed = await getSigned(s, coverRef.url ?? '');
    expect(Buffer.from(await signed.arrayBuffer()).equals(cover)).toBe(true);
  });

  it('re-hashes a changed file and never dedupes uploads onto an external asset', async () => {
    const { s, root, work } = await mounted();
    const first = bySrc(await s.client.works.media(work.id), '../images/cover.png');
    const replacement = await pngBytes(41, 31, '#0000aa');
    fs.writeFileSync(path.join(root, 'images/cover.png'), replacement);
    fs.utimesSync(path.join(root, 'images/cover.png'), new Date(), new Date(Date.now() + 5000));
    const second = bySrc(await s.client.works.media(work.id), '../images/cover.png');
    expect(second.asset_id).toBe(first.asset_id);
    const asset = await s.client.assets.get(second.asset_id ?? '');
    expect(asset.sha256).toBe(createHash('sha256').update(replacement).digest('hex'));

    const up = await s.client.assets.upload({ filename: 'same.png', data: replacement });
    expect(up.deduplicated).toBe(false);
    expect(up.asset.id).not.toBe(asset.id);
    expect(up.asset.mount_id ?? null).toBeNull();
  });

  it('reports files as missing when the mount is removed, and stops serving them', async () => {
    const { s, mount, work } = await mounted();
    const res = await s.client.works.media(work.id);
    const ref = bySrc(res, '../images/cover.png');
    await s.client.mounts.remove(mount.id);
    const after = await s.client.works.media(work.id);
    expect(bySrc(after, '../images/cover.png')).toMatchObject({ status: 'missing', url: null });
    expect((await getSigned(s, ref.url ?? '')).status).toBe(404);
    const stream = await fetch(`${s.baseUrl}/api/v1/assets/${ref.asset_id ?? ''}/stream`, {
      headers: authHeaders(),
    });
    expect(stream.status).toBe(404);
  });

  it('refuses a file swapped for a symlink after it was registered', async () => {
    const { s, root, work } = await mounted();
    const ref = bySrc(await s.client.works.media(work.id), './pic.png');
    const outside = tempDir('creatorhub-outside-');
    write(path.join(outside, 'x.png'), await pngBytes(3, 3));
    fs.rmSync(path.join(root, 'notes/pic.png'));
    fs.symlinkSync(path.join(outside, 'x.png'), path.join(root, 'notes/pic.png'));
    expect((await getSigned(s, ref.url ?? '')).status).toBe(403);
    const stream = await fetch(`${s.baseUrl}/api/v1/assets/${ref.asset_id ?? ''}/stream`, {
      headers: authHeaders(),
    });
    expect(stream.status).toBe(403);
  });
});
