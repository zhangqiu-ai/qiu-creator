import { randomUUID } from 'node:crypto';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  AgentActivityEventSchema,
  type AgentActivity,
  type AgentActivityEvent,
} from '@qiu-creator/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentActivityService,
  cleanStep,
  DONE_HOLD_MS,
  IDLE_AFTER_MS,
  STALE_AFTER_MS,
  WORKING_WINDOW_MS,
} from '../src/agents/agent-activity.js';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A server whose agent-status clock the test moves; lapses are re-evaluated with `tick()`. */
async function start(): Promise<{
  s: TestServer;
  clock: { t: number };
  advance: (ms: number) => void;
}> {
  const clock = { t: Date.parse('2026-11-25T08:00:00.000Z') };
  const s = await startTestServer({ agentActivity: { now: () => clock.t, timers: false } });
  servers.push(s);
  return {
    s,
    clock,
    advance: (ms) => {
      clock.t += ms;
      s.agentActivity.tick();
    },
  };
}

function agent(
  s: TestServer,
  name: string,
  scopes: ('read' | 'import' | 'write' | 'propose')[],
  projectIds?: string[],
): { id: string; client: CreatorHubClient } {
  const t = s.tokens.create({
    name,
    scopes,
    ...(projectIds === undefined ? {} : { project_ids: projectIds }),
  });
  return { id: t.token.id, client: createClient({ baseUrl: s.baseUrl, token: t.secret }) };
}

const states = (items: readonly AgentActivity[]): [string, string, string][] =>
  items.map((i) => [i.work_id, i.state, i.reason]);

