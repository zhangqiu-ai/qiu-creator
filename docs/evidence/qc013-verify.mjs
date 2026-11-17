// QC-013 acceptance driver for the real Electron window over CDP.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc013-verify.mjs <out-dir>
// Requires mac-server on 7420 seeded with qc013-seed.mjs and the Electron dev
// window on CDP port 9333.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const [out] = process.argv.slice(2);
if (!home || !out || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc013-verify.mjs <out-dir>');
}
const base = 'http://127.0.0.1:7420';
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const api = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc013-${name}.png`));
const until = async (expr, timeout = 8000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await p.evaluate(expr)) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
};
const click = (selector, text) =>
  p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${
      text === undefined ? 'true' : `e.textContent.includes(${JSON.stringify(text)})`
    });
    if (!el) return false;
    el.click();
    return true;
  })()`);
const tab = async (name) => {
  await click('.pv-tab', name);
  return until(
    `document.querySelector('.pv__title')?.textContent === ${JSON.stringify(`${name}版本`)}`,
  );
};
const setField = async (selector, value) => {
  await p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.select?.();
  })()`);
  await p.key('a', 'KeyA', 65, 4); // ⌘A
  await p.send('Input.insertText', { text: value });
};
const variant = (platform) => api('GET', `/api/v1/works/${workId}/variants/${platform}`);
const waitVariant = async (platform, pred) => {
  for (let i = 0; i < 60; i++) {
    const v = await variant(platform);
    if (pred(v)) return v;
    await sleep(100);
  }
  return variant(platform);
};

const workId = (await api('GET', '/api/v1/works?limit=10')).items[0].id;
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await p.evaluate('location.reload()');
await sleep(1500);

// Open the work, then 預覽.
// The library may re-render from SSE between finding the card and clicking it; retry.
for (let attempt = 0; attempt < 5; attempt++) {
  await click('nav .nav-item', '作品庫');
  await until(`document.querySelectorAll('.wcard').length > 0`);
  await click('.wcard', '京都');
  if (await until(`document.querySelector('.editor__title') !== null`, 3000)) break;
}
await click('.editor__actions .btn', '預覽');
check(
  '預覽 opens the platform preview for this work',
  await until(`document.querySelector('.pv__work')?.textContent === '京都紅葉季七日慢遊路線'`),
);
check(
  'four platform tabs, text names only',
  (await p.evaluate(
    `[...document.querySelectorAll('.pv-tab')].map((t) => t.textContent).join()`,
  )) === '小紅書,公眾號,抖音,視頻號',
);
check(
  'empty platform offers 從原稿建立 and the phone says 模擬',
  await until(
    `document.querySelector('.pv-empty')?.textContent.includes('尚無小紅書版本') && document.querySelector('.pp-sim')?.textContent === '模擬'`,
  ),
);
await shot('01-empty');

// Create all four from the original.
for (const name of ['小紅書', '公眾號', '抖音']) {
  await tab(name);
  await click('.pv-empty .btn', '從原稿建立');
  await until(`document.querySelector('#pv-title') !== null`);
}
await tab('視頻號');
check('視頻號 can copy the 公眾號 version', await click('.pv-empty .btn', '複製公眾號版本'));
await until(`document.querySelector('#pv-title') !== null`);
check(
  'preview never shows a platform logo: only the cover and our own shapes',
  await p.evaluate(
    `[...document.querySelectorAll('.pp-screen img')].every((i) => i.src.startsWith('qc-asset://'))`,
  ),
);

// Different title and body per platform.
const edits = {
  小紅書: ['xiaohongshu', '京都紅葉七日・不趕路版', '小紅書正文'],
  公眾號: ['wechat_mp', '京都紅葉季：七日慢遊完整路線', '# 公眾號\n\n公眾號正文'],
  抖音: ['douyin', '京都紅葉 7 天', '抖音描述'],
  視頻號: ['wechat_channels', '紅葉七日', '視頻號描述'],
};
for (const [name, [, title, body]] of Object.entries(edits)) {
  await tab(name);
  await setField('#pv-title', title);
  await setField('#pv-body', body);
  await sleep(1200);
}
let independent = true;
for (const [platform, title, body] of Object.values(edits)) {
  const v = await waitVariant(platform, (x) => x.title === title && x.body === body);
  if (v.title !== title || v.body !== body) independent = false;
}
check('each platform keeps its own title and body (no cross-writes)', independent);
const work = await api('GET', `/api/v1/works/${workId}`);
check(
  'the original is not modified',
  work.markdown.includes('十一月中旬到京都') && !work.markdown.includes('正文'),
);

// Cover per platform.
await tab('抖音');
await until(`document.querySelectorAll('.pv-thumbs .pv-thumb').length > 0`);
const ids = (await variant('douyin')).image_asset_ids;
if (ids.length < 2) {
  await click('.pv-add .pv-thumb');
  await sleep(600);
}
await p.evaluate(
  `[...document.querySelectorAll('.pv-thumbs')][0].querySelectorAll('button.pv-thumb')[1].click()`,
);
await click('.pv-imgbar .btn', '設為封面');
const dy = await waitVariant('douyin', (v) => v.cover_asset_id === v.image_asset_ids[1]);
check(
  'setting the 抖音 cover saves only 抖音',
  dy.cover_asset_id === dy.image_asset_ids[1] &&
    (await variant('xiaohongshu')).cover_asset_id !== dy.cover_asset_id,
);
check(
  'the phone shows the new cover',
  await until(
    `document.querySelector('.pp-dy__bg')?.src.endsWith(${JSON.stringify(dy.cover_asset_id)})`,
  ),
);
await shot('02-douyin');

// Over-limit warnings (PT-20261117-001): 小紅書 title, 視頻號 images.
await tab('小紅書');
await setField('#pv-title', '京都紅葉季七日慢遊路線：五個區域不趕路的完整安排');
check(
  'over-limit title: warning bar, counter, field hint, truncated preview, tab dot',
  await until(
    `document.querySelector('.pv-wbar')?.textContent.includes('不影響儲存') && document.querySelector('.pv-ct--over') !== null && document.querySelector('.pv-hint')?.textContent.includes('預覽已截斷') && document.querySelector('.pp-xhs__title')?.textContent.endsWith('…') && [...document.querySelectorAll('.pv-tab')].find((t) => t.textContent.startsWith('小紅書'))?.querySelector('.pv-tab__warn') !== null`,
  ),
);
const longTitle = await waitVariant('xiaohongshu', (v) =>
  v.title.startsWith('京都紅葉季七日慢遊路線：'),
);
check(
  'over-limit still saves',
  longTitle.warnings.some((w) => w.code === 'title_too_long'),
);
await shot('03-xhs-title-over');

await tab('視頻號');
for (let i = 0; i < 15; i++) {
  if (!(await click('.pv-add .pv-thumb'))) break;
  await sleep(300);
}
check(
  'more than 9 images on 視頻號: count 12/9, extra thumbnails dimmed, hint',
  await until(
    `document.querySelector('.pv-ct--over')?.textContent === '12/9 張' && document.querySelectorAll('.pv-thumb--over').length === 3 && [...document.querySelectorAll('.pv-hint')].some((h) => h.textContent.includes('超出 3 張'))`,
  ),
);
await shot('04-channels-images-over');

// Tags: IME Enter does nothing; Enter adds.
await tab('公眾號');
await p.evaluate(`document.querySelector('.pv-taginput').focus()`);
await p.send('Input.imeSetComposition', { text: 'ㄐ', selectionStart: 1, selectionEnd: 1 });
await p.key('Enter', 'Enter', 13);
check(
  'Enter while composing does not add a tag',
  await p.evaluate(`document.querySelectorAll('.pv-form .tag, .pv__form .tag').length === 0`),
);
await p.send('Input.insertText', { text: '京都' });
await p.key('Enter', 'Enter', 13);
check(
  'Enter adds a tag to 公眾號 only',
  (await waitVariant('wechat_mp', (v) => v.tags.includes('京都'))).tags.includes('京都') &&
    !(await variant('douyin')).tags.includes('京都'),
);
await shot('05-mp-article');

// Concurrent edit of the same platform: a 409 choice, never a silent overwrite.
await tab('抖音');
const before = await variant('douyin');
await p.evaluate(`document.querySelector('#pv-title').focus()`);
await p.send('Input.insertText', { text: '・我的' });
await p.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
await api('PATCH', `/api/v1/works/${workId}/variants/douyin`, {
  base_revision: before.revision,
  title: '另一個視窗的標題',
});
check(
  'another writer on the same platform shows the conflict notice',
  await until(
    `document.querySelector('.pv-banner')?.textContent.includes('抖音版本已在其他地方更新') && [...document.querySelectorAll('.pv-tab')].find((t) => t.textContent.startsWith('抖音'))?.querySelector('.pv-tab__bad') !== null`,
    8000,
  ),
);
await p.send('Input.insertText', { text: '' });
check(
  'the other writer was not overwritten',
  (await variant('douyin')).title === '另一個視窗的標題',
);
await shot('06-conflict');
await click('.pv-banner .btn', '以我的修改覆蓋');
check(
  '以我的修改覆蓋 writes mine on top of the latest revision',
  (await waitVariant('douyin', (v) => v.title.endsWith('・我的'))).revision === before.revision + 2,
);

await p.evaluate(`document.querySelector('#pv-title').focus()`);
await p.send('Input.insertText', { text: '再改' });
await p.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
const now = await variant('douyin');
await api('PATCH', `/api/v1/works/${workId}/variants/douyin`, {
  base_revision: now.revision,
  title: '第三方標題',
});
await until(`document.querySelector('.pv-banner') !== null`, 8000);
await p.send('Input.insertText', { text: '' });
await click('.pv-banner .btn', '載入最新版本');
check(
  "載入最新版本 shows the other writer's version",
  await until(
    `document.querySelector('#pv-title')?.value === '第三方標題' && document.querySelector('.pv-banner') === null`,
  ),
);

// Live update when clean.
await api('PATCH', `/api/v1/works/${workId}/variants/douyin`, {
  base_revision: (await variant('douyin')).revision,
  body: 'Agent 改的描述',
});
check(
  'a clean window picks up changes live',
  await until(`document.querySelector('#pv-body')?.value === 'Agent 改的描述'`),
);

// Navigation entry goes to the last work.
await click('nav .nav-item', '作品庫');
await click('nav .nav-item', '平台預覽');
check(
  '平台預覽 in the navigation opens the last work',
  await until(`document.querySelector('.pv__work')?.textContent === '京都紅葉季七日慢遊路線'`),
);

await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await tab('小紅書');
await sleep(500);
await shot('07-xhs-dark');
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1000,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});
await tab('公眾號');
await sleep(500);
await shot('08-mp-narrow');
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

fs.writeFileSync(
  path.join(out, 'qc013-verify-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
p.close();
process.exit(failed.length === 0 ? 0 : 1);
