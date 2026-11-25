import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AgentActivity,
  AgentActivityCounts,
  AgentActivityEvent,
  AgentActivityResponse,
  ChangeEvent,
} from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventRelay } from '../src/main/event-relay.js';
import { readEventStream } from '../src/main/sse.js';
import { liveView, snapshotOf } from '../src/renderer/agent-live.js';
import {
  countsOf,
  groupActivity,
  ServiceLiveSource,
  type ActivityFeed,
} from '../src/renderer/agent-live-service.js';
import type { EventStreamStatus } from '../src/shared/bridge.js';

/** QC-097 on the QC-096 service: grouping entries per work, the source, and the SSE path. */

const T0 = '2026-11-25T10:00:00.000Z';
const at = (s: number): string => new Date(Date.parse(T0) + s * 1000).toISOString();

const entry = (
  over: Partial<AgentActivity> & { token_id: string; work_id: string },
): AgentActivity => ({
  agent_name: over.token_id === 'cc' ? 'Claude Code' : 'Codex',
  state: 'working',
  reason: 'operation',
  step: null,
  last_active_at: at(0),
  expires_at: at(120),
  ...over,
});

const COUNTS: AgentActivityCounts = {
  all: { agents: 2, works: 1 },
  projects: [{ project_id: 'p1', agents: 2, works: 1 }],
};

describe('per-work records from per-(agent, work) entries', () => {
  it('shows the state that needs you first, its agents newest first, and the newest step', () => {
    const records = groupActivity(
      [
        entry({ token_id: 'cc', work_id: 'w1', step: '配圖生成中', last_active_at: at(5) }),
        entry({ token_id: 'cx', work_id: 'w1', step: null, last_active_at: at(9) }),
        entry({ token_id: 'cc', work_id: 'w2', state: 'working' }),
        entry({
          token_id: 'cx',
          work_id: 'w2',
          state: 'needs_attention',
          reason: 'proposal_pending',
          expires_at: null,
        }),
        entry({ token_id: 'cc', work_id: 'w3', state: 'idle' }),
      ],
      new Map([['w1', { title: '京都', project_ids: ['p1'] }]]),
      T0,
    );
    expect(records.map((r) => r.work_id)).toEqual(['w1', 'w2']);
    const w1 = records[0];
    expect(w1).toMatchObject({
      state: 'working',
      agents: [
        { token_id: 'cx', name: 'Codex' },
        { token_id: 'cc', name: 'Claude Code' },
      ],
      step: '配圖生成中',
      updated_at: at(9),
      work_title: '京都',
      project_ids: ['p1'],
      server: true,
    });
    expect(records[1]).toMatchObject({
      state: 'needs_attention',
      agents: [{ token_id: 'cx' }],
      expires_at: null,
    });
  });

  it('trusts the service’s state and counts; only a done fades by its expiry', () => {
    const [stale] = groupActivity(
      [entry({ token_id: 'cc', work_id: 'w', state: 'stale', last_active_at: at(0) })],
      new Map(),
      T0,
    );
    // Twenty minutes later the app still shows what the service said (it will push idle).
    expect(stale === undefined ? null : liveView(stale, Date.parse(at(1200)))?.state).toBe('stale');
    const [done] = groupActivity(
      [entry({ token_id: 'cc', work_id: 'w', state: 'done', expires_at: at(8) })],
      new Map(),
      T0,
    );
    expect(done === undefined ? null : liveView(done, Date.parse(at(7)))?.state).toBe('done');
    expect(done === undefined ? 'x' : liveView(done, Date.parse(at(8)))).toBeNull();
    expect(countsOf(COUNTS)).toEqual({ working: 2, workingWorks: 1, byProject: { p1: 2 } });
    const snap = snapshotOf(done === undefined ? [] : [done], Date.parse(at(1)), countsOf(COUNTS));
    expect(snap.working).toBe(2);
    expect(snap.byProject).toEqual({ p1: 2 });
  });
});

