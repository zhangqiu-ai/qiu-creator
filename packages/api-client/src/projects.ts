import {
  BatchWorkProjectsResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  ProjectSuggestionsResponseSchema,
  ProjectSummarySchema,
  RulesPreviewResponseSchema,
  WorkProjectsResponseSchema,
  type BatchWorkProjectsRequest,
  type BatchWorkProjectsResponse,
  type CreateProjectRequest,
  type PatchProjectRequest,
  type Project,
  type ProjectListResponse,
  type ProjectSuggestionsResponse,
  type ProjectSummary,
  type RulesPreviewRequest,
  type RulesPreviewResponse,
  type SuggestProjectsRequest,
  type WorkProjectsResponse,
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
  /** QC-092: a work's projects with who put it there (user, agent or rule) and why. */
  workMemberships(workId: string): Promise<WorkProjectsResponse>;
  /** QC-092 保留 (owner only): make an agent or rule assignment manual. */
  keepMembership(workId: string, projectId: string): Promise<WorkProjectsResponse>;
  /** QC-092 復原歸入 (owner only): undo an agent or rule assignment; manual ones are 409. */
  undoMembership(workId: string, projectId: string): Promise<WorkProjectsResponse>;
  /** QC-092: projects that fit a saved work by their rules, best first. */
  workSuggestions(workId: string): Promise<ProjectSuggestionsResponse>;
  /** QC-092: the same for content not saved yet. */
  suggest(input: SuggestProjectsRequest): Promise<ProjectSuggestionsResponse>;
  /** QC-092: try rules on recent works without saving them. */
  previewRules(projectId: string, input: RulesPreviewRequest): Promise<RulesPreviewResponse>;
}

export function createProjectsApi(ctx: Ctx): CreatorHubProjectsApi {
  const p = (id: string): string => `/api/v1/projects/${encodeURIComponent(id)}`;
  const w = (id: string): string => `/api/v1/works/${encodeURIComponent(id)}`;
  return {
    workMemberships: (workId) =>
      call(ctx, WorkProjectsResponseSchema, 'GET', `${w(workId)}/projects`),
    keepMembership: (workId, projectId) =>
      call(
        ctx,
        WorkProjectsResponseSchema,
        'POST',
        `${w(workId)}/projects/${encodeURIComponent(projectId)}/keep`,
        {},
      ),
    undoMembership: (workId, projectId) =>
      call(
        ctx,
        WorkProjectsResponseSchema,
        'DELETE',
        `${w(workId)}/projects/${encodeURIComponent(projectId)}`,
      ),
    workSuggestions: (workId) =>
      call(ctx, ProjectSuggestionsResponseSchema, 'GET', `${w(workId)}/project-suggestions`),
    suggest: (input) =>
      call(ctx, ProjectSuggestionsResponseSchema, 'POST', '/api/v1/projects/suggestions', input),
    previewRules: (projectId, input) =>
      call(ctx, RulesPreviewResponseSchema, 'POST', `${p(projectId)}/rules/preview`, input),
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
