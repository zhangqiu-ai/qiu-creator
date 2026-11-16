import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInfo } from '../shared/bridge.js';

export interface AppConfig {
  /** CREATORHUB_HOME, or null when it is required but missing. */
  home: string | null;
  baseUrl: string;
}

/**
 * Development builds must point at a throwaway CREATORHUB_HOME; only the
 * packaged app may fall back to the real ~/CreatorHub.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  homedir: string = os.homedir(),
): AppConfig {
  const fromEnv = env['CREATORHUB_HOME']?.trim();
  const home =
    fromEnv !== undefined && fromEnv !== ''
      ? path.resolve(fromEnv)
      : isPackaged
        ? path.join(homedir, 'CreatorHub')
        : null;
  const host = env['CREATORHUB_HOST']?.trim() || '127.0.0.1';
  const port = env['CREATORHUB_PORT']?.trim() || '7420';
  return { home, baseUrl: `http://${host}:${port}` };
}

export function tokenFile(home: string): string {
  return path.join(home, 'data', 'api-token');
}

/** Same precedence as mac-server: CREATORHUB_TOKEN, then `data/api-token`. */
export function readConnection(config: AppConfig, env: NodeJS.ProcessEnv): ConnectionInfo {
  if (config.home === null) {
    return {
      ok: false,
      reason: 'home_missing',
      detail: 'CREATORHUB_HOME',
      baseUrl: config.baseUrl,
    };
  }
  const fromEnv = env['CREATORHUB_TOKEN']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return { ok: true, baseUrl: config.baseUrl, token: fromEnv };
  }
  try {
    const token = fs.readFileSync(tokenFile(config.home), 'utf8').trim();
    if (token !== '') return { ok: true, baseUrl: config.baseUrl, token };
  } catch {
    // fall through: the service has not created its token yet
  }
  return {
    ok: false,
    reason: 'token_missing',
    detail: tokenFile(config.home),
    baseUrl: config.baseUrl,
  };
}
