import type { McpToolDef } from './define.js';
import { READ_TOOLS } from './read-tools.js';
import { WRITE_TOOLS } from './write-tools.js';

export * from './define.js';
export { platformRules, READ_TOOLS } from './read-tools.js';
export { WRITE_TOOLS } from './write-tools.js';

/** Every MCP tool: reads (QC-087), then imports and writes (QC-088). */
export const TOOLS: readonly McpToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];
