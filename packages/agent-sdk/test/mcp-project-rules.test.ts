import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  Project,
  ProjectSuggestionsResponse,
  RulesPreviewResponse,
  WorkDetail,
  WorkProjectMembership,
} from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCreatorHubMcpServer } from '../mcp/index.js';

const OWNER = 'mcp-rules-owner-token-0123456789';
let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
const clients: Client[] = [];

beforeEach(async () => {
  // A throwaway CREATORHUB_HOME; never the user's data.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-rules-'));
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

async function connect(): Promise<{ c: Client; tokenId: string }> {
  const token = server.tokens.create({ name: 'rules agent', scopes: ['read', 'import', 'write'] });
  const mcp = createCreatorHubMcpServer({ client: createClient({ baseUrl, token: token.secret }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const c = new Client({ name: 'rules-agent', version: '1.0.0' });
  await c.connect(clientSide);
  clients.push(c);
  return { c, tokenId: token.token.id };
}

async function ok<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  expect(result.isError === true, `${name}: ${text}`).toBe(false);
  return JSON.parse(text) as T;
}

describe('MCP: project rules and automatic assignment (QC-092)', () => {
  it('sets rules, previews them, suggests and auto-assigns with reasons', async () => {
    const { c, tokenId } = await connect();
    const kyoto = await ok<Project>(c, 'project_create', {
      name: '京都',
      description: '京都旅行筆記',
    });
    const preview = await ok<RulesPreviewResponse>(c, 'project_rules_preview', {
      id: kyoto.id,
      rules: { keywords: ['京都'] },
    });
    expect(preview.items).toEqual([]);
    const updated = await ok<Project>(c, 'project_update', {
      id: kyoto.id,
      base_revision: kyoto.revision,
      rules: { keywords: ['京都'], tags: ['旅行'] },
    });
    expect(updated.rules).toMatchObject({ keywords: ['京都'], tags: ['旅行'] });

    const draft = await ok<ProjectSuggestionsResponse>(c, 'projects_suggest', {
      title: '京都秋天',
      tags: ['旅行'],
    });
    expect(draft.items.map((m) => [m.project_name, m.score, m.outcome])).toEqual([
      ['京都', 0.84, 'auto'],
    ]);

    const work = await ok<WorkDetail>(c, 'work_create', {
      title: '京都秋天',
      tags: ['旅行'],
      auto_assign: true,
      idempotency_key: 'mcp-rules-create-01',
    });
    expect(work.auto_assignment?.assigned.map((m) => m.project_id)).toEqual([kyoto.id]);
    const got = await ok<{ projects: WorkProjectMembership[] }>(c, 'work_get', {
      id: work.id,
      include_markdown: false,
    });
    expect(
      got.projects.map((m) => [
        m.project_id,
        m.added_by.kind,
        m.added_by.token_id,
        m.added_by.score,
      ]),
    ).toEqual([[kyoto.id, 'rule', tokenId, 0.84]]);
    const forWork = await ok<ProjectSuggestionsResponse>(c, 'projects_suggest', {
      work_id: work.id,
    });
    expect(forWork.items[0]?.reasons.map((r) => r.kind)).toEqual(['keyword_title', 'tag']);
  });

  it('cannot take works out of projects the owner chose', async () => {
    const { c } = await connect();
    const p = await owner.projects.create({ name: '手動' });
    const work = await owner.works.create({ title: 'x', project_ids: [p.id] });
    const res = await ok<{ results: { ok: boolean; error?: { code: string } }[] }>(
      c,
      'works_assign_projects',
      { work_ids: [work.id], remove: [p.id] },
    );
    expect(res.results[0]).toMatchObject({ ok: false, error: { code: 'membership_manual' } });
    expect((await owner.projects.workMemberships(work.id)).items).toHaveLength(1);
  });
});
