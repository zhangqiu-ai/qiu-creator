import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textScriptInstruction, TOOLS } from '../mcp/index.js';

const OWNER = 'mcp-script-owner-token-0123456789';
let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
const clients: Client[] = [];

beforeEach(async () => {
  // A throwaway CREATORHUB_HOME; never the user's data.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-script-'));
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
  const c = new Client({ name: 'script-agent', version: '1.0.0' });
  await c.connect(transport);
  clients.push(c);
  return c;
}

const text = (r: CallToolResult): string =>
  r.content[0]?.type === 'text' ? r.content[0].text : '';

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  expect(r.isError === true, text(r)).toBe(false);
  return JSON.parse(text(r)) as unknown;
}

describe('MCP over stdio: 作品文字字體 (QC-103)', () => {
  it('server_status and the instructions name the script; work_create converts', async () => {
    const tw = await owner.projects.create({ name: '臺灣', text_script: 'zh-Hant' });
    const agent = server.tokens.create({ name: 'Claude Code', scopes: ['read', 'import'] });
    const c = await stdio(agent.secret);

    expect(c.getInstructions()).toContain('Simplified Chinese (zh-Hans)');
    expect(c.getInstructions()).toContain('"臺灣" → zh-Hant');

    const status = (await call(c, 'server_status', {})) as {
      text_script: { default: string; projects: unknown[]; rule: string };
      token: { text_script: unknown };
    };
    expect(status.text_script).toMatchObject({
      default: 'zh-Hans',
      projects: [{ project_id: tw.id, name: '臺灣', script: 'zh-Hant' }],
    });
    expect(status.text_script.rule).toContain('override');

    const work = (await call(c, 'work_create', {
      title: '軟體設計',
      markdown: '# 發展\n\n`程式碼` [說明](https://例子.com/設計)\n',
      idempotency_key: 'qc103-mcp-create-1',
    })) as WorkDetail;
    expect(work.title).toBe('软体设计');
    expect(work.markdown).toBe('# 发展\n\n`程式碼` [说明](https://例子.com/設計)\n');
    expect(work.script_conversion).toEqual({ script: 'zh-Hans', fields: ['title', 'markdown'] });

    const inProject = (await call(c, 'work_create', {
      title: '软件设计',
      project_ids: [tw.id],
      idempotency_key: 'qc103-mcp-create-2',
    })) as WorkDetail;
    expect(inProject.title).toBe('軟件設計');
  });

  it('after the owner switches to zh-Hant, a new session says so', async () => {
    await owner.settings.setTextScript({ script: 'zh-Hant' });
    const agent = server.tokens.create({ name: 'Codex', scopes: ['read'] });
    const c = await stdio(agent.secret);
    expect(c.getInstructions()).toContain('Traditional Chinese (zh-Hant)');
    const status = (await call(c, 'server_status', {})) as { text_script: { default: string } };
    expect(status.text_script.default).toBe('zh-Hant');
  });
});

describe('script notes in MCP descriptions (QC-103)', () => {
  it('every tool that writes a work’s text mentions script_conversion', () => {
    for (const name of [
      'work_create',
      'work_propose_edit',
      'work_update_body',
      'work_update_meta',
      'variant_update',
    ]) {
      expect(TOOLS.find((t) => t.name === name)?.description, name).toContain('script_conversion');
    }
  });

  it('project tools do not offer text_script (owner only)', () => {
    for (const name of ['project_create', 'project_update']) {
      expect(Object.keys(TOOLS.find((t) => t.name === name)?.inputSchema ?? {})).not.toContain(
        'text_script',
      );
    }
  });

  it('falls back to naming server_status when the session could not be read', () => {
    expect(textScriptInstruction(null)).toContain('server_status');
  });
});
