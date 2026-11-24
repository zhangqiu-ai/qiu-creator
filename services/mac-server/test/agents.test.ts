import path from 'node:path';
import fs from 'node:fs';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { TokenScope } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { AGENT_PROPOSALS_ROLLBACK_SQL, migrations } from '../src/db/migrations.js';
import { makeTempHome, startTestServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

let clock = new Date('2026-11-24T00:00:00.000Z');

async function start(): Promise<TestServer> {
  clock = new Date('2026-11-24T00:00:00.000Z');
  const s = await startTestServer({ proposals: { now: () => clock, purgeIntervalMs: 0 } });
  servers.push(s);
  return s;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

function agent(
  s: TestServer,
  scopes: TokenScope[],
  extra: { allow_direct_body_edit?: boolean; project_ids?: string[] | null } = {},
): { client: CreatorHubClient; id: string; secret: string } {
  const t = s.tokens.create({ name: `agent-${scopes.join('+')}`, scopes, ...extra });
  return {
    client: createClient({ baseUrl: s.baseUrl, token: t.secret }),
    id: t.token.id,
    secret: t.secret,
  };
}

const TEXT = ['# 京都', '', '第一段。', '', '第二段。', '', '第三段。'].join('\n');

describe('agents cannot change text without the switch (QC-089)', () => {
  it('a write token may change metadata but not the text; with the switch it may, naming itself', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '京都', markdown: TEXT });
    const w = agent(s, ['read', 'write']);

    const denied = await apiError(
      w.client.works.patch(work.id, { base_revision: work.current_revision_id, markdown: '覆蓋' }),
    );
    expect(denied.status).toBe(403);
    expect(denied.code).toBe('direct_edit_not_allowed');
    expect(denied.body?.error.details).toMatchObject({ alternative: 'propose' });
    expect((await s.client.works.get(work.id)).markdown).toBe(TEXT);

    // Metadata is fine, and the revision names the agent.
    const titled = await w.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      title: '京都二',
    });
    const [meta] = (await s.client.works.revisions(work.id)).items;
    expect(meta?.agent).toMatchObject({ token_id: w.id, via: 'direct' });

    // The owner turns the switch on; the change is on record.
    const updated = await s.client.tokens.update(w.id, { allow_direct_body_edit: true });
    expect(updated.allow_direct_body_edit).toBe(true);
    const direct = await w.client.works.patch(work.id, {
      base_revision: titled.current_revision_id,
      markdown: `${TEXT}\n\n第四段。`,
    });
    const [rev] = (await s.client.works.revisions(work.id)).items;
    expect(rev).toMatchObject({
      revision_id: direct.current_revision_id,
      source: 'edit',
      agent: {
        token_id: w.id,
        name: 'agent-read+write',
        via: 'direct',
        proposal_id: null,
        restore_to: titled.current_revision_id,
      },
    });
    // One click back to the snapshot before the agent's edit.
    const restored = await s.client.works.restore(work.id, titled.current_revision_id, {
      base_revision: direct.current_revision_id,
    });
    expect(restored.markdown).toBe(TEXT);

    const activity = await s.client.tokens.activity(w.id);
    expect(activity.items.find((a) => a.kind === 'token_updated')?.reason).toContain(
      'allow_direct_body_edit: false → true',
    );
  });
});

