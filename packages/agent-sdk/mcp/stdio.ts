import type { CreatorHubClient } from '@qiu-creator/api-client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCreatorHubMcpServer } from './server.js';
import type { Toolset } from './tools.js';

/**
 * Serve MCP over stdin/stdout until the client disconnects. stdout carries
 * only protocol messages; anything else goes to stderr.
 */
export async function serveMcpStdio(options: {
  client: CreatorHubClient;
  toolsets: readonly Toolset[];
  version?: string;
}): Promise<void> {
  const server = createCreatorHubMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => {
      resolve();
    };
  });
  await server.connect(transport);
  await closed;
}