/** The change feed publishes on a microtask; let it run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('cleanStep (QC-096)', () => {
  it('keeps a short plain step and removes controls, links, markup and paths', () => {
    expect(cleanStep('整理段落')).toBe('整理段落');
    expect(cleanStep(undefined)).toBeNull();
    expect(cleanStep('  \u0007‮ ')).toBeNull();
    expect(cleanStep('看 [這裡](https://x.example/a) 與 www.y.example')).toBe('看 這裡 與');
    expect(cleanStep('**粗體** <script>x</script> `code` #標題')).toBe('粗體 x code 標題');
    expect(cleanStep('讀 /Users/me/私密.md 和 ~/Desktop/a')).toBe('讀 和');
    expect(cleanStep('第一行\n第二行\t第三行')).toBe('第一行 第二行 第三行');
    const long = cleanStep('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十');
    expect(Array.from(long ?? '')).toHaveLength(24);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('derived state (QC-096)', () => {
  it('working for 60 s after an operation, still working until 2 min, then stale, then idle', async () => {
    const { s, advance } = await start();
    const writer = agent(s, 'Writer', ['read', 'write']);
    const work = await s.client.works.create({ title: '草稿' });
    await writer.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      title: '改過',
    });
    await settle();

    let now = await s.client.agents.activity();
    expect(states(now.items)).toEqual([[work.id, 'working', 'operation']]);
    expect(now.items[0]?.agent_name).toBe('Writer');
    expect(now.counts).toEqual({ all: { agents: 1, works: 1 }, projects: [] });

    advance(WORKING_WINDOW_MS + 1000);
    expect(states((await s.client.agents.activity()).items)).toEqual([
      [work.id, 'working', 'operation'],
    ]);
    advance(STALE_AFTER_MS - WORKING_WINDOW_MS);
    now = await s.client.agents.activity();
    expect(states(now.items)).toEqual([[work.id, 'stale', 'none']]);
    expect(now.counts.all).toEqual({ agents: 0, works: 0 });
    advance(IDLE_AFTER_MS - STALE_AFTER_MS);
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('the owner editing in the app is not an agent', async () => {
    const { s } = await start();
    const work = await s.client.works.create({ title: '我的' });
    await s.client.works.patch(work.id, { base_revision: work.current_revision_id, title: '我改' });
    await settle();
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('a pending proposal needs attention once the agent is quiet, until the user decides', async () => {
    const { s, advance } = await start();
    const proposer = agent(s, 'Proposer', ['read', 'propose']);
    const work = await s.client.works.create({ title: '提案', markdown: '一\n' });
    const proposal = await proposer.client.proposals.create(
      work.id,
      { base_revision: work.current_revision_id, markdown: '一\n二\n' },
      { idempotencyKey: `proposal-${randomUUID()}` },
    );
    await settle();
    expect(states((await s.client.agents.activity()).items)).toEqual([
      [work.id, 'working', 'operation'],
    ]);
    advance(WORKING_WINDOW_MS);
    const waiting = (await s.client.agents.activity()).items[0];
    expect(waiting).toMatchObject({ state: 'needs_attention', reason: 'proposal_pending' });
    expect(waiting?.expires_at).toBeNull();
    advance(IDLE_AFTER_MS * 2);
    expect(states((await s.client.agents.activity()).items)).toEqual([
      [work.id, 'needs_attention', 'proposal_pending'],
    ]);

    await s.client.proposals.discard(proposal.id);
    await settle();
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('a failed import the agent started is an error until it is retried', async () => {
    const { s, advance } = await start();
    const importer = agent(s, 'Importer', ['read', 'import']);
    const work = await s.client.works.create({ title: '匯入' });
    // A URL import this agent queued for the work, then failed (no network in tests).
    const jobId = randomUUID();
    const at = new Date().toISOString();
    s.db
      .prepare(
        `INSERT INTO import_jobs (id, method, status, progress, retry_count, created_at, updated_at,
           url, link_work_id, created_by)
         VALUES (?, 'url', 'failed', 0, 0, ?, ?, 'https://example.com/a.png', ?, ?)`,
      )
      .run(jobId, at, at, work.id, importer.id);
    s.feed.record('job', jobId, 'job.failed', { type: 'import', error_code: 'url_rejected' });
    await settle();
    advance(WORKING_WINDOW_MS);
    expect(states((await s.client.agents.activity()).items)).toEqual([
      [work.id, 'error', 'job_failed'],
    ]);
    advance(IDLE_AFTER_MS * 2);
    expect(states((await s.client.agents.activity()).items)).toEqual([
      [work.id, 'error', 'job_failed'],
    ]);
    s.feed.record('job', jobId, 'job.succeeded', { type: 'import' });
    await settle();
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('counts agents per project for the sidebar', async () => {
    const { s } = await start();
    const a = agent(s, 'A', ['write']);
    const b = agent(s, 'B', ['write']);
    const project = await s.client.projects.create({ name: '京都' });
    const inProject = await s.client.works.create({ title: '在項目', project_ids: [project.id] });
    const outside = await s.client.works.create({ title: '不在' });
    await a.client.agents.report({ work_ids: [inProject.id, outside.id], state: 'working' });
    await b.client.agents.report({ work_ids: [inProject.id], state: 'working' });
    expect((await s.client.agents.activity()).counts).toEqual({
      all: { agents: 2, works: 2 },
      projects: [{ project_id: project.id, agents: 2, works: 1 }],
    });
    const only = await s.client.agents.activity({ work_ids: [outside.id] });
    expect(states(only.items)).toEqual([[outside.id, 'working', 'report']]);
  });
});

describe('POST /api/v1/agents/status (QC-096)', () => {
  it('a working report lasts its TTL; a stopped agent goes stale, then idle', async () => {
    const { s, clock, advance } = await start();
    const a = agent(s, 'Reporter', ['import']);
    const work = await s.client.works.create({ title: '回報' });
    const res = await a.client.agents.report({
      work_ids: [work.id],
      state: 'working',
      step: '整理段落',
      ttl_seconds: 30,
    });
    expect(res.items).toEqual([
      {
        token_id: a.id,
        agent_name: 'Reporter',
        work_id: work.id,
        state: 'working',
        reason: 'report',
        step: '整理段落',
        last_active_at: new Date(clock.t).toISOString(),
        expires_at: new Date(clock.t + 30_000).toISOString(),
      },
    ]);
    advance(30_000);
    // The report ended: no step any more, working until 2 min after it was made.
    expect((await s.client.agents.activity()).items[0]).toMatchObject({
      state: 'working',
      step: null,
    });
    advance(STALE_AFTER_MS - 30_000);
    expect((await s.client.agents.activity()).items[0]?.state).toBe('stale');
    advance(IDLE_AFTER_MS);
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('done shows for 8 s and ends the work before it', async () => {
    const { s, advance } = await start();
    const a = agent(s, 'Finisher', ['write']);
    const work = await s.client.works.create({ title: '完成' });
    await a.client.works.patch(work.id, { base_revision: work.current_revision_id, title: '完' });
    await settle();
    await a.client.agents.report({ work_ids: [work.id], state: 'done', step: '忽略' });
    expect((await s.client.agents.activity()).items[0]).toMatchObject({
      state: 'done',
      step: null,
    });
    advance(DONE_HOLD_MS);
    // The edit before `done` no longer makes it working or stale.
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('an operation after a done report shows working again', async () => {
    const { s, advance } = await start();
    const a = agent(s, 'Again', ['write']);
    const work = await s.client.works.create({ title: '再來' });
    await a.client.agents.report({ work_ids: [work.id], state: 'done' });
    advance(1000);
    const fresh = await s.client.works.get(work.id);
    await a.client.works.patch(work.id, {
      base_revision: fresh.current_revision_id,
      title: '又改',
    });
    await settle();
    expect(states((await s.client.agents.activity()).items)).toEqual([
      [work.id, 'working', 'operation'],
    ]);
  });

  it('checks the token: agents only, report scopes, its projects, live works', async () => {
    const { s } = await start();
    const work = await s.client.works.create({ title: '權限' });
    const raw = (token: string, body: unknown): Promise<Response> =>
      fetch(`${s.baseUrl}/api/v1/agents/status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const code = async (r: Response): Promise<[number, string]> => [
      r.status,
      ((await r.json()) as { error: { code: string } }).error.code,
    ];

    expect(await code(await raw(TEST_TOKEN, { work_ids: [work.id], state: 'working' }))).toEqual([
      403,
      'forbidden',
    ]);
    const reader = s.tokens.create({ name: 'reader', scopes: ['read'] });
    expect(await code(await raw(reader.secret, { work_ids: [work.id], state: 'working' }))).toEqual(
      [403, 'forbidden'],
    );

    const project = await s.client.projects.create({ name: '限定' });
    const limited = agent(s, 'limited', ['propose'], [project.id]);
    await expect(
      limited.client.agents.report({ work_ids: [work.id], state: 'working' }),
    ).rejects.toMatchObject({ status: 404 });
    const missing = agent(s, 'missing', ['write']);
    await expect(
      missing.client.agents.report({ work_ids: [randomUUID()], state: 'working' }),
    ).rejects.toMatchObject({ status: 404 });
    const writer = s.tokens.create({ name: 'bad input', scopes: ['write'] });
    expect((await raw(writer.secret, { work_ids: [work.id], state: 'stale' })).status).toBe(400);
    expect(
      (await raw(writer.secret, { work_ids: [work.id], state: 'working', ttl_seconds: 901 }))
        .status,
    ).toBe(400);

    // Nothing was recorded for refused reports.
    expect((await s.client.agents.activity()).items).toEqual([]);
  });

  it('is shown live, not written to the activity log; refused ones are logged', async () => {
    const { s } = await start();
    const a = agent(s, 'Quiet', ['write']);
    const work = await s.client.works.create({ title: '記錄' });
    await a.client.agents.report({ work_ids: [work.id], state: 'working' });
    await expect(
      a.client.agents.report({ work_ids: [randomUUID()], state: 'working' }),
    ).rejects.toMatchObject({ status: 404 });
    const log = s.activity.list(a.id, { limit: 50 });
    expect(log.items.map((e) => [e.route, e.result])).toEqual([
      ['/api/v1/agents/status', 'rejected'],
    ]);
  });

  it('a revoked token disappears from the activity', async () => {
    const { s } = await start();
    const a = agent(s, 'Gone', ['write']);
    const work = await s.client.works.create({ title: '撤銷' });
    await a.client.agents.report({ work_ids: [work.id], state: 'working' });
    await s.client.tokens.revoke(a.id);
    expect((await s.client.agents.activity()).items).toEqual([]);
  });
});

describe('GET /api/v1/agents/activity and agent.activity events (QC-096)', () => {
  it('is owner only and validates work ids', async () => {
    const { s } = await start();
    const a = agent(s, 'reader', ['read', 'write']);
    await expect(a.client.agents.activity()).rejects.toMatchObject({ status: 403 });
    const bad = await fetch(`${s.baseUrl}/api/v1/agents/activity?work_ids=nope`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('pushes agent.activity without an id to the owner stream only, and idle when it ends', async () => {
    const { s, advance } = await start();
    const a = agent(s, 'Streamer', ['write']);
    const agentToken = s.tokens.create({ name: 'listener', scopes: ['read'] });
    const work = await s.client.works.create({ title: '推送' });

    const open = async (token: string) => {
      const controller = new AbortController();
      const res = await fetch(`${s.baseUrl}/api/v1/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      const until = async (match: (t: string) => boolean): Promise<string> => {
        while (!match(text)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        return text;
      };
      return {
        until,
        close: () => {
          controller.abort();
        },
        text: () => text,
      };
    };
    const ownerStream = await open(TEST_TOKEN);
    const agentStream = await open(agentToken.secret);
    await ownerStream.until((t) => t.includes(': connected'));
    await agentStream.until((t) => t.includes(': connected'));

    await a.client.agents.report({ work_ids: [work.id], state: 'done' });
    advance(DONE_HOLD_MS);
    // A change event afterwards, so the agent stream has something to deliver too.
    await s.client.works.patch(work.id, { base_revision: work.current_revision_id, title: '後' });

    const text = await ownerStream.until(
      (t) => /"state":"idle"/.test(t) && t.includes('work.updated'),
    );
    await agentStream.until((t) => t.includes('work.updated'));
    ownerStream.close();
    agentStream.close();

    const blocks = text.split('\n\n').filter((b) => b.includes('event: agent.activity'));
    expect(blocks.every((b) => !/^id:/m.test(b))).toBe(true);
    const events: AgentActivityEvent[] = blocks.map((b) =>
      AgentActivityEventSchema.parse(JSON.parse(b.slice(b.indexOf('data: ') + 6))),
    );
    expect(events.map((e) => [e.activity.state, e.activity.agent_name])).toEqual([
      ['done', 'Streamer'],
      ['idle', 'Streamer'],
    ]);
    expect(events[0]?.counts.all).toEqual({ agents: 0, works: 0 });
    expect(agentStream.text()).not.toContain('agent.activity');
  });
});

describe('timers (QC-096)', () => {
  it('publishes the lapse of a state on its own, without a request', async () => {
    const { s, clock } = await start();
    const a = agent(s, 'Timed', ['write']);
    const work = await s.client.works.create({ title: '計時' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = new AgentActivityService(s.db, s.feed, { now: () => clock.t });
    try {
      const seen: string[] = [];
      service.subscribe((e) => seen.push(e.activity.state));
      service.report(a.id, [work.id], { state: 'done', ttl_seconds: 120 });
      expect(seen).toEqual(['done']);
      clock.t += DONE_HOLD_MS;
      vi.advanceTimersByTime(DONE_HOLD_MS + 10);
      expect(seen).toEqual(['done', 'idle']);
    } finally {
      service.close();
      vi.useRealTimers();
    }
  });
});
