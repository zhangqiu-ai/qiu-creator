import { errorBody, type App } from '../http/app-type.js';
import type { ActivityService } from './activity-service.js';
import type { ProjectScope } from './project-scope.js';
import type { Principal } from './token-service.js';

/**
 * Agent-token rules that depend on the request, not just the route
 * (QC-089). Run after authentication and route-level scopes.
 *
 * - Project limits: a token limited to projects gets 404 for works and
 *   projects outside them (as if they did not exist) and 403
 *   `project_scope` when it would create something outside them.
 * - Direct text edits: changing a work's Markdown or description, or
 *   restoring an old revision, needs `allow_direct_body_edit`; otherwise
 *   403 `direct_edit_not_allowed` (propose the change instead).
 * - Activity: every agent request that changes something and every refused
 *   one is recorded for the token.
 */
export function registerAgentRules(
  app: App,
  deps: { scope: ProjectScope; activity: ActivityService },
): void {
  app.decorateRequest('activityError', null);

  app.addHook('preHandler', async (req, reply) => {
    const principal = req.principal;
    const route = req.routeOptions.url;
    if (principal?.kind !== 'agent' || route === undefined) return;
    const deny = (
      status: 403 | 404,
      code: 'project_scope' | 'not_found' | 'direct_edit_not_allowed',
      message: string,
      details?: Record<string, unknown>,
    ) => reply.code(status).send(errorBody(code, message, details));
    const params = req.params as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = `${req.method} ${route}`;

    // ---- direct text edits ----
    if (!principal.allowDirectBodyEdit) {
      const editsText =
        (key === 'PATCH /api/v1/works/:id' &&
          (body['markdown'] !== undefined || body['description'] !== undefined)) ||
        key === 'POST /api/v1/works/:id/revisions/:rid/restore';
      if (editsText) {
        await deny(
          403,
          'direct_edit_not_allowed',
          'this token may not change a work’s text directly; propose the change instead (POST /api/v1/works/:id/proposals)',
          { required: 'allow_direct_body_edit', alternative: 'propose' },
        );
        return;
      }
    }

    // ---- project limits ----
    const limit = principal.projectIds;
    if (limit === null) return;
    const workId = typeof params['id'] === 'string' ? params['id'] : null;
    const outside = (wid: string): boolean => !deps.scope.allowsWork(wid, limit);
    if (route.startsWith('/api/v1/works/:id') && workId !== null && outside(workId)) {
      await deny(404, 'not_found', 'work not found');
      return;
    }
    if (route.startsWith('/api/v1/projects/:id') && workId !== null && !limit.includes(workId)) {
      await deny(404, 'not_found', 'project not found');
      return;
    }
    if (key === 'POST /api/v1/projects' || key === 'PUT /api/v1/projects/order') {
      await deny(
        403,
        'project_scope',
        'this token is limited to some projects and cannot add or reorder projects',
        { project_ids: limit },
      );
      return;
    }
    if (key === 'POST /api/v1/works') {
      const ids = Array.isArray(body['project_ids']) ? (body['project_ids'] as unknown[]) : [];
      // QC-092: with auto_assign the rules may supply the project; the route
      // still refuses the work if none of this token's projects fits.
      const missing = ids.length === 0 && body['auto_assign'] !== true;
      if (missing || ids.some((p) => typeof p !== 'string' || !limit.includes(p))) {
        await deny(
          403,
          'project_scope',
          'put the new work in at least one of this token’s projects (project_ids)',
          { project_ids: limit },
        );
        return;
      }
    }
    if (key === 'POST /api/v1/works/batch') {
      const items = Array.isArray(body['items']) ? (body['items'] as { id?: unknown }[]) : [];
      if (items.some((i) => typeof i.id === 'string' && outside(i.id))) {
        await deny(404, 'not_found', 'work not found');
        return;
      }
    }
    if (key === 'POST /api/v1/works/batch/projects') {
      const works = Array.isArray(body['work_ids']) ? (body['work_ids'] as unknown[]) : [];
      if (works.some((w) => typeof w === 'string' && outside(w))) {
        await deny(404, 'not_found', 'work not found');
        return;
      }
      const projects = [
        ...(Array.isArray(body['add']) ? (body['add'] as unknown[]) : []),
        ...(Array.isArray(body['remove']) ? (body['remove'] as unknown[]) : []),
      ];
      if (projects.some((p) => typeof p !== 'string' || !limit.includes(p))) {
        await deny(
          403,
          'project_scope',
          'this token can only add works to or remove them from its own projects',
          { project_ids: limit },
        );
        return;
      }
    }
    if (
      key === 'POST /api/v1/imports/urls' &&
      typeof body['work_id'] === 'string' &&
      outside(body['work_id'])
    ) {
      await deny(404, 'not_found', 'work not found');
    }
  });

  // Remember a refused request's error code and message for the activity log.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.principal?.kind === 'agent' && reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload) as { error?: { code?: unknown; message?: unknown } };
        req.activityError = {
          code: typeof parsed.error?.code === 'string' ? parsed.error.code : null,
          message: typeof parsed.error?.message === 'string' ? parsed.error.message : null,
        };
      } catch {
        req.activityError = { code: null, message: null };
      }
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const principal: Principal | null = req.principal;
    if (principal?.kind !== 'agent') return;
    const reads = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (reads && reply.statusCode < 400) return;
    // QC-096: status reports are shown live, not logged (an agent may send many).
    if (req.routeOptions.url === '/api/v1/agents/status' && reply.statusCode < 400) return;
    const etag = reply.getHeader('etag');
    deps.activity.recordRequest({
      tokenId: principal.id,
      method: req.method,
      route: req.routeOptions.url ?? '(no route)',
      params: (req.params ?? {}) as Record<string, unknown>,
      status: reply.statusCode,
      code: req.activityError?.code ?? null,
      reason: req.activityError?.message ?? null,
      revision: typeof etag === 'string' ? etag.replaceAll('"', '') : null,
    });
    return Promise.resolve();
  });
}
