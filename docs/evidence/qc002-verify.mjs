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
const openWork = async (t) => {
  await p.evaluate(
    `[...document.querySelectorAll('.work-list__item')].find(b => b.textContent.includes(${JSON.stringify(t)})).click()`,
  );
  await sleep(1200);
};
const ime = (text) =>
  p.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
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

// 1. Opening does not save.
const travel = await byTitle('京都');
await openWork('京都');
await sleep(1500);
check(
  'opening a document does not create a revision',
  (await revCount(travel.id)) === 1,
  `revisions=${await revCount(travel.id)}`,
);
await shot('01-visual-editor');

// 2. IME composition in the visual editor.
const before = source(travel.id);
await caretAtEndOf('.qc-md-editor__content p', '最後一段');
await ime('z');
await ime('zh');
await ime('zhong');
await ime('中');
await sleep(300);
// ⌘S while composing must not save.
await p.key('s', 'KeyS', 83, META);
await shot('02-ime-composing');
await sleep(1600); // > autosave delay
check(
  'no save while IME is composing (visual)',
  source(travel.id) === before && (await revCount(travel.id)) === 1,
  `status=${await status()}`,
);
await p.send('Input.insertText', { text: '中文輸入' });
await sleep(2000);
const afterCommit = source(travel.id);
check(
  'composed text is saved after commit (visual)',
  afterCommit.includes('最後一段。中文輸入'),
  JSON.stringify(afterCommit.slice(-20)),
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
await shot('03-ime-committed');

// 3. Undo / redo.
await p.key('z', 'KeyZ', 90, META);
await sleep(300);
const undone = await p.evaluate(
  `document.querySelector('.qc-md-editor__content').innerText.includes('中文輸入')`,
);
check('⌘Z undoes the committed IME text', !undone);
await p.key('z', 'KeyZ', 90, META | SHIFT);
await sleep(300);
const redone = await p.evaluate(
  `document.querySelector('.qc-md-editor__content').innerText.includes('最後一段。中文輸入')`,
);
check('⇧⌘Z redoes it', redone);
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

// 5. Version history.
await p.evaluate(`document.querySelector('[aria-label="版本歷史"]').click()`);
await sleep(800);
const historyItems = await p.evaluate(`document.querySelectorAll('.history__item').length`);
check(
  'history lists every revision',
  historyItems === (await revCount(travel.id)),
  `items=${historyItems}`,
);
await shot('04-history');
await p.evaluate(`document.querySelector('[aria-label="版本歷史"]').click()`);

// 6. Conflict: someone else writes, then we edit.
const theirs = await api('PATCH', `/api/v1/works/${travel.id}`, {
  base_revision: travelNow.current_revision_id,
  markdown: travelNow.markdown.replace('最後一段。', '最後一段（Agent 修改）。'),
});
check('external writer saved via API', theirs.status === 200);
await caretAtEndOf('.qc-md-editor__content p', '最後一段');
await p.send('Input.insertText', { text: '我的修改' });
await sleep(2000);
check('stale save shows 版本衝突', (await status()) === '版本衝突');
check(
  'server copy was not overwritten',
  source(travel.id).includes('Agent 修改') && !source(travel.id).includes('我的修改'),
);
const draftKept = await p.evaluate(
  `document.querySelector('.qc-md-editor__content').innerText.includes('我的修改')`,
);
check('local draft kept in the editor', draftKept);
await shot('05-conflict');
await p.evaluate(
  `[...document.querySelectorAll('.conflict button')].find(b => b.textContent === '查看差異').click()`,
);
await sleep(800);
const diffText = await p.evaluate(`document.querySelector('.diff__body')?.innerText ?? ''`);
check('diff shows both versions', diffText.includes('Agent 修改') && diffText.includes('我的修改'));
await shot('06-diff');
await p.evaluate(`document.querySelector('[aria-label="關閉差異"]').click()`);
await sleep(300);
// Keep both: save my draft as a new work.
const countBefore = (await works()).length;
await p.evaluate(
  `[...document.querySelectorAll('.conflict button')].find(b => b.textContent === '另存新作品').click()`,
);
await sleep(1500);
const copy = await byTitle('（我的版本）');
check(
  'keep-both creates a new work with my draft',
  (await works()).length === countBefore + 1 &&
    copy !== undefined &&
    source(copy.id).includes('我的修改'),
);
check('original still has the other writer’s version', source(travel.id).includes('Agent 修改'));

// 7. Lossy document opens in source mode; IME in the textarea.
const lossy = await byTitle('特殊語法');
const lossyBefore = source(lossy.id);
await openWork('特殊語法');
check(
  'lossy document opens in source mode',
  await p.evaluate(`!!document.querySelector('textarea.qc-md-editor__source')`),
);
await shot('07-lossy-source-mode');
await p.evaluate(
  `[...document.querySelectorAll('.qc-md-editor__mode')].find(b => b.textContent === '視覺').click()`,
);
await sleep(300);
check(
  'switching to visual asks first',
  await p.evaluate(`!!document.querySelector('.qc-md-editor__confirm')`),
);
await shot('08-lossy-confirm');
await p.evaluate(
  `[...document.querySelectorAll('.qc-md-editor__confirm button')].find(b => b.textContent === '取消').click()`,
);
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

// 8. Long Chinese document scrolling.
await openWork('長文');
await sleep(800);
const long = await byTitle('長文');
const scroller = `document.querySelector('.qc-md-editor__visual')`;
const metrics = await p.evaluate(`(async () => {
  const el = ${scroller}.querySelector('.mdxeditor-root-contenteditable')?.parentElement ?? ${scroller};
  const sc = [el, ...el.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 100 && getComputedStyle(e).overflowY !== 'visible') ?? document.scrollingElement;
  const frames = [];
  let last = performance.now();
  const steps = 60;
  for (let i = 1; i <= steps; i++) {
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * i / steps;
    await new Promise(r => requestAnimationFrame(r));
    const now = performance.now(); frames.push(now - last); last = now;
  }
  frames.sort((a, b) => a - b);
  return { scrollHeight: sc.scrollHeight, atBottom: Math.abs(sc.scrollTop + sc.clientHeight - sc.scrollHeight) < 2,
    p50: frames[Math.floor(frames.length / 2)], p95: frames[Math.floor(frames.length * 0.95)], max: frames[frames.length - 1] };
})()`);
check('long document scrolls to the bottom', metrics.atBottom, JSON.stringify(metrics));
check('long document did not save on open', (await revCount(long.id)) === 1);
await shot('09-long-bottom');

// 9. Dark appearance.
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await openWork('京都');
await sleep(800);
await shot('10-dark');
const bg = await p.evaluate(`getComputedStyle(document.body).backgroundColor`);
check('dark appearance uses dark canvas token', bg === 'rgb(30, 30, 30)', bg);
await p.send('Emulation.setEmulatedMedia', { features: [] });

fs.writeFileSync(path.join(out, 'qc002-verify-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed, ${results.length} total`);
p.close();
