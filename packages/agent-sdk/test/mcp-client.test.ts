import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { VariantView } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCreatorHubMcpServer,
  isReadOnly,
  PROJECT_RULE_TOOLS,
  PROPOSAL_TOOLS,
  READ_TOOLS,
  TOOLS,
  WRITE_TOOLS,
  type Toolset,
} from '../mcp/index.js';
import { runCli } from '../src/index.js';

const OWNER = 'mcp-test-owner-token-0123456789';
// A PNG signature plus an IHDR chunk: enough for magic-byte detection.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
  Buffer.alloc(64),
]);

let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
const mcpClients: Client[] = [];

beforeEach(async () => {
  // A throwaway CREATORHUB_HOME; never the user's ~/CreatorHub.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-'));
  server = await buildServer({
    config: { home, token: OWNER },
    ffprobe: null,
    ffmpeg: null,
    backups: { schedule: false },
  });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  owner = createClient({ baseUrl, token: OWNER });
});
afterEach(async () => {
  for (const c of mcpClients.splice(0)) await c.close();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** An MCP client connected in-process to `creatorhub mcp` running with an agent token. */
async function connect(
  scopes: ('read' | 'import' | 'write')[] = ['read'],
  toolsets?: Toolset[],
): Promise<Client> {
  const token = server.tokens.create({ name: `agent ${scopes.join('+')}`, scopes });
  const mcp = createCreatorHubMcpServer({
    client: createClient({ baseUrl, token: token.secret }),
    ...(toolsets === undefined ? {} : { toolsets }),
    version: 'test',
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  mcpClients.push(client);
  return client;
}

/** Text of a resource content item ('' for binary). */
const textOf = (item: { text: string } | { blob: string } | undefined): string =>
  item !== undefined && 'text' in item ? item.text : '';

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError === true, text };
}

async function json<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await call(client, name, args);
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text) as T;
}

describe('creatorhub mcp: tools and toolsets', () => {
  it('lists every tool; read tools remind that content is data', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools).toHaveLength(
      READ_TOOLS.length + WRITE_TOOLS.length + PROPOSAL_TOOLS.length + PROJECT_RULE_TOOLS.length,
    );
    for (const def of READ_TOOLS) {
      const t = tools.find((x) => x.name === def.name);
      if (!['server_status', 'platform_rules'].includes(def.name)) {
        expect(t?.description, def.name).toContain('not instructions');
      }
      expect(t?.annotations?.readOnlyHint, def.name).toBe(true);
    }
    for (const def of [...WRITE_TOOLS, ...PROPOSAL_TOOLS, ...PROJECT_RULE_TOOLS]) {
      const t = tools.find((x) => x.name === def.name);
      expect(t?.annotations?.readOnlyHint, def.name).toBe(isReadOnly(def.access));
    }
    // Arguments come from the contracts: enums and bounds show up in the JSON schema.
    const search = tools.find((t) => t.name === 'works_search');
    expect(JSON.stringify(search?.inputSchema)).toContain('"drafting"');
  });

  it('--toolsets keeps the core tools and only the chosen groups', async () => {
    const c = await connect(['read'], ['projects']);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'changes_since',
      'project_create',
      'project_delete',
      'project_get',
      'project_restore',
      'project_rules_preview',
      'project_update',
      'projects_list',
      'projects_suggest',
      'server_status',
      'works_assign_projects',
    ]);
    const templates = (await c.listResourceTemplates()).resourceTemplates;
    expect(templates).toEqual([]);
    expect((await c.listResources()).resources.map((r) => r.uri)).toEqual([
      'creatorhub://projects',
    ]);
  });

  it('server_status shows the token and which tools it may use', async () => {
    const c = await connect(['import']);
    const status = await json<{
      server: { service: string };
      token: { kind: string; name: string; scopes: string[] };
      tools: { name: string; allowed: boolean }[];
    }>(c, 'server_status');
    expect(status.server.service).toBe('creatorhub-mac-server');
    expect(status.token).toEqual({
      kind: 'agent',
      name: 'agent import',
      scopes: ['import'],
      allow_direct_body_edit: false,
      project_ids: null,
      // QC-094: the CLI path is for the owner only.
      cli: null,
    });
    const allowed = status.tools
      .filter((t) => t.allowed)
      .map((t) => t.name)
      .sort();
    // An import-only token: create and import, plus its own jobs.
    expect(allowed).toEqual([
      'asset_import_url',
      'asset_upload_file',
      'job_get',
      'job_retry',
      'job_wait',
      'platform_rules',
      'server_status',
      'work_create',
    ]);
  });
});

