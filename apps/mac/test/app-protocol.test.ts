import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_INDEX_URL,
  appFilePath,
  appResponseHeaders,
  contentTypeOf,
  isAppUrl,
} from '../src/main/app-protocol.js';
import { contentSecurityPolicy } from '../src/main/csp.js';

const ROOT = '/Applications/qiu-creator.app/Contents/Resources/app/dist';

describe('qc-app:// renderer protocol (QC-031)', () => {
  it('maps renderer URLs to files inside dist', () => {
    expect(appFilePath(APP_INDEX_URL, ROOT)).toBe(path.join(ROOT, 'index.html'));
    expect(appFilePath('qc-app://renderer/', ROOT)).toBe(path.join(ROOT, 'index.html'));
    expect(appFilePath('qc-app://renderer/assets/index-abc.js?v=1#x', ROOT)).toBe(
      path.join(ROOT, 'assets/index-abc.js'),
    );
    expect(appFilePath('qc-app://renderer/assets/%E5%9C%96.png', ROOT)).toBe(
      path.join(ROOT, 'assets/圖.png'),
    );
  });

  it('refuses other hosts, schemes and paths outside dist', () => {
    expect(appFilePath('qc-app://other/index.html', ROOT)).toBeNull();
    expect(appFilePath('file:///etc/passwd', ROOT)).toBeNull();
    // URL dot segments are resolved by the URL parser and cannot climb above the origin.
    expect(appFilePath('qc-app://renderer/../../secret', ROOT)).toBe(path.join(ROOT, 'secret'));
    expect(appFilePath('qc-app://renderer/%2e%2e/%2e%2e/secret', ROOT)).toBe(
      path.join(ROOT, 'secret'),
    );
    // Encoded slashes are decoded after parsing: these would escape, so they are refused.
    expect(appFilePath('qc-app://renderer/assets/..%2F..%2F..%2Fsecret', ROOT)).toBeNull();
    expect(appFilePath('qc-app://renderer/a%00b', ROOT)).toBeNull();
    expect(appFilePath('qc-app://renderer/%E0%A4%A', ROOT)).toBeNull();
    expect(appFilePath('not a url', ROOT)).toBeNull();
  });

  it('serves every file with the CSP for the actual service address', () => {
    const csp = contentSecurityPolicy(null, 'http://127.0.0.1:7555');
    const headers = appResponseHeaders(path.join(ROOT, 'index.html'), csp);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['content-security-policy']).toContain('img-src');
    expect(headers['content-security-policy']).toContain('http://127.0.0.1:7555');
    expect(headers['content-security-policy']).not.toContain('7420');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(contentTypeOf('a.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeOf('font.woff2')).toBe('font/woff2');
    expect(contentTypeOf('blob')).toBe('application/octet-stream');
  });

  it('trusts IPC only from the renderer origin', () => {
    expect(isAppUrl('qc-app://renderer/index.html', null)).toBe(true);
    expect(isAppUrl('qc-app://renderer.evil/index.html', null)).toBe(false);
    expect(isAppUrl('file:///Applications/qiu-creator.app/dist/index.html', null)).toBe(false);
    expect(isAppUrl('http://localhost:5180/', 'http://localhost:5180/')).toBe(true);
    expect(isAppUrl('qc-app://renderer/index.html', 'http://localhost:5180/')).toBe(false);
  });

  it('does not bake a CSP with a fixed service port into the build', () => {
    const config = fs.readFileSync(path.join(import.meta.dirname, '../vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/Content-Security-Policy/);
    expect(config).not.toMatch(/contentSecurityPolicy\(/);
  });
});
