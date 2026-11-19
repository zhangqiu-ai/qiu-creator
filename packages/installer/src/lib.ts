/**
 * Pure helpers for installing, upgrading and rolling back the Mac service and
 * the app (QC-032). Nothing here touches the disk, the network or launchd, so
 * all of it is unit-tested; `ops.ts` wires it to the real world.
 */
import path from 'node:path';

export const LABEL = 'com.qiu-creator.mac-server';
export const DEFAULT_PORT = 7420;
export const APP_BUNDLE = 'qiu-creator.app';

export interface InstallPaths {
  home: string;
  /** `~/Library/Application Support/qiu-creator` */
  supportDir: string;
  /** Current service build. */
  server: string;
  /** Staging area for a new build while upgrading. */
  serverNext: string;
  /** Previous service build, kept for rollback. */
  serverPrev: string;
  /** Previous app bundle, kept for rollback (not in the Applications folder). */
  appPrevDir: string;
  appPrev: string;
  applicationsDir: string;
  app: string;
  /** Staging copy of the new app while upgrading, next to the target. */
  appNext: string;
  plist: string;
  logDir: string;
  dataHome: string;
  tokenFile: string;
}

export function computePaths(home: string, applicationsDir: string): InstallPaths {
  const supportDir = path.join(home, 'Library', 'Application Support', 'qiu-creator');
  const dataHome = path.join(home, 'CreatorHub');
  const appPrevDir = path.join(supportDir, 'app.prev');
  return {
    home,
    supportDir,
    server: path.join(supportDir, 'server'),
    serverNext: path.join(supportDir, 'server.next'),
    serverPrev: path.join(supportDir, 'server.prev'),
    appPrevDir,
    appPrev: path.join(appPrevDir, APP_BUNDLE),
    applicationsDir,
    app: path.join(applicationsDir, APP_BUNDLE),
    appNext: path.join(applicationsDir, `.${APP_BUNDLE}.next`),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    logDir: path.join(home, 'Library', 'Logs', 'qiu-creator'),
    dataHome,
    tokenFile: path.join(dataHome, 'data', 'api-token'),
  };
}

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Fill the launchd template. Every `__PLACEHOLDER__` must be known and gets
 * XML-escaped; an unknown or left-over one throws so a broken plist is never
 * written.
 */
export function renderPlist(template: string, values: { home: string; port: number }): string {
  if (!path.isAbsolute(values.home)) throw new Error(`home must be absolute: ${values.home}`);
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) {
    throw new Error(`invalid port: ${values.port}`);
  }
  const map: Record<string, string> = {
    __USER_HOME__: xmlEscape(values.home),
    __PORT__: String(values.port),
  };
  const rendered = template.replace(/__[A-Z_]+__/g, (token) => map[token] ?? token);
  const left = rendered.match(/__[A-Z_]+__/g);
  if (left !== null) throw new Error(`unreplaced placeholder(s): ${[...new Set(left)].join(', ')}`);
  return rendered;
}

export interface Preflight {
  mode: 'install' | 'upgrade';
  serverExists: boolean;
  plistExists: boolean;
  appExists: boolean;
  agentLoaded: boolean;
  /** Something other than our own service listens on the port. */
  portBusy: boolean;
  port: number;
}

/** Why an install or upgrade must not start; empty means go. Messages are shown to the user. */
export function preflightProblems(p: Preflight): string[] {
  const out: string[] = [];
  if (p.mode === 'install') {
    if (p.serverExists)
      out.push('已安裝服務（server 資料夾已存在）。要更新請用 upgrade，不要重複 install。');
    if (p.plistExists)
      out.push(
        `launchd plist 已存在（${LABEL}）。不會覆蓋；要更新請用 upgrade，要移除請先 uninstall。`,
      );
    if (p.agentLoaded)
      out.push(
        `launchd 已載入 ${LABEL}（可能是舊版或手動載入）。請先 uninstall，或自行 launchctl bootout 後再裝。`,
      );
    if (p.appExists)
      out.push('目標 Applications 目錄已有 qiu-creator.app。不會覆蓋；請先 uninstall 或移走它。');
    if (p.portBusy)
      out.push(`埠 ${p.port} 已被佔用（可能是開發中的服務）。請先關掉它，或用 --port 指定別的埠。`);
  } else {
    if (!p.serverExists)
      out.push('找不到已安裝的服務（server 資料夾不存在）。第一次安裝請用 install。');
    if (!p.plistExists)
      out.push('找不到 launchd plist。安裝狀態不完整，請先 uninstall 再 install。');
  }
  return out;
}

export interface BuildInfo {
  version: string;
  commit: string | null;
  built_at: string | null;
}

export function parseBuildInfo(text: string): BuildInfo {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('build-info.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o['version'] !== 'string') throw new Error('build-info.json has no version');
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return { version: o['version'], commit: str(o['commit']), built_at: str(o['built_at']) };
}

/** Files a service build must contain before it may replace the running one. */
export const SERVER_REQUIRED_FILES = ['server.mjs', 'bin/node', 'build-info.json', 'package.json'];

export function missingFiles(required: readonly string[], present: ReadonlySet<string>): string[] {
  return required.filter((f) => !present.has(f));
}

export interface HealthBody {
  status?: unknown;
  version?: unknown;
  commit?: unknown;
  built_at?: unknown;
}

/** Does `/health` report the build we just installed? */
export function healthMatchesBuild(body: HealthBody, expected: BuildInfo): boolean {
  if (body.status !== 'ok') return false;
  if (body.version !== expected.version) return false;
  if (expected.commit !== null && body.commit !== expected.commit) return false;
  if (expected.built_at !== null && body.built_at !== expected.built_at) return false;
  return true;
}

export interface SwapStep {
  from: string;
  to: string;
}

/**
 * Directory moves that put `next` in place of `current` while keeping the old
 * one as `prev`. A missing `prev` slot is cleared by the caller first
 * (`removeBefore`). Rollback is the same move with the roles exchanged, so
 * running it twice goes forward again.
 */
export function swapPlan(slots: { current: string; next: string; prev: string }): {
  removeBefore: string[];
  moves: SwapStep[];
} {
  return {
    removeBefore: [slots.prev],
    moves: [
      { from: slots.current, to: slots.prev },
      { from: slots.next, to: slots.current },
    ],
  };
}

/** In-place exchange of current and prev through a temporary name (for `rollback`). */
export function exchangePlan(slots: { current: string; prev: string }): SwapStep[] {
  const tmp = `${slots.current}.swap`;
  return [
    { from: slots.current, to: tmp },
    { from: slots.prev, to: slots.current },
    { from: tmp, to: slots.prev },
  ];
}

export interface RollbackState {
  serverPrevExists: boolean;
  appPrevExists: boolean;
}

/** Can `rollback` run, and what does it have to say if not? */
export function rollbackProblems(s: RollbackState): string[] {
  const out: string[] = [];
  if (!s.serverPrevExists) out.push('沒有上一版服務（server.prev 不存在），無法回滾。');
  return out;
}

/** A service port from `--port`; defaults to 7420. */
export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port: ${value}`);
  return n;
}
