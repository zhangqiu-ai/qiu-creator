import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAddress, isBlockedAddress } from '../src/net/ip-policy.js';
import { DownloadError, safeDownload } from '../src/net/safe-download.js';
import { pngBytes } from './fixtures.js';
import { makeTempHome } from './helpers.js';
import {
  PUBLIC_IP,
  PUBLIC_IP_2,
  redirect,
  serve,
  startUpstream,
  v4,
  type Upstream,
} from './upstream.js';

describe('ip policy', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '100.100.100.100', // Tailscale MagicDNS
    '100.127.255.255',
    '192.0.2.10',
    '198.18.0.1',
    '224.0.0.251', // multicast
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '0:0:0:0:0:ffff:192.168.0.1',
    'fe80::1',
    'fe80::1%en0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    '2001::1', // Teredo
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '100.63.255.255',
    '100.128.0.1',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('reports the unmapped IPv4 address it checked', () => {
    expect(checkAddress('::ffff:8.8.8.8')).toEqual({ allowed: true, address: '8.8.8.8' });
  });
});

describe('safeDownload', () => {
  let up: Upstream;
  let dir: string;
  let n = 0;
  beforeEach(async () => {
    up = await startUpstream();
    dir = makeTempHome();
  });
  afterEach(async () => {
    await up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dest = (): string => path.join(dir, `f${++n}`);

  async function fails(url: string, extra = {}): Promise<DownloadError> {
    const target = dest();
    const err: unknown = await safeDownload(url, target, {
      ...up.download(extra),
      maxBytes: 1024 * 1024,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(fs.existsSync(target)).toBe(false);
    return err as DownloadError;
  }

  it('downloads from a public host through the pinned address', async () => {
    const png = await pngBytes(10, 10);
    up.routes.set(
      '/a.png',
      serve(png, 'image/png', {
        'content-disposition': "attachment; filename*=UTF-8''%E5%B0%81%E9%9D%A2.png",
      }),
    );
    const target = dest();
    const result = await safeDownload('http://cdn.example.com/a.png', target, {
      ...up.download(),
      maxBytes: 1e6,
    });
    expect(fs.readFileSync(target).equals(png)).toBe(true);
    expect(result).toMatchObject({
      bytes: png.length,
      contentType: 'image/png',
      suggestedName: '封面.png',
    });
    expect(up.connects).toEqual([PUBLIC_IP]);
  });

  it.each([
    ['http://127.0.0.1/x', 'blocked_address'],
    ['http://[::1]/x', 'blocked_address'],
    ['http://[::ffff:127.0.0.1]/x', 'blocked_address'],
    ['http://169.254.169.254/latest/meta-data', 'blocked_address'],
    ['http://100.100.100.100/x', 'blocked_address'],
    ['http://10.0.0.1/x', 'blocked_address'],
    ['http://0.0.0.0/x', 'blocked_address'],
    ['http://localhost/x', 'blocked_address'],
    ['http://foo.localhost/x', 'blocked_address'],
    ['ftp://cdn.example.com/x', 'url_rejected'],
    ['file:///etc/passwd', 'url_rejected'],
    ['http://user:pass@cdn.example.com/x', 'url_rejected'],
    ['not a url', 'url_rejected'],
  ])('rejects %s before connecting (%s)', async (url, code) => {
    const err = await fails(url);
    expect(err.code).toBe(code);
    expect(up.connects).toEqual([]);
  });

  it('rejects a name that resolves to a private address', async () => {
    const err = await fails('http://internal.example.com/x');
    expect(err.code).toBe('blocked_address');
    expect(up.connects).toEqual([]);
  });

  it('rejects when any resolved address is private, even if another is public', async () => {
    up.dns.set('mixed.example.com', [v4(PUBLIC_IP), v4('192.168.0.10')]);
    expect((await fails('http://mixed.example.com/x')).code).toBe('blocked_address');
  });

  it('defeats DNS rebinding: resolves once per hop and connects to the checked address', async () => {
    // First answer is public, every later answer points at loopback.
    up.dns.set('rebind.example.com', (call) => [v4(call === 1 ? PUBLIC_IP : '127.0.0.1')]);
    up.routes.set('/v.png', serve(await pngBytes(5, 5), 'image/png'));
    await safeDownload('http://rebind.example.com/v.png', dest(), {
      ...up.download(),
      maxBytes: 1e6,
    });
    expect(up.lookups).toEqual(['rebind.example.com']);
    expect(up.connects).toEqual([PUBLIC_IP]);

    // A later hop to the same name re-resolves, gets loopback, and is blocked.
    up.routes.set('/hop', redirect('http://rebind.example.com/v.png'));
    up.dns.set('start.example.com', [v4(PUBLIC_IP_2)]);
    const err = await fails('http://start.example.com/hop');
    expect(err.code).toBe('blocked_address');
  });

  it('re-checks every redirect: to a loopback literal, to a private name', async () => {
    up.routes.set('/to-loopback', redirect('http://127.0.0.1:7420/api/v1/works'));
    up.routes.set('/to-internal', redirect('http://internal.example.com/secret'));
    up.routes.set('/to-metadata', redirect('http://[::ffff:169.254.169.254]/'));
    for (const p of ['/to-loopback', '/to-internal', '/to-metadata']) {
      expect((await fails(`http://cdn.example.com${p}`)).code).toBe('blocked_address');
    }
    expect(up.connects.every((a) => a === PUBLIC_IP)).toBe(true);
  });

  it('follows public redirects up to the limit', async () => {
    const png = await pngBytes(5, 5);
    up.routes.set('/final.png', serve(png, 'image/png'));
    up.routes.set('/r1', redirect('http://other.example.net/r2', 301));
    up.routes.set('/r2', redirect('/final.png', 307));
    const res = await safeDownload('http://cdn.example.com/r1', dest(), {
      ...up.download(),
      maxBytes: 1e6,
    });
    expect(res.finalUrl).toBe('http://other.example.net/final.png');
    expect(up.connects).toEqual([PUBLIC_IP, PUBLIC_IP_2, PUBLIC_IP_2]);

    up.routes.set('/loop', redirect('/loop'));
    expect((await fails('http://cdn.example.com/loop')).code).toBe('too_many_redirects');
  });

  it('enforces the size limit from Content-Length and while streaming', async () => {
    up.routes.set('/declared', serve(Buffer.alloc(2 * 1024 * 1024), 'video/mp4'));
    expect((await fails('http://cdn.example.com/declared')).code).toBe('payload_too_large');

    up.routes.set('/chunked', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' }); // no Content-Length
      for (let i = 0; i < 40; i++) res.write(Buffer.alloc(64 * 1024));
      res.end();
    });
    expect((await fails('http://cdn.example.com/chunked')).code).toBe('payload_too_large');
  });

  it('rejects disallowed content types', async () => {
    up.routes.set('/page', serve(Buffer.from('<html></html>'), 'text/html; charset=utf-8'));
    up.routes.set('/api', serve(Buffer.from('{}'), 'application/json'));
    expect((await fails('http://cdn.example.com/page')).code).toBe('unsupported_content_type');
    expect((await fails('http://cdn.example.com/api')).code).toBe('unsupported_content_type');
  });

  it('times out when the server stalls (idle) or trickles past the total deadline', async () => {
    up.routes.set('/stall', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write(Buffer.alloc(10));
    });
    const idle = await fails('http://cdn.example.com/stall', { idleTimeoutMs: 200 });
    expect(idle).toMatchObject({ code: 'timeout', retryable: true });

    up.routes.set('/trickle', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      const t = setInterval(() => res.write(Buffer.alloc(1)), 50);
      res.on('close', () => {
        clearInterval(t);
      });
    });
    const totalErr = await fails('http://cdn.example.com/trickle', {
      idleTimeoutMs: 1000,
      totalTimeoutMs: 400,
    });
    expect(totalErr).toMatchObject({ code: 'timeout' });
  });

  it('classifies HTTP errors as permanent (4xx) or retryable (5xx, 429)', async () => {
    up.routes.set('/busy', (_req, res) => {
      res.writeHead(503);
      res.end();
    });
    up.routes.set('/slow-down', (_req, res) => {
      res.writeHead(429);
      res.end();
    });
    expect(await fails('http://cdn.example.com/missing')).toMatchObject({
      code: 'http_error',
      retryable: false,
    });
    expect(await fails('http://cdn.example.com/busy')).toMatchObject({
      code: 'http_error',
      retryable: true,
    });
    expect(await fails('http://cdn.example.com/slow-down')).toMatchObject({
      code: 'http_error',
      retryable: true,
    });
  });

  it('reports unresolvable names as retryable network errors', async () => {
    expect(await fails('http://nowhere.example.org/x')).toMatchObject({
      code: 'network_error',
      retryable: true,
    });
  });
});
