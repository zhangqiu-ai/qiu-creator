import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const COMMON_LOCATIONS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

/**
 * Locate ffmpeg for video card frames (QC-061), like ffprobe: explicit setting
 * (`CREATORHUB_FFMPEG`), then PATH, then common Homebrew locations. Not
 * bundled (see docs/dependencies.md); `null` when unavailable, and the app
 * then captures the frame itself. An explicit empty string disables it.
 */
export function resolveFfmpeg(
  explicit: string | undefined,
  envPath = process.env['PATH'] ?? '',
): string | null {
  if (explicit !== undefined) {
    return explicit !== '' && isExecutable(explicit) ? explicit : null;
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'ffmpeg');
    if (isExecutable(candidate)) return candidate;
  }
  return COMMON_LOCATIONS.find(isExecutable) ?? null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Write the frame at `seconds` of `video` to `target` as PNG. Reads the video
 * only; rejects on non-zero exit, timeout or when no image was written.
 */
export function extractFrame(
  ffmpeg: string,
  video: string,
  seconds: number,
  target: string,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(Math.max(0, seconds)),
        '-i',
        video,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'png',
        target,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() === '' ? err.message : stderr.trim();
          reject(new Error(`ffmpeg failed: ${detail.slice(0, 300)}`, { cause: err }));
          return;
        }
        try {
          if (fs.statSync(target).size > 0) {
            resolve();
            return;
          }
        } catch {
          // fall through
        }
        reject(new Error('ffmpeg wrote no frame'));
      },
    );
  });
}
