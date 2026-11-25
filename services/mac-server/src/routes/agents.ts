import {
  AgentActivityQuerySchema,
  AgentActivityResponseSchema,
  AgentStatusReportRequestSchema,
  AgentStatusReportResponseSchema,
  ErrorResponseSchema,
} from '@qiu-creator/contracts';
import type { AgentActivityService } from '../agents/agent-activity.js';
import type { ProjectScope } from '../auth/project-scope.js';
import { requirePrincipal } from '../auth/token-service.js';
import { notFound, ServiceError } from '../errors.js';
import type { App } from '../http/app-type.js';
import type { WorkService } from '../works/work-service.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

/** Agent live status (QC-096): the app's initial state and agents' own reports. */
export function registerAgentActivityRoutes(
  app: App,
  agents: AgentActivityService,
  works: WorkService,
  scope: ProjectScope,
  now: () => number = Date.now,
): void {
  app.get(
    '/api/v1/agents/activity',
    {
      schema: {
        description:
          'Owner only. What agents are doing right now: one entry per (agent token, work) that is not idle — working, done (8 s), needs_attention, error or stale — for the given `work_ids` (comma-separated, at most 200) or all works, plus how many agents work in 全部作品 and in each project. Changes arrive as `agent.activity` events on `GET /api/v1/events`.',
        querystring: AgentActivityQuerySchema,
        response: { 200: AgentActivityResponseSchema, ...errors },
      },
    },
    (req) => ({
      ...agents.list(req.query.work_ids),
      now: new Date(now()).toISOString(),
    }),
  );

  app.post(
    '/api/v1/agents/status',
    {
      schema: {
        description:
          'An agent token (with `import`, `write` or `propose`) reports its state on works it may touch: `working` with an optional short `step`, `done` (shown 8 s), `needs_attention` or `error`. A report lasts `ttl_seconds` (default 120, at most 900) unless sent again, so a stopped agent does not stay `working`. `step` is shown to the user as plain data: control characters, links, markup and paths are removed and it is cut to 24 characters. Writes nothing to the works.',
        body: AgentStatusReportRequestSchema,
        response: { 200: AgentStatusReportResponseSchema, ...errors },
      },
    },
    (req) => {
      const p = requirePrincipal(req.principal);
      if (p.kind !== 'agent') {
        throw new ServiceError(403, 'forbidden', 'only agent tokens report their status');
      }
      const workIds = [...new Set(req.body.work_ids)];
      for (const id of workIds) {
        // Outside the token's projects answers like a missing work (QC-089).
        if (!scope.allowsWork(id)) throw notFound('work');
        works.requireActive(id);
      }
      return { items: agents.report(p.id, workIds, req.body) };
    },
  );
}
