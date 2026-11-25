import { z } from 'zod';
import { IdSchema, TimestampSchema } from './entities.js';

/**
 * Agent live status (QC-096, PT-20261125-001). For each (agent token, work)
 * the service derives a state from the token's recent write, import and
 * propose operations, and agents may report a state and a short step with
 * `POST /api/v1/agents/status` (MCP `agent_status_report`). State lives in
 * the service's memory: after a restart everything is idle again, except
 * pending proposals (needs_attention), which come from the database.
 */

/** Thresholds (seconds). The client never recomputes them; `expires_at` says when a state lapses. */
export const AGENT_WORKING_WINDOW_SECONDS = 60;
export const AGENT_STALE_AFTER_SECONDS = 120;
export const AGENT_IDLE_AFTER_SECONDS = 600;
/** How long a `done` report is shown before it fades (decision 2026-11-25, 4). */
export const AGENT_DONE_HOLD_SECONDS = 8;
export const AGENT_REPORT_TTL_DEFAULT_SECONDS = 120;
export const AGENT_REPORT_TTL_MAX_SECONDS = 900;
/** A reported step is shown as data, at most this many characters (code points). */
export const AGENT_STEP_MAX_CHARS = 24;
/** Works in one report or one activity query. */
export const AGENT_STATUS_WORKS_MAX = 50;
export const AGENT_ACTIVITY_QUERY_WORKS_MAX = 200;

/**
 * - `working`: an operation in the last 60 s, a valid `working` report, or
 *   (no report) the last operation less than 2 min ago.
 * - `done`: reported done; shown for 8 s.
 * - `needs_attention`: a proposal of this agent on the work waits for the user,
 *   or the agent reported it.
 * - `error`: an import the agent started for the work failed (until it is
 *   retried or succeeds), or the agent reported it.
 * - `stale`: no operation or valid report for 2–10 min after working
 *   (「可能已停止」).
 * - `idle`: nothing to show. Only appears in events (the entry went away);
 *   lists leave idle entries out.
 */
export const AgentActivityStateSchema = z.enum([
  'working',
  'done',
  'needs_attention',
  'error',
  'stale',
  'idle',
]);
export type AgentActivityState = z.infer<typeof AgentActivityStateSchema>;

/** States an agent may report. */
export const AgentReportStateSchema = z.enum(['working', 'done', 'needs_attention', 'error']);
export type AgentReportState = z.infer<typeof AgentReportStateSchema>;

/** Why the entry has its state. */
export const AgentActivityReasonSchema = z.enum([
  /** A recent write, import or propose operation. */
  'operation',
  /** The agent's own report. */
  'report',
  /** A pending proposal. */
  'proposal_pending',
  /** A failed import. */
  'job_failed',
  /** Nothing recent (stale or idle). */
  'none',
]);
export type AgentActivityReason = z.infer<typeof AgentActivityReasonSchema>;

export const AgentActivitySchema = z.object({
  token_id: IdSchema,
  /** The agent token's name, as the user named it. */
  agent_name: z.string(),
  work_id: IdSchema,
  state: AgentActivityStateSchema,
  reason: AgentActivityReasonSchema,
  /**
   * The step the agent reported (≤ 24 characters, control characters, links
   * and markup removed): what it is doing while working, or a one-line result
   * on done, needs_attention and error (QC-098). Agent-written: show as plain
   * text. Null unless a valid report has one; derived states never have one.
   */
  step: z.string().nullable(),
  /** Last operation or report of this agent on this work. */
  last_active_at: TimestampSchema.nullable(),
  /** When this state lapses unless something new happens (null: until handled). */
  expires_at: TimestampSchema.nullable(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

/** Number of distinct agents with `working` state, and of works they work on. */
export const AgentActivityCountSchema = z.object({
  agents: z.number().int().nonnegative(),
  works: z.number().int().nonnegative(),
});
export type AgentActivityCount = z.infer<typeof AgentActivityCountSchema>;

/** Sidebar counts: 全部作品 and each project with at least one working agent. */
export const AgentActivityCountsSchema = z.object({
  all: AgentActivityCountSchema,
  projects: z.array(AgentActivityCountSchema.extend({ project_id: IdSchema })),
});
export type AgentActivityCounts = z.infer<typeof AgentActivityCountsSchema>;

/**
 * `GET /api/v1/agents/activity?work_ids=a,b,…` (owner): current non-idle
 * entries, for those works or all of them, plus the sidebar counts.
 */
export const AgentActivityQuerySchema = z.object({
  /** Comma-separated work ids; omitted = every work with activity. */
  work_ids: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const ids = [...new Set(v.split(',').map((s) => s.trim()))].filter((s) => s !== '');
      if (ids.length > AGENT_ACTIVITY_QUERY_WORKS_MAX) {
        ctx.addIssue({
          code: 'custom',
          message: `at most ${String(AGENT_ACTIVITY_QUERY_WORKS_MAX)} work ids`,
        });
        return z.NEVER;
      }
      for (const id of ids) {
        if (!IdSchema.safeParse(id).success) {
          ctx.addIssue({ code: 'custom', message: `not a work id: ${id}` });
          return z.NEVER;
        }
      }
      return ids;
    }),
});
export interface AgentActivityQuery {
  work_ids?: readonly string[];
}

export const AgentActivityResponseSchema = z.object({
  items: z.array(AgentActivitySchema),
  counts: AgentActivityCountsSchema,
  /** Server time, so a client can place `expires_at` on its own clock. */
  now: TimestampSchema,
});
export type AgentActivityResponse = z.infer<typeof AgentActivityResponseSchema>;

/**
 * `POST /api/v1/agents/status` (MCP `agent_status_report`): an agent token
 * with `import`, `write` or `propose` reports its state on works it may
 * touch. `step` is cleaned server-side (control characters, links and
 * markup removed, cut to 24 characters). `done` shows for 8 s; other states
 * last `ttl_seconds` (default 120, at most 900) unless reported again.
 */
export const AgentStatusReportRequestSchema = z.object({
  work_ids: z.array(IdSchema).min(1).max(AGENT_STATUS_WORKS_MAX),
  state: AgentReportStateSchema,
  step: z.string().max(500).optional(),
  ttl_seconds: z
    .number()
    .int()
    .min(5)
    .max(AGENT_REPORT_TTL_MAX_SECONDS)
    .default(AGENT_REPORT_TTL_DEFAULT_SECONDS),
});
export type AgentStatusReportRequest = z.input<typeof AgentStatusReportRequestSchema>;

export const AgentStatusReportResponseSchema = z.object({
  items: z.array(AgentActivitySchema),
});
export type AgentStatusReportResponse = z.infer<typeof AgentStatusReportResponseSchema>;

/** SSE event name on `GET /api/v1/events` (owner streams only). */
export const AGENT_ACTIVITY_EVENT = 'agent.activity';

/**
 * Data of an `agent.activity` SSE block. Unlike change events it has no
 * `id` (not in the change log, no replay): after reconnecting, read
 * `GET /api/v1/agents/activity` again. `activity.state` is `idle` when the
 * entry went away.
 */
export const AgentActivityEventSchema = z.object({
  type: z.literal(AGENT_ACTIVITY_EVENT),
  activity: AgentActivitySchema,
  counts: AgentActivityCountsSchema,
  at: TimestampSchema,
});
export type AgentActivityEvent = z.infer<typeof AgentActivityEventSchema>;
