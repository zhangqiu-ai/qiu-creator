import {
  ListAssetsQuerySchema,
  ListChangesQuerySchema,
  ListWorksQuerySchema,
  PLATFORM_LIMITS,
  PlatformSchema,
  type Platform,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { id, tool, ToolInputError, USER_DATA_NOTE, type McpToolDef } from './define.js';
import { unifiedDiff } from './diff.js';

/** Platform rules: reference limits (warnings only) and how the body is rendered. */
export function platformRules(platform?: Platform) {
  const rules = (p: Platform) => ({
    platform: p,
    ...PLATFORM_LIMITS[p],
    note: 'Reference values from public creator guidance, not verified against the platform; over-limit content is saved and only warned about. Lengths count Unicode code points.',
  });
  return platform === undefined ? PlatformSchema.options.map(rules) : rules(platform);
}

export const READ_TOOLS: readonly McpToolDef[] = [
  tool({
    name: 'server_status',
    group: 'core',
    access: 'any',
    routes: ['GET /api/v1/session'],
    description:
      'CreatorHub server version, this token (owner or agent, name, scopes: read / import / write), text_script (the Chinese script to write works in: the default and project overrides, with the rule), and the MCP tools enabled in this session with whether this token may use each. Call this first.',
    inputSchema: {},
    run: async (client) => {
      const [health, session] = await Promise.all([client.health(), client.session()]);
      return { server: health, token: session };
    },
  }),
  tool({
    name: 'changes_since',
    group: 'core',
    access: 'read',
    routes: ['GET /api/v1/changes'],
    description: `Change log entries (works, assets, projects, jobs) after a sequence number, oldest first. Start with since=0 or the latest_seq you saw; continue with next_since while has_more. Each event has only small hints; read the entity again for details. ${USER_DATA_NOTE}`,
    inputSchema: ListChangesQuerySchema.shape,
    run: (client, args) => client.changes(args),
  }),
  tool({
    name: 'works_search',
    group: 'works',
    access: 'read',
    routes: ['GET /api/v1/works'],
    description: `Find works (articles, image posts, videos). q matches title, tags and body, including Traditional/Simplified Chinese and pinyin; filter by type, status, tag, project_id; scope=trash lists works in 回收站. Returns one page; pass next_cursor as cursor for the next. ${USER_DATA_NOTE}`,
    inputSchema: ListWorksQuerySchema.omit({ ids: true }).shape,
    run: (client, args) => client.works.list(args),
  }),
  tool({
    name: 'work_get',
    group: 'works',
    access: 'read',
    routes: [
      'GET /api/v1/works/:id',
      'GET /api/v1/works/:id/assets',
      'GET /api/v1/works/:id/projects',
    ],
    description: `One work: metadata, its Markdown (front matter included), current_revision_id (needed later as base_revision for edits), linked assets (cover, body, video, in order) and its projects with who put it there (user by hand, an agent, or a rule with score and reasons); work.project_groups gives its group in each project and its episode in a series. ${USER_DATA_NOTE}`,
    inputSchema: {
      id: id('work'),
      include_markdown: z
        .boolean()
        .default(true)
        .describe('false to leave out the Markdown and save context'),
    },
    run: async (client, args) => {
      const [work, assets, projects] = await Promise.all([
        client.works.get(args.id),
        client.workAssets.list(args.id),
        client.projects.workMemberships(args.id),
      ]);
      return {
        // JSON leaves out the undefined Markdown.
        work: args.include_markdown ? work : { ...work, markdown: undefined },
        assets: assets.items,
        projects: projects.items,
      };
    },
  }),
  tool({
    name: 'work_revisions',
    group: 'works',
    access: 'read',
    routes: ['GET /api/v1/works/:id/revisions', 'GET /api/v1/works/:id/revisions/:rid'],
    description: `History of a work, newest first (who changed it: edit, restore, external editor, accepted AI). With revision_id, that one revision including its Markdown. ${USER_DATA_NOTE}`,
    inputSchema: {
      id: id('work'),
      revision_id: id('revision').optional(),
    },
    run: (client, args) =>
      args.revision_id === undefined
        ? client.works.revisions(args.id)
        : client.works.revision(args.id, args.revision_id),
  }),
  tool({
    name: 'work_diff',
    group: 'works',
    access: 'read',
    routes: ['GET /api/v1/works/:id', 'GET /api/v1/works/:id/revisions/:rid'],
    description: `Unified line diff of a work's Markdown between two revisions (to_revision_id defaults to the current one). ${USER_DATA_NOTE}`,
    inputSchema: {
      id: id('work'),
      from_revision_id: id('revision'),
      to_revision_id: id('revision').optional(),
    },
    run: async (client, args) => {
      const from = await client.works.revision(args.id, args.from_revision_id);
      const to =
        args.to_revision_id === undefined
          ? await client.works.get(args.id).then((w) => ({
              revision_id: w.current_revision_id,
              markdown: w.markdown,
            }))
          : await client.works.revision(args.id, args.to_revision_id);
      const diff = unifiedDiff(from.markdown, to.markdown, {
        from: `revision ${from.revision_id}`,
        to: `revision ${to.revision_id}`,
      });
      return diff === ''
        ? `No differences between ${from.revision_id} and ${to.revision_id}.`
        : diff;
    },
  }),
  tool({
    name: 'assets_search',
    group: 'assets',
    access: 'read',
    routes: ['GET /api/v1/assets'],
    description: `Find assets (images, videos, audio, files) in the library by kind, name (q), tag or project; scope=trash for 回收站. Paged with limit and offset. ${USER_DATA_NOTE}`,
    inputSchema: ListAssetsQuerySchema.shape,
    run: (client, args) => client.assets.list(args),
  }),
  tool({
    name: 'asset_get',
    group: 'assets',
    access: 'read',
    routes: [
      'GET /api/v1/assets/:id',
      'GET /api/v1/assets/:id/references',
      'GET /api/v1/assets/:id/works',
    ],
    description: `One asset: metadata (kind, size, dimensions, duration, tags, notes) and where it is used (works and platform versions). No file content. ${USER_DATA_NOTE}`,
    inputSchema: { id: id('asset') },
    run: async (client, args) => {
      const [asset, references, works] = await Promise.all([
        client.assets.get(args.id),
        client.assets.references(args.id),
        client.assets.works(args.id),
      ]);
      return { asset, references, works: works.items };
    },
  }),
  tool({
    name: 'projects_list',
    group: 'projects',
    access: 'read',
    routes: ['GET /api/v1/projects'],
    description: `All projects in sidebar order, with how many works each has. Projects group works without moving their files; a work can be in several. ${USER_DATA_NOTE}`,
    inputSchema: {},
    run: (client) => client.projects.list(),
  }),
  tool({
    name: 'project_get',
    group: 'projects',
    access: 'read',
    routes: ['GET /api/v1/projects/:id', 'GET /api/v1/projects/:id/summary'],
    description: `One project and its summary (counts by type and status, recent works), with its groups (project.groups: name, ordered for a series, revision, created_by, work_ids in order; works in no group are 未分組). Use works_search with project_id to list its works; each work's project_groups gives its group and episode. ${USER_DATA_NOTE}`,
    inputSchema: { id: id('project') },
    run: async (client, args) => {
      const [project, summary] = await Promise.all([
        client.projects.get(args.id),
        client.projects.summary(args.id),
      ]);
      return { project, summary };
    },
  }),
  tool({
    name: 'variant_get',
    group: 'platforms',
    access: 'read',
    routes: [
      'GET /api/v1/works/:id/variants',
      'GET /api/v1/works/:id/variants/:platform',
      'GET /api/v1/works/:id/variants/:platform/revisions',
      'GET /api/v1/works/:id/variants/:platform/revisions/:revision',
    ],
    description: `How a work publishes on 小紅書 (xiaohongshu), 公眾號 (wechat_mp), 抖音 (douyin) and 視頻號 (wechat_channels). Title, cover, images and tags follow the work unless overridden (*_source: work or override); the body is always derived from the work (plain text, or Markdown for 公眾號) and is never truncated: warnings say where the platform would cut (body_too_long cut_at, source_offset). revision is the base_revision for variant_update (0 before the first override). Without platform, all four. With platform and history=true, the override history; with revision, one past revision. ${USER_DATA_NOTE}`,
    inputSchema: {
      id: id('work'),
      platform: PlatformSchema.optional(),
      history: z.boolean().default(false),
      revision: z.number().int().positive().optional(),
    },
    run: async (client, args) => {
      const platform = args.platform;
      if (platform === undefined) {
        if (args.history || args.revision !== undefined) {
          throw new ToolInputError('history and revision need a platform');
        }
        return client.variants.list(args.id);
      }
      if (args.revision !== undefined) {
        return client.variants.revision(args.id, platform, args.revision);
      }
      const current = await client.variants.get(args.id, platform);
      return args.history
        ? { current, history: (await client.variants.revisions(args.id, platform)).items }
        : current;
    },
  }),
  tool({
    name: 'platform_rules',
    group: 'platforms',
    access: 'any',
    routes: [],
    description:
      'Reference limits per platform (title, body, images, tags) and whether the body is plain text or Markdown. Without platform, all four.',
    inputSchema: { platform: PlatformSchema.optional() },
    run: (_client, args) => Promise.resolve(platformRules(args.platform)),
  }),
];