describe('proposals (QC-089)', () => {
  async function setup() {
    const s = await start();
    const work = await s.client.works.create({ title: '京都', markdown: TEXT });
    const p = agent(s, ['read', 'propose']);
    const proposed = TEXT.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');
    const proposal = await p.client.proposals.create(
      work.id,
      { base_revision: work.current_revision_id, markdown: proposed, note: '潤飾兩段' },
      { idempotencyKey: 'proposal-key-0001' },
    );
    return { s, work, p, proposed, proposal };
  }

  it('splits a proposal into hunks with stable ids and leaves the work alone', async () => {
    const { s, work, p, proposal } = await setup();
    expect(proposal).toMatchObject({
      status: 'pending',
      overlap: 'none',
      token_id: p.id,
      note: '潤飾兩段',
      hunk_count: 2,
      base_revision: work.current_revision_id,
    });
    expect(proposal.hunks.map((h) => [h.id, h.removed, h.added, h.overlap])).toEqual([
      ['h1', ['第一段。'], ['第一段改。'], 'none'],
      ['h2', ['第三段。'], ['第三段改。'], 'none'],
    ]);
    expect((await s.client.works.get(work.id)).current_revision_id).toBe(work.current_revision_id);
    expect(await s.client.proposals.counts()).toEqual({ pending: 1, by_work: { [work.id]: 1 } });
    expect((await p.client.proposals.list()).items.map((x) => x.id)).toEqual([proposal.id]);

    // Retrying with the same key returns the same proposal; agents must send one.
    const again = await p.client.proposals.create(
      work.id,
      {
        base_revision: work.current_revision_id,
        markdown: proposal.proposed_markdown,
        note: '潤飾兩段',
      },
      { idempotencyKey: 'proposal-key-0001' },
    );
    expect(again.id).toBe(proposal.id);
    const noKey = await apiError(
      p.client.proposals.create(work.id, {
        base_revision: work.current_revision_id,
        markdown: 'x',
      }),
    );
    expect(noKey.status).toBe(428);
    const same = await apiError(
      p.client.proposals.create(
        work.id,
        { base_revision: work.current_revision_id, markdown: TEXT },
        { idempotencyKey: 'proposal-key-0002' },
      ),
    );
    expect(same.status).toBe(400);

    // Who may do what.
    const writer = agent(s, ['read', 'write']);
    const denied = await apiError(
      writer.client.proposals.create(
        work.id,
        { base_revision: work.current_revision_id, markdown: 'y' },
        { idempotencyKey: 'proposal-key-0003' },
      ),
    );
    expect(denied.status).toBe(403);
    const agentAccept = await apiError(
      p.client.proposals.accept(proposal.id, { base_revision: work.current_revision_id }),
    );
    expect(agentAccept.status).toBe(403);
  });

  it('accepts some hunks as a new revision naming the agent; a decided proposal is closed', async () => {
    const { s, work, p, proposal } = await setup();
    const res = await s.client.proposals.accept(proposal.id, {
      base_revision: work.current_revision_id,
      hunk_ids: ['h2'],
    });
    expect(res.work.markdown).toBe(TEXT.replace('第三段。', '第三段改。'));
    expect(res.proposal).toMatchObject({
      status: 'partially_accepted',
      accepted_hunk_ids: ['h2'],
      result_revision_id: res.work.current_revision_id,
    });
    const [rev] = (await s.client.works.revisions(work.id)).items;
    expect(rev?.agent).toMatchObject({
      token_id: p.id,
      via: 'proposal',
      proposal_id: proposal.id,
      restore_to: work.current_revision_id,
    });
    const closed = await apiError(
      s.client.proposals.accept(proposal.id, { base_revision: res.work.current_revision_id }),
    );
    expect(closed.code).toBe('proposal_closed');
    expect(await s.client.proposals.counts()).toEqual({ pending: 0, by_work: {} });

    const events = (await s.client.changes()).items.filter((e) => e.action.startsWith('proposal.'));
    expect(events.map((e) => [e.action, e.entity_id, e.actor, e.data['status'] ?? null])).toEqual([
      ['proposal.created', work.id, p.id, null],
      ['proposal.updated', work.id, 'owner', 'partially_accepted'],
    ]);
    const updated = (await s.client.changes()).items.find(
      (e) => e.action === 'work.updated' && e.data['proposal_id'] === proposal.id,
    );
    expect(updated?.actor).toBe('owner');
  });

  it('accepts a stale proposal whose changes do not overlap later edits', async () => {
    const { s, work, proposal } = await setup();
    const mine = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: TEXT.replace('第二段。', '第二段（我改的）。'),
    });
    const detail = await s.client.proposals.get(proposal.id);
    expect(detail.overlap).toBe('stale');
    expect(detail.current_revision).toBe(mine.current_revision_id);
    // The base the user sees must be the current one.
    const stale = await apiError(
      s.client.proposals.accept(proposal.id, { base_revision: work.current_revision_id }),
    );
    expect(stale).toMatchObject({ status: 409, code: 'revision_conflict' });
    const res = await s.client.proposals.accept(proposal.id, {
      base_revision: mine.current_revision_id,
    });
    expect(res.work.markdown).toBe(
      TEXT.replace('第一段。', '第一段改。')
        .replace('第二段。', '第二段（我改的）。')
        .replace('第三段。', '第三段改。'),
    );
    expect(res.proposal.status).toBe('accepted');
  });

  it('refuses overlapping hunks with three-way input; the others can still be taken', async () => {
    const { s, work, proposal } = await setup();
    const mine = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: TEXT.replace('第一段。', '第一段（我改的）。'),
    });
    const detail = await s.client.proposals.get(proposal.id);
    expect(detail.overlap).toBe('conflict');
    expect(detail.hunks.map((h) => [h.id, h.overlap])).toEqual([
      ['h1', 'conflict'],
      ['h2', 'none'],
    ]);
    expect(detail.conflicts).toEqual([
      {
        hunk_ids: ['h1'],
        base_start: 2,
        base_end: 3,
        base: '第一段。',
        mine: '第一段（我改的）。',
        theirs: '第一段改。',
      },
    ]);
    const refused = await apiError(
      s.client.proposals.accept(proposal.id, { base_revision: mine.current_revision_id }),
    );
    expect(refused).toMatchObject({ status: 409, code: 'proposal_conflict' });
    expect(refused.body?.error.details).toMatchObject({
      hunk_ids: ['h1'],
      conflicts: [{ base: '第一段。', mine: '第一段（我改的）。', theirs: '第一段改。' }],
    });
    expect((await s.client.works.get(work.id)).current_revision_id).toBe(mine.current_revision_id);
    const partial = await s.client.proposals.accept(proposal.id, {
      base_revision: mine.current_revision_id,
      hunk_ids: ['h2'],
    });
    expect(partial.work.markdown).toBe(mine.markdown.replace('第三段。', '第三段改。'));
  });

  it('keeps discarded proposals 30 days', async () => {
    const { s, proposal } = await setup();
    const discarded = await s.client.proposals.discard(proposal.id);
    expect(discarded).toMatchObject({
      status: 'discarded',
      expires_at: '2026-12-24T00:00:00.000Z',
    });
    expect((await s.client.proposals.list()).items).toEqual([]);
    expect((await s.client.proposals.list({ status: 'done' })).items.map((x) => x.id)).toEqual([
      proposal.id,
    ]);
    clock = new Date('2026-12-20T00:00:00.000Z');
    expect(s.proposals.purgeExpired()).toBe(0);
    clock = new Date('2026-12-25T00:00:00.000Z');
    expect(s.proposals.purgeExpired()).toBe(1);
    expect((await apiError(s.client.proposals.get(proposal.id))).status).toBe(404);
  });
});

