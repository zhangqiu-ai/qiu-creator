import {
  AGENT_REPORT_TTL_DEFAULT_SECONDS,
  AGENT_REPORT_TTL_MAX_SECONDS,
  AGENT_STATUS_WORKS_MAX,
  AGENT_STEP_MAX_CHARS,
  AgentReportStateSchema,
  IdSchema,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { tool, type McpToolDef } from './define.js';

/**
 * QC-096: an agent says what it is doing, so the user sees it live on the
 * work's card. Always enabled (core), like server_status.
 */
export const AGENT_STATUS_TOOLS: readonly McpToolDef[] = [
  tool({
    name: 'agent_status_report',
    group: 'core',
    access: 'report',
    routes: ['POST /api/v1/agents/status'],
    description: `Tell the user what you are doing on one or more works; it shows live on their cards. Report state "working" when you start (with a short step such as "整理段落", at most ${String(AGENT_STEP_MAX_CHARS)} characters, plain text only: links, markup and paths are removed), "done" when finished (shown for 8 seconds), "needs_attention" when the user must act, or "error". A report lasts ttl_seconds (default ${String(AGENT_REPORT_TTL_DEFAULT_SECONDS)}, at most ${String(AGENT_REPORT_TTL_MAX_SECONDS)}): report again before it ends while you keep working. Your edits, imports and proposals already show you as working; reporting adds the step and the end. Needs import, write or propose; only works you may touch.`,
    inputSchema: {
      work_id: IdSchema.optional().describe('One work; or use work_ids'),
      work_ids: z
        .array(IdSchema)
        .min(1)
        .max(AGENT_STATUS_WORKS_MAX)
        .optional()
        .describe(`Several works (at most ${String(AGENT_STATUS_WORKS_MAX)})`),
      state: AgentReportStateSchema,
      step: z.string().max(200).optional().describe('What you are doing now, very short'),
      ttl_seconds: z.number().int().min(5).max(AGENT_REPORT_TTL_MAX_SECONDS).optional(),
    },
    run: async (client, args) => {
      const ids = [...(args.work_id === undefined ? [] : [args.work_id]), ...(args.work_ids ?? [])];
      if (ids.length === 0) throw new Error('give work_id or work_ids');
      return client.agents.report({
        work_ids: [...new Set(ids)],
        state: args.state,
        ...(args.step === undefined ? {} : { step: args.step }),
        ...(args.ttl_seconds === undefined ? {} : { ttl_seconds: args.ttl_seconds }),
      });
    },
  }),
];
