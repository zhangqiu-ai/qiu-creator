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
    description: `Tell the user what you are doing on one or more works; it shows live on their cards. \`step\` is one short line of plain text (at most ${String(AGENT_STEP_MAX_CHARS)} characters; links, markup and paths are removed). Report "working" when you start, with what you are doing as the step (e.g. "整理段落"); "done" when finished, with a one-line result as the step (e.g. "已新建並上傳 6 張圖片"; shown for 8 seconds); "error" when it failed, with what went wrong (e.g. "圖片下載失敗（2 張）"); or "needs_attention" when the user must act. A report lasts ttl_seconds (default ${String(AGENT_REPORT_TTL_DEFAULT_SECONDS)}, at most ${String(AGENT_REPORT_TTL_MAX_SECONDS)}): report again before it ends while you keep working. Your edits, imports and proposals already show you as working; reporting adds the step and the result. Needs import, write or propose; only works you may touch.`,
    inputSchema: {
      work_id: IdSchema.optional().describe('One work; or use work_ids'),
      work_ids: z
        .array(IdSchema)
        .min(1)
        .max(AGENT_STATUS_WORKS_MAX)
        .optional()
        .describe(`Several works (at most ${String(AGENT_STATUS_WORKS_MAX)})`),
      state: AgentReportStateSchema,
      step: z
        .string()
        .max(200)
        .optional()
        .describe('Working: what you are doing now. Done or error: the result in one line.'),
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
