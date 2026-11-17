import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConnection, resolveConfig } from '../src/main/config.js';
import { contentSecurityPolicy } from '../src/main/csp.js';

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-test-'));
  temps.push(dir);
  return dir;
}

describe('resolveConfig', () => {
  it('refuses to fall back to ~/CreatorHub in development', () => {
    expect(resolveConfig({}, false, '/Users/x').home).toBeNull();
  });

  it('uses ~/CreatorHub only for the packaged app', () => {
    expect(resolveConfig({}, true, '/Users/x').home).toBe('/Users/x/CreatorHub');
  });

  it('honours CREATORHUB_HOME, HOST and PORT', () => {
    const c = resolveConfig(
      { CREATORHUB_HOME: '/tmp/h', CREATORHUB_HOST: '127.0.0.1', CREATORHUB_PORT: '7999' },
      false,
    );
    expect(c).toEqual({ home: '/tmp/h', baseUrl: 'http://127.0.0.1:7999' });
  });
});

describe('readConnection', () => {
  it('reports a missing home', () => {
    expect(readConnection({ home: null, baseUrl: 'http://127.0.0.1:7420' }, {})).toMatchObject({
      ok: false,
      reason: 'home_missing',
    });
  });

  it('reports a missing token file (service never started)', () => {
    const home = tempHome();
    expect(readConnection({ home, baseUrl: 'http://127.0.0.1:7420' }, {})).toMatchObject({
      ok: false,
      reason: 'token_missing',
    });
  });

  it('reads data/api-token, with CREATORHUB_TOKEN taking precedence', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, 'data'));
    fs.writeFileSync(path.join(home, 'data', 'api-token'), 'file-token-0123456789\n');
    const config = { home, baseUrl: 'http://127.0.0.1:7420' };
    expect(readConnection(config, {})).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:7420',
      token: 'file-token-0123456789',
    });
    expect(readConnection(config, { CREATORHUB_TOKEN: 'env-token-0123456789' })).toMatchObject({
      token: 'env-token-0123456789',
    });
  });
});

describe('contentSecurityPolicy', () => {
  it('allows no inline scripts and no remote connections in production', () => {
    const csp = contentSecurityPolicy(null);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('loads images only from the app, the asset proxy and the Mac service', () => {
    const csp = contentSecurityPolicy(null, 'http://127.0.0.1:7421/');
    expect(csp).toContain("img-src 'self' data: blob: qc-asset: http://127.0.0.1:7421;");
    expect(csp).toContain("media-src 'self' qc-asset: http://127.0.0.1:7421;");
    expect(csp).not.toMatch(/img-src[^;]*https:/);
    expect(contentSecurityPolicy(null)).toContain('http://127.0.0.1:7420');
  });

  it('adds only the Vite HMR socket in development', () => {
    expect(contentSecurityPolicy('http://localhost:5180/')).toContain(
      "connect-src 'self' ws://localhost:5180",
    );
  });
});
