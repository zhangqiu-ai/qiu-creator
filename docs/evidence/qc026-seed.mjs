// Seed a throwaway CREATORHUB_HOME for QC-026: one work and one 56-second test video
// (ffmpeg test pattern, generated locally). No AI keys: the driver enters them in the UI.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc026-seed.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
if (!home || !path.basename(home).startsWith('qc026-home')) {
  throw new Error('CREATORHUB_HOME must be a qc026-home* temp dir');
}
const base = 'http://127.0.0.1:7420';
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const auth = { authorization: `Bearer ${token}` };

const work = await fetch(`${base}/api/v1/works`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    title: 'M3 驗收：書房改剪輯室',
    source: 'mac-app',
    markdown:
      '# M3 驗收：書房改剪輯室\n\n剛搬進來時，我以為書房只要一張大桌子就夠了。後來發現，真正耽誤剪輯的是線材、散熱和那台一直在響的風扇。所以這半年我陸續做了很多很多調整。\n\n## 一、桌子換成兩張\n\n原本的實木大桌很好看，但螢幕臂夾不住它的圓邊。\n',
  }),
}).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
});

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
const bytes = fs.readFileSync(file);
const up = await fetch(`${base}/api/v1/assets/uploads?filename=coffee-v60.mp4`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/octet-stream' },
  body: bytes,
}).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
});
fs.rmSync(file);
fs.writeFileSync(
  path.join(home, 'qc026-seed.json'),
  JSON.stringify({
    workId: work.id,
    assetId: up.asset.id,
    videoSha256: createHash('sha256').update(bytes).digest('hex'),
    videoBytes: bytes.length,
  }),
);
console.log('seeded', { work: work.id, asset: up.asset.id, bytes: bytes.length });
