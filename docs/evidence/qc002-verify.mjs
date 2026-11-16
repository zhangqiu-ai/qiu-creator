// QC-002 acceptance run against the real Electron window and a real mac-server.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc002-verify.mjs <out-dir>
// Requires `node apps/mac/scripts/dev.mjs --remote-debugging-port=9333` running.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const out = process.argv[2];
if (!home || !out) throw new Error('usage: CREATORHUB_HOME=... node qc002-verify.mjs <out-dir>');
fs.mkdirSync(out, { recursive: true });
const token = fs.readFileSync(path.join(home, 'data/api-token'), 'utf8').trim();
const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:7420${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const works = async () => (await api('GET', '/api/v1/works?limit=200')).json.items;
const byTitle = async (t) => (await works()).find((w) => w.title.includes(t));
const source = (id) => fs.readFileSync(path.join(home, 'library/works', id, 'source.md'), 'utf8');
const revCount = async (id) =>
  (await api('GET', `/api/v1/works/${id}/revisions`)).json.items.length;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const p = await connectPage();
await p.send('Page.enable');
const shot = (name) => p.screenshot(path.join(out, `qc002-${name}.png`));
const status = () => p.evaluate(`document.querySelector('.save-status')?.textContent ?? null`);
const goLibrary = async () => {
  const back = await p.evaluate(`!!document.querySelector('[aria-label="返回作品庫"]')`);
  if (back) await p.evaluate(`document.querySelector('[aria-label="返回作品庫"]').click()`);
  await sleep(900);
};
const openWork = async (t) => {
  await goLibrary();
  await p.evaluate(
    `[...document.querySelectorAll('.wcard')].find(b => b.querySelector('.wcard__title').textContent.includes(${JSON.stringify(t)})).click()`,
  );
  await sleep(1300);
};
const clickText = (selector, text) =>
  p.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})).click()`,
  );
const text = (selector) =>
  p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const exists = (selector) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const ime = (t) =>
  p.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
const caretAtEndOf = (selector, textIncludes) =>
  p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(textIncludes)}));
    el.closest('[contenteditable]').focus();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null; while (walker.nextNode()) last = walker.currentNode;
    const r = document.createRange(); r.setStart(last, last.length); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return last.textContent;
  })()`);
const META = 4;
const SHIFT = 8;
const setWidth = (width) =>
  width === null
    ? p.send('Emulation.clearDeviceMetricsOverride')
    : p.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        deviceScaleFactor: 2,
        mobile: false,
      });

