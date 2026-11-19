import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePaths } from '../src/lib.js';
import {
  InstallError,
  install,
  rollback,
  uninstall,
  upgrade,
  type Deps,
  type Options,
} from '../src/ops.js';

const TEMPLATE = path.resolve(
  import.meta.dirname,
  '../../../deploy/launchd/com.qiu-creator.mac-server.plist',
);

let tmp: string;
let home: string;
let apps: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-installer-'));
  home = path.join(tmp, 'home');
  apps = path.join(tmp, 'Applications');
  fs.mkdirSync(home);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeBuild(name: string, version: string, opts: { broken?: boolean } = {}): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.mjs'), opts.broken === true ? 'BROKEN' : 'ok');
  fs.writeFileSync(path.join(dir, 'bin', 'node'), '#!/bin/sh');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(
    path.join(dir, 'build-info.json'),
    JSON.stringify({ version, commit: `c-${version}`, built_at: `t-${version}` }),
  );
  return dir;
}

function makeApp(name: string, marker: string): string {
  const dir = path.join(tmp, name, 'qiu-creator.app');
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'qiu-creator'), marker);
  return dir;
}

interface FakeState {
  loaded: boolean;
  portBusy: boolean;
  backupStatus: number;
  backupIntegrity: string;
  /**
   * Real launchd: `bootout` returns as soon as SIGTERM is sent, and the service is only
   * removed a moment later. Number of `print` calls that still find the service after each
   * `bootout` (Infinity: never removed). Consumed per bootout from `bootoutDelays`, then
   * `defaultDelay`.
   */
  defaultDelay: number;
  bootoutDelays: number[];
  /** Remaining `print`s that still succeed; null when no removal is in progress. */
  removing: number | null;
  /** Virtual clock (ms); `sleep` advances it, nothing really waits. */
  clock: number;
  sleeps: number[];
}

interface Fake {
  deps: Deps;
  calls: string[];
  state: FakeState;
  logs: string[];
}

/** A fake launchd plus a fake service that serves the installed build's identity while loaded. */
function fake(o: Options): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const state: FakeState = {
    loaded: false,
    portBusy: false,
    backupStatus: 201,
    backupIntegrity: 'ok',
    defaultDelay: 0,
    bootoutDelays: [],
    removing: null,
    clock: 0,
    sleeps: [],
  };
  const p = computePaths(o.home, o.applicationsDir);
  const deps: Deps = {
    launchctl: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'print') {
        if (state.removing !== null) {
          if (state.removing > 0) {
            state.removing -= 1;
            return Promise.resolve({ code: 0, out: '' });
          }
          state.removing = null;
          state.loaded = false;
          return Promise.resolve({ code: 113, out: '' });
        }
        return Promise.resolve({ code: state.loaded ? 0 : 113, out: '' });
      }
      if (args[0] === 'bootstrap') {
        // Still being removed: launchd answers EIO, exactly what the real upgrade got.
        if (state.removing !== null) {
          return Promise.resolve({ code: 5, out: 'Bootstrap failed: 5: Input/output error' });
        }
        if (state.loaded) return Promise.resolve({ code: 5, out: 'already loaded' });
        state.loaded = true;
      }
      if (args[0] === 'bootout') {
        const delay = state.bootoutDelays.shift() ?? state.defaultDelay;
        if (delay > 0) state.removing = delay;
        else state.loaded = false;
      }
      return Promise.resolve({ code: 0, out: '' });
    },
    copyTree: (from, to) => {
      fs.cpSync(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
      return Promise.resolve();
    },
    httpJson: (method, url) => {
      calls.push(`${method} ${new URL(url).pathname}`);
      if (url.endsWith('/health')) {
        const script = fs.readFileSync(path.join(p.server, 'server.mjs'), 'utf8');
        if (!state.loaded || script === 'BROKEN') return Promise.reject(new Error('ECONNREFUSED'));
        const info = JSON.parse(
          fs.readFileSync(path.join(p.server, 'build-info.json'), 'utf8'),
        ) as Record<string, unknown>;
        return Promise.resolve({ status: 200, body: { status: 'ok', ...info } });
      }
      if (url.endsWith('/api/v1/backups') && method === 'POST') {
        return Promise.resolve({
          status: state.backupStatus,
          body: { id: 'bk-1', integrity: state.backupIntegrity },
        });
      }
      return Promise.resolve({ status: 404, body: null });
    },
    portBusy: () => Promise.resolve(state.portBusy),
    now: () => state.clock,
    sleep: (ms) => {
      state.clock += ms;
      state.sleeps.push(ms);
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
  };
  return { deps, calls, state, logs };
}

