import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { atomicWriteFileSync, nodeFsOps, type AtomicFsOps } from '../src/fs/atomic.js';
import { Layout } from '../src/layout.js';
import { WorkService } from '../src/works/work-service.js';
import { makeTempHome } from './helpers.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function tempDir(): string {
  const h = makeTempHome();
  homes.push(h);
  return h;
}

class SimulatedCrash extends Error {}

/** Writes only half of the buffer, then "crashes". */
const crashMidWrite: AtomicFsOps = {
  ...nodeFsOps,
  writeSync: (fd, data) => {
    nodeFsOps.writeSync(fd, data.subarray(0, Math.floor(data.length / 2)));
    throw new SimulatedCrash('disk full mid-write');
  },
};

const crashBeforeRename: AtomicFsOps = {
  ...nodeFsOps,
  renameSync: () => {
    throw new SimulatedCrash('power loss before rename');
  },
};

describe('atomicWriteFileSync', () => {
  it('replaces the file contents', () => {
    const dir = tempDir();
    const target = path.join(dir, 'source.md');
    fs.writeFileSync(target, 'old');
    atomicWriteFileSync(target, '新內容');
    expect(fs.readFileSync(target, 'utf8')).toBe('新內容');
    expect(fs.readdirSync(dir)).toEqual(['source.md']);
  });

  it.each([
    ['mid-write', crashMidWrite],
    ['before rename', crashBeforeRename],
  ])('keeps the original intact and leaves no temp file when it fails %s', (_label, ops) => {
    const dir = tempDir();
    const target = path.join(dir, 'source.md');
    const original = '# 原稿\n\n不能被寫壞。\n';
    fs.writeFileSync(target, original);

    expect(() => {
      atomicWriteFileSync(target, 'x'.repeat(10_000), ops);
    }).toThrow(SimulatedCrash);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(['source.md']);
  });
});

describe('WorkService under a failed write', () => {
  it('does not change source.md, the current revision or the revision history', () => {
    const home = tempDir();
    const layout = new Layout(home);
    layout.ensureBase();
    const db = openDatabase(layout.databaseFile);
    try {
      const work = new WorkService(db, layout).create({ title: 't', markdown: 'v1' });
      const failing = new WorkService(db, layout, crashMidWrite);

      expect(() =>
        failing.patch(work.id, { baseRevision: work.current_revision_id, markdown: 'v2' }),
      ).toThrow(SimulatedCrash);

      const healthy = new WorkService(db, layout);
      const after = healthy.get(work.id);
      expect(after.markdown).toBe('v1');
      expect(after.current_revision_id).toBe(work.current_revision_id);
      expect(healthy.revisions(work.id)).toHaveLength(1);
      expect(fs.readdirSync(path.join(home, 'library/works', work.id, 'revisions'))).toEqual([
        `${work.current_revision_id}.md`,
      ]);
      expect(fs.readdirSync(path.join(home, 'library/works', work.id)).sort()).toEqual(
        ['assets', 'revisions', 'source.md'].sort(),
      );
    } finally {
      db.close();
    }
  });
});
