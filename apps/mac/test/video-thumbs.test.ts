import { describe, expect, it } from 'vitest';
import { VideoThumbs } from '../src/renderer/video-thumbs.js';

function deferred() {
  let resolve: (v: string) => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('video card thumbnails (QC-108)', () => {
  it('grabs one video at a time, in order, at the thumbnail time', async () => {
    const calls: [string, number][] = [];
    const pending = [deferred(), deferred()];
    let n = 0;
    const thumbs = new VideoThumbs((src, time) => {
      calls.push([src, time]);
      return (pending[n++] ?? deferred()).promise;
    });
    thumbs.request('a', 'qc-asset://stream/a', 8);
    thumbs.request('b', 'qc-asset://stream/b', 1);
    await tick();
    expect(calls).toEqual([['qc-asset://stream/a', 1]]);
    pending[0]?.resolve('data:image/jpeg;base64,AAA');
    await tick();
    expect(thumbs.get('a')).toBe('data:image/jpeg;base64,AAA');
    expect(calls).toEqual([
      ['qc-asset://stream/a', 1],
      ['qc-asset://stream/b', 0.5],
    ]);
  });

  it('asks once per video; a failed one keeps the icon (null) and is not retried', async () => {
    let count = 0;
    const thumbs = new VideoThumbs(() => {
      count++;
      return Promise.reject(new Error('cannot decode'));
    });
    thumbs.request('a', 'src', null);
    thumbs.request('a', 'src', null);
    await tick();
    expect(thumbs.get('a')).toBeNull();
    thumbs.request('a', 'src', null);
    await tick();
    expect(count).toBe(1);
  });

  it('drops a request for a card that left the view before its turn', async () => {
    const first = deferred();
    const seen: string[] = [];
    const thumbs = new VideoThumbs((src) => {
      seen.push(src);
      return src === 'a' ? first.promise : Promise.resolve('frame');
    });
    thumbs.request('a', 'a', 1);
    thumbs.request('b', 'b', 1);
    thumbs.cancel('b');
    first.resolve('frame-a');
    await tick();
    await tick();
    expect(seen).toEqual(['a']);
    expect(thumbs.get('b')).toBeUndefined();
  });

  it('tells subscribers when a frame arrives and keeps at most `max` frames', async () => {
    const thumbs = new VideoThumbs((src) => Promise.resolve(`frame-${src}`), 2);
    let notified = 0;
    const off = thumbs.subscribe(() => {
      notified++;
    });
    thumbs.request('a', 'a', 1);
    thumbs.request('b', 'b', 1);
    thumbs.request('c', 'c', 1);
    await tick();
    await tick();
    await tick();
    off();
    expect(notified).toBe(3);
    expect(thumbs.get('a')).toBeUndefined();
    expect(thumbs.get('c')).toBe('frame-c');
  });
});
