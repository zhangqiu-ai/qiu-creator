import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';

const run = promisify(execFile);

/**
 * Records a window at normal speed for the motion acceptance (QC-065).
 * Playwright's recordVideo hangs the hidden e2e window, so frames come from
 * CDP's screencast instead, each with its own timestamp, and ffmpeg (when
 * installed) turns them into an mp4 that keeps the real timing. Returns a
 * function that stops and gives the path of the mp4 (or of the frames).
 */
export async function startScreencast(
  page: Page,
  dir: string,
  name: string,
): Promise<() => Promise<string>> {
  const cdp = await page.context().newCDPSession(page);
  const frames: { data: string; at: number }[] = [];
  cdp.on('Page.screencastFrame', (frame) => {
    frames.push({ data: frame.data, at: frame.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: 1440,
    maxHeight: 900,
    everyNthFrame: 1,
  });

  return async () => {
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    const framesDir = path.join(dir, `${name}-frames`);
    await mkdir(framesDir, { recursive: true });
    const list: string[] = ['ffconcat version 1.0'];
    for (const [i, f] of frames.entries()) {
      const file = path.join(framesDir, `${String(i).padStart(5, '0')}.jpg`);
      await writeFile(file, Buffer.from(f.data, 'base64'));
      const next = frames[i + 1];
      // Each frame stays until the next one came: the recording keeps the real timing.
      const seconds = next === undefined ? 0.5 : Math.max(0.001, next.at - f.at);
      list.push(`file '${file}'`, `duration ${seconds.toFixed(4)}`);
    }
    const last = frames.at(-1);
    if (last !== undefined)
      list.push(
        `file '${path.join(framesDir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`,
      );
    const listFile = path.join(framesDir, 'frames.ffconcat');
    await writeFile(listFile, `${list.join('\n')}\n`);
    const out = path.join(dir, `${name}.mp4`);
    try {
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-vf',
        'fps=60,scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        out,
      ]);
      return out;
    } catch (err) {
      // No ffmpeg, or it failed: say why; the timed frames and their list are the recording.
      console.warn(`screencast ${name}: ffmpeg did not make an mp4, keeping the frames`, err);
      return framesDir;
    }
  };
}
