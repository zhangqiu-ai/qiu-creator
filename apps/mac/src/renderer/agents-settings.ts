import type { ApiToken, SessionCli, TokenActivity, TokenScope } from '@qiu-creator/contracts';
import type { IconName } from './Icon.js';
import { t } from './i18n.js';

/**
 * 設定 › Agent 與 MCP (QC-091, PT-20261124-001), pure parts: token order,
 * scope labels, the MCP config to copy, and how an activity entry reads.
 */

export const SCOPES: readonly TokenScope[] = ['read', 'import', 'write', 'propose'];

export const SCOPE_LABEL: Readonly<Record<TokenScope, string>> = {
  get read() {
    return t('agents.scopeRead');
  },
  get import() {
    return t('agents.scopeImport');
  },
  get write() {
    return t('agents.scopeWrite');
  },
  get propose() {
    return t('agents.scopePropose');
  },
};

export const SCOPE_HINT: Readonly<Record<TokenScope, string>> = {
  get read() {
    return t('agents.scopeReadHint');
  },
  get import() {
    return t('agents.scopeImportHint');
  },
  get write() {
    return t('agents.scopeWriteHint');
  },
  get propose() {
    return t('agents.scopeProposeHint');
  },
};

/** Active tokens first (newest first), then revoked ones. */
export function sortTokens(tokens: readonly ApiToken[]): ApiToken[] {
  return [...tokens].sort((a, b) => {
    const ra = a.revoked_at === null ? 0 : 1;
    const rb = b.revoked_at === null ? 0 : 1;
    return ra !== rb ? ra - rb : b.created_at.localeCompare(a.created_at);
  });
}

/** `讀取・匯入・提案修改正文`, in the fixed scope order. */
export function scopeSummary(scopes: readonly TokenScope[]): string {
  return SCOPES.filter((s) => scopes.includes(s))
    .map((s) => SCOPE_LABEL[s])
    .join('・');
}

/** Toggle one scope, never leaving none (the API needs at least one). */
export function toggleScope(scopes: readonly TokenScope[], scope: TokenScope): TokenScope[] | null {
  const next = scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope];
  return next.length === 0 ? null : SCOPES.filter((s) => next.includes(s));
}

/**
 * Placeholder path, used only when the service did not report a CLI (an old
 * service, or a source tree without the agent SDK).
 */
export const CLI_PATH_EXAMPLE = '/path/to/qiu-creator/packages/agent-sdk/bin/creatorhub.js';

/**
 * Where the copied command comes from (QC-094): the CLI installed with the
 * service, the repository's CLI while running from source, or the example
 * path when the service reported none.
 */
export type McpCliKind = SessionCli['source'] | 'example';

export function mcpCliKind(cli: SessionCli | null): McpCliKind {
  return cli === null ? 'example' : cli.source;
}

/** One line under the config saying which command it uses. */
export function mcpCliNote(cli: SessionCli | null): string {
  if (cli === null) return t('agents.mcpCliExample');
  return cli.source === 'installed'
    ? t('agents.mcpCliInstalled', { path: cli.command })
    : t('agents.mcpCliSource');
}

/** The toast after 複製 MCP 設定 (without the secret). */
export function mcpCopiedText(cli: SessionCli | null): string {
  const kind = mcpCliKind(cli);
  return kind === 'installed'
    ? t('agents.mcpCopied')
    : kind === 'source'
      ? t('agents.mcpCopiedSource')
      : t('agents.mcpCopiedExample');
}

/**
 * The Claude Code / Claude Desktop `mcpServers` entry (docs/architecture.md,
 * MCP 設定範例). `cli` is what `/api/v1/session` reports for this Mac
 * (QC-094); the secret is only known right after creating a token,
 * otherwise a placeholder the user replaces.
 */
export function mcpConfig(secret: string | null, cli: SessionCli | null): string {
  const token = secret ?? t('agents.mcpTokenPlaceholder');
  const entry =
    cli === null
      ? { command: 'node', args: [CLI_PATH_EXAMPLE, 'mcp'], env: { CREATORHUB_TOKEN: token } }
      : {
          command: cli.command,
          args: [...cli.args, 'mcp'],
          env: { CREATORHUB_URL: cli.server_url, CREATORHUB_TOKEN: token },
        };
  return `${JSON.stringify({ mcpServers: { creatorhub: entry } }, null, 2)}\n`;
}

export type ActivityKind =
  | 'propose'
  | 'create'
  | 'edit'
  | 'direct'
  | 'restore'
  | 'assign'
  | 'variant'
  | 'upload'
  | 'import'
  | 'project'
  | 'token'
  | 'other';

