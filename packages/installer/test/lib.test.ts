import { describe, expect, it } from 'vitest';
import {
  computePaths,
  exchangePlan,
  healthMatchesBuild,
  missingFiles,
  parseBuildInfo,
  parsePort,
  preflightProblems,
  renderPlist,
  rollbackProblems,
  swapPlan,
} from '../src/lib.js';

const TEMPLATE = `<dict><string>__USER_HOME__/x</string><string>__PORT__</string><string>__USER_HOME__/y</string></dict>`;

describe('computePaths', () => {
  it('derives every location from HOME and the applications folder', () => {
    const p = computePaths('/Users/me', '/Applications');
    expect(p.server).toBe('/Users/me/Library/Application Support/qiu-creator/server');
    expect(p.serverPrev).toBe('/Users/me/Library/Application Support/qiu-creator/server.prev');
    expect(p.appPrev).toBe(
      '/Users/me/Library/Application Support/qiu-creator/app.prev/qiu-creator.app',
    );
    expect(p.app).toBe('/Applications/qiu-creator.app');
    expect(p.plist).toBe('/Users/me/Library/LaunchAgents/com.qiu-creator.mac-server.plist');
    expect(p.tokenFile).toBe('/Users/me/CreatorHub/data/api-token');
  });
});

describe('renderPlist', () => {
  it('replaces every occurrence', () => {
    const out = renderPlist(TEMPLATE, { home: '/Users/me', port: 7421 });
    expect(out).toBe(
      '<dict><string>/Users/me/x</string><string>7421</string><string>/Users/me/y</string></dict>',
    );
  });
  it('escapes XML in the home path', () => {
    expect(renderPlist(TEMPLATE, { home: '/Users/a&b', port: 1 })).toContain('/Users/a&amp;b/x');
  });
  it('rejects unknown placeholders, relative homes and bad ports', () => {
    expect(() => renderPlist('__NOPE__', { home: '/h', port: 1 })).toThrow(/__NOPE__/);
    expect(() => renderPlist(TEMPLATE, { home: 'rel', port: 1 })).toThrow(/absolute/);
    expect(() => renderPlist(TEMPLATE, { home: '/h', port: 0 })).toThrow(/port/);
    expect(() => renderPlist(TEMPLATE, { home: '/h', port: 70000 })).toThrow(/port/);
  });
});

describe('preflightProblems', () => {
  const clean = {
    mode: 'install' as const,
    serverExists: false,
    plistExists: false,
    appExists: false,
    agentLoaded: false,
    portBusy: false,
    port: 7420,
  };
  it('passes a clean machine', () => {
    expect(preflightProblems(clean)).toEqual([]);
  });
  it('names each install blocker', () => {
    const msgs = preflightProblems({
      ...clean,
      serverExists: true,
      plistExists: true,
      appExists: true,
      agentLoaded: true,
      portBusy: true,
    });
    expect(msgs).toHaveLength(5);
    expect(msgs.join('\n')).toContain('7420');
    expect(msgs.join('\n')).toContain('upgrade');
  });
  it('upgrade needs an existing install', () => {
    expect(preflightProblems({ ...clean, mode: 'upgrade' })).toHaveLength(2);
    expect(
      preflightProblems({ ...clean, mode: 'upgrade', serverExists: true, plistExists: true }),
    ).toEqual([]);
  });
  it('an occupied port does not block an upgrade', () => {
    expect(
      preflightProblems({
        ...clean,
        mode: 'upgrade',
        serverExists: true,
        plistExists: true,
        portBusy: true,
      }),
    ).toEqual([]);
  });
});

describe('build info and health', () => {
  const info = { version: '0.1.0', commit: 'abc', built_at: 't1' };
  it('parses build-info.json', () => {
    expect(parseBuildInfo('{"version":"1","commit":null,"built_at":"x"}')).toEqual({
      version: '1',
      commit: null,
      built_at: 'x',
    });
    expect(() => parseBuildInfo('[]')).toThrow();
    expect(() => parseBuildInfo('{}')).toThrow(/version/);
  });
  it('matches only the expected build', () => {
    expect(healthMatchesBuild({ status: 'ok', ...info }, info)).toBe(true);
    expect(healthMatchesBuild({ status: 'ok', ...info, commit: 'old' }, info)).toBe(false);
    expect(healthMatchesBuild({ status: 'ok', ...info, built_at: 't0' }, info)).toBe(false);
    expect(healthMatchesBuild({ status: 'bad', ...info }, info)).toBe(false);
  });
  it('lists missing files', () => {
    expect(missingFiles(['a', 'b'], new Set(['a']))).toEqual(['b']);
  });
});

describe('directory plans', () => {
  it('swap keeps the old build as prev', () => {
    expect(swapPlan({ current: '/s', next: '/s.next', prev: '/s.prev' })).toEqual({
      removeBefore: ['/s.prev'],
      moves: [
        { from: '/s', to: '/s.prev' },
        { from: '/s.next', to: '/s' },
      ],
    });
  });
  it('exchange goes through a temporary name', () => {
    expect(exchangePlan({ current: '/s', prev: '/s.prev' })).toEqual([
      { from: '/s', to: '/s.swap' },
      { from: '/s.prev', to: '/s' },
      { from: '/s.swap', to: '/s.prev' },
    ]);
  });
  it('rollback needs a previous server', () => {
    expect(rollbackProblems({ serverPrevExists: false, appPrevExists: true })).toHaveLength(1);
    expect(rollbackProblems({ serverPrevExists: true, appPrevExists: false })).toEqual([]);
  });
});

describe('parsePort', () => {
  it('defaults and validates', () => {
    expect(parsePort(undefined)).toBe(7420);
    expect(parsePort('8000')).toBe(8000);
    expect(() => parsePort('abc')).toThrow();
    expect(() => parsePort('0')).toThrow();
  });
});