describe('the service source', () => {
  function fakes(responses: AgentActivityResponse[]) {
    let activity: ((e: AgentActivityEvent) => void) | null = null;
    let status: ((s: EventStreamStatus) => void) | null = null;
    const feed: ActivityFeed = {
      onAgentActivity: (l) => {
        activity = l;
        return () => {
          activity = null;
        };
      },
      onEventStatus: (l) => {
        status = l;
        return () => {
          status = null;
        };
      },
    };
    const calls: number[] = [];
    const client = {
      agents: {
        activity: () => {
          calls.push(1);
          const next = responses.shift();
          return next === undefined ? Promise.reject(new Error('none')) : Promise.resolve(next);
        },
      },
      works: {
        list: () => Promise.resolve({ items: [], next_cursor: null, total: 0 }),
      },
    } as unknown as CreatorHubClient;
    return {
      client,
      feed,
      calls,
      push: (e: AgentActivityEvent) => activity?.(e),
      status: (s: EventStreamStatus) => status?.(s),
    };
  }

  it('reads once, follows events (idle removes), and reads again after a reconnect', async () => {
    const f = fakes([
      { items: [entry({ token_id: 'cc', work_id: 'w1' })], counts: COUNTS, now: T0 },
      { items: [], counts: { all: { agents: 0, works: 0 }, projects: [] }, now: at(60) },
    ]);
    const source = new ServiceLiveSource(f.client, f.feed);
    let changes = 0;
    const off = source.watch(() => {
      changes++;
    });
    expect((await source.load()).map((r) => r.work_id)).toEqual(['w1']);
    expect(source.counts()).toEqual({ working: 2, workingWorks: 1, byProject: { p1: 2 } });
    f.push({
      type: 'agent.activity',
      activity: entry({ token_id: 'cx', work_id: 'w2' }),
      counts: COUNTS,
      at: at(5),
    });
    expect((await source.load()).map((r) => r.work_id).sort()).toEqual(['w1', 'w2']);
    f.push({
      type: 'agent.activity',
      activity: entry({ token_id: 'cc', work_id: 'w1', state: 'idle', expires_at: null }),
      counts: COUNTS,
      at: at(6),
    });
    expect((await source.load()).map((r) => r.work_id)).toEqual(['w2']);
    expect(changes).toBe(2);
    expect(f.calls).toHaveLength(1);
    // The stream dropped and came back: nothing was replayed, so read again.
    f.status('open');
    f.status('reconnecting');
    f.status('open');
    await vi.waitFor(() => {
      expect(f.calls).toHaveLength(2);
    });
    expect(await source.load()).toEqual([]);
    off();
  });
});

describe('agent.activity over the event stream (against mac-server)', () => {
  const TOKEN = 'test-token-0123456789abcdef';
  let server: CreatorHubServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    await server?.app.close();
    if (home !== undefined) fs.rmSync(home, { recursive: true, force: true });
  });

  it('passes agent.activity blocks on without moving the change sequence', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-live-'));
    server = await buildServer({ config: { home, token: TOKEN } });
    const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const owner = createClient({ baseUrl, token: TOKEN });
    const work = await owner.works.create({ title: '京都', type: 'article', markdown: 'a\n' });
    const agent = server.tokens.create({ name: 'Claude Code', scopes: ['read', 'propose'] });
    const agentClient = createClient({ baseUrl, token: agent.secret });

    const changes: ChangeEvent[] = [];
    const live: AgentActivityEvent[] = [];
    const relay = new EventRelay({
      connect: () => (handlers, options) =>
        readEventStream({ baseUrl, token: TOKEN, ...options }, handlers),
      onEvent: (e) => changes.push(e),
      onStatus: () => undefined,
      onAgentActivity: (e) => live.push(e),
      backoffMs: [20],
    });
    relay.start();
    await vi.waitFor(() => {
      expect(relay.currentStatus).toBe('open');
    });
    await agentClient.agents.report({ work_ids: [work.id], state: 'working', step: '配圖生成中' });
    await vi.waitFor(() => {
      expect(
        live.some((e) => e.activity.work_id === work.id && e.activity.state === 'working'),
      ).toBe(true);
    });
    const ev = live.find((e) => e.activity.work_id === work.id);
    expect(ev?.activity).toMatchObject({ agent_name: 'Claude Code', step: '配圖生成中' });
    expect(ev?.counts.all.agents).toBe(1);
    // A change event after it still arrives in order.
    const second = await owner.works.create({ title: 'B', type: 'article', markdown: 'b\n' });
    await vi.waitFor(() => {
      expect(changes.some((e) => e.entity_id === second.id)).toBe(true);
    });
    const now = await owner.agents.activity({ work_ids: [work.id] });
    expect(now.items[0]).toMatchObject({ token_id: agent.token.id, state: 'working' });
    relay.stop();
  });
});