/** What kind of thing an activity entry was, from its method and route. */
export function activityKind(
  a: Pick<TokenActivity, 'kind' | 'method' | 'route'>,
  direct: boolean,
): ActivityKind {
  if (a.kind === 'token_updated') return 'token';
  const { method, route } = a;
  if (route.endsWith('/proposals')) return 'propose';
  if (route.includes('/revisions/') && route.endsWith('/restore')) return 'restore';
  if (route.includes('/variants')) return 'variant';
  if (route.includes('/projects') && route.startsWith('/api/v1/works/')) return 'assign';
  if (route.startsWith('/api/v1/projects')) return 'project';
  if (
    route.startsWith('/api/v1/assets') ||
    route.includes('/uploads') ||
    route.includes('/media')
  ) {
    return 'upload';
  }
  if (route.startsWith('/api/v1/imports') || route.startsWith('/api/v1/jobs')) return 'import';
  if (method === 'POST' && route === '/api/v1/works') return 'create';
  if (method === 'PATCH' && route === '/api/v1/works/:id') return direct ? 'direct' : 'edit';
  return 'other';
}

export const ACTIVITY_ICON: Readonly<Record<ActivityKind, IconName>> = {
  propose: 'agentInbox',
  create: 'plus',
  edit: 'doc',
  direct: 'robot',
  restore: 'history',
  assign: 'tag',
  variant: 'phone',
  upload: 'upload',
  import: 'imports',
  project: 'folder',
  token: 'key',
  other: 'api',
};

/** The entry in words: what it did (to which work), and how it ended when refused. */
export function activityText(
  a: Pick<TokenActivity, 'kind' | 'method' | 'route' | 'result' | 'reason' | 'code'>,
  kind: ActivityKind,
  title: string | null,
): { line: string; detail: string | null } {
  const name = title ?? t('agents.unknownWork');
  const line =
    kind === 'propose'
      ? t('agents.actPropose', { title: name })
      : kind === 'create'
        ? t('agents.actCreate', { title: name })
        : kind === 'edit'
          ? t('agents.actEdit', { title: name })
          : kind === 'direct'
            ? t('agents.actDirect', { title: name })
            : kind === 'restore'
              ? t('agents.actRestore', { title: name })
              : kind === 'assign'
                ? t('agents.actAssign', { title: name })
                : kind === 'variant'
                  ? t('agents.actVariant', { title: name })
                  : kind === 'upload'
                    ? t('agents.actUpload')
                    : kind === 'import'
                      ? t('agents.actImport')
                      : kind === 'project'
                        ? t('agents.actProject')
                        : kind === 'token'
                          ? t('agents.actTokenUpdated')
                          : t('agents.actOther', { method: a.method, route: a.route });
  const why = a.reason ?? a.code ?? '';
  const detail =
    a.result === 'rejected'
      ? t('agents.actRejected', { reason: why })
      : a.result === 'error'
        ? t('agents.actError', { reason: why })
        : kind === 'token'
          ? a.reason
          : null;
  return { line, detail };
}

/**
 * The service's note on what the owner changed (`scopes: read → read,propose;
 * allow_direct_body_edit: false → true`), in words. Unknown parts stay as they are.
 */
export function tokenChangeText(reason: string, projectName: (id: string) => string): string {
  const isScope = (v: string): v is TokenScope => SCOPES.some((s) => s === v);
  const value = (key: string, v: string): string => {
    if (key === 'scopes') return scopeSummary(v.split(',').filter(isScope));
    if (key === 'allow_direct_body_edit')
      return t(v === 'true' ? 'agents.changeOn' : 'agents.changeOff');
    if (key === 'project_ids') {
      return v === 'all' ? t('agents.allWorks') : v.split(',').map(projectName).join('、');
    }
    return v;
  };
  const label: Readonly<Record<string, string>> = {
    get name() {
      return t('serviceSettings.tokenName');
    },
    get scopes() {
      return t('agents.whatCan');
    },
    get allow_direct_body_edit() {
      return t('agents.direct');
    },
    get project_ids() {
      return t('agents.projectsTitle');
    },
  };
  return reason
    .split('; ')
    .map((part) => {
      const m = /^([a-z_]+): (.*) → (.*)$/.exec(part);
      if (m === null) return part;
      const [, key = '', from = '', to = ''] = m;
      const name = label[key];
      return name === undefined
        ? part
        : t('agents.changeLine', { name, from: value(key, from), to: value(key, to) });
    })
    .join(t('agents.changeSep'));
}