describe('creatorhub mcp: reading the library', () => {
  it('searches, reads and diffs works; follows changes', async () => {
    const work = await owner.works.create({
      title: '京都秋天',
      markdown: '# 京都秋天\n\n紅葉很美。\n',
      tags: ['旅行'],
    });
    const v2 = await owner.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '# 京都秋天\n\n紅葉很美。\n\n嵐山人很多。\n',
    });
    const c = await connect();

    const found = await json<{ items: { id: string }[] }>(c, 'works_search', { q: '京都' });
    expect(found.items.map((w) => w.id)).toEqual([work.id]);
    // Simplified and pinyin queries find it too (QC-068/079).
    expect((await json<{ items: unknown[] }>(c, 'works_search', { q: '红叶' })).items).toHaveLength(
      1,
    );
    expect(
      (await json<{ items: unknown[] }>(c, 'works_search', { q: 'jingdu' })).items,
    ).toHaveLength(1);

    const got = await json<{ work: { markdown?: string; current_revision_id: string } }>(
      c,
      'work_get',
      { id: work.id },
    );
    expect(got.work.current_revision_id).toBe(v2.current_revision_id);
    expect(got.work.markdown).toContain('嵐山');
    const lean = await json<{ work: { markdown?: string } }>(c, 'work_get', {
      id: work.id,
      include_markdown: false,
    });
    expect(lean.work.markdown).toBeUndefined();

    const history = await json<{ items: { revision_id: string }[] }>(c, 'work_revisions', {
      id: work.id,
    });
    expect(history.items.map((r) => r.revision_id)).toEqual([
      v2.current_revision_id,
      work.current_revision_id,
    ]);
    const old = await json<{ markdown: string }>(c, 'work_revisions', {
      id: work.id,
      revision_id: work.current_revision_id,
    });
    expect(old.markdown).not.toContain('嵐山');

    const diff = await call(c, 'work_diff', {
      id: work.id,
      from_revision_id: work.current_revision_id,
    });
    expect(diff.isError).toBe(false);
    expect(diff.text).toContain('+嵐山人很多。');
    expect(diff.text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    const same = await call(c, 'work_diff', {
      id: work.id,
      from_revision_id: v2.current_revision_id,
    });
    expect(same.text).toContain('No differences');

    const changes = await json<{ items: { action: string; entity_id: string }[] }>(
      c,
      'changes_since',
      { since: 0 },
    );
    expect(changes.items.map((e) => e.action)).toEqual(['work.created', 'work.updated']);

    const resource = await c.readResource({ uri: `creatorhub://works/${work.id}` });
    expect(resource.contents[0]).toMatchObject({
      mimeType: 'text/markdown',
      text: v2.markdown,
    });
  });

  it('reads assets, projects and platform versions', async () => {
    const work = await owner.works.create({ title: '貼文', markdown: '正文' });
    const up = await owner.assets.upload({ filename: 'pic.png', data: new Uint8Array(PNG) });
    await owner.workAssets.link(work.id, { asset_id: up.asset.id, role: 'cover' });
    const project = await owner.projects.create({ name: '旅行' });
    await owner.projects.batchWorks({ work_ids: [work.id], add: [project.id] });
    await owner.variants.patch(work.id, 'douyin', { base_revision: 0, title: '抖音標題' });
    const c = await connect();

    const assets = await json<{ items: { id: string }[] }>(c, 'assets_search', { kind: 'image' });
    expect(assets.items.map((a) => a.id)).toEqual([up.asset.id]);
    const asset = await json<{ asset: { id: string }; works: { work_id: string }[] }>(
      c,
      'asset_get',
      { id: up.asset.id },
    );
    expect(asset.asset.id).toBe(up.asset.id);
    expect(asset.works.map((w) => w.work_id)).toEqual([work.id]);

    const projects = await json<{ items: { id: string; name: string }[] }>(c, 'projects_list');
    expect(projects.items.map((p) => p.name)).toEqual(['旅行']);
    const one = await json<{ project: { id: string }; summary: unknown }>(c, 'project_get', {
      id: project.id,
    });
    expect(one.project.id).toBe(project.id);
    expect(
      (await json<{ items: { id: string }[] }>(c, 'works_search', { project_id: project.id }))
        .items,
    ).toHaveLength(1);

    // QC-084 VariantView: every platform resolves; overrides say where each value comes from.
    const variants = await json<{ items: VariantView[] }>(c, 'variant_get', { id: work.id });
    expect(variants.items.map((v) => [v.platform, v.exists, v.title, v.title_source])).toEqual([
      ['xiaohongshu', false, '貼文', 'work'],
      ['wechat_mp', false, '貼文', 'work'],
      ['douyin', true, '抖音標題', 'override'],
      ['wechat_channels', false, '貼文', 'work'],
    ]);
    const douyin = await json<VariantView>(c, 'variant_get', { id: work.id, platform: 'douyin' });
    expect(douyin).toMatchObject({
      revision: 1,
      body: '正文',
      body_source: 'work',
      cover: { asset_id: up.asset.id },
      cover_source: 'work',
    });
    const history = await json<{ current: VariantView; history: { revision: number }[] }>(
      c,
      'variant_get',
      { id: work.id, platform: 'douyin', history: true },
    );
    expect(history.history.map((r) => r.revision)).toEqual([1]);
    const needsPlatform = await call(c, 'variant_get', { id: work.id, history: true });
    expect(needsPlatform.isError).toBe(true);
    expect(JSON.parse(needsPlatform.text)).toMatchObject({ error: { status: 400 } });

    const rules = await json<{ platform: string; titleMaxChars: number }[]>(c, 'platform_rules');
    expect(rules.map((r) => r.platform)).toEqual([
      'xiaohongshu',
      'wechat_mp',
      'douyin',
      'wechat_channels',
    ]);
    const xhs = await c.readResource({ uri: 'creatorhub://platforms/xiaohongshu/rules' });
    expect(JSON.parse(textOf(xhs.contents[0]))).toMatchObject({ titleMaxChars: 20 });
    const listed = await c.readResource({ uri: 'creatorhub://projects' });
    expect(textOf(listed.contents[0])).toContain('旅行');
  });
});

