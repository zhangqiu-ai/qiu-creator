import {
  BatchWorkProjectsResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  ProjectSummarySchema,
  type BatchWorkProjectsRequest,
  type BatchWorkProjectsResponse,
  type CreateProjectRequest,
  type PatchProjectRequest,
  type Project,
  type ProjectListResponse,
  type ProjectSummary,
} from '@qiu-creator/contracts';
import { call, type Ctx } from './imports.js';

/**
 * Projects (QC-062). Filter works with `works.list({ project_id })` or
 * `{ unassigned: '1' }`, and assets with `assets.list({ project_id })`.
 */
export interface CreatorHubProjectsApi {
  list(): Promise<ProjectListResponse>;
  get(id: string): Promise<Project>;
  create(input: CreateProjectRequest): Promise<Project>;
  /** Pass `base_revision` (the project's `revision`) or `options.ifMatch`. */
  patch(id: string, input: PatchProjectRequest, options?: { ifMatch?: number }): Promise<Project>;
  /** Every project that is not deleted, in the new order. */
  reorder(ids: string[]): Promise<ProjectListResponse>;
  /** Soft delete: works stay; undo with `restore` within 30 days. */
  remove(id: string): Promise<Project>;
  restore(id: string): Promise<Project>;
  summary(id: string): Promise<ProjectSummary>;
  /** Add works to and remove them from projects; each work succeeds or fails on its own. */
  batchWorks(input: BatchWorkProjectsRequest): Promise<BatchWorkProjectsResponse>;
}

export function createProjectsApi(ctx: Ctx): CreatorHubProjectsApi {
  const p = (id: string): string => `/api/v1/projects/${encodeURIComponent(id)}`;
  return {
    list: () => call(ctx, ProjectListResponseSchema, 'GET', '/api/v1/projects'),
    get: (id) => call(ctx, ProjectSchema, 'GET', p(id)),
    create: (input) => call(ctx, ProjectSchema, 'POST', '/api/v1/projects', input),
    patch: (id, input, options = {}) =>
      call(
        ctx,
        ProjectSchema,
        'PATCH',
        p(id),
        input,
        options.ifMatch === undefined ? {} : { 'if-match': `"${String(options.ifMatch)}"` },
      ),
    reorder: (ids) =>
      call(ctx, ProjectListResponseSchema, 'PUT', '/api/v1/projects/order', { ids }),
    remove: (id) => call(ctx, ProjectSchema, 'DELETE', p(id)),
    restore: (id) => call(ctx, ProjectSchema, 'POST', `${p(id)}/restore`),
    summary: (id) => call(ctx, ProjectSummarySchema, 'GET', `${p(id)}/summary`),
    batchWorks: (input) =>
      call(ctx, BatchWorkProjectsResponseSchema, 'POST', '/api/v1/works/batch/projects', input),
  };
}
