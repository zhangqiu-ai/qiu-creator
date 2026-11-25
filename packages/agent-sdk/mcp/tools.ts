import type { McpToolDef } from './define.js';
import { PROJECT_RULE_TOOLS } from './project-rule-tools.js';
import { PROPOSAL_TOOLS } from './proposal-tools.js';
import { AGENT_STATUS_TOOLS } from './agent-status-tools.js';
import { READ_TOOLS } from './read-tools.js';
import { WRITE_TOOLS } from './write-tools.js';

export * from './define.js';
export { platformRules, READ_TOOLS } from './read-tools.js';
export { WRITE_TOOLS } from './write-tools.js';
export { PROPOSAL_TOOLS } from './proposal-tools.js';
export { PROJECT_RULE_TOOLS } from './project-rule-tools.js';
export { AGENT_STATUS_TOOLS } from './agent-status-tools.js';

/**
 * Every MCP tool: reads (QC-087), imports and writes (QC-088), proposals and
 * text (QC-089), project rules (QC-092), agent live status (QC-096).
 */
export const TOOLS: readonly McpToolDef[] = [
  ...READ_TOOLS,
  ...WRITE_TOOLS,
  ...PROPOSAL_TOOLS,
  ...PROJECT_RULE_TOOLS,
  ...AGENT_STATUS_TOOLS,
];
