import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { ProposalDetail, TokenScope, WorkDetail } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCreatorHubMcpServer } from '../mcp/index.js';

const OWNER = 'mcp-proposal-owner-token-0123456789';
const TEXT = ['# 京都', '', '第一段。', '', '第二段。'].join('\n');

let home: string;
let server: CreatorHubServer;
let baseUrl: string;
let owner: CreatorHubClient;
const clients: Client[] = [];

beforeEach(async () => {
  // A throwaway CREATORHUB_HOME; never the user's data.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mcp-proposals-'));
  server = await buildServer({
    config: { home, token: OWNER },
    ffprobe: null,
    ffmpeg: null,
    backups: { schedule: false },
    proposals: { purgeIntervalMs: 0 },
  });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  owner = createClient({ baseUrl, token: OWNER });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function agent(
  scopes: TokenScope[],
  extra: { project_ids?: string[] } = {},
): Promise<{ c: Client; tokenId: string }> {
  const token = server.tokens.create({ name: 'mcp agent', scopes, ...extra });
  const mcp = createCreatorHubMcpServer({ client: createClient({ baseUrl, token: token.secret }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const c = new Client({ name: 'proposal-agent', version: '1.0.0' });
  await c.connect(clientSide);
  clients.push(c);
  return { c, tokenId: token.token.id };
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return { isError: result.isError === true, text: first?.type === 'text' ? first.text : '' };
}

async function ok<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(c, name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return JSON.parse(r.text) as T;
}

async function fails(c: Client, name: string, args: Record<string, unknown>) {
  const r = await call(c, name, args);
  expect(r.isError, `${name} should fail: ${r.text}`).toBe(true);
  return (JSON.parse(r.text) as { error: { status: number; code: string; retry: string } }).error;
}

describe('MCP: agents propose, the user decides (QC-089)', () => {
  it('proposes an edit; the user accepts part of it; the agent sees the outcome', async () => {
    const work = await owner.works.create({ title: '京都', markdown: TEXT });
    const { c, tokenId } = await agent(['read', 'propose']);
    const proposal = await ok<ProposalDetail>(c, 'work_propose_edit', {
      id: work.id,
      base_revision: work.current_revision_id,
      markdown: TEXT.replace('第一段。', '第一段改。').replace('第二段。', '第二段改。'),
      note: '改寫兩段',
      idempotency_key: 'mcp-proposal-0001',
    });
    expect(proposal).toMatchObject({ status: 'pending', hunk_count: 2, token_id: tokenId });
    expect((await owner.works.get(work.id)).markdown).toBe(TEXT);

    const listed = await ok<{ items: { id: string }[]; counts: { pending: number } }>(
      c,
      'proposals_list',
      {},
    );
    expect(listed.items.map((p) => p.id)).toEqual([proposal.id]);
    expect(listed.counts.pending).toBe(1);

    // The user takes only the first change.
    const res = await owner.proposals.accept(proposal.id, {
      base_revision: work.current_revision_id,
      hunk_ids: ['h1'],
    });
    expect(res.work.markdown).toBe(TEXT.replace('第一段。', '第一段改。'));
    const seen = await ok<ProposalDetail>(c, 'proposal_get', { id: proposal.id });
    expect(seen).toMatchObject({ status: 'partially_accepted', accepted_hunk_ids: ['h1'] });

    // The agent cannot write the text itself.
    const direct = await fails(c, 'work_update_body', {
      id: work.id,
      base_revision: res.work.current_revision_id,
      markdown: '覆蓋',
    });
    expect(direct.status).toBe(403);
  });

  it('writes the text directly only once the user allows it, naming the agent', async () => {
    const work = await owner.works.create({ title: '京都', markdown: TEXT });
    const { c, tokenId } = await agent(['read', 'write']);
    const allowedBefore = await ok<{ tools: { name: string; allowed: boolean }[] }>(
      c,
      'server_status',
    );
    expect(allowedBefore.tools.find((t) => t.name === 'work_update_body')?.allowed).toBe(false);

    const refused = await fails(c, 'work_update_body', {
      id: work.id,
      base_revision: work.current_revision_id,
      markdown: `${TEXT}\n\n第三段。`,
    });
    expect(refused).toMatchObject({ status: 403, code: 'direct_edit_not_allowed' });
    expect(refused.retry).toContain('work_propose_edit');

    await owner.tokens.update(tokenId, { allow_direct_body_edit: true });
    const after = await ok<{ tools: { name: string; allowed: boolean }[] }>(c, 'server_status');
    expect(after.tools.find((t) => t.name === 'work_update_body')?.allowed).toBe(true);
    const written = await ok<WorkDetail>(c, 'work_update_body', {
      id: work.id,
      base_revision: work.current_revision_id,
      markdown: `${TEXT}\n\n第三段。`,
    });
    expect(written.markdown).toContain('第三段');
    const [rev] = (await owner.works.revisions(work.id)).items;
    expect(rev?.agent).toMatchObject({
      token_id: tokenId,
      via: 'direct',
      restore_to: work.current_revision_id,
    });
    const both = await fails(c, 'work_update_body', {
      id: work.id,
      base_revision: written.current_revision_id,
    });
    expect(both.status).toBe(400);
  });

  it('a token limited to a project only reaches works inside it', async () => {
    const a = await owner.projects.create({ name: 'A' });
    const inside = await owner.works.create({ title: '裡面', project_ids: [a.id] });
    const outside = await owner.works.create({ title: '外面' });
    const { c } = await agent(['read', 'import'], { project_ids: [a.id] });
    const found = await ok<{ items: { id: string }[] }>(c, 'works_search', {});
    expect(found.items.map((w) => w.id)).toEqual([inside.id]);
    const hidden = await fails(c, 'work_get', { id: outside.id });
    expect(hidden).toMatchObject({ status: 404, code: 'not_found' });
    const noProject = await fails(c, 'work_create', {
      title: '新',
      idempotency_key: 'mcp-limited-0001',
    });
    expect(noProject).toMatchObject({ status: 403, code: 'project_scope' });
    expect(noProject.retry).toContain(a.id);
  });
});
