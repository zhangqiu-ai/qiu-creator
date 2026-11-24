import {
  AcceptProposalResponseSchema,
  ListProposalsResponseSchema,
  ProposalCountsResponseSchema,
  ProposalDetailSchema,
  type AcceptProposalRequest,
  type AcceptProposalResponse,
  type CreateProposalRequest,
  type ListProposalsQuery,
  type ListProposalsResponse,
  type ProposalCountsResponse,
  type ProposalDetail,
} from '@qiu-creator/contracts';
import { call, idempotencyHeaders, type Ctx, type IdempotencyOptions } from './imports.js';

/**
 * Agent proposals (QC-089). Agents with `propose` create them; the owner
 * (the user) accepts all or some changes, or discards them.
 */
export interface CreatorHubProposalsApi {
  /** Propose a new text for a work. Agent tokens must pass `options.idempotencyKey`. */
  create(
    workId: string,
    input: CreateProposalRequest,
    options?: IdempotencyOptions,
  ): Promise<ProposalDetail>;
  list(query?: ListProposalsQuery): Promise<ListProposalsResponse>;
  counts(): Promise<ProposalCountsResponse>;
  get(id: string): Promise<ProposalDetail>;
  /** Owner only. 409 `revision_conflict` (stale base) or `proposal_conflict` (overlap, with three-way input). */
  accept(id: string, input: AcceptProposalRequest): Promise<AcceptProposalResponse>;
  /** Owner only; kept 30 days under `done`. */
  discard(id: string): Promise<ProposalDetail>;
}

export function createProposalsApi(ctx: Ctx): CreatorHubProposalsApi {
  const one = (id: string): string => `/api/v1/proposals/${encodeURIComponent(id)}`;
  return {
    create: (workId, input, options) =>
      call(
        ctx,
        ProposalDetailSchema,
        'POST',
        `/api/v1/works/${encodeURIComponent(workId)}/proposals`,
        input,
        idempotencyHeaders(options),
      ),
    list: (q = {}) => {
      const params = new URLSearchParams();
      if (q.status !== undefined) params.set('status', q.status);
      if (q.work_id !== undefined) params.set('work_id', q.work_id);
      if (q.token_id !== undefined) params.set('token_id', q.token_id);
      if (q.limit !== undefined) params.set('limit', String(q.limit));
      if (q.offset !== undefined) params.set('offset', String(q.offset));
      const qs = params.toString();
      return call(
        ctx,
        ListProposalsResponseSchema,
        'GET',
        `/api/v1/proposals${qs === '' ? '' : `?${qs}`}`,
      );
    },
    counts: () => call(ctx, ProposalCountsResponseSchema, 'GET', '/api/v1/proposals/counts'),
    get: (id) => call(ctx, ProposalDetailSchema, 'GET', one(id)),
    accept: (id, input) =>
      call(ctx, AcceptProposalResponseSchema, 'POST', `${one(id)}/accept`, input),
    discard: (id) => call(ctx, ProposalDetailSchema, 'POST', `${one(id)}/discard`, {}),
  };
}