// 0. Library: grid, list, filters, empty-filter state, narrow window.
await setWidth(1440);
await sleep(800);
check(
  'library shows every work as a card',
  (await p.evaluate(`document.querySelectorAll('.wcard').length`)) === (await works()).length,
);
await shot('01-library-grid');
await p.evaluate(`document.querySelector('[aria-label="列表"]').click()`);
await sleep(300);
check(
  'list view shows a table row per work',
  (await p.evaluate(`document.querySelectorAll('.tbl tbody tr').length`)) ===
    (await works()).length,
);
await shot('02-library-list');
await p.evaluate(`document.querySelector('[aria-label="網格"]').click()`);
await clickText('.fchip', '待審核');
await sleep(300);
check(
  'status filter with no matches shows 無符合作品',
  (await text('.page__body')).includes('無符合作品'),
);
await shot('03-library-empty-filter');
await clickText('.page__body .btn', '清除篩選');
await sleep(600);
await p.evaluate(`document.querySelector('.search input').focus()`);
await ime('chang');
await ime('長');
await sleep(600);
check(
  'search does not run during IME composition',
  (await p.evaluate(`document.querySelectorAll('.wcard').length`)) === (await works()).length,
);
await p.send('Input.insertText', { text: '長文' });
await sleep(900);
const found = await p.evaluate(
  `[...document.querySelectorAll('.wcard__title')].map(e => e.textContent)`,
);
check(
  'search runs after the composition commits',
  found.length === 1 && found[0].includes('長文'),
  JSON.stringify(found),
);
await p.evaluate(
  `(() => { const i = document.querySelector('.search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
);
await sleep(700);
await setWidth(1000);
await sleep(400);
const sideWidth = await p.evaluate(`document.querySelector('.side').getBoundingClientRect().width`);
check('narrow window collapses the navigation to icons', sideWidth <= 64, `width=${sideWidth}`);
await shot('04-library-narrow');
await setWidth(760);
await sleep(400);
const stacked = await p.evaluate(
  `(() => { const side = document.querySelector('.side').getBoundingClientRect(); const page = document.querySelector('main').getBoundingClientRect(); return { sideBottom: side.bottom, pageTop: page.top, sideWidth: side.width }; })()`,
);
check(
  'below 800px the navigation stacks above the content',
  stacked.pageTop >= stacked.sideBottom - 1 && stacked.sideWidth > 700,
  JSON.stringify(stacked),
);
await shot('04b-library-stacked');
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
const motion = await p.evaluate(
  `({ card: getComputedStyle(document.querySelector('.wcard')).transitionDuration, seg: getComputedStyle(document.querySelector('.seg button')).transitionDuration })`,
);
check(
  'Reduce Motion switches transitions off',
  motion.card === '0s' && motion.seg === '0s',
  JSON.stringify(motion),
);
await p.send('Emulation.setEmulatedMedia', { features: [] });
const motionOn = await p.evaluate(
  `getComputedStyle(document.querySelector('.wcard')).transitionDuration`,
);
check(
  'hover transitions are 150ms otherwise',
  motionOn.split(', ').every((d) => d === '0.15s'),
  motionOn,
);
await setWidth(1440);
await sleep(400);

// 0b. Approved visual baseline: light bg token and bundled Inter.
const lightBg = await p.evaluate(`getComputedStyle(document.body).backgroundColor`);
check('light appearance uses the bg token (#F6F5F1)', lightBg === 'rgb(246, 245, 241)', lightBg);
const inter = await p.evaluate(`(async () => {
  await document.fonts.ready;
  const faces = [...document.fonts].filter(f => f.family.replace(/"/g, '') === 'Inter Variable' && f.status === 'loaded');
  const remote = performance.getEntriesByType('resource').filter(r => r.name.endsWith('.woff2') &&!r.name.startsWith(location.origin));
  return { loaded: faces.length, remote: remote.length, used: getComputedStyle(document.querySelector('.page__title')).fontFamily };
})()`);
check(
  'Inter is loaded from the app bundle, not the network',
  inter.loaded > 0 && inter.remote === 0,
  JSON.stringify(inter),
);

// 0c. Computed styles against DESIGN.md 視覺基線 (sizes, radii, type scale).
const style = (selector, props) =>
  p.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    return Object.fromEntries(${JSON.stringify(props)}.map(k => [k, k === 'width' ? r.width : k === 'height' ? r.height : cs[k]])); })()`);
const expectStyle = async (name, selector, expected) => {
  const got = await style(selector, Object.keys(expected));
  const ok =
    got !== null && Object.entries(expected).every(([k, v]) => String(got[k]) === String(v));
  check(`baseline: ${name}`, ok, JSON.stringify(got));
};
await expectStyle('sidebar 220px on sunken', '.side', {
  width: 220,
  backgroundColor: 'rgb(239, 237, 231)',
});
await expectStyle('nav item 34px, radius 7', '.nav-item', {
  height: 34,
  borderTopLeftRadius: '7px',
});
await expectStyle('page title 20px/600', '.page__title', { fontSize: '20px', fontWeight: '600' });
await expectStyle('primary button 32px, radius 7, accent', '.page__header .btn--primary', {
  height: 32,
  borderTopLeftRadius: '7px',
  backgroundColor: 'rgb(47, 79, 207)',
});
await expectStyle('segmented control radius 8', '.page__header .seg', {
  borderTopLeftRadius: '8px',
});
await expectStyle('segment item 28px, radius 6', '.page__header .seg button', {
  height: 28,
  borderTopLeftRadius: '6px',
});
await expectStyle('card radius 10 on surface', '.wcard', {
  borderTopLeftRadius: '10px',
  backgroundColor: 'rgb(255, 255, 255)',
});
await expectStyle('card title 14px/600', '.wcard__title', { fontSize: '14px', fontWeight: '600' });
await expectStyle('chip 22px pill', '.chip', { height: 22, borderTopLeftRadius: '999px' });
await expectStyle('filter chip 28px pill', '.fchip', { height: 28, borderTopLeftRadius: '999px' });
await expectStyle('header padding 16px 28px', '.page__header', {
  paddingTop: '16px',
  paddingLeft: '28px',
});

// 1. Opening does not save.
const travel = await byTitle('京都');
await openWork('京都');
await sleep(800);
check('opening a document does not create a revision', (await revCount(travel.id)) === 1);
check(
  'editor header shows r1 and a word count',
  (await text('.editor__bar')).includes('r1') && /\d+ 字/.test(await text('.editor__bar')),
);
await expectStyle('reading column 680px with 48px padding', '.qc-md-editor__content', {
  maxWidth: '680px',
  paddingLeft: '48px',
});
await expectStyle('long-form body 16px/1.85', '.qc-md-editor__content p', {
  fontSize: '16px',
  lineHeight: '29.6px',
});
await expectStyle('long-form h1 28px/700', '.qc-md-editor__content h1', {
  fontSize: '28px',
  fontWeight: '700',
});
await expectStyle('long-form h2 19px/600', '.qc-md-editor__content h2', {
  fontSize: '19px',
  fontWeight: '600',
});
await shot('05-editor');

// 2. IME composition in the visual editor.
const before = source(travel.id);
await caretAtEndOf('.qc-md-editor__content p', '最後一段');
for (const t of ['z', 'zh', 'zhong', '中']) await ime(t);
await sleep(300);
await p.key('s', 'KeyS', 83, META); // ⌘S while composing must not save
await shot('06-ime-composing');
await sleep(1600);
check(
  'no save while IME is composing (visual, including ⌘S)',
  source(travel.id) === before && (await revCount(travel.id)) === 1,
  `status=${await status()}`,
);
await p.send('Input.insertText', { text: '中文輸入' });
await sleep(2000);
check(
  'composed text is saved after commit (visual)',
  source(travel.id).includes('最後一段。中文輸入'),
);
check('save status returns to 已儲存', (await status()) === '已儲存');
const caret = await p.evaluate(
  `(() => { const s = getSelection(); return s.anchorNode.textContent.slice(0, s.anchorOffset); })()`,
);
check(
  'caret sits right after the committed text',
  caret.endsWith('中文輸入'),
  JSON.stringify(caret.slice(-8)),
);

// 3. Undo / redo.
await p.key('z', 'KeyZ', 90, META);
await sleep(300);
check(
  '⌘Z undoes the committed IME text',
  !(await text('.qc-md-editor__content')).includes('中文輸入'),
);
await p.key('z', 'KeyZ', 90, META | SHIFT);
await sleep(300);
check('⇧⌘Z redoes it', (await text('.qc-md-editor__content')).includes('最後一段。中文輸入'));
await sleep(1500);
check('document on disk matches after undo/redo', source(travel.id).includes('最後一段。中文輸入'));

// 4. IME in the title field.
await p.evaluate(
  `(() => { const t = document.querySelector('.editor__title'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`,
);
const revBeforeTitle = await revCount(travel.id);
await ime('xin');
await ime('新');
await sleep(1600);
check('no save while composing in the title', (await revCount(travel.id)) === revBeforeTitle);
await p.send('Input.insertText', { text: '（新版）' });
await sleep(1800);
const travelNow = (await api('GET', `/api/v1/works/${travel.id}`)).json;
check(
  'title saved after commit',
  travelNow.title === '旅行筆記：京都三日（新版）',
  travelNow.title,
);

// 5. ⌘/ switches modes; version history panel.
await p.key('/', 'Slash', 191, META);
await sleep(400);
check('⌘/ switches to source mode', await exists('textarea.qc-md-editor__source'));
await p.key('/', 'Slash', 191, META);
await sleep(600);
check('⌘/ switches back to visual', await exists('.qc-md-editor__content'));
await clickText('.editor__actions .btn', '歷史');
await sleep(800);
const historyItems = await p.evaluate(`document.querySelectorAll('.rev').length`);
check(
  'history lists every revision with r numbers',
  historyItems === (await revCount(travel.id)) &&
    (await text('.revs')).includes(`r${historyItems}`),
  `items=${historyItems}`,
);
await shot('07-history');
await p.evaluate(`document.querySelector('[aria-label="關閉歷史"]').click()`);

// 6. Conflict → 保留雙方.
const agentEdit = async (from, to) => {
  const cur = (await api('GET', `/api/v1/works/${travel.id}`)).json;
  return api('PATCH', `/api/v1/works/${travel.id}`, {
    base_revision: cur.current_revision_id,
    markdown: cur.markdown.replace(from, to),
  });
};
check(
  'Agent writes via API',
  (await agentEdit('最後一段。', '最後一段（Agent 修改）。')).status === 200,
);
await caretAtEndOf('.qc-md-editor__content p', '最後一段');
await p.send('Input.insertText', { text: '我的修改' });
await sleep(2000);
check('stale save opens the conflict dialog', await exists('[role="dialog"]'));
check(
  'server copy was not overwritten',
  source(travel.id).includes('Agent 修改') && !source(travel.id).includes('我的修改'),
);
const panes = await text('.panes');
check(
  'dialog shows my change and the server change side by side',
  panes.includes('我的修改') && panes.includes('Agent 修改'),
);
await expectStyle('dialog radius 14', '.dialog', { borderTopLeftRadius: '14px' });
await expectStyle('dialog title 16px/600', '.dialog__title', {
  fontSize: '16px',
  fontWeight: '600',
});
check(
  'editor behind the dialog is inert',
  await p.evaluate(`document.querySelector('main.editor').inert === true`),
);
await shot('08-conflict');
await clickText('.dialog__foot .btn', '查看差異');
await sleep(300);
const diffText = await text('.diffview');
check(
  '查看差異 shows deletions and insertions',
  diffText.includes('Agent 修改') && diffText.includes('我的修改'),
);
await shot('09-conflict-diff');
const countBefore = (await works()).length;
await clickText('.dialog__foot .btn', '保留雙方');
await sleep(1500);
const copy = await byTitle('（我的修改）');
check(
  '保留雙方 creates a copy with my draft',
  (await works()).length === countBefore + 1 &&
    copy !== undefined &&
    source(copy.id).includes('我的修改'),
);
check(
  'original keeps the Agent version',
  source(travel.id).includes('Agent 修改') && !source(travel.id).includes('我的修改'),
);
await shot('10-conflict-done');
await clickText('.dialog__foot .btn', '返回編輯');
await sleep(800);
check(
  'editor shows the server version after 保留雙方',
  (await text('.qc-md-editor__content')).includes('Agent 修改') && (await status()) === '已儲存',
);

// 7. Conflict → 手動合併 with a per-hunk pick.
check(
  'Agent writes again',
  (await agentEdit('最後一段（Agent 修改）。', '最後一段（Agent 第二次）。')).status === 200,
);
await caretAtEndOf('.qc-md-editor__content h1', '旅行筆記');
await p.send('Input.insertText', { text: '・合併' });
await sleep(2000);
check('second stale save opens the dialog again', await exists('[role="dialog"]'));
await clickText('.dialog__foot .btn', '手動合併');
await sleep(300);
const hunkCount = await p.evaluate(`document.querySelectorAll('.merge__row').length`);
// Keep my heading change (hunk 1, default 我的) and take the server's last paragraph.
await p.evaluate(
  `[...document.querySelectorAll('.merge__row')].forEach(row => { if (row.textContent.includes('Agent')) [...row.querySelectorAll('.seg button')].find(b => b.textContent === '伺服器').click(); })`,
);
await sleep(200);
await shot('11-conflict-merge');
await clickText('.dialog__foot .btn', '完成合併');
await sleep(1500);
const merged = source(travel.id);
check(
  '手動合併 writes the picked sides',
  merged.includes('旅行筆記：京都三日・合併') && merged.includes('最後一段（Agent 第二次）。'),
  `hunks=${hunkCount}`,
);
await clickText('.dialog__foot .btn', '返回編輯');
await sleep(800);
check(
  'editor shows the merged version',
  (await text('.qc-md-editor__content')).includes('京都三日・合併') &&
    (await status()) === '已儲存',
);

// 8. Lossy document opens in source mode; IME in the textarea.
const lossy = await byTitle('特殊語法');
const lossyBefore = source(lossy.id);
await openWork('特殊語法');
check('lossy document opens in source mode', await exists('textarea.qc-md-editor__source'));
await shot('12-lossy-source-mode');
await clickText('.editor__actions .seg button', '視覺');
await sleep(300);
check('switching to visual asks first', await exists('.qc-md-editor__confirm'));
await shot('13-lossy-confirm');
await clickText('.qc-md-editor__confirm button', '取消');
await p.evaluate(
  `(() => { const t = document.querySelector('textarea.qc-md-editor__source'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`,
);
await ime('hao');
await ime('好');
await sleep(1600);
check('no save while composing (source mode)', source(lossy.id) === lossyBefore);
await p.send('Input.insertText', { text: '好的' });
await sleep(1800);
check('source mode saves byte-exact text + insertion', source(lossy.id) === `${lossyBefore}好的`);

// 9. Long Chinese document scrolling.
await openWork('長文捲動');
const long = await byTitle('長文');
const metrics = await p.evaluate(`(async () => {
  const sc = document.querySelector('.editor__doc');
  const frames = []; let last = performance.now();
  for (let i = 1; i <= 60; i++) {
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * i / 60;
    await new Promise(r => requestAnimationFrame(r));
    const now = performance.now(); frames.push(now - last); last = now;
  }
  frames.sort((a, b) => a - b);
  return { scrollHeight: sc.scrollHeight, atBottom: Math.abs(sc.scrollTop + sc.clientHeight - sc.scrollHeight) < 2,
    p50: frames[30], p95: frames[57], max: frames[59] };
})()`);
check(
  'long document scrolls to the bottom',
  metrics.atBottom && metrics.scrollHeight > 10000,
  JSON.stringify(metrics),
);
check('long document did not save on open', (await revCount(long.id)) === 1);
await shot('14-long-bottom');

// 10. Dark appearance.
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await openWork('京都');
await shot('15-editor-dark');
const bg = await p.evaluate(`getComputedStyle(document.body).backgroundColor`);
check('dark appearance uses the dark bg token (#161615)', bg === 'rgb(22, 22, 21)', bg);
await goLibrary();
await shot('16-library-dark');
await p.send('Emulation.setEmulatedMedia', { features: [] });
await setWidth(null);

fs.writeFileSync(
  path.join(out, 'qc002-verify-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed, ${results.length} total`);
p.close();
