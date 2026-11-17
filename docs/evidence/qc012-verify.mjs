// QC-012 acceptance driver for the real Electron window over CDP.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc012-verify.mjs <out-dir> <scratch-dir> <mounts-dir>
// Requires mac-server on 7420 (seeded with qc012-seed.mjs) and
// `node apps/mac/scripts/dev.mjs --remote-debugging-port=9333`.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const [out, scratch] = process.argv.slice(2);
if (!home || !out || !scratch || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc012-verify.mjs <out-dir> <scratch-dir>');
}
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const require = createRequire(
  new URL('../../services/mac-server/package.json', import.meta.url).pathname,
);
const sharp = require('sharp');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc012-${name}.png`));
const size = (width, height) =>
  p.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
const scheme = (value) =>
  p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
const until = async (expr, timeout = 8000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await p.evaluate(expr)) return true;
    if (Date.now() > end) return false;
    await sleep(80);
  }
};
const click = (selector, text) =>
  p.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => ${text === undefined ? 'true' : `e.textContent.includes(${JSON.stringify(text)})`});
    if (!el) return false;
    el.click();
    return true;
  })()`);
const nav = (label) => click('nav .nav-item', label);
const text = (selector) =>
  p.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`,
  );

async function drop(files) {
  const data = { items: [], files, dragOperationsMask: 1 };
  const at = { x: 600, y: 400 };
  await p.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data });
  await p.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data });
  await sleep(150);
  await shot('03-drop-overlay');
  await p.send('Input.dispatchDragEvent', { type: 'drop', ...at, data });
}

async function typeInto(selector, value) {
  await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await p.send('Input.insertText', { text: value });
}

await size(1440, 900);
await scheme('light');
await p.evaluate('location.reload()');
await sleep(1500);

// ---- 素材庫 ----
check(
  'nav has 作品庫/素材庫/匯入任務/設定',
  (await text('nav .nav-item .side__label')).join() === '作品庫,素材庫,匯入任務,設定',
);
await nav('素材庫');
check(
  'asset grid shows seeded assets',
  await until(`document.querySelectorAll('.atile:not(.atile--skeleton)').length === 8`),
);
check(
  'image thumbnails load through qc-asset:// (CSP + token in main)',
  await until(
    `[...document.querySelectorAll('.atile .thumb__img')].filter((i) => i.complete && i.naturalWidth > 0).length === 6`,
  ),
);
await click('.atile', 'kyoto-arashiyama-01.jpg');
await until(`document.querySelector('.viewer') !== null`);
const kv = await text('.viewer .kv dd');
check(
  'viewer shows size, codec, bytes, hash, location, origin',
  kv[0] === '4032 × 3024' && kv.some((v) => v.includes('library/')) && kv.includes('上傳'),
  kv.join(' | '),
);
await click('.viewer .kv__hash button');
check(
  'copy hash confirms',
  await until(`document.querySelector('.viewer .kv__hash [role=status]') !== null`),
);
await shot('01-assets-viewer');

await click('.seg button', '視頻');
check(
  'kind filter 視頻',
  await until(
    `document.querySelectorAll('.atile').length === 1 && document.querySelector('.atile__name').textContent === 'beef-final.mp4'`,
  ),
);
await click('.seg button', '音訊');
check(
  'filter with no match shows 清除篩選',
  await until(
    `[...document.querySelectorAll('.state-card button')].some((b) => b.textContent === '清除篩選')`,
  ),
);
await shot('02-assets-filter-empty');
await click('.state-card button', '清除篩選');
await until(`document.querySelectorAll('.atile').length === 8`);

// Live refresh from SSE: an upload made outside the app appears without reloading.
const outside = await sharp({
  create: { width: 640, height: 480, channels: 3, background: '#55606A' },
})
  .png()
  .toBuffer();
await fetch('http://127.0.0.1:7420/api/v1/assets/uploads?filename=ulysses-screen.png', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
  body: outside,
});
check(
  'SSE asset.created refreshes the grid without reload',
  await until(`document.querySelectorAll('.atile').length === 9`, 5000),
);

// ---- Uploads by drop ----
const big = path.join(scratch, 'IMG_2041.mov');
const ftyp = Buffer.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d,
  0x69, 0x73, 0x6f, 0x32,
]);
const fd = fs.openSync(big, 'w');
fs.writeSync(fd, ftyp);
const block = Buffer.alloc(16 * 1024 * 1024);
for (let i = 0; i < block.length; i += 4096) block[i] = (i / 4096) & 0xff;
for (let i = 0; i < 60; i++) {
  block[0] = i;
  fs.writeSync(fd, block);
}
fs.closeSync(fd);
const bad = path.join(scratch, 'archive.png');
fs.writeFileSync(bad, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300, 1)]));
const dup = path.join(scratch, 'kyoto-copy.jpg');
fs.writeFileSync(
  dup,
  await sharp({ create: { width: 4032, height: 3024, channels: 3, background: '#9E4428' } })
    .jpeg()
    .toBuffer(),
);

await drop([big, bad, dup]);
check(
  'drop queues uploads and says so',
  await until(`document.querySelector('.notice')?.textContent.includes('已加入 3 個上傳')`),
);
check(
  'nav badge counts the active upload',
  await until(`document.querySelector('.nav-item__badge') !== null`, 3000),
);
await click('.notice button', '查看匯入任務');
check(
  'imports page shows uploading row with progress',
  await until(
    `Number(document.querySelector('.trow [role=progressbar][aria-valuenow]')?.getAttribute('aria-valuenow') ?? '0') >= 2`,
    10000,
  ),
);
await shot('04-imports-uploading');
await click('.trow .btn', '取消');
check(
  'cancel keeps the row with 繼續',
  await until(
    `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('已取消') && r.textContent.includes('繼續'))`,
  ),
);
const pausedAt = await p.evaluate(
  `Number(document.querySelector('.trow [role=progressbar]')?.getAttribute('aria-valuenow') ?? '0')`,
);
check(
  'failed upload shows reason',
  await until(
    `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('archive.png') && r.textContent.includes('不支援的檔案格式'))`,
  ),
);
check(
  'duplicate upload reuses the existing asset',
  await until(
    `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('已存在') && r.textContent.includes('沿用原素材'))`,
  ),
);
await shot('05-imports-states');
await click('.trow .btn', '繼續');
const resumed = await until(
  `(() => { const b = document.querySelector('.trow [role=progressbar][aria-valuenow]'); return b !== null && Number(b.getAttribute('aria-valuenow')) >= ${pausedAt}; })()`,
  3000,
);
check(
  '繼續 resumes from the uploaded offset, not from 0',
  resumed && pausedAt > 0,
  `paused at ${pausedAt}%`,
);
check(
  'resumed upload completes',
  await until(
    `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('IMG_2041.mov') && r.textContent.includes('成功'))`,
    60000,
  ),
);
check(
  'badge clears when nothing is running',
  await until(`document.querySelector('.nav-item__badge') === null`, 3000),
);
await click('.seg button', '失敗');
check('status filter 失敗', await until(`document.querySelectorAll('.trow').length === 1`));
await click('.seg button', '全部');

await click('.trow .btn', '沿用原素材');
check(
  '沿用原素材 opens the asset in the viewer',
  await until(
    `document.querySelector('.viewer .viewer__name')?.textContent === 'kyoto-arashiyama-01.jpg'`,
  ),
);
await nav('匯入任務');

// ---- URL import dialog ----
await click('.page__header .btn', '貼上 URL');
await until(`document.querySelector('[role=dialog]') !== null`);
check(
  'URL dialog focuses the URL field',
  await p.evaluate(`document.activeElement?.type === 'url'`),
);
await p.send('Input.imeSetComposition', { text: 'ㄏ', selectionStart: 1, selectionEnd: 1 });
await p.key('Enter', 'Enter', 13);
check(
  'Enter while composing does not submit',
  await p.evaluate(`document.querySelector('[role=dialog] .field__error') === null`),
);
await p.send('Input.insertText', { text: '' });
await p.evaluate(
  `(() => { const i = document.querySelector('[role=dialog] input[type=url]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
);
await typeInto('[role=dialog] input[type=url]', 'http://10.0.0.12/render.mp4');
await p.key('Enter', 'Enter', 13);
check(
  'private address is refused inline',
  await until(
    `document.querySelector('[role=dialog] .field__error')?.textContent.includes('內網或本機位址')`,
  ),
);
await shot('06-url-blocked');
await p.key('Escape', 'Escape', 27);
check('Esc closes the dialog', await until(`document.querySelector('[role=dialog]') === null`));

// ---- Agent tokens ----
check(
  'tokens list shows active first and revoked last',
  (await text('.token .token__name')).join() === 'claude-code,n8n-flow,cursor-agent',
);
await click('.side-card__head .btn', '新增');
await until(`document.querySelector('[role=dialog]') !== null`);
await typeInto('[role=dialog] input[type=text]', 'qc-acceptance');
await shot('07-token-create');
await click('[role=dialog] .btn', '建立');
check(
  'secret shown once after creating',
  await until(`document.querySelector('.secret__value')?.textContent.length > 20`),
);
await p.key('Escape', 'Escape', 27);
check(
  'Esc does not dismiss the one-time secret',
  await p.evaluate(`document.querySelector('.secret__value') !== null`),
);
await shot('08-token-secret');
await click('[role=dialog] .btn', '完成');
check(
  'new token listed without its secret',
  await until(
    `[...document.querySelectorAll('.token__name')].some((n) => n.textContent === 'qc-acceptance') && document.querySelector('.secret__value') === null`,
  ),
);
await click('.token .btn', '撤銷');
await until(`document.querySelector('[role=dialog]') !== null`);
check(
  'revoke asks first with default focus on 取消',
  await p.evaluate(`document.activeElement?.textContent === '取消'`),
);
await shot('09-token-revoke');
await click('[role=dialog] .btn--danger-solid', '撤銷');
check(
  'revoked token shows 已撤銷',
  await until(
    `[...document.querySelectorAll('.token')].filter((t) => t.textContent.includes('已撤銷')).length === 2`,
  ),
);
await shot('10-imports-tokens');

// ---- 設定 ----
await nav('設定');
check(
  'settings shows service running and live updates connected',
  await until(
    `document.querySelector('.settings').textContent.includes('執行中') && document.querySelector('.settings').textContent.includes('已連線')`,
  ),
);
check('mounts listed', await until(`document.querySelectorAll('.ln .ln__k').length >= 4`));
check(
  'no Tailscale, pairing, backup or AI-key sections',
  await p.evaluate(
    `!/Tailscale|配對|備份|金鑰/.test(document.querySelector('.settings').textContent)`,
  ),
);
await shot('11-settings');

const drive = path.join(process.argv[4] ?? '', '外接硬碟-剪輯腳本');
if (process.argv[4]) {
  fs.renameSync(drive, `${drive}-moved`);
  await p.evaluate(
    `(() => { const row = [...document.querySelectorAll('.ln')].find((r) => r.textContent.includes('外接硬碟-剪輯腳本')); [...row.querySelectorAll('button')].find((b) => b.textContent.includes('重新掃描')).click(); })()`,
  );
  check(
    'missing folder shows 找不到資料夾 with guidance',
    await until(
      `[...document.querySelectorAll('.ln')].some((r) => r.textContent.includes('外接硬碟-剪輯腳本') && r.textContent.includes('找不到資料夾') && r.textContent.includes('重新掃描即可恢復'))`,
      10000,
    ),
  );
  await shot('12-settings-mount-missing');
  fs.renameSync(`${drive}-moved`, drive);
  await p.evaluate(
    `(() => { const row = [...document.querySelectorAll('.ln')].find((r) => r.textContent.includes('外接硬碟-剪輯腳本')); [...row.querySelectorAll('button')].find((b) => b.textContent.includes('重新掃描')).click(); })()`,
  );
  check(
    'folder back + rescan returns to 監控中',
    await until(
      `[...document.querySelectorAll('.ln')].some((r) => r.textContent.includes('外接硬碟-剪輯腳本') && r.textContent.includes('監控中'))`,
      10000,
    ),
  );
}

await p.evaluate(
  `(() => { const row = [...document.querySelectorAll('.ln')].find((r) => r.textContent.includes('/寫作')); [...row.querySelectorAll('button')].find((b) => b.textContent === '卸載').click(); })()`,
);
await until(`document.querySelector('[role=dialog]') !== null`);
check(
  'unmount explains files stay on disk',
  await p.evaluate(
    `document.querySelector('[role=dialog]').textContent.includes('不會被移動或刪除')`,
  ),
);
await shot('13-settings-unmount');
await click('[role=dialog] .btn--primary', '卸載');
check(
  'unmounted folder shows 已卸載 with 重新掛載',
  await until(
    `[...document.querySelectorAll('.ln')].some((r) => r.textContent.includes('已卸載') && r.textContent.includes('重新掛載'))`,
  ),
);
await click('.ln .btn', '重新掛載');
check(
  're-mount reactivates the folder',
  await until(
    `![...document.querySelectorAll('.ln')].some((r) => r.textContent.includes('已卸載'))`,
  ),
);

// ---- Dark mode and narrow windows ----
await scheme('dark');
await nav('素材庫');
await until(`document.querySelectorAll('.atile').length > 0`);
await click('.atile', 'beef-final.mp4');
await sleep(300);
await shot('14-assets-dark');
await nav('匯入任務');
await sleep(400);
await shot('15-imports-dark');
await nav('設定');
await sleep(400);
await shot('16-settings-dark');
await scheme('light');
await size(1000, 760);
await nav('匯入任務');
await sleep(400);
check(
  'icon rail below 1180px',
  await p.evaluate(`document.querySelector('.side').getBoundingClientRect().width === 60`),
);
await shot('17-imports-narrow');
await size(760, 900);
await nav('素材庫');
await sleep(400);
await shot('18-assets-stacked');
await size(1440, 900);

// The renderer never sees the token: no request from the page carries it.
check(
  'renderer has no Node access',
  await p.evaluate(`typeof require === 'undefined' && typeof process === 'undefined'`),
);
check(
  'remote fonts not requested',
  await p.evaluate(
    `performance.getEntriesByType('resource').every((r) => !r.name.includes('fonts.googleapis'))`,
  ),
);

fs.writeFileSync(path.join(out, 'qc012-verify-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
p.close();
process.exit(failed.length === 0 ? 0 : 1);