function options(extra: Partial<Options> = {}): Options {
  return {
    home,
    applicationsDir: apps,
    port: 7420,
    launchd: true,
    uid: 501,
    dryRun: false,
    healthTimeoutMs: 50,
    plistTemplate: TEMPLATE,
    ...extra,
  };
}

function withToken(): void {
  const p = computePaths(home, apps);
  fs.mkdirSync(path.dirname(p.tokenFile), { recursive: true });
  fs.writeFileSync(p.tokenFile, 'test-token\n');
}

const read = (p: string): string => fs.readFileSync(p, 'utf8');

describe('install', () => {
  it('copies service and app, writes a rendered plist, loads it and waits for /health', async () => {
    const o = options({ serverBuild: makeBuild('b1', '1.0.0'), appBundle: makeApp('a1', 'app1') });
    const f = fake(o);
    await install(o, f.deps);
    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(read(path.join(p.app, 'Contents/MacOS/qiu-creator'))).toBe('app1');
    const plist = read(p.plist);
    expect(plist).toContain(`${home}/Library/Application Support/qiu-creator/server/bin/node`);
    expect(plist).not.toMatch(/__[A-Z_]+__/);
    expect(f.calls).toContain(`bootstrap gui/501 ${p.plist}`);
    expect(f.state.loaded).toBe(true);
  });

  it('refuses when the port is busy, the agent is loaded, or files exist, and changes nothing', async () => {
    const o = options({ serverBuild: makeBuild('b1', '1.0.0'), appBundle: makeApp('a1', 'app1') });
    const f = fake(o);
    f.state.portBusy = true;
    f.state.loaded = true;
    const msg = await install(o, f.deps).then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(msg).toContain('埠 7420 已被佔用');
    expect(msg).toContain('已載入');
    expect(fs.existsSync(computePaths(home, apps).server)).toBe(false);
    expect(fs.existsSync(computePaths(home, apps).plist)).toBe(false);
  });

  it('refuses to overwrite an existing install', async () => {
    const o = options({ serverBuild: makeBuild('b1', '1.0.0'), appBundle: makeApp('a1', 'app1') });
    const f = fake(o);
    await install(o, f.deps);
    f.state.loaded = false;
    await expect(install(o, f.deps)).rejects.toThrow(/upgrade/);
  });

  it('rejects an incomplete build', async () => {
    const dir = makeBuild('b1', '1.0.0');
    fs.rmSync(path.join(dir, 'bin'), { recursive: true });
    const o = options({ serverBuild: dir, appBundle: makeApp('a1', 'app1') });
    await expect(install(o, fake(o).deps)).rejects.toThrow(/bin\/node/);
  });

  it('dry run prints the steps and changes nothing', async () => {
    const o = options({
      dryRun: true,
      serverBuild: makeBuild('b1', '1.0.0'),
      appBundle: makeApp('a1', 'app1'),
    });
    const f = fake(o);
    await install(o, f.deps);
    expect(f.logs.filter((l) => l.startsWith('[dry-run]')).length).toBeGreaterThan(3);
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false);
    expect(fs.existsSync(apps)).toBe(false);
    expect(f.calls.some((c) => c.startsWith('bootstrap'))).toBe(false);
  });

  it('does not touch launchd when launchd is off (a HOME other than the real one)', async () => {
    const o = options({
      launchd: false,
      serverBuild: makeBuild('b1', '1.0.0'),
      appBundle: makeApp('a1', 'app1'),
    });
    const f = fake(o);
    f.state.loaded = true; // pretend a service answers, so the health wait succeeds
    await install(o, f.deps);
    expect(f.calls.filter((c) => c.startsWith('print') || c.startsWith('boot'))).toEqual([]);
  });
});

async function installed(): Promise<{ f: Fake; o: Options }> {
  const o = options({ serverBuild: makeBuild('b1', '1.0.0'), appBundle: makeApp('a1', 'app1') });
  const f = fake(o);
  await install(o, f.deps);
  withToken();
  return { f, o };
}