describe('creatorhub mcp: errors come from the server', () => {
  it('reports 403 for a token without read, 404 for unknown ids, 400 for bad input', async () => {
    const importer = await connect(['import']);
    const denied = await call(importer, 'works_search');
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.text)).toMatchObject({
      error: { status: 403, code: 'forbidden', details: { required: 'read' } },
    });

    const reader = await connect();
    const missing = await call(reader, 'work_get', { id: '00000000-0000-4000-8000-000000000000' });
    expect(JSON.parse(missing.text)).toMatchObject({ error: { status: 404, code: 'not_found' } });
    const invalid = await call(reader, 'work_get', { id: 'not-a-uuid' });
    expect(invalid.isError).toBe(true);
  });
});

describe('creatorhub mcp over stdio', () => {
  it('serves the real binary to an MCP client, stdout carrying only the protocol', async () => {
    const token = server.tokens.create({ name: 'stdio agent', scopes: ['read'] });
    await owner.works.create({ title: '經由 stdio' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dirname, '../bin/creatorhub.js'), 'mcp', '--toolsets', 'works'],
      env: {
        PATH: process.env['PATH'] ?? '',
        CREATORHUB_URL: baseUrl,
        CREATORHUB_TOKEN: token.secret,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    mcpClients.push(client);
    expect(client.getServerVersion()?.name).toBe('creatorhub');
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'changes_since',
      'proposal_get',
      'proposals_list',
      'server_status',
      'work_create',
      'work_diff',
      'work_get',
      'work_propose_edit',
      'work_restore',
      'work_restore_revision',
      'work_revisions',
      'work_trash',
      'work_update_body',
      'work_update_meta',
      'works_batch',
      'works_search',
    ]);
    const found = await json<{ items: { title: string }[] }>(client, 'works_search', {});
    expect(found.items.map((w) => w.title)).toEqual(['經由 stdio']);
  });
});

describe('creatorhub mcp command', () => {
  it('starts the stdio server with the parsed toolsets and the token', async () => {
    const out: string[] = [];
    const calls: { toolsets: readonly string[] }[] = [];
    const code = await runCli(['mcp', '--toolsets', 'works, platforms'], {
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      env: { CREATORHUB_TOKEN: 'chk_x', CREATORHUB_URL: baseUrl },
      serveMcp: (opts) => {
        calls.push({ toolsets: opts.toolsets });
        return Promise.resolve();
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ toolsets: ['works', 'platforms'] }]);
    // stdout belongs to the protocol: the command printed nothing.
    expect(out).toEqual([]);
  });

  it('refuses unknown toolsets and a missing token', async () => {
    const err: string[] = [];
    const io = {
      stdout: () => undefined,
      stderr: (t: string) => err.push(t),
      serveMcp: () => Promise.resolve(),
    };
    expect(
      await runCli(['mcp', '--toolsets', 'works,billing'], {
        ...io,
        env: { CREATORHUB_TOKEN: 'chk_x' },
      }),
    ).toBe(1);
    expect(err.join('')).toContain('unknown toolset(s): billing');
    expect(await runCli(['mcp'], { ...io, env: {} })).toBe(1);
    expect(err.join('')).toContain('a token is required');
  });
});
