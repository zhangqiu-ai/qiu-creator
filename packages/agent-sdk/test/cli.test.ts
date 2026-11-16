import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

const TOKEN = 'cli-test-token-0123456789';
let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let upstream: http.Server;

// A PNG signature plus padding: enough for magic-byte detection.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
  Buffer.alloc(64),
]);

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-cli-'));
  // Local stand-in for a public file host; never the real internet.
  upstream = http.createServer((req, res) => {
    if (req.url === '/pic.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  server = await buildServer({
    config: { home, token: TOKEN },
    ffprobe: null,
    jobs: { pollMs: 5 },
    download: {
      resolver: (host) =>
        host === 'files.example.com'
          ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
          : Promise.reject(new Error('ENOTFOUND')),
      connectOverride: () => ({ host: '127.0.0.1', port: upstreamPort }),
    },
  });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await server.app.close();
  await new Promise<void>((r) => {
    upstream.close(() => {
      r();
    });
  });
  fs.rmSync(home, { recursive: true, force: true });
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { CREATORHUB_URL: baseUrl, CREATORHUB_TOKEN: TOKEN, ...env },
  });
  return { code, stdout, stderr };
}

describe('creatorhub CLI', () => {
  it('creates a work from a Markdown file and lists it', async () => {
    const md = path.join(home, 'note.md');
    fs.writeFileSync(md, '# 來自 Agent\n\n內容\n');

    const created = await run([
      'works',
      'create',
      '--title',
      'Agent 匯入',
      '--file',
      md,
      '--tags',
      'ai,草稿',
    ]);
    expect(created).toMatchObject({ code: 0, stderr: '' });
    const id = /^created ([0-9a-f-]{36}) /.exec(created.stdout)?.[1];
    expect(id).toBeDefined();

    const onDisk = path.join(home, 'library', 'works', id ?? '', 'source.md');
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('# 來自 Agent\n\n內容\n');

    const listed = await run(['--json', 'works', 'list']);
    expect(listed.code).toBe(0);
    const page = JSON.parse(listed.stdout) as {
      total: number;
      items: { title: string; source: string; tags: string[] }[];
    };
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      title: 'Agent 匯入',
      source: 'cli',
      tags: ['ai', '草稿'],
    });
  });

  it('imports a URL, waits for the job, and shows it with jobs get', async () => {
    const res = await run([
      'import',
      'url',
      'http://files.example.com/pic.png',
      '--wait',
      '--idempotency-key',
      'cli-import-0001',
    ]);
    expect(res).toMatchObject({ code: 0, stderr: '' });
    const match = /^job ([0-9a-f-]{36}) succeeded asset ([0-9a-f-]{36})\n$/.exec(res.stdout);
    expect(match).not.toBeNull();

    const shown = await run(['--json', 'jobs', 'get', match?.[1] ?? '']);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      status: 'succeeded',
      url: 'http://files.example.com/pic.png',
      result_asset_id: match?.[2],
      idempotency_key: 'cli-import-0001',
    });

    // Same key again: the original job comes back, nothing is downloaded twice.
    const again = await run([
      'import',
      'url',
      'http://files.example.com/pic.png',
      '--idempotency-key',
      'cli-import-0001',
    ]);
    expect(again.stdout).toContain(match?.[1] ?? 'x');
  });

  it('exits non-zero when a waited import fails', async () => {
    const res = await run(['import', 'url', 'http://files.example.com/missing.png', '--wait']);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/failed .*http_error/);
  });

  it('fails clearly without a token', async () => {
    const res = await run(['works', 'list'], { CREATORHUB_TOKEN: '' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('token is required');
  });

  it('reports server errors with status and code', async () => {
    const res = await run(['works', 'list'], { CREATORHUB_TOKEN: 'wrong-token-xxxxxxxx' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('401 unauthorized');
  });
});
