import {
  ErrorResponseSchema,
  ListChangesQuerySchema,
  ListChangesResponseSchema,
  SessionResponseSchema,
} from '@qiu-creator/contracts';
import { requirePrincipal } from '../auth/token-service.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { App } from '../http/app-type.js';

const errors = { 401: ErrorResponseSchema, 403: ErrorResponseSchema };

/** Session and change-list reads for agents (QC-087, used by `creatorhub mcp`). */
export function registerSessionRoutes(app: App, feed: ChangeFeed): void {
  app.get(
    '/api/v1/session',
    {
      schema: {
        description:
          'The calling token: owner or agent, its name and scopes (`read`, `import`, `write`). Any token may read its own session.',
        response: { 200: SessionResponseSchema, ...errors },
      },
    },
    (req) => {
      const p = requirePrincipal(req.principal);
      return {
        kind: p.kind,
        name: p.kind === 'agent' ? p.name : null,
        scopes: [...p.scopes],
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
      return {
        items,
        next_since: items.at(-1)?.seq ?? since,
        has_more: page.length > limit,
        latest_seq: feed.latestSeq(),
      };
    },
  );
}
