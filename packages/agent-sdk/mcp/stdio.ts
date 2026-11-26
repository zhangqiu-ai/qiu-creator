import type { CreatorHubClient } from '@qiu-creator/api-client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCreatorHubMcpServer } from './server.js';
import type { Toolset } from './tools.js';

/**
 * Serve MCP over stdin/stdout until the client disconnects (stdin ends) or the
 * process is asked to stop (SIGTERM, SIGINT). stdout carries only protocol
 * messages; anything else goes to stderr. A broken stdin rejects.
 */
export async function serveMcpStdio(options: {
  client: CreatorHubClient;
  toolsets: readonly Toolset[];
  version?: string;
}): Promise<void> {
  // QC-103: name the script to write in; the server still works without it.
  const textScript = await options.client.session().then(
    (s) => s.text_script,
    () => null,
  );
  const server = createCreatorHubMcpServer({ ...options, textScript });
  const transport = new StdioServerTransport();
  let reject: (error: Error) => void = () => undefined;
  const closed = new Promise<void>((resolve, rejectClosed) => {
    reject = rejectClosed;
    server.server.onclose = () => {
      resolve();
    };
  });
  // The SDK's transport only watches stdin's data and error, so the end of
  // input (the client disconnecting) has to close it from here (QC-101).
  const stop = () => {
    void transport.close();
  };
  const fail = (error: Error) => {
    reject(error);
    stop();
  };
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  process.stdin.once('error', fail);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await server.connect(transport);
    await closed;
  } finally {
    process.stdin.off('end', stop);
    process.stdin.off('close', stop);
    process.stdin.off('error', fail);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
