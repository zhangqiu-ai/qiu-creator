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

  it('mounts, lists and unmounts an external folder without touching it', async () => {
    const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-cli-notes-')));
    try {
      fs.writeFileSync(path.join(notes, 'idea.md'), '# 點子\n');
      const added = await run(['mounts', 'add', notes, '--name', '筆記']);
      expect(added.code).toBe(0);
      const id = /^mounted ([0-9a-f-]{36}) /.exec(added.stdout)?.[1] ?? '';
      await server.jobs.drain();

      const listed = await run(['mounts', 'list']);
      expect(listed.stdout).toContain(`${id}\tactive\t1 works\t${notes}`);
      const removed = await run(['mounts', 'remove', id]);
      expect(removed.stdout).toContain('1 works kept as "unmounted"');
      expect(fs.readFileSync(path.join(notes, 'idea.md'), 'utf8')).toBe('# 點子\n');
    } finally {
      fs.rmSync(notes, { recursive: true, force: true });
    }
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

describe('creatorhub CLI: 回收站 and batch (QC-053)', () => {
  /** An agent token with only what these commands need. */
  function writer(): NodeJS.ProcessEnv {
    return {
      CREATORHUB_TOKEN: server.tokens.create({ name: 'cli-writer', scopes: ['read', 'write'] })
        .secret,
    };
  }

  function create(title: string, tags: string[] = []) {
    return server.works.create({ title, markdown: `# ${title}\n`, tags });
  }

  it('deletes and restores a work with a write token; the revision is required or explicit', async () => {
    const env = writer();
    const w = create('要刪的');

    const missing = await run(['works', 'delete', w.id], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('--base-revision');

    const deleted = await run(
      ['works', 'delete', w.id, '--base-revision', w.current_revision_id],
      env,
    );
    expect(deleted).toMatchObject({ code: 0, stderr: '' });
    expect(deleted.stdout).toMatch(new RegExp(`^deleted ${w.id} \\(trashed\\) until `));

    const trash = await run(['--json', 'works', 'list', '--trash'], env);
    expect(
      (JSON.parse(trash.stdout) as { items: { id: string }[] }).items.map((i) => i.id),
    ).toEqual([w.id]);

    const restored = await run(['works', 'restore', w.id, '--use-current-revision'], env);
    expect(restored).toMatchObject({
      code: 0,
      stdout: `restored ${w.id} revision ${w.current_revision_id}\n`,
    });
    expect(server.works.get(w.id).deleted_at).toBeNull();
  });

  it('runs batch actions item by item and exits 1 when any item failed', async () => {
    const env = writer();
    const a = create('A');
    const b = create('B', ['舊']);
    const stale = create('C');
    server.works.patch(stale.id, { baseRevision: stale.current_revision_id, title: 'C2' });

    const tagged = await run(
      [
        'works',
        'batch',
        'add-tags',
        a.id,
        `${b.id}:${b.current_revision_id}`,
        '--tags',
        '新',
        '--use-current-revision',
      ],
      env,
    );
    expect(tagged.code).toBe(0);
    expect(tagged.stdout).toContain('2 succeeded, 0 failed');
    expect(server.works.get(b.id).tags).toEqual(['舊', '新']);

    const mixed = await run(
      [
        'works',
        'batch',
        'set-status',
        `${stale.id}:${stale.current_revision_id}`,
        '--status',
        'ready',
        '--use-current-revision',
        a.id,
      ],
      env,
    );
    expect(mixed.code).toBe(1);
    expect(mixed.stdout).toMatch(new RegExp(`failed\\t${stale.id}\\trevision_conflict\\t`));
    expect(mixed.stdout).toMatch(new RegExp(`ok\\t${a.id}\\t`));
    expect(mixed.stdout).toContain('1 succeeded, 1 failed');
    expect(server.works.get(a.id).status).toBe('ready');

    const json = await run(
      ['--json', 'works', 'batch', 'trash', a.id, '--use-current-revision'],
      env,
    );
    expect(JSON.parse(json.stdout)).toMatchObject({ succeeded: 1, failed: 0 });
    expect(server.works.get(a.id).deleted_at).not.toBeNull();
  });

  it('rejects bad items and actions before sending anything, and offers no permanent deletion', async () => {
    const env = writer();
    expect((await run(['works', 'batch', 'trash', 'not-an-id'], env)).code).toBe(1);
    expect((await run(['works', 'batch', 'purge', create('x').id], env)).code).toBe(1);
    expect(
      (await run(['works', 'batch', 'add-tags', create('y').id, '--use-current-revision'], env))
        .stderr,
    ).toContain('--tags');
    const help = await run(['works', '--help'], env);
    expect(help.stdout).not.toMatch(/\bpurge\b|empty-trash/);
    expect(help.stdout).toContain('delete');
  });

  it('read-only tokens cannot delete', async () => {
    const w = create('只讀');
    const reader = server.tokens.create({ name: 'cli-reader', scopes: ['read'] }).secret;
    const res = await run(['works', 'delete', w.id, '--base-revision', w.current_revision_id], {
      CREATORHUB_TOKEN: reader,
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('403');
    expect(server.works.get(w.id).deleted_at).toBeNull();
  });
});

describe('creatorhub CLI: projects (QC-062)', () => {
  function token(scopes: ('read' | 'write')[]): NodeJS.ProcessEnv {
    return {
      CREATORHUB_TOKEN: server.tokens.create({ name: `cli-${scopes.join('-')}`, scopes }).secret,
    };
  }

  it('creates and lists projects, and adds and removes works with a write token', async () => {
    const env = token(['read', 'write']);
    const created = await run(['projects', 'create', '--name', '京都', '--color', '3'], env);
    expect(created.code).toBe(0);
    const projectId = /^created project ([0-9a-f-]{36}) 京都\n$/.exec(created.stdout)?.[1] ?? '';
    expect(projectId).not.toBe('');
    const a = server.works.create({ title: 'A', markdown: '# A\n' });
    const b = server.works.create({ title: 'B', markdown: '# B\n' });

    const added = await run(['projects', 'add', projectId, a.id, b.id], env);
    expect(added).toMatchObject({ code: 0, stderr: '' });
    expect(added.stdout).toContain('2 succeeded, 0 failed');
    expect(server.works.get(a.id).project_ids).toEqual([projectId]);

    const listed = await run(['projects', 'list'], env);
    expect(listed.stdout).toBe(`${projectId}\t2 works\tactive\t京都\n`);
    const inProject = await run(['--json', 'works', 'list', '--project', projectId], env);
    expect((JSON.parse(inProject.stdout) as { total: number }).total).toBe(2);

    const removed = await run(['projects', 'remove', projectId, b.id], env);
    expect(removed.code).toBe(0);
    const loose = await run(['--json', 'works', 'list', '--unassigned'], env);
    expect(
      (JSON.parse(loose.stdout) as { items: { id: string }[] }).items.map((i) => i.id),
    ).toEqual([b.id]);
    // The works themselves are untouched.
    expect(server.works.get(b.id).markdown).toBe('# B\n');
  });

  it('exits 1 when an item fails, refuses bad input, and needs write to change', async () => {
    const env = token(['read', 'write']);
    const created = await run(['--json', 'projects', 'create', '--name', 'P'], env);
    const projectId = (JSON.parse(created.stdout) as { id: string }).id;
    const missing = '00000000-0000-4000-8000-000000000000';
    const partial = await run(['projects', 'add', projectId, missing], env);
    expect(partial.code).toBe(1);
    expect(partial.stdout).toContain(`failed\t${missing}\tnot_found`);
    expect((await run(['projects', 'create', '--name', 'x', '--color', '9'], env)).code).toBe(1);
    expect((await run(['projects', 'add', 'nope', missing], env)).code).toBe(1);

    const reader = token(['read']);
    expect((await run(['projects', 'list'], reader)).code).toBe(0);
    const denied = await run(['projects', 'create', '--name', 'x'], reader);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('403');
  });
});
