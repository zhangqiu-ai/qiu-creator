/**
 * MCP adapter for external agents (QC-087 reads, QC-088 imports and writes, QC-089 proposals; docs/mcp-plan.md): `creatorhub mcp`.
 * Calls `@qiu-creator/api-client` only — never the filesystem or SQLite.
 */
export {
  createCreatorHubMcpServer,
  enabledTools,
  parseToolsets,
  MCP_SERVER_NAME,
  TEXT_SCRIPT_RULE,
  textScriptInstruction,
  type CreatorHubMcpOptions,
} from './server.js';
export { serveMcpStdio } from './stdio.js';
export {
  TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  PROPOSAL_TOOLS,
  PROJECT_RULE_TOOLS,
  AGENT_STATUS_TOOLS,
  REPORT_SCOPES,
  TOOLSETS,
  USER_DATA_NOTE,
  SCRIPT_NOTE,
  isReadOnly,
  retryHint,
  platformRules,
  type McpToolDef,
  type ToolAccess,
  type ToolGroup,
  type Toolset,
} from './tools.js';
export {
  coverageOf,
  toolRoutes,
  MCP_EXCLUDED,
  MCP_EXCLUDED_AREAS,
  MCP_PENDING,
  MCP_PENDING_AREAS,
  type Coverage,
} from './coverage.js';
export { diffLines, unifiedDiff, type DiffLine } from './diff.js';
