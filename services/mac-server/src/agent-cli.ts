import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where the `creatorhub` CLI is on this Mac (QC-094), for the MCP config the
 * app copies. An installed service carries the CLI next to itself
 * (`<server>/bin/creatorhub`, see scripts/build.ts), so the path follows the
 * build that is actually running through upgrades and rollbacks. Running
 * from source, it is the repository's `packages/agent-sdk/bin/creatorhub.js`
 * started with the same Node.
 */
export interface CliLocation {
  /** Executable to start. */
  command: string;
  /** Arguments before the CLI's own subcommand (e.g. `mcp`). */
  args: string[];
  source: 'installed' | 'source';
}

export function locateCli(
  launcher: URL = new URL('./bin/creatorhub', import.meta.url),
  sourceBin: URL = new URL('../../../packages/agent-sdk/bin/creatorhub.js', import.meta.url),
  node: string = process.execPath,
): CliLocation | null {
  const installed = fileURLToPath(launcher);
  if (isFile(installed)) return { command: installed, args: [], source: 'installed' };
  const repoBin = fileURLToPath(sourceBin);
  if (isFile(repoBin)) return { command: node, args: [repoBin], source: 'source' };
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
