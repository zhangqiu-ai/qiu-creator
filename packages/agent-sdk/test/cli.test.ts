import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

const TOKEN = 'cli-test-token-0123456789';
let home: string;
let server: CreatorHubServer;
let baseUrl: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-cli-'));
  server = await buildServer({ config: { home, token: TOKEN } });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await server.app.close();
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
