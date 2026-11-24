import {
  BatchWorkProjectsRequestSchema,
  BatchWorkProjectsResponseSchema,
  CreateProjectRequestSchema,
  ErrorResponseSchema,
  PatchProjectRequestSchema,
  ProjectIdParamsSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  ProjectSummarySchema,
  ProjectSuggestionsResponseSchema,
  ReorderProjectsRequestSchema,
  RulesPreviewRequestSchema,
  RulesPreviewResponseSchema,
  SuggestProjectsRequestSchema,
  WorkIdParamsSchema,
  WorkProjectParamsSchema,
  WorkProjectsResponseSchema,
} from '@qiu-creator/contracts';
import type { App } from '../http/app-type.js';
import type { ProjectRuleService } from '../projects/project-rules.js';
import type { ProjectService } from '../projects/project-service.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/**
 * Projects (QC-062). Reads need `read`; every change needs `write`
 * (deleting a project is reversible and never deletes works).
 */
export function registerProjectRoutes(
  app: App,
  projects: ProjectService,
  rules: ProjectRuleService,
): void {
  // ---- QC-092: rules, suggestions and who assigned what ----

  app.get(
    '/api/v1/works/:id/projects',
    {
      schema: {
        description:
          'The projects a work is in, each with `added_by`: `user` (the owner by hand), `agent` (an agent token’s choice) or `rule` (auto_assign, with score and reasons).',
        params: WorkIdParamsSchema,
        response: { 200: WorkProjectsResponseSchema, ...errors },
      },
    },
    (req) => ({ items: projects.memberships(req.params.id) }),
  );

  app.post(
    '/api/v1/works/:id/projects/:projectId/keep',
    {
      schema: {
        description:
          '保留：make an agent or rule assignment manual, so agents and rules leave it alone (owner only: the user’s decision).',
        params: WorkProjectParamsSchema,
        response: { 200: WorkProjectsResponseSchema, ...errors, 409: ErrorResponseSchema },
      },
    },
    (req) => ({ items: projects.keepMembership(req.params.id, req.params.projectId) }),
  );

  app.delete(
    '/api/v1/works/:id/projects/:projectId',
    {
      schema: {
        description:
          '復原歸入：take the work out of a project an agent or a rule put it in (owner only). A manual membership is 409 `membership_manual`; remove those with `POST /api/v1/works/batch/projects`.',
        params: WorkProjectParamsSchema,
        response: { 200: WorkProjectsResponseSchema, ...errors, 409: ErrorResponseSchema },
      },
    },
    (req) => ({ items: projects.undoMembership(req.params.id, req.params.projectId) }),
  );

  app.get(
    '/api/v1/works/:id/project-suggestions',
    {
      schema: {
        description:
          'Projects that fit a work by their rules, best first, with a 0–1 score, `outcome` (`auto` ≥ 0.8, `suggest` 0.5–0.8, `none`) and reasons. Deterministic, no AI; projects without rules are not listed.',
        params: WorkIdParamsSchema,
        response: { 200: ProjectSuggestionsResponseSchema, ...errors },
      },
    },
    (req) => ({ items: rules.forWork(req.params.id) }),
  );

  app.post(
    '/api/v1/projects/suggestions',
    {
      schema: {
        description:
          'Like `GET /works/:id/project-suggestions` for content not saved yet (title, markdown, tags, source URL). Only reads.',
        body: SuggestProjectsRequestSchema,
        response: { 200: ProjectSuggestionsResponseSchema, ...errors },
      },
    },
    (req) => ({ items: rules.forDraft(req.body) }),
  );

  app.post(
    '/api/v1/projects/:id/rules/preview',
    {
      schema: {
        description:
          'Try rules on the most recently updated works (default 20) without saving them: each work’s score, outcome and reasons, and whether it is already in the project. Only reads.',
        params: ProjectIdParamsSchema,
        body: RulesPreviewRequestSchema,
        response: { 200: RulesPreviewResponseSchema, ...errors },
      },
    },
    (req) => rules.preview(req.params.id, req.body),
  );

  app.get(
    '/api/v1/projects',
    {
      schema: {
        description:
          'Projects that are not deleted (archived ones included, `archived: true`), in sidebar order, with `work_count` (works in 最近刪除 not counted).',
        response: { 200: ProjectListResponseSchema, ...errors },
      },
    },
    () => ({ items: projects.list() }),
  );

  app.post(
    '/api/v1/projects',
    {
      schema: {
        description:
          'Create a project at the end of the list. `name` 1–60 characters, `color` 0–7.',
        body: CreateProjectRequestSchema,
        response: { 201: ProjectSchema, ...errors },
      },
    },
    (req, reply) => {
      reply.code(201);
      return projects.create(req.body);
    },
  );

  app.put(
    '/api/v1/projects/order',
    {
      schema: {
        description:
          'New sidebar order: `ids` must list every project that is not deleted, exactly once (400 with `details.missing`/`unknown` otherwise).',
        body: ReorderProjectsRequestSchema,
        response: { 200: ProjectListResponseSchema, ...errors },
      },
    },
    (req) => ({ items: projects.reorder(req.body) }),
  );

  app.get(
    '/api/v1/projects/:id',
    {
      schema: {
        params: ProjectIdParamsSchema,
        response: { 200: ProjectSchema, ...errors },
      },
    },
    (req, reply) => {
      const project = projects.get(req.params.id);
      reply.header('etag', `"${String(project.revision)}"`);
      return project;
    },
  );

  app.patch(
    '/api/v1/projects/:id',
    {
      schema: {
        description:
          'Rename, recolor, archive or unarchive. Requires `base_revision` or `If-Match`: 428 without, 409 `revision_conflict` when stale.',
        params: ProjectIdParamsSchema,
        body: PatchProjectRequestSchema,
        response: {
          200: ProjectSchema,
          409: ErrorResponseSchema,
          428: ErrorResponseSchema,
          ...errors,
        },
      },
    },
    (req, reply) => {
      const project = projects.patch(req.params.id, req.body, req.headers['if-match']);
      reply.header('etag', `"${String(project.revision)}"`);
      return project;
    },
  );

  app.delete(
    '/api/v1/projects/:id',
    {
      schema: {
        description:
          'Delete a project (soft): it leaves every list, its works stay where they are (and in their other projects). Restorable for 30 days with `POST …/restore`.',
        params: ProjectIdParamsSchema,
        response: { 200: ProjectSchema, ...errors },
      },
    },
    (req) => projects.remove(req.params.id),
  );

  app.post(
    '/api/v1/projects/:id/restore',
    {
      schema: {
        description:
          'Undo a delete: the project returns with its works and its place. Restoring a project that is not deleted changes nothing.',
        params: ProjectIdParamsSchema,
        response: { 200: ProjectSchema, ...errors },
      },
    },
    (req) => projects.restore(req.params.id),
  );

  app.get(
    '/api/v1/projects/:id/summary',
    {
      schema: {
        description:
          'Works by status, most recent update and how many library assets the project uses (works in 最近刪除 not counted).',
        params: ProjectIdParamsSchema,
        response: { 200: ProjectSummarySchema, ...errors },
      },
    },
    (req) => projects.summary(req.params.id),
  );

  app.post(
    '/api/v1/works/batch/projects',
    {
      schema: {
        description:
          'Add works to and remove them from projects (up to 200 works). 404 when a project is unknown or deleted (nothing changes); otherwise each work succeeds or fails on its own (`not_found`, `work_in_trash`) and the answer is 200. Works keep their revision; nothing is written to their files.',
        body: BatchWorkProjectsRequestSchema,
        response: { 200: BatchWorkProjectsResponseSchema, ...errors },
      },
    },
    (req) => projects.batch(req.body),
  );
}
