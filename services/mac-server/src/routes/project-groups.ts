import {
  AssignProjectGroupRequestSchema,
  CreateProjectGroupRequestSchema,
  ErrorResponseSchema,
  PatchProjectGroupRequestSchema,
  ProjectGroupParamsSchema,
  ProjectGroupSchema,
  ProjectIdParamsSchema,
  ProjectSchema,
} from '@qiu-creator/contracts';
import type { App } from '../http/app-type.js';
import type { ProjectGroupService } from '../projects/project-groups.js';
import type { ProjectService } from '../projects/project-service.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/**
 * Groups and series inside a project (QC-113). Every change needs `write`;
 * groups are the project's metadata, never a work's text or files. The
 * groups themselves are read with `GET /api/v1/projects/:id` (`groups`).
 */
export function registerProjectGroupRoutes(
  app: App,
  projects: ProjectService,
  groups: ProjectGroupService,
): void {
  app.post(
    '/api/v1/projects/:id/groups',
    {
      schema: {
        description:
          'Create a group after the project’s others. `name` 1–60 characters, unique in the project (409 `group_name_taken`); `ordered: true` makes it a series (系列) with episode numbers. At most 100 groups. It starts empty: put works in with `POST …/groups/assign`.',
        params: ProjectIdParamsSchema,
        body: CreateProjectGroupRequestSchema,
        response: { 201: ProjectGroupSchema, ...errors, 409: ErrorResponseSchema },
      },
    },
    (req, reply) => {
      const group = groups.create(req.params.id, req.body);
      reply.code(201);
      reply.header('etag', `"${String(group.revision)}"`);
      return group;
    },
  );

  app.patch(
    '/api/v1/projects/:id/groups/:groupId',
    {
      schema: {
        description:
          'Rename a group, turn it into a series or back (`ordered`), or move it to `sort_order` (0-based; the others shift). Requires `base_revision` or `If-Match` with the group’s revision: 428 without, 409 `revision_conflict` when stale.',
        params: ProjectGroupParamsSchema,
        body: PatchProjectGroupRequestSchema,
        response: {
          200: ProjectGroupSchema,
          409: ErrorResponseSchema,
          428: ErrorResponseSchema,
          ...errors,
        },
      },
    },
    (req, reply) => {
      const group = groups.patch(
        req.params.id,
        req.params.groupId,
        req.body,
        req.headers['if-match'],
      );
      reply.header('etag', `"${String(group.revision)}"`);
      return group;
    },
  );

  app.delete(
    '/api/v1/projects/:id/groups/:groupId',
    {
      schema: {
        description:
          'Delete a group. Its works go back to 未分組 and stay in the project; no work is deleted or changed. Answers with the project and its remaining groups.',
        params: ProjectGroupParamsSchema,
        response: { 200: ProjectSchema, ...errors },
      },
    },
    (req) => {
      groups.remove(req.params.id, req.params.groupId);
      return projects.get(req.params.id);
    },
  );

  app.post(
    '/api/v1/projects/:id/groups/assign',
    {
      schema: {
        description:
          'Put works of the project in a group, or back in 未分組 with `group_id: null` (up to 200). Each work is in at most one group per project, so this moves it from its old one. `position` (1-based) puts them there in the order given and moves the works after them down; without it they go to the end. Moving works already in the group reorders a series. Episodes are renumbered 1..n, never leaving gaps. All or nothing: 404 for an unknown work or group, 409 `work_in_trash`, 409 `work_not_in_project` (`details.work_ids`; add them to the project first). Works keep their revision. Answers with the project and its groups.',
        params: ProjectIdParamsSchema,
        body: AssignProjectGroupRequestSchema,
        response: { 200: ProjectSchema, ...errors, 409: ErrorResponseSchema },
      },
    },
    (req) => {
      groups.assign(req.params.id, req.body);
      return projects.get(req.params.id);
    },
  );
}
