import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Project, ProjectGroup, TokenScope, WorkDetail } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCreatorHubMcpServer } from '../mcp/index.js';

/** QC-113: project groups and series through MCP. Temporary CREATORHUB_HOME; no network. */

const OWNER = 'mcp-groups-owner-token-0123456789';
let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
const clients: Client[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-groups-'));
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
  for (const c of clients.splice(0)) await c.close();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(scopes: TokenScope[]): Promise<{ c: Client; tokenId: string }> {
  const token = server.tokens.create({ name: 'groups agent', scopes });
  const mcp = createCreatorHubMcpServer({ client: createClient({ baseUrl, token: token.secret }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const c = new Client({ name: 'groups-agent', version: '1.0.0' });
  await c.connect(clientSide);
  clients.push(c);
  return { c, tokenId: token.token.id };
}

async function call(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: boolean; text: string }> {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return { error: result.isError === true, text: first?.type === 'text' ? first.text : '' };
}

async function ok<T>(c: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(c, name, args);
  expect(r.error, `${name}: ${r.text}`).toBe(false);
  return JSON.parse(r.text) as T;
}

describe('MCP: project groups and series (QC-113)', () => {
  it('creates a series, places works by episode, renames, and deletes it', async () => {
    const { c, tokenId } = await connect(['read', 'write']);
    const p = await owner.projects.create({ name: '京都' });
    const a = await owner.works.create({ title: '第一篇', project_ids: [p.id] });
    const b = await owner.works.create({ title: '第二篇', project_ids: [p.id] });

    const group = await ok<ProjectGroup>(c, 'project_group_create', {
      project_id: p.id,
      name: '京都秋季系列',
      ordered: true,
    });
    expect(group.created_by).toEqual({
      kind: 'agent',
      token_id: tokenId,
      token_name: 'groups agent',
    });

    await ok<Project>(c, 'works_assign_group', {
      project_id: p.id,
      work_ids: [b.id],
      group_id: group.id,
    });
    const placed = await ok<Project>(c, 'works_assign_group', {
      project_id: p.id,
      work_ids: [a.id],
      group_id: group.id,
      position: 1,
    });
    expect(placed.groups?.[0]?.work_ids).toEqual([a.id, b.id]);

    const got = await ok<{ project: Project }>(c, 'project_get', { id: p.id });
    expect(got.project.groups?.map((g) => [g.name, g.ordered, g.revision])).toEqual([
      ['京都秋季系列', true, 1],
    ]);
    const { work } = await ok<{ work: WorkDetail }>(c, 'work_get', {
      id: b.id,
      include_markdown: false,
    });
    expect(work.project_groups).toEqual([
      {
        project_id: p.id,
        group_id: group.id,
        group_name: '京都秋季系列',
        ordered: true,
        episode: 2,
      },
    ]);

    const renamed = await ok<ProjectGroup>(c, 'project_group_update', {
      project_id: p.id,
      group_id: group.id,
      base_revision: 1,
      name: '京都',
    });
    expect(renamed.revision).toBe(2);
    const stale = await call(c, 'project_group_update', {
      project_id: p.id,
      group_id: group.id,
      base_revision: 1,
      ordered: false,
    });
    expect(stale.error).toBe(true);
    expect(stale.text).toContain('revision_conflict');

    const notIn = await owner.works.create({ title: '外' });
    const refused = await call(c, 'works_assign_group', {
      project_id: p.id,
      work_ids: [notIn.id],
      group_id: group.id,
    });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('work_not_in_project');

    const after = await ok<Project>(c, 'project_group_delete', {
      project_id: p.id,
      group_id: group.id,
    });
    expect(after.groups).toEqual([]);
    expect((await owner.works.get(a.id)).project_groups).toEqual([]);
  });

  it('needs write: a propose-only token sees them as not allowed and gets 403', async () => {
    const { c } = await connect(['read', 'propose']);
    const status = await ok<{ tools: { name: string; access: string; allowed: boolean }[] }>(
      c,
      'server_status',
      {},
    );
    const groupTools = [
      'project_group_create',
      'project_group_update',
      'project_group_delete',
      'works_assign_group',
    ];
    expect(
      status.tools
        .filter((t) => groupTools.includes(t.name))
        .map((t) => [t.name, t.access, t.allowed]),
    ).toEqual(groupTools.map((name) => [name, 'write', false]));
    expect(status.tools.find((t) => t.name === 'project_get')?.allowed).toBe(true);

    const p = await owner.projects.create({ name: 'P' });
    const g = await owner.projects.createGroup(p.id, { name: 'G' });
    const refused = await call(c, 'project_group_delete', { project_id: p.id, group_id: g.id });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('403');
    expect((await owner.projects.get(p.id)).groups?.map((x) => x.id)).toEqual([g.id]);
  });
});