describe('tokens limited to projects (QC-089)', () => {
  it('see and change only works and projects inside, as if the rest did not exist', async () => {
    const s = await start();
    const a = await s.client.projects.create({ name: 'A' });
    const b = await s.client.projects.create({ name: 'B' });
    const inA = await s.client.works.create({ title: '在 A', project_ids: [a.id] });
    const inB = await s.client.works.create({ title: '在 B', project_ids: [b.id] });
    await s.client.works.create({ title: '不在項目' });
    const limited = agent(s, ['read', 'write', 'import', 'propose'], { project_ids: [a.id] });
    const c = limited.client;

    expect((await c.works.list()).items.map((w) => w.title)).toEqual(['在 A']);
    expect((await c.works.list({ q: '在' })).items.map((w) => w.title)).toEqual(['在 A']);
    expect((await c.works.facets()).total).toBe(1);
    expect((await apiError(c.works.get(inB.id))).status).toBe(404);
    expect(
      (
        await apiError(
          c.works.patch(inB.id, { base_revision: inB.current_revision_id, title: 'x' }),
        )
      ).status,
    ).toBe(404);
    expect((await apiError(c.variants.list(inB.id))).status).toBe(404);
    expect((await c.projects.list()).items.map((p) => p.name)).toEqual(['A']);
    expect((await apiError(c.projects.get(b.id))).status).toBe(404);
    expect((await apiError(c.projects.create({ name: 'C' }))).code).toBe('project_scope');

    // New works must land in one of its projects.
    const outside = await apiError(
      c.works.create({ title: '無項目' }, { idempotencyKey: 'limited-create-01' }),
    );
    expect(outside).toMatchObject({ status: 403, code: 'project_scope' });
    const created = await c.works.create(
      { title: '新的', project_ids: [a.id] },
      { idempotencyKey: 'limited-create-02' },
    );
    const moved = await apiError(c.projects.batchWorks({ work_ids: [created.id], add: [b.id] }));
    expect(moved.code).toBe('project_scope');
    expect(
      (await apiError(c.projects.batchWorks({ work_ids: [inB.id], add: [a.id] }))).status,
    ).toBe(404);

    // Change events and proposals outside are hidden too.
    const events = (await c.changes()).items;
    expect(
      events.every((e) => e.entity !== 'work' || [inA.id, created.id].includes(e.entity_id)),
    ).toBe(true);
    expect(events.some((e) => e.entity === 'project' && e.entity_id === b.id)).toBe(false);
    const other = agent(s, ['read', 'propose']);
    const hidden = await other.client.proposals.create(
      inB.id,
      { base_revision: inB.current_revision_id, markdown: '別的' },
      { idempotencyKey: 'other-proposal-01' },
    );
    expect((await c.proposals.list()).items).toEqual([]);
    expect((await apiError(c.proposals.get(hidden.id))).status).toBe(404);

    // Lifting the limit shows everything.
    await s.client.tokens.update(limited.id, { project_ids: null });
    expect((await c.works.list()).items).toHaveLength(4);
  });
});

