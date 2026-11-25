import {
  AgentActivityResponseSchema,
  AgentStatusReportResponseSchema,
  type AgentActivityQuery,
  type AgentActivityResponse,
  type AgentStatusReportRequest,
  type AgentStatusReportResponse,
} from '@qiu-creator/contracts';
import { call, type Ctx } from './imports.js';

/** Agent live status (QC-096). */
export interface CreatorHubAgentsApi {
  /** Owner only: non-idle (agent, work) entries and the sidebar counts. */
  activity(query?: AgentActivityQuery): Promise<AgentActivityResponse>;
  /** Agent tokens: report the state (and a short step) on works they may touch. */
  report(input: AgentStatusReportRequest): Promise<AgentStatusReportResponse>;
}

export function createAgentsApi(ctx: Ctx): CreatorHubAgentsApi {
  return {
    activity: (q = {}) => {
      const ids = q.work_ids ?? [];
      const qs = ids.length > 0 ? `?work_ids=${ids.map(encodeURIComponent).join(',')}` : '';
      return call(ctx, AgentActivityResponseSchema, 'GET', `/api/v1/agents/activity${qs}`);
    },
    report: (input) =>
      call(ctx, AgentStatusReportResponseSchema, 'POST', '/api/v1/agents/status', input),
  };
}
