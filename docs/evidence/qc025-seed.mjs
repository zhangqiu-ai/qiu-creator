// Seed a throwaway CREATORHUB_HOME for QC-025: one 56-second test video
// (ffmpeg test pattern, generated locally) and no AI keys.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc025-seed.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
if (!home || !home.includes('/tmp/')) throw new Error('CREATORHUB_HOME must be a temp dir');
const base = 'http://127.0.0.1:7420';
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const auth = { authorization: `Bearer ${token}` };

const file = path.join(home, 'coffee-v60.mp4');
execFileSync('ffmpeg', [
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=640x360:rate=25:duration=56',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=56',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-shortest',
  file,
]);
const res = await fetch(`${base}/api/v1/assets/uploads?filename=coffee-v60.mp4`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/octet-stream' },
  body: fs.readFileSync(file),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const { asset } = await res.json();
fs.rmSync(file);
// Wait for ffprobe metadata (duration) and the thumbnail.
for (let i = 0; i < 100; i++) {
  const a = await (await fetch(`${base}/api/v1/assets/${asset.id}`, { headers: auth })).json();
  if (a.duration !== null && a.thumbnail_status !== 'pending') {
    console.log('asset', a.id, a.duration, a.thumbnail_status);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 200));
}
throw new Error('metadata did not arrive');