describe('token activity (QC-089)', () => {
  it('records changes and refused requests, not plain reads; owner only', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T', markdown: TEXT });
    const w = agent(s, ['read', 'write']);
    await w.client.works.get(work.id);
    const ok = await w.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      title: 'T2',
    });
    await apiError(
      w.client.works.patch(work.id, { base_revision: work.current_revision_id, title: 'T3' }),
    );
    await apiError(
      w.client.works.patch(work.id, { base_revision: ok.current_revision_id, markdown: 'x' }),
    );
    await apiError(w.client.backups.list());

    const page = await s.client.tokens.activity(w.id, { limit: 3 });
    expect(page.items.map((a) => [a.method, a.route, a.status, a.result, a.code])).toEqual([
      ['GET', '/api/v1/backups', 403, 'rejected', 'forbidden'],
      ['PATCH', '/api/v1/works/:id', 403, 'rejected', 'direct_edit_not_allowed'],
      ['PATCH', '/api/v1/works/:id', 409, 'rejected', 'revision_conflict'],
    ]);
    expect(page.next_before).not.toBeNull();
    const rest = await s.client.tokens.activity(w.id, { before: page.next_before ?? 0 });
    expect(rest.items).toEqual([
      expect.objectContaining({
        kind: 'request',
        target_type: 'work',
        target_id: work.id,
        status: 200,
        result: 'ok',
        revision: ok.current_revision_id,
      }),
    ]);
    expect(rest.next_before).toBeNull();

    // change_log names who did it.
    const updates = (await s.client.changes()).items.filter((e) => e.action === 'work.updated');
    expect(updates.map((e) => e.actor)).toEqual([w.id]);
    expect((await s.client.changes()).items[0]?.actor).toBe('owner');

    const notOwner = await apiError(w.client.tokens.activity(w.id));
    expect(notOwner.status).toBe(403);
  });

  it('validates token updates', async () => {
    const s = await start();
    const w = agent(s, ['read']);
    const unknown = await apiError(
      s.client.tokens.update(w.id, { project_ids: ['00000000-0000-4000-8000-000000000000'] }),
    );
    expect(unknown.status).toBe(404);
    const scoped = await s.client.tokens.update(w.id, { scopes: ['read', 'propose'] });
    expect(scoped.scopes).toEqual(['propose', 'read']);
    const res = await fetch(`${s.baseUrl}/api/v1/tokens/${w.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${w.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ allow_direct_body_edit: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe('migration 0021 rollback', () => {
  it('drops proposals and activity, cleans scopes and events, and re-applies', () => {
    const home = makeTempHome();
    dirs.push(home);
    const upTo0021 = migrations.filter((m) => m.id <= '0021');
    const db = openDatabase(path.join(home, 'db.sqlite'), upTo0021);
    try {
      db.prepare(
        `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, created_at, allow_direct_body_edit)
         VALUES ('t1', 'a', 'chk_', 'h1', '["propose","read"]', 'now', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO change_log (entity, entity_id, action, data, created_at, actor)
         VALUES ('work', 'w', 'proposal.created', '{}', 'now', 't1'),
                ('work', 'w', 'work.updated', '{}', 'now', 't1')`,
      ).run();
      db.exec(AGENT_PROPOSALS_ROLLBACK_SQL);
      const tables = db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name);
      expect(tables).not.toContain('proposals');
      expect(tables).not.toContain('token_activity');
      expect(
        db.prepare<[], { scopes: string }>("SELECT scopes FROM api_tokens WHERE id = 't1'").get(),
      ).toEqual({ scopes: '["read"]' });
      expect(db.prepare<[], { action: string }>('SELECT action FROM change_log').all()).toEqual([
        { action: 'work.updated' },
      ]);
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('revisions')")
        .all()
        .map((c) => c.name);
      expect(cols).not.toContain('agent_token_id');
      expect(runMigrations(db, upTo0021)).toEqual(['0021']);
    } finally {
      db.close();
    }
  });
});
