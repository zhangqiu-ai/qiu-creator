/**
 * Usage: tsx src/cli.ts <install|upgrade|rollback|uninstall> [options]
 *
 *   --server-build <dir>   built service folder (default services/mac-server/dist)
 *   --app <path>           built qiu-creator.app (default apps/mac/release/mac-arm64/qiu-creator.app)
 *   --applications <dir>   where the app goes (default /Applications)
 *   --home <dir>           HOME to install into (default the real one). launchd is only
 *                          touched when this is the real HOME.
 *   --port <n>             service port (default 7420)
 *   --yes                  really do it; without it the command is a dry run
 */
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parsePort } from './lib.js';
import {
  InstallError,
  install,
  rollback,
  uninstall,
  upgrade,
  type Deps,
  type Options,
} from './ops.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function realDeps(): Deps {
  return {
    launchctl: (args) =>
      new Promise((resolve) => {
        execFile('/bin/launchctl', args, (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
          resolve({ code, out: `${stdout}${stderr}` });
        });
      }),
    copyTree: (from, to) =>
      new Promise((resolve, reject) => {
        const p = spawn('/usr/bin/ditto', [from, to], { stdio: 'inherit' });
        p.on('error', reject);
        p.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ditto exited with ${code}`));
        });
      }),
    httpJson: (method, url, headers) =>
      new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers, timeout: 5000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let body: unknown = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              // not JSON
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      }),
    portBusy: (port) =>
      new Promise((resolve) => {
        const s = net.connect({ port, host: '127.0.0.1' });
        s.once('connect', () => {
          s.destroy();
          resolve(true);
        });
        s.once('error', () => {
          resolve(false);
        });
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => {
      process.stdout.write(`${m}\n`);
    },
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'server-build': { type: 'string' },
      app: { type: 'string' },
      applications: { type: 'string' },
      home: { type: 'string' },
      port: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  // pnpm runs us inside the package folder; relative paths are the caller's.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const realHome = os.homedir();
  const home = path.resolve(cwd, values.home ?? realHome);
  const o: Options = {
    home,
    applicationsDir: path.resolve(cwd, values.applications ?? '/Applications'),
    port: parsePort(values.port),
    launchd: home === realHome,
    uid: process.getuid?.() ?? 501,
    dryRun: values.yes !== true,
    healthTimeoutMs: 30_000,
    serverBuild: path.resolve(
      cwd,
      values['server-build'] ?? path.join(repo, 'services/mac-server/dist'),
    ),
    appBundle: path.resolve(
      cwd,
      values.app ?? path.join(repo, 'apps/mac/release/mac-arm64/qiu-creator.app'),
    ),
    plistTemplate: path.join(repo, 'deploy/launchd/com.qiu-creator.mac-server.plist'),
  };
  const d = realDeps();
  if (o.dryRun) d.log('dry run (add --yes to apply)');
  switch (command) {
    case 'install':
      return install(o, d);
    case 'upgrade':
      return upgrade(o, d);
    case 'rollback':
      return rollback(o, d);
    case 'uninstall':
      return uninstall(o, d);
    default:
      throw new InstallError('usage: qc <install|upgrade|rollback|uninstall> [--yes] [options]');
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
