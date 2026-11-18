import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingLogFile, trimFile } from '../src/log-file.js';
import { makeTempHome } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('size-capped log files (QC-030)', () => {
  it('rotates at the cap, keeps N old files, drops the oldest', () => {
    const dir = makeTempHome();
    dirs.push(dir);
    const file = path.join(dir, 'Logs', 'qiu-creator', 'mac-server.log');
    const log = new RotatingLogFile(file, 100, 2);
    const line = (n: number) => `${String(n).padStart(3, '0')}${'x'.repeat(46)}\n`; // 50 bytes
    for (let i = 0; i < 9; i++) log.write(line(i));
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([
      'mac-server.log',
      'mac-server.log.1',
      'mac-server.log.2',
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe(line(8));
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe(line(6) + line(7));
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe(line(4) + line(5));
    for (const f of fs.readdirSync(path.dirname(file))) {
      expect(fs.statSync(path.join(path.dirname(file), f)).size).toBeLessThanOrEqual(100);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('continues an existing file and counts its size', () => {
    const dir = makeTempHome();
    dirs.push(dir);
    const file = path.join(dir, 'a.log');
    fs.writeFileSync(file, 'y'.repeat(90));
    const log = new RotatingLogFile(file, 100, 1);
    log.write('z'.repeat(20));
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(90));
    expect(fs.readFileSync(file, 'utf8')).toBe('z'.repeat(20));
  });

  it('trims the launchd stderr file at start once it passes the cap', () => {
    const dir = makeTempHome();
    dirs.push(dir);
    const file = path.join(dir, 'err.log');
    fs.writeFileSync(file, 'e'.repeat(50));
    trimFile(file, 100);
    expect(fs.statSync(file).size).toBe(50);
    fs.appendFileSync(file, 'e'.repeat(60));
    trimFile(file, 100);
    expect(fs.statSync(file).size).toBe(0);
    trimFile(path.join(dir, 'missing.log'), 100);
  });
});
