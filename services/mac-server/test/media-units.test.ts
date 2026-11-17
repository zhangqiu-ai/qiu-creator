import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeContainedPath } from '../src/fs/contained-file.js';
import { classifyRef, extractMediaRefs } from '../src/media/markdown-refs.js';
import {
  loadOrCreateSigningKey,
  MediaUrlSigner,
  redactSignedUrl,
} from '../src/media/url-signer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('normalizeContainedPath', () => {
  it.each([
    ['', 'assets/a.png', 'assets/a.png'],
    ['', './assets/./a.png', 'assets/a.png'],
    ['notes', '../images/a.png', 'images/a.png'],
    ['notes/deep', '../../a.png', 'a.png'],
    ['notes', 'sub/', 'notes/sub'],
  ])('%s + %s → %s', (base, ref, out) => {
    expect(normalizeContainedPath(base, ref)).toBe(out);
  });

  it.each([
    ['', '../a.png'],
    ['notes', '../../a.png'],
    ['', '/etc/passwd'],
    ['', 'a\\..\\b.png'],
    ['', 'a\0.png'],
    ['', ''],
    ['', '.'],
    ['notes', '..'],
  ])('rejects %s + %s', (base, ref) => {
    expect(normalizeContainedPath(base, ref)).toBeNull();
  });
});

describe('extractMediaRefs / classifyRef', () => {
  it('ignores front matter, code and inline code; keeps document order without duplicates', () => {
    const md = [
      '---',
      'cover: ![](fm.png)',
      '---',
      '`![](inline-code.png)`',
      '![](b.png) ![](a.png) ![](b.png)',
      '',
      '    ![](indented-code.png)',
      '',
      '<video src="v.mp4" controls></video>',
      '',
      '<img src="x&amp;y.png">',
    ].join('\n');
    expect(extractMediaRefs(md)).toEqual(['b.png', 'a.png', 'v.mp4', 'x&y.png']);
  });

  it('classifies schemes', () => {
    expect(classifyRef('data:image/png;base64,AA')).toEqual({ type: 'inline' });
    expect(classifyRef('HTTPS://x/y.png')).toEqual({ type: 'remote' });
    expect(classifyRef('//cdn/x.png')).toEqual({ type: 'remote' });
    expect(classifyRef('file:///etc/passwd')).toEqual({ type: 'rejected' });
    expect(classifyRef('javascript:alert(1)')).toEqual({ type: 'rejected' });
    expect(classifyRef('a%2Fb.png#frag')).toEqual({ type: 'local', path: 'a/b.png' });
    expect(classifyRef('%E0%A4%A')).toEqual({ type: 'rejected' });
  });
});

describe('MediaUrlSigner', () => {
  const key = Buffer.alloc(32, 7);

  it('verifies its own URLs and binds path, principal and expiry', () => {
    let now = 1_800_000_000_000;
    const signer = new MediaUrlSigner(key, 60_000, () => now);
    const { url } = signer.sign('/media/v1/x', 'owner');
    const q = Object.fromEntries(new URL(url, 'http://h').searchParams);
    expect(signer.verify('/media/v1/x', q).principalId).toBe('owner');
    expect(() => signer.verify('/media/v1/y', q)).toThrow(/invalid or expired/);
    expect(() => signer.verify('/media/v1/x', { ...q, p: 'other' })).toThrow();
    expect(() => signer.verify('/media/v1/x', { ...q, sig: undefined })).toThrow();
    expect(() =>
      new MediaUrlSigner(Buffer.alloc(32, 8), 60_000, () => now).verify('/media/v1/x', q),
    ).toThrow();
    now += 60_001;
    expect(() => signer.verify('/media/v1/x', q)).toThrow();
  });

  it('creates a 0600 key once and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-key-'));
    dirs.push(dir);
    const file = path.join(dir, 'k');
    const a = loadOrCreateSigningKey(file);
    const b = loadOrCreateSigningKey(file);
    expect(a.equals(b)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, 'short');
    expect(() => loadOrCreateSigningKey(file)).toThrow(/corrupt/);
  });

  it('redacts signatures for logs', () => {
    expect(redactSignedUrl('/media/v1/a?exp=1&p=owner&sig=abc')).toBe(
      '/media/v1/a?exp=1&p=owner&sig=[REDACTED]',
    );
  });
});
