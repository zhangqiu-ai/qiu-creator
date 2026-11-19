/**
 * install / upgrade / rollback / uninstall (QC-032). Everything that touches
 * the outside world goes through `Deps`, so tests run the real flows against a
 * temporary HOME with a fake launchctl and a fake service.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LABEL,
  SERVER_REQUIRED_FILES,
  computePaths,
  exchangePlan,
  healthMatchesBuild,
  missingFiles,
  parseBuildInfo,
  preflightProblems,
  renderPlist,
  rollbackProblems,
  swapPlan,
  type BuildInfo,
  type InstallPaths,
} from './lib.js';

export interface Deps {
  /** Run launchctl; `code` is the exit status. */
  launchctl(args: string[]): Promise<{ code: number; out: string }>;
  /** Copy a directory tree preserving symlinks and attributes (ditto on macOS). */
  copyTree(from: string, to: string): Promise<void>;
  httpJson(
    method: 'GET' | 'POST',
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
  portBusy(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface Options {
  home: string;
  applicationsDir: string;
  port: number;
  /** Really load/unload launchd. Off for any HOME other than the real one. */
  launchd: boolean;
  uid: number;
  /** Only print what would happen (read-only checks still run). */
  dryRun: boolean;
  healthTimeoutMs: number;
  /** Built service folder (`services/mac-server/dist`). */
  serverBuild?: string;
  /** Built `.app` bundle. */
  appBundle?: string;
  /** launchd plist template. */
  plistTemplate?: string;
}

export class InstallError extends Error {}

class Run {
  readonly paths: InstallPaths;
  constructor(
    readonly o: Options,
    readonly d: Deps,
  ) {
    this.paths = computePaths(o.home, o.applicationsDir);
  }

  get domain(): string {
    return `gui/${this.o.uid}`;
  }

  /** Perform a change, or only announce it in a dry run. */
  async act(what: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.o.dryRun) {
      this.d.log(`[dry-run] ${what}`);
      return;
    }
    this.d.log(what);
    await fn();
  }

  exists(p: string): boolean {
    return fs.existsSync(p);
  }

  async agentLoaded(): Promise<boolean> {
    if (!this.o.launchd) return false;
    return (await this.d.launchctl(['print', `${this.domain}/${LABEL}`])).code === 0;
  }

  async bootout(): Promise<void> {
    if (!this.o.launchd) {
      this.d.log('launchd skipped (HOME is not the real one)');
      return;
    }
    if (await this.agentLoaded()) {
      const r = await this.d.launchctl(['bootout', `${this.domain}/${LABEL}`]);
      if (r.code !== 0) throw new InstallError(`launchctl bootout failed: ${r.out.trim()}`);
    }
  }

  async bootstrap(): Promise<void> {
    if (!this.o.launchd) {
      this.d.log('launchd skipped (HOME is not the real one)');
      return;
    }
    const r = await this.d.launchctl(['bootstrap', this.domain, this.paths.plist]);
    if (r.code !== 0) throw new InstallError(`launchctl bootstrap failed: ${r.out.trim()}`);
  }

  buildInfoOf(dir: string): BuildInfo {
    return parseBuildInfo(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8'));
  }

  checkBuild(dir: string): BuildInfo {
    const present = new Set(SERVER_REQUIRED_FILES.filter((f) => fs.existsSync(path.join(dir, f))));
    const missing = missingFiles(SERVER_REQUIRED_FILES, present);
    if (missing.length > 0) {
      throw new InstallError(
        `服務建置產物不完整（${dir}）：缺 ${missing.join(', ')}。先跑 mac-server 的 build。`,
      );
    }
    return this.buildInfoOf(dir);
  }

  checkApp(bundle: string): void {
    if (!fs.existsSync(path.join(bundle, 'Contents', 'MacOS'))) {
      throw new InstallError(`找不到 .app（${bundle}）。先跑 apps/mac 的 package。`);
    }
  }

  writePlist(): void {
    const template = this.o.plistTemplate;
    if (template === undefined) throw new InstallError('no plist template given');
    const text = renderPlist(fs.readFileSync(template, 'utf8'), {
      home: this.o.home,
      port: this.o.port,
    });
    fs.mkdirSync(path.dirname(this.paths.plist), { recursive: true });
    fs.mkdirSync(this.paths.logDir, { recursive: true });
    fs.writeFileSync(this.paths.plist, text, { mode: 0o644 });
  }

  healthUrl(): string {
    return `http://127.0.0.1:${this.o.port}/health`;
  }

  /** Wait until `/health` reports the expected build. */
  async waitHealthy(expected: BuildInfo): Promise<boolean> {
    if (this.o.dryRun) return true;
    const deadline = Date.now() + this.o.healthTimeoutMs;
    for (;;) {
      try {
        const r = await this.d.httpJson('GET', this.healthUrl());
        if (r.status === 200 && healthMatchesBuild(r.body as Record<string, unknown>, expected)) {
          return true;
        }
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) return false;
      await this.d.sleep(500);
    }
  }

  /** Online backup through the service API. Throws unless it succeeds with a clean integrity check. */
  async backupBeforeUpgrade(): Promise<string> {
    let token: string;
    try {
      token = fs.readFileSync(this.paths.tokenFile, 'utf8').trim();
    } catch {
      throw new InstallError(
        `讀不到 API 權杖（${this.paths.tokenFile}），無法在升級前備份。已中止，沒有改動任何東西。`,
      );
    }
    let r: { status: number; body: unknown };
    try {
      r = await this.d.httpJson('POST', `http://127.0.0.1:${this.o.port}/api/v1/backups`, {
        authorization: `Bearer ${token}`,
      });
    } catch (err) {
      throw new InstallError(
        `服務沒有回應，無法在升級前備份（${err instanceof Error ? err.message : String(err)}）。已中止，沒有改動任何東西。`,
      );
    }
    const b = r.body as { id?: unknown; integrity?: unknown } | null;
    if (r.status !== 201 || b === null || typeof b.id !== 'string') {
      throw new InstallError(`升級前備份失敗（HTTP ${r.status}）。已中止，沒有改動任何東西。`);
    }
    if (b.integrity !== 'ok') {
      throw new InstallError(`升級前備份 ${b.id} 的完整性檢查沒通過。已中止，沒有改動任何東西。`);
    }
    return b.id;
  }
}

function rm(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function mv(from: string, to: string): void {
  fs.renameSync(from, to);
}

async function preflight(run: Run, mode: 'install' | 'upgrade'): Promise<void> {
  const p = run.paths;
  const problems = preflightProblems({
    mode,
    serverExists: run.exists(p.server),
    plistExists: run.exists(p.plist),
    appExists: run.exists(p.app),
    agentLoaded: await run.agentLoaded(),
    portBusy: mode === 'install' ? await run.d.portBusy(run.o.port) : false,
    port: run.o.port,
  });
  if (problems.length > 0) throw new InstallError(problems.map((m) => `- ${m}`).join('\n'));
}

export async function install(o: Options, d: Deps): Promise<void> {
  const run = new Run(o, d);
  const p = run.paths;
  if (o.serverBuild === undefined || o.appBundle === undefined) {
    throw new InstallError('install needs --server-build and --app');
  }
  const serverBuild = o.serverBuild;
  const appBundle = o.appBundle;
  const build = run.checkBuild(serverBuild);
  run.checkApp(appBundle);
  await preflight(run, 'install');

  await run.act(
    `copy service ${build.version} (${build.commit ?? 'no commit'}) -> ${p.server}`,
    async () => {
      fs.mkdirSync(p.supportDir, { recursive: true });
      await d.copyTree(serverBuild, p.server);
    },
  );
  await run.act(`copy app -> ${p.app}`, async () => {
    fs.mkdirSync(p.applicationsDir, { recursive: true });
    await d.copyTree(appBundle, p.app);
  });
  await run.act(`write ${p.plist}`, () => {
    run.writePlist();
  });
  await run.act('launchctl bootstrap', async () => {
    try {
      await run.bootstrap();
    } catch (err) {
      await run.bootout().catch(() => undefined);
      throw err;
    }
  });
  if (!(await run.waitHealthy(build))) {
    throw new InstallError(
      `服務沒有在 ${o.healthTimeoutMs / 1000} 秒內回報預期版本。檢查 ${p.logDir}。已安裝的檔案保留；要清掉請跑 uninstall。`,
    );
  }
  d.log(
    o.dryRun ? 'dry run finished; nothing was changed' : `installed ${build.version}; /health ok`,
  );
}

export async function upgrade(o: Options, d: Deps): Promise<void> {
  const run = new Run(o, d);
  const p = run.paths;
  if (o.serverBuild === undefined || o.appBundle === undefined) {
    throw new InstallError('upgrade needs --server-build and --app');
  }
  const serverBuild = o.serverBuild;
  const appBundle = o.appBundle;
  const build = run.checkBuild(serverBuild);
  run.checkApp(appBundle);
  await preflight(run, 'upgrade');
  const old = run.buildInfoOf(p.server);

  // 1. Backup first. No backup, no upgrade; nothing has changed yet.
  let backupId = '(dry-run)';
  if (!o.dryRun) backupId = await run.backupBeforeUpgrade();
  else d.log('[dry-run] POST /api/v1/backups');
  if (!o.dryRun) d.log(`backup ${backupId} ok`);

  // 2. Stage the new build next to the running one.
  await run.act('stage new service and app', async () => {
    rm(p.serverNext);
    rm(p.appNext);
    await d.copyTree(serverBuild, p.serverNext);
    fs.mkdirSync(p.applicationsDir, { recursive: true });
    await d.copyTree(appBundle, p.appNext);
  });

  // 3. Swap, keeping the old ones as .prev.
  await run.act('stop service and swap in the new build', async () => {
    await run.bootout();
    swapDirs(p.server, p.serverNext, p.serverPrev);
    fs.mkdirSync(p.appPrevDir, { recursive: true });
    if (run.exists(p.app)) swapDirs(p.app, p.appNext, p.appPrev);
    else mv(p.appNext, p.app);
    run.writePlist();
  });

  // 4. Start it; on any failure go back to the previous build.
  try {
    await run.act('launchctl bootstrap', () => run.bootstrap());
    if (!(await run.waitHealthy(build))) {
      throw new InstallError('新版服務沒有在時限內回報預期版本');
    }
  } catch (err) {
    d.log(`upgrade failed: ${err instanceof Error ? err.message : String(err)}; rolling back`);
    await restorePrevious(run, old);
    throw new InstallError(
      `升級失敗，已回到 ${old.version}。升級前備份：${backupId}。新版的錯誤見 ${p.logDir}。`,
    );
  }
  if (o.dryRun) {
    d.log('dry run finished; nothing was changed');
    return;
  }
  d.log(
    `upgraded ${old.version} -> ${build.version}; previous build kept as server.prev; backup ${backupId}`,
  );
}

function swapDirs(current: string, next: string, prev: string): void {
  const plan = swapPlan({ current, next, prev });
  for (const target of plan.removeBefore) rm(target);
  for (const step of plan.moves) mv(step.from, step.to);
}

/** After a failed start: put prev back as current and start it. */
async function restorePrevious(run: Run, expected: BuildInfo): Promise<void> {
  const p = run.paths;
  await run.bootout().catch(() => undefined);
  // current is the failed new build, prev the old one: exchange them, then drop the failed build.
  for (const step of exchangePlan({ current: p.server, prev: p.serverPrev })) {
    mv(step.from, step.to);
  }
  rm(p.serverPrev);
  if (run.exists(p.appPrev)) {
    for (const step of exchangePlan({ current: p.app, prev: p.appPrev })) mv(step.from, step.to);
    rm(p.appPrev);
  }
  run.writePlist();
  await run.bootstrap();
  if (!(await run.waitHealthy(expected))) {
    throw new InstallError('回滾後舊版也沒有起來，請手動檢查日誌');
  }
}

/** Manual rollback: exchange current and previous (a second rollback goes forward again). */
export async function rollback(o: Options, d: Deps): Promise<void> {
  const run = new Run(o, d);
  const p = run.paths;
  const problems = rollbackProblems({
    serverPrevExists: run.exists(p.serverPrev),
    appPrevExists: run.exists(p.appPrev),
  });
  if (!run.exists(p.server)) problems.push('找不到已安裝的服務，無法回滾。');
  if (problems.length > 0) throw new InstallError(problems.map((m) => `- ${m}`).join('\n'));
  const target = run.buildInfoOf(p.serverPrev);
  const from = run.buildInfoOf(p.server);

  await run.act(`stop service; exchange ${from.version} <-> ${target.version}`, async () => {
    await run.bootout();
    for (const step of exchangePlan({ current: p.server, prev: p.serverPrev })) {
      mv(step.from, step.to);
    }
    if (run.exists(p.appPrev) && run.exists(p.app)) {
      for (const step of exchangePlan({ current: p.app, prev: p.appPrev })) mv(step.from, step.to);
    }
    run.writePlist();
  });
  await run.act('launchctl bootstrap', () => run.bootstrap());
  if (!(await run.waitHealthy(target))) {
    throw new InstallError(`回滾到 ${target.version} 後服務沒有回報預期版本。檢查 ${p.logDir}。`);
  }
  d.log(
    `rolled back ${from.version} -> ${target.version}. 若新版已遷移過資料庫而舊版讀不了，請從升級前的備份還原（設定頁或 POST /api/v1/backups/:id/restore）。`,
  );
}

/** Remove the service, the plist and the app. Never touches the data folder. */
export async function uninstall(o: Options, d: Deps): Promise<void> {
  const run = new Run(o, d);
  const p = run.paths;
  await run.act('launchctl bootout', () => run.bootout());
  for (const target of [
    p.plist,
    p.server,
    p.serverNext,
    p.serverPrev,
    p.appPrevDir,
    p.appNext,
    p.app,
  ]) {
    if (run.exists(target)) {
      await run.act(`remove ${target}`, () => {
        rm(target);
      });
    }
  }
  await run.act(`remove ${p.supportDir} if empty`, () => {
    try {
      fs.rmdirSync(p.supportDir);
    } catch {
      // not empty or already gone
    }
  });
  d.log(`uninstalled; ${p.dataHome} and ${p.logDir} were left untouched`);
}
