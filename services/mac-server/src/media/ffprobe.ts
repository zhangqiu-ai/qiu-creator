import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
}

const COMMON_LOCATIONS = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'];

/**
 * Locate ffprobe: explicit setting (`CREATORHUB_FFPROBE`), then PATH, then
 * common Homebrew locations. Returns `null` when unavailable; callers must
 * degrade (no duration/size shown) rather than fail.
 * An explicit empty string disables probing.
 */
export function resolveFfprobe(
  explicit: string | undefined,
  envPath = process.env['PATH'] ?? '',
): string | null {
  if (explicit !== undefined) {
    return explicit !== '' && isExecutable(explicit) ? explicit : null;
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'ffprobe');
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

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function num(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseFfprobeOutput(json: string): ProbeResult {
  const out = JSON.parse(json) as FfprobeOutput;
  const streams = out.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const main = video ?? audio;
  const width = num(video?.width);
  const height = num(video?.height);
  return {
    duration: num(out.format?.duration) ?? num(main?.duration),
    width: width !== null && width > 0 ? Math.round(width) : null,
    height: height !== null && height > 0 ? Math.round(height) : null,
    codec: main?.codec_name ?? null,
  };
}

/** Run ffprobe on a local file. Rejects on non-zero exit, timeout or unparsable output. */
export function probeMedia(
  ffprobe: string,
  file: string,
  timeoutMs = 30_000,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() === '' ? err.message : stderr.trim();
          reject(new Error(`ffprobe failed: ${detail}`, { cause: err }));
          return;
        }
        try {
          resolve(parseFfprobeOutput(stdout));
        } catch (parseErr) {
          reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
        }
      },
    );
  });
}
