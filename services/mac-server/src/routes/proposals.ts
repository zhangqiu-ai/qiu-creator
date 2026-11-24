import {
  AcceptProposalRequestSchema,
  AcceptProposalResponseSchema,
  CreateProposalRequestSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  ListProposalsQuerySchema,
  ListProposalsResponseSchema,
  ProposalCountsResponseSchema,
  ProposalDetailSchema,
  ProposalParamsSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { requirePrincipal } from '../auth/token-service.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';
import type { ProposalService } from '../proposals/proposal-service.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};
const writeErrors = {
  ...errors,
  409: ErrorResponseSchema,
  422: ErrorResponseSchema,
  428: ErrorResponseSchema,
};

/** Agent proposals (QC-089). */
export function registerProposalRoutes(
  app: App,
  proposals: ProposalService,
  idempotency: IdempotencyService,
): void {
  app.post(
    '/api/v1/works/:id/proposals',
    {
      schema: {
        description:
          'Propose a new text for a work (agent tokens with the `propose` scope). Send the whole proposed Markdown and the revision it was written from; it is split into changes (hunks) with stable ids. Nothing is written to the work: the user accepts all or some changes, or discards them. Send an `Idempotency-Key` (required for agent tokens).',
        params: WorkIdParamsSchema,
        body: CreateProposalRequestSchema,
        response: { 201: ProposalDetailSchema, ...writeErrors },
      },
    },
    (req, reply) => {
      const principal = requirePrincipal(req.principal);
      const result = idempotency.run(
        principal,
        'POST /api/v1/works/:id/proposals',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        { work_id: req.params.id, ...req.body },
        () => ({ statusCode: 201, body: proposals.create(principal, req.params.id, req.body) }),
      );
      reply.code(result.statusCode);
      if (result.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return ProposalDetailSchema.parse(result.body);
    },
  );

  app.get(
    '/api/v1/proposals',
    {
      schema: {
        description:
          'Proposals, newest first: `pending` (default), `done` or `all`, optionally for one work or one agent token. Pending ones say whether they still apply (`overlap`: none, stale, conflict).',
        querystring: ListProposalsQuerySchema,
        response: { 200: ListProposalsResponseSchema, ...errors },
      },
    },
    (req) => proposals.list(req.query),
  );

  app.get(
    '/api/v1/proposals/counts',
    {
      schema: {
        description: 'Pending proposals in total and per work (sidebar badge, editor tab).',
        response: { 200: ProposalCountsResponseSchema, ...errors },
      },
    },
    () => proposals.counts(),
  );

  app.get(
    '/api/v1/proposals/:id',
    {
      schema: {
        description:
          'One proposal: base and proposed text, its changes with stable ids and whether each overlaps later edits, and three-way merge input (`conflicts`) for the ones that do.',
        params: ProposalParamsSchema,
        response: { 200: ProposalDetailSchema, ...errors },
      },
    },
    (req) => proposals.get(req.params.id),
  );

  app.post(
    '/api/v1/proposals/:id/accept',
    {
      schema: {
        description:
          'Accept a proposal, all of it or the chosen `hunk_ids` (owner token only: the user’s decision). The result is a new work revision naming the agent. `base_revision` is the work revision the user is looking at (409 `revision_conflict` if stale); chosen changes that overlap later edits are 409 `proposal_conflict` with `details.conflicts` (base, mine, theirs). Nothing is written on a 409.',
        params: ProposalParamsSchema,
        body: AcceptProposalRequestSchema,
        response: { 200: AcceptProposalResponseSchema, ...writeErrors },
      },
    },
    (req) => proposals.accept(req.params.id, req.body),
  );

  app.post(
    '/api/v1/proposals/:id/discard',
    {
      schema: {
        description:
          'Discard a proposal (owner token only). It stays listed under `done` for 30 days, then is removed.',
        params: ProposalParamsSchema,
        response: { 200: ProposalDetailSchema, ...writeErrors },
      },
    },
    (req) => proposals.discard(req.params.id),
  );
}
