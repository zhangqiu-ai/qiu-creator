import { describe, expect, it } from 'vitest';
import { CardFrameQueue, type FrameJob } from '../src/renderer/card-frames.js';

/** QC-061: video frames for library cards are grabbed one at a time, once per card version. */

const job = (over: Partial<FrameJob> = {}): FrameJob => ({
  workId: 'w1',
  version: '0123456789abcdef',
  assetId: 'a1',
  path: 'assets/clip.mp4',
  timeSeconds: 3,
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CardFrameQueue (QC-061)', () => {
  it('grabs and uploads one video at a time, in order', async () => {
    const log: string[] = [];
    let active = 0;
    let most = 0;
    const done: [string, boolean][] = [];
    const queue = new CardFrameQueue(
      async (j) => {
        log.push(`up:${j.workId}`);
        await tick();
      },
      async (src, t) => {
        active += 1;
        most = Math.max(most, active);
        log.push(`grab:${src}@${String(t)}`);
        await tick();
        active -= 1;
        return new Blob(['x']);
      },
      (j, ok) => done.push([j.workId, ok]),
    );
    queue.enqueue(job({ workId: 'w1', assetId: 'a1' }));
    queue.enqueue(job({ workId: 'w2', assetId: 'a2', timeSeconds: 0 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(most).toBe(1);
    expect(log).toEqual([
      'grab:qc-asset://stream/a1@3',
      'up:w1',
      'grab:qc-asset://stream/a2@0',
      'up:w2',
    ]);
    expect(done).toEqual([
      ['w1', true],
      ['w2', true],
    ]);
  });

  it('asks once per card version, and a new version again', async () => {
    let grabs = 0;
    const queue = new CardFrameQueue(
      () => Promise.resolve(),
      () => {
        grabs += 1;
        return Promise.resolve(new Blob(['x']));
      },
    );
    queue.enqueue(job());
    queue.enqueue(job());
    await new Promise((r) => setTimeout(r, 10));
    queue.enqueue(job());
    queue.enqueue(job({ version: 'fedcba9876543210' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(grabs).toBe(2);
  });

  it('a failed grab or upload is reported and not retried; no asset means no grab', async () => {
    const done: [string, boolean][] = [];
    let grabs = 0;
    const queue = new CardFrameQueue(
      (j) => (j.workId === 'bad-upload' ? Promise.reject(new Error('409')) : Promise.resolve()),
      (src) => {
        grabs += 1;
        return src.endsWith('/broken')
          ? Promise.reject(new Error('cannot decode'))
          : Promise.resolve(new Blob(['x']));
      },
      (j, ok) => done.push([j.workId, ok]),
    );
    queue.enqueue(job({ workId: 'broken', assetId: 'broken' }));
    queue.enqueue(job({ workId: 'bad-upload' }));
    queue.enqueue(job({ workId: 'no-asset', assetId: null }));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toEqual([
      ['broken', false],
      ['bad-upload', false],
      ['no-asset', false],
    ]);
    expect(grabs).toBe(2);
    queue.enqueue(job({ workId: 'broken', assetId: 'broken' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(grabs).toBe(2);
  });
});
