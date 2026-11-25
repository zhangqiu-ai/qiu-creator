import { describe, expect, it } from 'vitest';
import {
  AgentLiveStore,
  agentsName,
  cleanStep,
  DONE_FOR_MS,
  FixedSource,
  IDLE_AFTER_MS,
  liveView,
  snapshotOf,
  STALE_AFTER_MS,
  type WorkLiveRecord,
} from '../src/renderer/agent-live.js';

/** QC-097 (PT-20261125-001): agents at work, the pure parts. */

const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const cc = { token_id: 't-cc', name: 'Claude Code' };
const cx = { token_id: 't-cx', name: 'Codex' };

const rec = (over: Partial<WorkLiveRecord> & { work_id: string }): WorkLiveRecord => ({
  state: 'working',
  agents: [cc],
  step: null,
  updated_at: ago(5_000),
  ...over,
});

describe('a work’s live state over time', () => {
  it('working turns 「可能已停止」 after 2 minutes and idle after 10', () => {
    expect(liveView(rec({ work_id: 'w' }), NOW)?.state).toBe('working');
    const silent = liveView(rec({ work_id: 'w', updated_at: ago(STALE_AFTER_MS + 61_000) }), NOW);
    expect(silent).toMatchObject({ state: 'stale', silentMinutes: 3 });
    expect(liveView(rec({ work_id: 'w', updated_at: ago(IDLE_AFTER_MS) }), NOW)).toBeNull();
  });

  it('剛完成 lasts 8 seconds; 需要你處理 and errors stay until handled', () => {
    expect(liveView(rec({ work_id: 'w', state: 'done', updated_at: ago(3_000) }), NOW)?.state).toBe(
      'done',
    );
    expect(
      liveView(rec({ work_id: 'w', state: 'done', updated_at: ago(DONE_FOR_MS) }), NOW),
    ).toBeNull();
    const old = ago(IDLE_AFTER_MS * 3);
    expect(
      liveView(rec({ work_id: 'w', state: 'needs_attention', updated_at: old }), NOW)?.state,
    ).toBe('needs_attention');
    expect(liveView(rec({ work_id: 'w', state: 'error', updated_at: old }), NOW)?.state).toBe(
      'error',
    );
  });

  it('shows nothing for idle or without an agent', () => {
    expect(liveView(rec({ work_id: 'w', state: 'idle' }), NOW)).toBeNull();
    expect(liveView(rec({ work_id: 'w', agents: [] }), NOW)).toBeNull();
  });
});

describe('the agent’s step is data', () => {
  it('one line, no control characters, at most 24 characters', () => {
    expect(cleanStep('  配圖\n生成中\u0007 ')).toBe('配圖 生成中');
    expect(cleanStep('一'.repeat(30))).toBe(`${'一'.repeat(23)}…`);
    expect(cleanStep('   ')).toBeNull();
    expect(cleanStep(null)).toBeNull();
  });

  it('names several agents as 「X 等 N 個」', () => {
    const more = (name: string, n: number) => `${name} 等 ${String(n)} 個`;
    expect(agentsName([cc], more)).toBe('Claude Code');
    expect(agentsName([cc, cx], more)).toBe('Claude Code 等 2 個');
  });
});

describe('counts for the sidebar and the ring limit', () => {
  it('counts distinct working agents overall and per project, and lists their works', () => {
    const snap = snapshotOf(
      [
        rec({ work_id: 'a', work_title: '京都', project_ids: ['p1'], agents: [cc] }),
        rec({ work_id: 'b', work_title: '書房', project_ids: ['p1'], agents: [cc, cx] }),
        rec({ work_id: 'c', project_ids: ['p2'], agents: [cx], state: 'needs_attention' }),
        rec({
          work_id: 'd',
          project_ids: ['p2'],
          agents: [cx],
          updated_at: ago(STALE_AFTER_MS + 1),
        }),
      ],
      NOW,
    );
    expect(snap.working).toBe(2);
    expect(snap.byProject).toEqual({ p1: 2 });
    expect(snap.workingWorks).toBe(2);
    expect(snap.works.size).toBe(4);
    expect(snap.agents.find((a) => a.agent.token_id === 't-cc')?.works).toEqual([
      { id: 'a', title: '京都' },
      { id: 'b', title: '書房' },
    ]);
  });
});

describe('the live store', () => {
  it('re-reads on a source change and re-derives as time passes', async () => {
    let now = NOW;
    const source = new FixedSource();
    const store = new AgentLiveStore(source, () => now);
    const seen: number[] = [];
    const off = store.subscribe(() => {
      seen.push(store.getSnapshot().works.size);
    });
    source.set([rec({ work_id: 'w', state: 'done', updated_at: ago(1_000) })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().works.get('w')?.state).toBe('done');
    now += DONE_FOR_MS;
    store.derive();
    expect(store.getSnapshot().works.size).toBe(0);
    expect(seen.at(-1)).toBe(0);
    off();
  });
});
