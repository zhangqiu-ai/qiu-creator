import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTIVITY_QUERY_WORKS_MAX,
  AgentActivityEventSchema,
  AgentActivityQuerySchema,
  AgentStatusReportRequestSchema,
} from '../src/index.js';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';

describe('agent activity contracts (QC-096)', () => {
  it('reads comma-separated work ids, deduped, and rejects bad ones', () => {
    expect(AgentActivityQuerySchema.parse({ work_ids: `${W1}, ${W2},${W1}` })).toEqual({
      work_ids: [W1, W2],
    });
    expect(AgentActivityQuerySchema.parse({})).toEqual({});
    expect(AgentActivityQuerySchema.safeParse({ work_ids: 'nope' }).success).toBe(false);
    const many = Array.from(
      { length: AGENT_ACTIVITY_QUERY_WORKS_MAX + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');
    expect(AgentActivityQuerySchema.safeParse({ work_ids: many }).success).toBe(false);
  });

  it('defaults the report TTL and bounds it', () => {
    expect(AgentStatusReportRequestSchema.parse({ work_ids: [W1], state: 'working' })).toEqual({
      work_ids: [W1],
      state: 'working',
      ttl_seconds: 120,
    });
    expect(
      AgentStatusReportRequestSchema.safeParse({
        work_ids: [W1],
        state: 'working',
        ttl_seconds: 901,
      }).success,
    ).toBe(false);
    expect(
      AgentStatusReportRequestSchema.safeParse({ work_ids: [W1], state: 'stale' }).success,
    ).toBe(false);
    expect(AgentStatusReportRequestSchema.safeParse({ work_ids: [], state: 'done' }).success).toBe(
      false,
    );
  });

  it('describes the SSE event', () => {
    const at = '2026-11-25T08:00:00.000Z';
    expect(
      AgentActivityEventSchema.parse({
        type: 'agent.activity',
        activity: {
          token_id: W2,
          agent_name: 'Claude Code',
          work_id: W1,
          state: 'idle',
          reason: 'none',
          step: null,
          last_active_at: at,
          expires_at: null,
        },
        counts: { all: { agents: 0, works: 0 }, projects: [] },
        at,
      }).activity.state,
    ).toBe('idle');
  });
});