describe('upgrade', () => {
  it('backs up first, swaps in the new build and keeps the old one as prev', async () => {
    const { f } = await installed();
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    f.calls.length = 0;
    await upgrade(next, f.deps);
    const p = computePaths(home, apps);
    expect(f.calls.indexOf('POST /api/v1/backups')).toBeLessThan(
      f.calls.findIndex((c) => c.startsWith('bootout')),
    );
    expect(read(path.join(p.server, 'build-info.json'))).toContain('2.0.0');
    expect(read(path.join(p.serverPrev, 'build-info.json'))).toContain('1.0.0');
    expect(read(path.join(p.app, 'Contents/MacOS/qiu-creator'))).toBe('app2');
    expect(read(path.join(p.appPrev, 'Contents/MacOS/qiu-creator'))).toBe('app1');
    expect(fs.existsSync(p.serverNext)).toBe(false);
    expect(fs.existsSync(p.appNext)).toBe(false);
    expect(f.state.loaded).toBe(true);
  });

  it('aborts without any change when the backup fails', async () => {
    const { f } = await installed();
    f.state.backupStatus = 500;
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await expect(upgrade(next, f.deps)).rejects.toThrow(/備份失敗/);
    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(fs.existsSync(p.serverNext)).toBe(false);
    expect(f.state.loaded).toBe(true);
  });

  it('aborts when the backup integrity check fails', async () => {
    const { f } = await installed();
    f.state.backupIntegrity = 'corrupt';
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await expect(upgrade(next, f.deps)).rejects.toThrow(/完整性/);
  });

  it('aborts when there is no API token or the service does not answer', async () => {
    const { f } = await installed();
    const p = computePaths(home, apps);
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    fs.rmSync(p.tokenFile);
    await expect(upgrade(next, f.deps)).rejects.toThrow(/權杖/);
    withToken();
    f.state.loaded = false;
    // launchd shows it unloaded, so the fake service refuses the backup request too
    f.deps.httpJson = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(upgrade(next, f.deps)).rejects.toThrow(/沒有回應/);
  });

  it('rolls back automatically when the new build does not come up', async () => {
    const { f } = await installed();
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0', { broken: true }),
      appBundle: makeApp('a2', 'app2'),
    });
    await expect(upgrade(next, f.deps)).rejects.toThrow(/已回到 1\.0\.0[\s\S]*bk-1/);
    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(read(path.join(p.app, 'Contents/MacOS/qiu-creator'))).toBe('app1');
    expect(fs.existsSync(p.serverPrev)).toBe(false);
    expect(f.state.loaded).toBe(true);
  });

  it('needs an existing install', async () => {
    const o = options({ serverBuild: makeBuild('b2', '2.0.0'), appBundle: makeApp('a2', 'app2') });
    await expect(upgrade(o, fake(o).deps)).rejects.toThrow(/install/);
  });
});

