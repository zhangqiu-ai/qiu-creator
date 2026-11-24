import {
  CreateProposalRequestSchema,
  IdempotencyKeySchema,
  ListProposalsQuerySchema,
  PatchWorkRequestSchema,
} from '@qiu-creator/contracts';
import { id, tool, ToolInputError, USER_DATA_NOTE, type McpToolDef } from './define.js';

/**
 * Changing a work's text (QC-089). Agents propose; the user accepts all or
 * some changes, or discards them. Only tokens the user allowed to edit text
 * directly may write it themselves (work_update_body).
 */
export const PROPOSAL_TOOLS: readonly McpToolDef[] = [
  tool({
    name: 'work_propose_edit',
    group: 'works',
    access: 'propose',
    routes: ['POST /api/v1/works/:id/proposals'],
    description:
      'Propose a new text for a work: send the whole edited Markdown and the current_revision_id you edited (work_get). Nothing changes until the user accepts all or some of your changes in CreatorHub; they may also discard it. Explain briefly in note what you changed and why. Reuse the same idempotency_key when retrying.',
    inputSchema: {
      id: id('work'),
      base_revision: CreateProposalRequestSchema.shape.base_revision.describe(
        'The current_revision_id the edit is based on.',
      ),
      markdown: CreateProposalRequestSchema.shape.markdown.describe(
        'The whole proposed Markdown (front matter included, unchanged if you did not mean to change it).',
      ),
      note: CreateProposalRequestSchema.shape.note,
      idempotency_key: IdempotencyKeySchema.describe(
        'Your own unique key (8–200 printable ASCII). Reuse it only to retry the same proposal.',
      ),
    },
    run: (client, { id: workId, idempotency_key, ...input }) =>
      client.proposals.create(workId, input, { idempotencyKey: idempotency_key }),
  }),
  tool({
    name: 'proposals_list',
    group: 'works',
    access: 'read',
    routes: ['GET /api/v1/proposals', 'GET /api/v1/proposals/counts'],
    description: `Proposals, newest first: pending (default), done or all; filter by work_id or token_id. Each says whether it still applies (overlap: none, stale, conflict). Also returns pending counts per work. ${USER_DATA_NOTE}`,
    inputSchema: ListProposalsQuerySchema.shape,
    run: async (client, args) => {
      const [page, counts] = await Promise.all([
        client.proposals.list(args),
        client.proposals.counts(),
      ]);
      return { ...page, counts };
    },
  }),
  tool({
    name: 'proposal_get',
    group: 'works',
    access: 'read',
    routes: ['GET /api/v1/proposals/:id'],
    description: `One proposal: status, its changes (hunks, with stable ids) and whether each overlaps later edits of the work, with base / mine / theirs text for those. Accepting or discarding is the user's decision, not a tool. ${USER_DATA_NOTE}`,
    inputSchema: { id: id('proposal') },
    run: (client, args) => client.proposals.get(args.id),
  }),
  tool({
    name: 'work_update_body',
    group: 'works',
    access: 'write',
    routes: ['PATCH /api/v1/works/:id'],
    directBodyEdit: true,
    description:
      "Write a work's text directly. Only for tokens the user explicitly allowed to (allow_direct_body_edit, see server_status); otherwise 403 direct_edit_not_allowed — use work_propose_edit. base_revision is required (409 if the work changed); the previous revision stays as a snapshot the user can restore in one click, and the new revision names this agent. Give markdown for articles or description for image and video works.",
    inputSchema: {
      id: id('work'),
      base_revision: id('revision').describe('The current_revision_id you read.'),
      markdown: PatchWorkRequestSchema.shape.markdown,
      description: PatchWorkRequestSchema.shape.description,
    },
    run: async (client, { id: workId, base_revision, markdown, description }) => {
      if ((markdown === undefined) === (description === undefined)) {
        throw new ToolInputError('give exactly one of markdown or description');
      }
      return client.works.patch(workId, {
        base_revision,
        ...(markdown === undefined ? {} : { markdown }),
        ...(description === undefined ? {} : { description }),
      });
    },
  }),
];
