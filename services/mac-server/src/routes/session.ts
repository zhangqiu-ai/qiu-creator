import {
  ErrorResponseSchema,
  ListChangesQuerySchema,
  ListChangesResponseSchema,
  SessionResponseSchema,
  type ChangeEvent,
} from '@qiu-creator/contracts';
import type { CliLocation } from '../agent-cli.js';
import { currentProjectLimit, type ProjectScope } from '../auth/project-scope.js';
import { requirePrincipal } from '../auth/token-service.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { App } from '../http/app-type.js';
import type { TextScriptService } from '../works/text-script-service.js';

const errors = { 401: ErrorResponseSchema, 403: ErrorResponseSchema };

/** Session and change-list reads for agents (QC-087, used by `creatorhub mcp`). */
/**
 * Whether the current request may see an event (QC-089): a token limited
 * to projects sees no events of works or projects outside them.
 */
export function eventVisibility(scope: ProjectScope): (event: ChangeEvent) => boolean {
  const limit = currentProjectLimit();
  if (limit === null) return () => true;
  return (event) =>
    event.entity === 'work'
      ? scope.allowsWork(event.entity_id, limit)
      : event.entity === 'project'
        ? limit.includes(event.entity_id)
        : true;
}

export function registerSessionRoutes(
  app: App,
  feed: ChangeFeed,
  scope: ProjectScope,
  cli: CliLocation | null,
  textScripts: TextScriptService,
): void {
  app.get(
    '/api/v1/session',
    {
      schema: {
        description:
          'The calling token: owner or agent, its name, scopes (`read`, `import`, `write`, `propose`), whether it may edit text directly, and the projects it is limited to. Any token may read its own session. The owner also gets `cli`: how to start the `creatorhub` CLI on this Mac (for the MCP config). `text_script` (QC-103): the script works are written in (global default and project overrides this token may see); text agents send is converted to it.',
        response: { 200: SessionResponseSchema, ...errors },
      },
    },
    (req) => {
      const p = requirePrincipal(req.principal);
      return {
        kind: p.kind,
        name: p.kind === 'agent' ? p.name : null,
        scopes: [...p.scopes],
        allow_direct_body_edit: p.kind === 'agent' && p.allowDirectBodyEdit,
        project_ids: p.kind === 'agent' && p.projectIds !== null ? [...p.projectIds] : null,
        // QC-094: a local path, so only the owner sees it.
        cli:
          p.kind === 'owner' && cli !== null
            ? {
                command: cli.command,
                args: [...cli.args],
                source: cli.source,
                server_url: `http://127.0.0.1:${String(req.socket.localPort)}`,
              }
            : null,
        text_script: textScripts.session(currentProjectLimit()),
      };
    },
  );

  app.get(
    '/api/v1/changes',
    {
      schema: {
        description:
          'Change events after `since` (a seq; default 0), oldest first, at most `limit` (1–500, default 100): the same log as `GET /api/v1/events`, as one JSON page. Continue with `next_since` while `has_more`.',
        querystring: ListChangesQuerySchema,
        response: { 200: ListChangesResponseSchema, ...errors },
      },
    },
    (req) => {
      const { since, limit } = req.query;
      const page = feed.since(since, limit + 1);
      const items = page.slice(0, limit);
      const visible = eventVisibility(scope);
      return {
        // QC-089: a token limited to projects sees only their works' events;
        // next_since still moves past the hidden ones.
        items: items.filter(visible),
        next_since: items.at(-1)?.seq ?? since,
        has_more: page.length > limit,
        latest_seq: feed.latestSeq(),
      };
    },
  );
}
