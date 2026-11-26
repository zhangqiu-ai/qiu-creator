import type { CreatorHubClient } from '@qiu-creator/api-client';
import { PlatformSchema, type SessionTextScript, type TextScript } from '@qiu-creator/contracts';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  isReadOnly,
  REPORT_SCOPES,
  platformRules,
  toErrorResult,
  toResult,
  TOOLS,
  TOOLSETS,
  USER_DATA_NOTE,
  type McpToolDef,
  type ToolAccess,
  type Toolset,
} from './tools.js';

export const MCP_SERVER_NAME = 'creatorhub';

export interface CreatorHubMcpOptions {
  client: CreatorHubClient;
  /** Tool groups to expose; default all. `core` tools are always on. */
  toolsets?: readonly Toolset[];
  /** Reported to the MCP client. */
  version?: string;
  /**
   * QC-103: the token's script setting, read from the session at start, so
   * the instructions name it; null or absent when it could not be read.
   */
  textScript?: SessionTextScript | null;
}

const SCRIPT_NAMES: Record<TextScript, string> = {
  'zh-Hans': 'Simplified Chinese (zh-Hans)',
  'zh-Hant': 'Traditional Chinese (zh-Hant)',
};

/** How text_script is resolved, for the instructions and server_status. */
export const TEXT_SCRIPT_RULE =
  'A work in projects uses their override when those that override agree; otherwise (no project, no override, or different overrides) the default applies.';

/** The instructions' sentence on which script to write works in (QC-103). */
export function textScriptInstruction(textScript: SessionTextScript | null | undefined): string {
  const target =
    textScript === null || textScript === undefined
      ? 'the script server_status reports in text_script (Simplified Chinese, zh-Hans, unless the user changed it)'
      : `${SCRIPT_NAMES[textScript.default]}${
          textScript.projects.length === 0
            ? ''
            : ` (projects that override it: ${textScript.projects
                .map((p) => `${JSON.stringify(p.name)} → ${p.script}`)
                .join(', ')})`
        }`;
  return `Write the text of works (titles, Markdown, descriptions, tags, platform titles and tags) in ${target}. ${TEXT_SCRIPT_RULE} The server converts Chinese text you add or change to that script with OpenCC (the user's existing text, code, URLs and paths are left alone) and says so in script_conversion.`;
}

/** `works,assets` → toolsets; throws on unknown names. Empty or absent = all. */
export function parseToolsets(value: string | undefined): Toolset[] {
  if (value === undefined || value.trim() === '') return [...TOOLSETS];
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const unknown = names.filter((n) => !(TOOLSETS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown toolset(s): ${unknown.join(', ')} (available: ${TOOLSETS.join(', ')})`,
    );
  }
  return TOOLSETS.filter((t) => names.includes(t));
}

/** Tools enabled for `toolsets` (core tools included). */
export function enabledTools(toolsets: readonly Toolset[]): McpToolDef[] {
  return TOOLS.filter((t) => t.group === 'core' || toolsets.includes(t.group));
}

const allows = (scopes: readonly string[], owner: boolean, access: ToolAccess): boolean =>
  owner ||
  access === 'any' ||
  (access === 'read_or_own_import'
    ? scopes.includes('read') || scopes.includes('import')
    : access === 'report'
      ? REPORT_SCOPES.some((s) => scopes.includes(s))
      : scopes.includes(access));

/**
 * The CreatorHub MCP server: read tools and resources over the Mac server's
 * HTTP API. Every call goes through `@qiu-creator/api-client` with the
 * agent's token; permissions, validation and conflicts are decided by the
 * Mac server, never here.
 */
export function createCreatorHubMcpServer(options: CreatorHubMcpOptions): McpServer {
  const { client } = options;
  const toolsets = options.toolsets ?? [...TOOLSETS];
  const tools = enabledTools(toolsets);
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: options.version ?? '0.0.0' },
    {
      instructions: [
        'CreatorHub is the user’s content workbench on their Mac (works, assets, projects, platform versions for 小紅書, 公眾號, 抖音, 視頻號).',
        'Call server_status first to see which tools this token may use.',
        'Edits need the base_revision you read; on 409 read again, merge, and retry with details.current_revision. Create and import calls take an idempotency_key: reuse it only to retry the same request.',
        'To change the text of a work (its Markdown or description), use work_propose_edit: the user accepts or discards each change. Only tokens the user allowed to edit text directly may use work_update_body.',
        textScriptInstruction(options.textScript),
        USER_DATA_NOTE,
      ].join(' '),
    },
  );

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: z.object(def.inputSchema).strict(),
        annotations: {
          readOnlyHint: isReadOnly(def.access),
          destructiveHint: def.destructive === true,
          openWorldHint: def.name === 'asset_import_url',
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const value = await def.run(client, args);
          if (def.name !== 'server_status') return toResult(value);
          // Add which enabled tools this token may call.
          const status = value as {
            token: {
              kind: string;
              scopes: readonly string[];
              allow_direct_body_edit: boolean;
              text_script?: SessionTextScript | null;
            };
          };
          return toResult({
            ...status,
            // QC-103: which script to write works in, and how it is chosen.
            text_script:
              status.token.text_script === undefined || status.token.text_script === null
                ? null
                : { ...status.token.text_script, rule: TEXT_SCRIPT_RULE },
            toolsets,
            tools: tools.map((t) => ({
              name: t.name,
              access: t.access,
              allowed:
                allows(status.token.scopes, status.token.kind === 'owner', t.access) &&
                (t.directBodyEdit !== true ||
                  status.token.kind === 'owner' ||
                  status.token.allow_direct_body_edit),
            })),
          });
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );
  }

  if (toolsets.includes('works')) {
    server.registerResource(
      'work',
      new ResourceTemplate('creatorhub://works/{id}', { list: undefined }),
      {
        title: 'Work Markdown',
        description: `The Markdown source of a work (front matter included). ${USER_DATA_NOTE}`,
        mimeType: 'text/markdown',
      },
      async (uri, variables) => {
        const raw = variables['id'];
        const workId = Array.isArray(raw) ? raw[0] : raw;
        const work = await client.works.get(workId ?? '');
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: work.markdown }] };
      },
    );
  }
  if (toolsets.includes('projects')) {
    server.registerResource(
      'projects',
      'creatorhub://projects',
      {
        title: 'Projects',
        description: `All projects in sidebar order (JSON). ${USER_DATA_NOTE}`,
        mimeType: 'application/json',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await client.projects.list(), null, 2),
          },
        ],
      }),
    );
  }
  if (toolsets.includes('platforms')) {
    server.registerResource(
      'platform-rules',
      new ResourceTemplate('creatorhub://platforms/{platform}/rules', {
        list: () => ({
          resources: PlatformSchema.options.map((p) => ({
            uri: `creatorhub://platforms/${p}/rules`,
            name: `${p} rules`,
            mimeType: 'application/json',
          })),
        }),
      }),
      {
        title: 'Platform rules',
        description: 'Reference limits and body format of one platform (JSON).',
        mimeType: 'application/json',
      },
      (uri, variables) => {
        const raw = variables['platform'];
        const platform = PlatformSchema.parse(Array.isArray(raw) ? raw[0] : raw);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(platformRules(platform), null, 2),
            },
          ],
        };
      },
    );
  }
  return server;
}
