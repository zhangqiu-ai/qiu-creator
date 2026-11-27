import {
  AssignProjectGroupRequestSchema,
  CreateProjectGroupRequestSchema,
  PatchProjectGroupRequestSchema,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { id, tool, ToolInputError, USER_DATA_NOTE, type McpToolDef } from './define.js';

/**
 * Groups and series inside a project (QC-113, docs/mcp-plan.md). project_get
 * returns the groups. Groups are metadata, so these need `write`; a token with
 * only `propose` cannot use them. Groups an agent creates carry its token in
 * created_by and show the Agent mark in the app.
 */
export const PROJECT_GROUP_TOOLS: readonly McpToolDef[] = [
  tool({
    name: 'project_group_create',
    group: 'projects',
    access: 'write',
    routes: ['POST /api/v1/projects/:id/groups'],
    description: `Create a group inside a project, after its other groups. ordered=true makes it a series (系列) whose works get episode numbers. Names are unique in a project (409 group_name_taken with details.group_id): read the groups with project_get first and reuse one that fits. Only one level; there are no groups inside groups. It starts empty: put works in with works_assign_group. ${USER_DATA_NOTE}`,
    inputSchema: { project_id: id('project'), ...CreateProjectGroupRequestSchema.shape },
    run: async (client, { project_id, ...input }) => {
      const parsed = CreateProjectGroupRequestSchema.safeParse(input);
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.projects.createGroup(project_id, parsed.data);
    },
  }),
  tool({
    name: 'project_group_update',
    group: 'projects',
    access: 'write',
    routes: ['PATCH /api/v1/projects/:id/groups/:groupId'],
    description:
      "Rename a group, make it a series or a plain group again (ordered), or move it among the project's groups (sort_order, 0-based). base_revision is the group's revision from project_get (groups[].revision); a stale one returns 409: read again and retry.",
    inputSchema: {
      project_id: id('project'),
      group_id: id('group'),
      base_revision: z.number().int().positive(),
      name: PatchProjectGroupRequestSchema.shape.name,
      ordered: PatchProjectGroupRequestSchema.shape.ordered,
      sort_order: PatchProjectGroupRequestSchema.shape.sort_order,
    },
    run: async (client, { project_id, group_id, ...change }) => {
      const parsed = PatchProjectGroupRequestSchema.safeParse(change);
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.projects.patchGroup(project_id, group_id, parsed.data);
    },
  }),
  tool({
    name: 'project_group_delete',
    group: 'projects',
    access: 'write',
    routes: ['DELETE /api/v1/projects/:id/groups/:groupId'],
    destructive: true,
    description:
      'Delete a group. Its works are not deleted: they go back to 未分組 and stay in the project. Returns the project with its remaining groups.',
    inputSchema: { project_id: id('project'), group_id: id('group') },
    run: (client, args) => client.projects.removeGroup(args.project_id, args.group_id),
  }),
  tool({
    name: 'works_assign_group',
    group: 'projects',
    access: 'write',
    routes: ['POST /api/v1/projects/:id/groups/assign'],
    description: `Put works of a project into one of its groups, or back in 未分組 with group_id null. The works must already be in the project (add them with works_assign_projects; 409 work_not_in_project lists the others). A work is in at most one group per project, so this moves it out of its old one. In a series, position (1-based episode) puts the works there in the order given and moves later ones down; without it they go to the end; moving works already in the series reorders it. Episodes are renumbered with no gaps. All or nothing. Returns the project with its groups (work_ids in episode order). ${USER_DATA_NOTE}`,
    inputSchema: { project_id: id('project'), ...AssignProjectGroupRequestSchema.shape },
    run: async (client, { project_id, ...input }) => {
      const parsed = AssignProjectGroupRequestSchema.safeParse(input);
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
      return client.projects.assignGroup(project_id, parsed.data);
    },
  }),
];
