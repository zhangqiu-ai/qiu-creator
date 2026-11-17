// QC-012 viewer player check over CDP: original image, H.264 video with
// seeking (Range through the qc-asset:// proxy), audio, and an HEVC .mov.
// Usage: node docs/evidence/qc012-player-verify.mjs <out-dir>
// Requires mac-server on 7420 with demo-h264.mp4, tone.m4a, demo-hevc.mov and
// desk-after.jpg uploaded, and the Electron dev window on CDP port 9333.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: node qc012-player-verify.mjs <out-dir>');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const p = await connectPage(9333);
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
const until = async (expr, timeout = 8000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await p.evaluate(expr)) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
};
const open = (name) =>
  p.evaluate(`(() => {
    const tile = [...document.querySelectorAll('.atile')].find((t) => t.textContent.includes(${JSON.stringify(name)}));
    tile?.click();
    return tile !== undefined;
  })()`);

await p.evaluate('location.reload()');
await sleep(1500);
await p.evaluate(
  `[...document.querySelectorAll('nav .nav-item')].find((b) => b.textContent.includes('素材庫')).click()`,
);
await until(`document.querySelectorAll('.atile').length === 4`);

await open('desk-after.jpg');
check(
  'original image loads through assetMediaUrl (not the 512px thumbnail)',
  await until(
    `(() => { const i = document.querySelector('.viewer__preview img'); return i !== null && i.src.startsWith('qc-asset://stream/') && i.naturalWidth === 2400; })()`,
  ),
);

await open('demo-h264.mp4');
check(
  'H.264 video loads metadata',
  await until(
    `(() => { const v = document.querySelector('.viewer video'); return v !== null && v.readyState >= 1 && Math.round(v.duration) === 20; })()`,
  ),
);
await p.evaluate(
  `(() => { const v = document.querySelector('.viewer video'); v.muted = true; v.currentTime = 15; })()`,
);
check(
  'seeking to 0:15 works (Range passes through the proxy)',
  await until(
    `(() => { const v = document.querySelector('.viewer video'); return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 15) < 0.5; })()`,
  ),
);
await p.evaluate(`document.querySelector('.viewer video').play()`);
await sleep(800);
check(
  'video plays',
  await p.evaluate(
    `(() => { const v = document.querySelector('.viewer video'); return !v.paused && v.currentTime > 15; })()`,
  ),
);
await p.evaluate(`document.querySelector('.viewer video').pause()`);
await p.screenshot(path.join(out, 'qc012-20-viewer-video.png'));

await open('tone.m4a');
check(
  'audio player loads',
  await until(
    `(() => { const a = document.querySelector('.viewer audio'); return a !== null && a.readyState >= 1 && Math.round(a.duration) === 6; })()`,
  ),
);
await p.screenshot(path.join(out, 'qc012-21-viewer-audio.png'));

await open('demo-hevc.mov');
await sleep(2500);
const hevc = await p.evaluate(`(() => {
  const v = document.querySelector('.viewer video');
  if (v && v.readyState >= 1) return 'plays';
  if (document.querySelector('.viewer__preview-note')) return 'fallback';
  return 'unknown';
})()`);
check('HEVC .mov either plays or shows the fallback note', hevc !== 'unknown', hevc);
await p.screenshot(path.join(out, 'qc012-22-viewer-hevc.png'));

fs.writeFileSync(
  path.join(out, 'qc012-player-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
p.close();
process.exit(failed.length === 0 ? 0 : 1);
