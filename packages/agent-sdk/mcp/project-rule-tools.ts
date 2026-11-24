import {
  IdSchema,
  RulesPreviewRequestSchema,
  SuggestProjectsRequestSchema,
  TagSchema,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { id, tool, ToolInputError, USER_DATA_NOTE, type McpToolDef } from './define.js';

/**
 * Project rules and suggestions (QC-092, docs/mcp-plan.md §7). The server
 * scores by fixed rules, never AI; the agent reads project descriptions and
 * decides, then assigns with works_assign_projects.
 */
export const PROJECT_RULE_TOOLS: readonly McpToolDef[] = [
  tool({
    name: 'projects_suggest',
    group: 'projects',
    access: 'read',
    routes: ['GET /api/v1/works/:id/project-suggestions', 'POST /api/v1/projects/suggestions'],
    description: `Which projects fit a work by their rules: give work_id for a saved work, or title (with markdown, tags, source) for content not saved yet. Returns projects best first with a 0–1 score, outcome (auto ≥ 0.8, suggest 0.5–0.8, none) and reasons. Deterministic rules, no AI: read the projects' descriptions (projects_list) and decide yourself, then use works_assign_projects. ${USER_DATA_NOTE}`,
    inputSchema: {
      work_id: IdSchema.optional().describe('A saved work'),
      title: SuggestProjectsRequestSchema.shape.title.optional(),
      markdown: z
        .string()
        .max(5 * 1024 * 1024)
        .optional(),
      // No default here: an absent list must stay absent to tell the two forms apart.
      tags: z.array(TagSchema).max(64).optional(),
      source: SuggestProjectsRequestSchema.shape.source,
    },
    run: async (client, { work_id, title, markdown, tags, source }) => {
      if (work_id !== undefined) {
        if (title !== undefined || markdown !== undefined || tags !== undefined) {
          throw new ToolInputError('give work_id or content (title, markdown, tags), not both');
        }
        return client.projects.workSuggestions(work_id);
      }
      if (title === undefined)
        throw new ToolInputError('give work_id, or title for unsaved content');
      return client.projects.suggest({
        title,
        ...(markdown === undefined ? {} : { markdown }),
        ...(tags === undefined ? {} : { tags }),
        ...(source === undefined ? {} : { source }),
      });
    },
  }),
  tool({
    name: 'project_rules_preview',
    group: 'projects',
    access: 'read',
    routes: ['POST /api/v1/projects/:id/rules/preview'],
    description: `Try rules for a project on the most recently updated works (default 20) without saving them: each work's score, outcome and reasons, and whether it is already in the project. Use before project_update changes rules. ${USER_DATA_NOTE}`,
    inputSchema: { id: id('project'), ...RulesPreviewRequestSchema.shape },
    run: (client, { id: projectId, ...input }) => client.projects.previewRules(projectId, input),
  }),
];