/** launchd keeps the service for a moment after `bootout` returns (QC-036). */
describe('slow removal after bootout', () => {
  const printsBetween = (calls: string[], from: string, to: string): string[] => {
    const a = calls.findIndex((c) => c.startsWith(from));
    const b = calls.findIndex((c, i) => i > a && c.startsWith(to));
    return calls.slice(a + 1, b);
  };

  it('upgrade waits until launchd has removed the service before it bootstraps', async () => {
    const { f } = await installed();
    f.state.defaultDelay = 3;
    f.state.sleeps.length = 0;
    f.calls.length = 0;
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await upgrade(next, f.deps);

    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('2.0.0');
    expect(f.state.loaded).toBe(true);
    // Three prints still found it, the fourth did not; one 100 ms pause per print that did.
    const between = printsBetween(f.calls, 'bootout', 'bootstrap');
    expect(between.filter((c) => c.startsWith('print'))).toHaveLength(4);
    expect(f.state.sleeps.slice(0, 3)).toEqual([100, 100, 100]);
  });

  it('the automatic rollback after a failed upgrade waits too', async () => {
    const { f } = await installed();
    // The first stop is instant; the second one, before the previous build is restored, is slow.
    f.state.bootoutDelays = [0, 3];
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0', { broken: true }),
      appBundle: makeApp('a2', 'app2'),
    });
    await expect(upgrade(next, f.deps)).rejects.toThrow(/已回到 1\.0\.0[\s\S]*bk-1/);
    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(read(path.join(p.app, 'Contents/MacOS/qiu-creator'))).toBe('app1');
    expect(f.state.loaded).toBe(true);
  });

  it('manual rollback waits before it bootstraps the other build', async () => {
    const { f } = await installed();
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await upgrade(next, f.deps);
    f.state.defaultDelay = 3;
    await rollback(next, f.deps);
    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(f.state.loaded).toBe(true);
  });

  it('uninstall does not remove files while the service is still being removed', async () => {
    const { f, o } = await installed();
    f.state.defaultDelay = 3;
    await uninstall(o, f.deps);
    expect(f.state.removing).toBeNull(); // the removal had finished when uninstall went on
    expect(f.state.loaded).toBe(false);
    expect(fs.existsSync(computePaths(home, apps).server)).toBe(false);
  });

  it('gives up after 10 seconds and leaves the installed build exactly as it was (upgrade)', async () => {
    const { f } = await installed();
    f.state.defaultDelay = Number.POSITIVE_INFINITY;
    f.state.sleeps.length = 0;
    f.calls.length = 0;
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await expect(upgrade(next, f.deps)).rejects.toThrow(/10 秒[\s\S]*舊版仍在原位[\s\S]*重跑/);

    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(read(path.join(p.app, 'Contents/MacOS/qiu-creator'))).toBe('app1');
    expect(fs.existsSync(p.serverPrev)).toBe(false);
    // 100 ms polls for 10 s on the injected clock; no bootstrap was attempted.
    expect(f.state.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(f.calls.some((c) => c.startsWith('bootstrap'))).toBe(false);
  });

  it('gives up after 10 seconds without touching either build (rollback)', async () => {
    const { f } = await installed();
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await upgrade(next, f.deps);
    f.state.defaultDelay = Number.POSITIVE_INFINITY;
    await expect(rollback(next, f.deps)).rejects.toThrow(/舊版仍在原位/);
    const p = computePaths(home, apps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('2.0.0');
    expect(read(path.join(p.serverPrev, 'build-info.json'))).toContain('1.0.0');
  });

  it('the limits can be set through the options', async () => {
    const { f } = await installed();
    f.state.defaultDelay = Number.POSITIVE_INFINITY;
    f.state.sleeps.length = 0;
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
      launchdSettleTimeoutMs: 1000,
      launchdSettlePollMs: 250,
    });
    await expect(upgrade(next, f.deps)).rejects.toThrow(/1 秒/);
    expect(f.state.sleeps).toEqual([250, 250, 250, 250]);
  });
});

describe('rollback', () => {
  it('exchanges current and previous, and a second rollback goes forward again', async () => {
    const { f } = await installed();
    const next = options({
      serverBuild: makeBuild('b2', '2.0.0'),
      appBundle: makeApp('a2', 'app2'),
    });
    await upgrade(next, f.deps);
    const p = computePaths(home, apps);

    await rollback(next, f.deps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('1.0.0');
    expect(read(path.join(p.app, 'Contents/MacOS/qiu-creator'))).toBe('app1');
    expect(read(path.join(p.serverPrev, 'build-info.json'))).toContain('2.0.0');

    await rollback(next, f.deps);
    expect(read(path.join(p.server, 'build-info.json'))).toContain('2.0.0');
    expect(f.state.loaded).toBe(true);
  });

  it('says so when there is no previous build', async () => {
    const { f, o } = await installed();
    await expect(rollback(o, f.deps)).rejects.toThrow(/server\.prev/);
  });
});

describe('uninstall', () => {
  it('removes service, plist and app but never the data folder or logs', async () => {
    const { f, o } = await installed();
    const p = computePaths(home, apps);
    fs.writeFileSync(path.join(p.dataHome, 'data', 'keep.txt'), 'user data');
    fs.mkdirSync(path.join(p.dataHome, 'works'), { recursive: true });
    fs.writeFileSync(path.join(p.dataHome, 'works', 'a.md'), '# mine');
    fs.writeFileSync(path.join(p.logDir, 'mac-server.log'), 'log');
    await uninstall(o, f.deps);
    expect(fs.existsSync(p.server)).toBe(false);
    expect(fs.existsSync(p.plist)).toBe(false);
    expect(fs.existsSync(p.app)).toBe(false);
    expect(fs.existsSync(p.supportDir)).toBe(false);
    expect(f.state.loaded).toBe(false);
    expect(read(path.join(p.dataHome, 'works', 'a.md'))).toBe('# mine');
    expect(read(path.join(p.dataHome, 'data', 'keep.txt'))).toBe('user data');
    expect(fs.existsSync(path.join(p.logDir, 'mac-server.log'))).toBe(true);
  });

  it('works on a machine with nothing installed', async () => {
    const o = options();
    await expect(uninstall(o, fake(o).deps)).resolves.toBeUndefined();
  });
});

describe('InstallError', () => {
  it('is an Error subclass', () => {
    expect(new InstallError('x')).toBeInstanceOf(Error);
  });
});
