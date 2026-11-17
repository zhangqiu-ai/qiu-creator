// QC-011 acceptance driver for the real Electron window over CDP.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc011-verify.mjs <out-dir> <mount-dir>
// Requires mac-server on 7420 seeded with qc011-seed.mjs and the Electron dev
// window on CDP port 9333.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const [out, mountDir] = process.argv.slice(2);
if (!home || !out || !mountDir || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc011-verify.mjs <out-dir> <mount-dir>');
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
const writing = path.join(mountDir, '寫作');
const toolsFile = path.join(writing, '工具', '2026 年我用過最順手的 6 個寫作工具.md');
const tainanFile = path.join(writing, '台南兩天一夜小吃地圖.md');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc011-${name}.png`));
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
const nav = (label) => click('nav .nav-item', label);
const openWork = async (title) => {
  // The list may re-render from SSE between finding a card and clicking it; retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    await nav('作品庫');
    await until(`document.querySelectorAll('.wcard, .tbl__open').length > 0`);
    await click('.wcard, .tbl__open', title);
    if (
      await until(
        `document.querySelector('.editor__title')?.value === ${JSON.stringify(title)}`,
        3000,
      )
    ) {
      return true;
    }
  }
  throw new Error(`could not open ${title}`);
};
const editorText = () =>
  p.evaluate(`document.querySelector('.editor__doc [contenteditable]')?.textContent ?? ''`);
const focusEditorEnd = () =>
  p.evaluate(`(() => {
    const el = document.querySelector('.editor__doc [contenteditable]');
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el.querySelector('p:last-of-type') ?? el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  })()`);

await size(1440, 900);
await scheme('light');
await p.evaluate('location.reload()');
await sleep(1500);

// ---- 作品庫: external source labels ----
await nav('作品庫');
await until(`document.querySelectorAll('.wcard').length === 4`);
check(
  'grid shows 外部掛載 · 寫作 for mounted works',
  (await p.evaluate(
    `[...document.querySelectorAll('.wcard')].filter((c) => c.textContent.includes('外部掛載 · 寫作')).length`,
  )) === 2,
);
await click('.seg button[aria-label="列表"]');
await until(`document.querySelector('.tbl') !== null`);
check(
  'list shows 外部 chip with the folder on hover',
  await p.evaluate(
    `[...document.querySelectorAll('.tbl .src-ext')].length === 2 && [...document.querySelectorAll('.tbl .src-ext')].every((c) => c.title.endsWith('/寫作'))`,
  ),
);
await shot('01-library-list-external');

// ---- 檔案遺失, live from SSE ----
fs.rmSync(tainanFile);
check(
  'deleting the file shows 檔案遺失 without reloading',
  await until(
    `[...document.querySelectorAll('.tbl tr')].some((r) => r.textContent.includes('台南') && r.textContent.includes('檔案遺失'))`,
    10000,
  ),
);
await click('.seg button[aria-label="網格"]');
await until(`document.querySelector('.wcard--missing') !== null`);
check(
  'grid card is greyed with the 檔案遺失 chip',
  await p.evaluate(`document.querySelector('.wcard--missing')?.textContent.includes('檔案遺失')`),
);
await shot('02-library-missing');

await openWork('台南兩天一夜小吃地圖');
check(
  'missing work opens read-only with path and recovery hint',
  await until(
    `document.querySelector('.banner--bad')?.textContent.includes('找不到原檔，唯讀') && document.querySelector('.banner--bad').textContent.includes('放回原處後自動恢復') && document.querySelector('.banner--bad').textContent.includes('台南兩天一夜小吃地圖.md')`,
  ),
);
check(
  'save chip says 唯讀; body, title, status and tags are not editable',
  await p.evaluate(
    `document.querySelector('.save-status').textContent.includes('唯讀') && document.querySelector('.editor__doc [contenteditable]')?.getAttribute('contenteditable') === 'false' && document.querySelector('.editor__title').readOnly && document.querySelector('.editor__meta select').disabled && document.querySelector('.tags__input') === null`,
  ),
);
check(
  'header shows 外部掛載 · ~/… with the file path on hover',
  await p.evaluate(
    `document.querySelector('.editor__bar .src-ext')?.title.endsWith('台南兩天一夜小吃地圖.md')`,
  ),
);
await click('.editor__actions .btn', '歷史');
await until(`document.querySelector('.rev--button') !== null`);
await click('.rev--button');
await until(`document.querySelector('.rev-detail') !== null`);
check(
  'restore is disabled while the file is missing',
  await p.evaluate(
    `[...document.querySelectorAll('.rev-detail button')].find((b) => b.textContent === '恢復此版本')?.disabled === true`,
  ),
);
await shot('03-editor-missing');
fs.writeFileSync(tainanFile, '# 台南兩天一夜小吃地圖\n\n第一天。\n');
check(
  'putting the file back restores editing automatically',
  await until(
    `document.querySelector('.banner--bad') === null && document.querySelector('.editor__doc [contenteditable]')?.getAttribute('contenteditable') === 'true'`,
    10000,
  ),
);
await click('.panel__close');

// ---- External edit while typing: notice instead of overwrite ----
await openWork('2026 年我用過最順手的 6 個寫作工具');
await until(`document.querySelector('.editor__doc [contenteditable="true"]') !== null`);
await focusEditorEnd();
await p.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
fs.writeFileSync(
  toolsFile,
  '# 2026 年我用過最順手的 6 個寫作工具\n\n今年換了三次工具。VS Code 補一句。\n',
);
check(
  'an external edit while typing shows the notice, not a silent reload',
  await until(
    `document.querySelector('.banner--warn')?.textContent.includes('檔案已在外部修改 · 外部編輯器')`,
    10000,
  ),
);
await p.send('Input.insertText', { text: '中' });
await shot('04-editor-external-change');
check('my text stays in the window', (await editorText()).includes('中'));
check(
  'the file on disk is not overwritten',
  fs.readFileSync(toolsFile, 'utf8').includes('VS Code 補一句'),
);
await click('.banner--warn .btn', '比對並合併');
check(
  '比對並合併 opens the conflict dialog',
  await until(`document.querySelector('[role=dialog]')?.textContent.includes('衝突')`),
);
await shot('05-editor-compare');
await p.evaluate(
  `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.includes('保留雙方')); b?.click(); })()`,
);
await until(
  `[...document.querySelectorAll('[role=dialog] button')].some((x) => x.textContent.includes('返回編輯'))`,
);
await click('[role=dialog] button', '返回編輯');
check(
  'after keeping both, the work shows the external version',
  await until(
    `document.querySelector('.editor__doc [contenteditable]')?.textContent.includes('VS Code 補一句')`,
  ),
);

// ---- Clean window: newer revisions are adopted live ----
const tools = (await api('GET', '/api/v1/works?limit=50')).items.find(
  (w) => w.title === '2026 年我用過最順手的 6 個寫作工具',
);
await api('PATCH', `/api/v1/works/${tools.id}`, {
  base_revision: tools.current_revision_id,
  markdown: '# 2026 年我用過最順手的 6 個寫作工具\n\nAgent 重寫了第一段。\n',
});
check(
  'a change from an agent is shown live when nothing is unsaved',
  await until(
    `document.querySelector('.editor__doc [contenteditable]')?.textContent.includes('Agent 重寫了第一段')`,
    8000,
  ),
);
check(
  'no notice for a clean window',
  await p.evaluate(`document.querySelector('.banner--warn') === null`),
);

// ---- Images, status, tags ----
await openWork('我把書房改成剪輯室：半年後的取捨');
check(
  'Markdown image loads through a signed URL',
  await until(
    `[...document.querySelectorAll('.editor__doc img')].some((i) => i.src.startsWith('${base}/media/v1/') && i.naturalWidth === 1600)`,
  ),
);
check(
  'missing image shows a placeholder instead of a broken icon',
  await p.evaluate(
    `[...document.querySelectorAll('.editor__doc img')].some((i) => i.src.startsWith('data:image/svg+xml') && decodeURIComponent(i.src).includes('找不到圖片'))`,
  ),
);
check(
  'image stays inside the reading column',
  await p.evaluate(
    `(() => { const i = [...document.querySelectorAll('.editor__doc img')][0]; if (!i) return false; const c = document.querySelector('.editor__doc [contenteditable]'); return i.getBoundingClientRect().right <= c.getBoundingClientRect().right + 1; })()`,
  ),
);
await shot('06-editor-images');

const desk = () =>
  api('GET', '/api/v1/works?limit=50').then((r) =>
    r.items.find((w) => w.title === '我把書房改成剪輯室：半年後的取捨'),
  );
await p.evaluate(
  `(() => { const s = document.querySelector('.editor__meta select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'ready'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
);
check(
  'status change saves right away',
  await (async () => {
    for (let i = 0; i < 40; i++) {
      if ((await desk()).status === 'ready') return true;
      await sleep(100);
    }
    return false;
  })(),
);
await p.evaluate(`document.querySelector('.tags__input').focus()`);
await p.send('Input.imeSetComposition', { text: 'ㄐ', selectionStart: 1, selectionEnd: 1 });
await p.key('Enter', 'Enter', 13);
check('Enter while composing does not add a tag', (await text('.tag')).length === 2);
await p.send('Input.insertText', { text: '工作室' });
await p.key('Enter', 'Enter', 13);
check(
  'Enter adds a tag',
  (
    await (async () => {
      for (let i = 0; i < 40; i++) {
        const w = await desk();
        if (w.tags.includes('工作室')) return w.tags;
        await sleep(100);
      }
      return null;
    })()
  )?.join() === '空間,剪輯,工作室',
);
await click('.tag__remove[aria-label="移除標籤 空間"]');
check(
  'removing a tag saves',
  await (async () => {
    for (let i = 0; i < 40; i++) {
      const w = await desk();
      if (!w.tags.includes('空間')) return true;
      await sleep(100);
    }
    return false;
  })(),
);
await shot('07-editor-status-tags');

async function text(selector) {
  return p.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`,
  );
}

// ---- History and restore ----
await click('.editor__actions .btn', '歷史');
await until(`document.querySelectorAll('.rev--button').length >= 5`);
const before = (await text('.rev--button .rev__n')).length;
await p.evaluate(`[...document.querySelectorAll('.rev--button')][0].click()`);
check(
  'selecting the current revision says 即目前版本 and disables restore',
  await until(
    `document.querySelector('.rev-detail__same')?.textContent === '即目前版本' && [...document.querySelectorAll('.rev-detail button')].find((b) => b.textContent === '恢復此版本').disabled`,
  ),
);
await p.evaluate(
  `[...document.querySelectorAll('.rev--button')].find((b) => b.querySelector('.rev__n').textContent === 'r2').click()`,
);
check(
  'an older revision shows its differences',
  await until(
    `/\\d+ 處不同/.test(document.querySelector('.rev-detail__stat')?.textContent ?? '') && document.querySelector('.rev-detail__diff del, .rev-detail__diff ins') !== null`,
  ),
);
await click('.rev-detail button', '恢復此版本');
check(
  'restore asks first and says it becomes a new revision',
  await until(
    `document.querySelector('.rev-confirm')?.textContent.includes('恢復 r2 為新版本 r${before + 1}') && document.querySelector('.rev-confirm').textContent.includes('歷史版本全部保留')`,
  ),
);
await shot('08-history-confirm');
await click('.rev-confirm button', '確認恢復');
check(
  'restored as a new revision; nothing removed from history',
  await until(
    `document.querySelectorAll('.rev--button').length === ${before + 1} && document.querySelector('.rev-msg--ok')?.textContent.includes('已恢復 r2')`,
  ),
);
check(
  'editor shows the restored text',
  await until(
    `!document.querySelector('.editor__doc [contenteditable]').textContent.includes('桌子換成兩張')`,
  ),
);
const revs = await api('GET', `/api/v1/works/${(await desk()).id}/revisions`);
check('service recorded a restore revision', revs.items[0]?.source === 'restore');
await shot('09-history-restored');

// ---- Asset viewer: 引用 ----
await nav('素材庫');
await until(`document.querySelectorAll('.atile:not(.atile--skeleton)').length > 0`);
for (let attempt = 0; attempt < 5; attempt++) {
  await click('.atile', 'kyoto-arashiyama-01.jpg');
  if (await until(`document.querySelector('.viewer') !== null`, 2000)) break;
}
check(
  '引用 lists works with their role',
  await until(
    `[...document.querySelectorAll('.viewer .ref')].map((r) => r.textContent).sort().join('|') === '京都紅葉季七日慢遊路線封面|我把書房改成剪輯室：半年後的取捨正文'`,
  ),
);
await shot('10-asset-references');
await click('.viewer .ref', '京都紅葉季');
check(
  'clicking a reference opens the work',
  await until(`document.querySelector('.editor__title')?.value === '京都紅葉季七日慢遊路線'`),
);

// ---- Dark ----
await scheme('dark');
await openWork('台南兩天一夜小吃地圖');
await sleep(500);
await shot('11-editor-external-dark');
await nav('作品庫');
await sleep(500);
await shot('12-library-dark');
await scheme('light');

fs.writeFileSync(
  path.join(out, 'qc011-verify-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
p.close();
process.exit(failed.length === 0 ? 0 : 1);
