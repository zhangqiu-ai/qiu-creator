import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  /** Root of all CreatorHub data (`library/`, `cache/`, `data/`). */
  home: string;
  host: string;
  port: number;
  /** Bearer token required on every `/api/*` request. */
  token: string;
  logLevel: string;
  /** Where the token came from, for startup logging (never log the token itself). */
  tokenSource: 'env' | 'file';
}

export const DEFAULT_PORT = 7420;
export const DEFAULT_HOST = '127.0.0.1';
const TOKEN_FILE = path.join('data', 'api-token');

export function defaultHome(): string {
  return path.join(os.homedir(), 'CreatorHub');
}

/**
 * Build config from environment variables:
 * - `CREATORHUB_HOME` (default `~/CreatorHub`; dev and tests must point it at a temp dir)
 * - `CREATORHUB_HOST` (default `127.0.0.1`), `CREATORHUB_PORT` (default 7420)
 * - `CREATORHUB_TOKEN`; when unset, a random token is created once in
 *   `<home>/data/api-token` with mode 0600 and reused afterwards.
 * - `CREATORHUB_LOG_LEVEL` (default `info`)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const home = path.resolve(env['CREATORHUB_HOME'] ?? defaultHome());
  const host = env['CREATORHUB_HOST'] ?? DEFAULT_HOST;
  const port = parsePort(env['CREATORHUB_PORT']);
  const logLevel = env['CREATORHUB_LOG_LEVEL'] ?? 'info';
  const envToken = env['CREATORHUB_TOKEN'];
  if (envToken !== undefined && envToken !== '') {
    assertStrongToken(envToken);
    return { home, host, port, token: envToken, logLevel, tokenSource: 'env' };
  }
  return { home, host, port, token: readOrCreateToken(home), logLevel, tokenSource: 'file' };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CREATORHUB_PORT must be an integer 0-65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function assertStrongToken(token: string): void {
  if (token.length < 16) {
    throw new Error('CREATORHUB_TOKEN must be at least 16 characters');
  }
}

export function tokenFilePath(home: string): string {
  return path.join(home, TOKEN_FILE);
}

function readOrCreateToken(home: string): string {
  const file = tokenFilePath(home);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    assertStrongToken(existing);
    return existing;
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  // `wx` fails if another process created it first; then read theirs.
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if (isNodeError(err) && err.code === 'EEXIST') {
      return fs.readFileSync(file, 'utf8').trim();
    }
    throw err;
  }
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
