import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { AgentStatusReportResponse } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const OWNER = 'mcp-status-owner-token-0123456789';
let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
const clients: Client[] = [];

beforeEach(async () => {
  // A throwaway CREATORHUB_HOME; never the user's data.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-status-'));
  server = await buildServer({
    config: { home, token: OWNER },
    ffprobe: null,
    ffmpeg: null,
    backups: { schedule: false },
    agentActivity: { timers: false },
  });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  owner = createClient({ baseUrl, token: OWNER });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The real `creatorhub mcp` binary over stdio, as Claude Code starts it. */
async function stdio(secret: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, '../bin/creatorhub.js'), 'mcp'],
    env: { PATH: process.env['PATH'] ?? '', CREATORHUB_URL: baseUrl, CREATORHUB_TOKEN: secret },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'status-agent', version: '1.0.0' });
  await c.connect(transport);
  clients.push(c);
  return c;
}

async function call(c: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await c.callTool({ name: 'agent_status_report', arguments: args })) as CallToolResult;
}

const text = (r: CallToolResult): string =>
  r.content[0]?.type === 'text' ? r.content[0].text : '';

describe('MCP over stdio: agent_status_report (QC-096)', () => {
  it('reports working with a cleaned step, then done, and the app sees it', async () => {
    const work = await owner.works.create({ title: '進行中' });
    const other = await owner.works.create({ title: '另一篇' });
    const agent = server.tokens.create({ name: 'Claude Code', scopes: ['read', 'propose'] });
    const c = await stdio(agent.secret);

    const working = await call(c, {
      work_ids: [work.id, other.id],
      state: 'working',
      step: '整理<b>段落</b> https://evil.example/x 與 /Users/me/secret.md 的引用並加上小標題',
      ttl_seconds: 300,
    });
    expect(working.isError === true, text(working)).toBe(false);
    const body = JSON.parse(text(working)) as AgentStatusReportResponse;
    expect(body.items.map((i) => [i.work_id, i.state, i.step])).toEqual([
      [work.id, 'working', '整理 段落 與 的引用並加上小標題'],
      [other.id, 'working', '整理 段落 與 的引用並加上小標題'],
    ]);

    const seen = await owner.agents.activity({ work_ids: [work.id] });
    expect(seen.items).toEqual([
      expect.objectContaining({
        token_id: agent.token.id,
        agent_name: 'Claude Code',
        work_id: work.id,
        state: 'working',
        reason: 'report',
      }),
    ]);
    expect(seen.counts.all).toEqual({ agents: 1, works: 2 });

    const done = await call(c, { work_id: work.id, state: 'done', step: 'ignored' });
    expect(done.isError === true, text(done)).toBe(false);
    const after = await owner.agents.activity({ work_ids: [work.id] });
    expect(after.items.map((i) => [i.state, i.step])).toEqual([['done', null]]);
    expect(after.counts.all).toEqual({ agents: 1, works: 1 });
  });

  it('refuses read-only tokens, works outside the token, and missing works', async () => {
    const work = await owner.works.create({ title: '限定' });
    const reader = server.tokens.create({ name: 'reader', scopes: ['read'] });
    const r = await call(await stdio(reader.secret), { work_id: work.id, state: 'working' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('forbidden');

    const project = await owner.projects.create({ name: '只在這裡' });
    const limited = server.tokens.create({
      name: 'limited',
      scopes: ['write'],
      project_ids: [project.id],
    });
    const lc = await stdio(limited.secret);
    const outside = await call(lc, { work_id: work.id, state: 'working' });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain('not_found');
    const none = await call(lc, { state: 'working' });
    expect(none.isError).toBe(true);
    expect((await owner.agents.activity()).items).toEqual([]);
  });
});
