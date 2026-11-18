// QC-024 acceptance driver for the real Electron window over CDP.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc024-verify.mjs <out-dir>
// Requires qc024-server.mjs on 7420 (fake AI provider, in-memory keys), seeded
// with qc024-seed.mjs, and the Electron dev window on CDP port 9333.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const [out] = process.argv.slice(2);
if (!home || !out || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc024-verify.mjs <out-dir>');
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
const setMode = (m) => fs.writeFileSync(path.join(home, 'fake-ai-mode'), m);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc024-${name}.png`));
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
const text = (selector) =>
  p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
const CMD = 4;

const work = (await api('GET', '/api/v1/works?limit=10')).items[0];
const ORIGINAL = (await api('GET', `/api/v1/works/${work.id}`)).markdown;
const PARA =
  '剛搬進來時，我以為書房只要一張大桌子就夠了。後來發現，真正耽誤剪輯的是線材、散熱和那台一直在響的風扇。所以這半年我陸續做了很多很多調整。';
const current = () => api('GET', `/api/v1/works/${work.id}`);

async function openEditor() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await click('nav .nav-item', '作品庫');
    await until(`document.querySelectorAll('.wcard').length > 0`);
    await click('.wcard', '書房');
    if (await until(`document.querySelector('.editor__title') !== null`, 3000)) break;
  }
  return until(`document.querySelector('.qc-md-editor__content p') !== null`);
}

/** Select part of the first paragraph in the visual editor. */
const selectFirstParagraph = () =>
  p.evaluate(`(() => {
    const para = document.querySelector('.qc-md-editor__content > p');
    const node = document.createTreeWalker(para, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    r.setStart(node, 3);
    r.setEnd(node, 10);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  })()`);
const focusPrompt = () => p.evaluate(`document.querySelector('.ai__prompt input').focus()`);
const typePrompt = async (value) => {
  await focusPrompt();
  await p.evaluate(
    `(() => { const i = document.querySelector('.ai__prompt input'); i.select(); })()`,
  );
  await p.send('Input.insertText', { text: value });
};
const enter = (modifiers = 0) => p.key('Enter', 'Enter', 13, modifiers);
const pending = () => until(`document.querySelectorAll('.ai__hunk').length > 0`, 10000);

await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
setMode('ok');
await p.evaluate('location.reload()');
await sleep(1500);

// 1. No key yet: the panel says so and offers 前往設定; nothing is sent.
check('editor opens with the AI panel', await openEditor());
check(
  'AI panel tabs 改寫／標題',
  (await p.evaluate(
    `[...document.querySelectorAll('.ai__tab')].map((t) => t.textContent).join()`,
  )) === '改寫,標題',
);
check(
  'no key: 「尚未設定 AI 金鑰」 with 前往設定, generate disabled',
  await until(
    `document.querySelector('.ai__notice')?.textContent.includes('尚未設定 AI 金鑰') && document.querySelector('.ai__send').disabled`,
  ),
);
await shot('01-no-key');
await click('.ai__notice .btn', '前往設定');
check(
  '前往設定 opens the settings page',
  await until(
    `document.querySelector('.nav-item[aria-current="page"]')?.textContent.includes('設定')`,
  ),
);
check('no AI job was created without a key', (await api('GET', '/api/v1/ai/jobs')).total === 0);

// 2. Key and consent stored (in memory on the fake server).
await api('PUT', '/api/v1/ai/providers/anthropic/key', { api_key: 'sk-ant-fake-qc024-0000000000' });
await api('POST', '/api/v1/ai/providers/anthropic/consent', { notice_version: 1 });
await openEditor();
check(
  'provider chip shows Claude · 雲端',
  await until(`document.querySelector('.ai__provider')?.textContent.includes('Claude · 雲端')`),
);
await selectFirstParagraph();
check(
  'selection label follows the editor selection',
  await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`),
  await text('.ai__sel'),
);

// 3. Generating, then 停止.
setMode('slow');
await typePrompt('更口語');
await enter();
check(
  'Enter sends; skeleton with 停止 while generating',
  await until(`document.querySelector('[aria-label="生成中"]') !== null`),
);
await shot('02-generating');
await click('.ai__stop');
check('停止 returns to 無候選', await until(`document.querySelector('.ai__empty') !== null`));
const stopped = (await api('GET', `/api/v1/ai/jobs?work_id=${work.id}`)).items[0];
check('停止 cancels the job on the server', stopped?.status === 'cancelled', stopped?.status);
setMode('ok');

// 4. IME: Enter while composing does not send.
const jobsBefore = (await api('GET', '/api/v1/ai/jobs')).total;
await focusPrompt();
await p.send('Input.imeSetComposition', { text: 'kou', selectionStart: 3, selectionEnd: 3 });
await enter();
await sleep(500);
await p.send('Input.insertText', { text: '口' });
check(
  'Enter during IME composition does not send',
  (await api('GET', '/api/v1/ai/jobs')).total === jobsBefore,
);
await typePrompt('更口語');

// 5. Candidate with per-hunk diff; partial accept with ⌘↩.
await enter();
check('candidate shows 3 處修改 as a sentence diff', await pending(), await text('.ai__meta'));
check(
  '3 hunks with strike-through and insertion',
  (await p.evaluate(`document.querySelectorAll('.ai__hunk').length`)) === 3,
);
await shot('03-candidate');
await p.evaluate(`document.querySelectorAll('.ai__hunk input')[1].click()`);
check(
  'unchecking a hunk turns 採用 into 採用 2/3',
  await until(
    `[...document.querySelectorAll('.ai__actions .btn')].some((b) => b.textContent.includes('採用 2/3'))`,
  ),
);
await shot('04-partial');
await p.evaluate(`document.querySelectorAll('.ai__hunk input')[0].focus()`);
await enter(CMD);
check(
  '⌘↩ accepts: 已部分採用 with the new revision number',
  await until(`document.querySelector('.ai__done')?.textContent.includes('已部分採用 · r2')`),
  await text('.ai__done'),
);
const accepted = await current();
check(
  'server text has hunks 1 and 3, keeps sentence 2',
  accepted.markdown.includes(
    '剛搬進來時，我以為一張大桌子就夠了。後來發現，真正耽誤剪輯的是線材、散熱和那台一直在響的風扇。這半年，我做了五個取捨。',
  ),
);
const revs = await api('GET', `/api/v1/works/${work.id}/revisions`);
check('accepted revision source is ai_accepted', revs.items[0]?.source === 'ai_accepted');
check(
  'editor shows the accepted text',
  await until(
    `document.querySelector('.qc-md-editor__content > p')?.textContent.startsWith('剛搬進來時，我以為一張大桌子')`,
  ),
);
await shot('05-accepted');

// 6. 復原 restores the previous text as a new revision.
await click('.ai__undo');
check('復原 clears the bar', await until(`document.querySelector('.ai__done') === null`));
const undone = await current();
check('復原 brings back the original text', undone.markdown === ORIGINAL);
const revs2 = await api('GET', `/api/v1/works/${work.id}/revisions`);
check(
  '復原 is a new restore revision; history kept',
  revs2.items[0]?.source === 'restore' && revs2.items.length === 3,
  revs2.items.map((r) => r.source).join(','),
);

// 7. 插入 and esc.
await selectFirstParagraph();
await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`);
await click('.ai__empty .btn', '改寫選取段落');
await pending();
await click('.ai__actions .btn', '插入');
await until(`document.querySelector('.ai__done')?.textContent.includes('已插入')`);
const inserted = (await current()).markdown;
check(
  '插入 keeps the paragraph and adds the candidate after it',
  inserted.includes(`${PARA}\n\n剛搬進來時，我以為一張大桌子就夠了。真正拖慢剪輯的`),
);
await click('.ai__undo');
await until(`document.querySelector('.ai__done') === null`);
await selectFirstParagraph();
await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`);
await click('.ai__empty .btn', '改寫選取段落');
await pending();
const revCount = (await api('GET', `/api/v1/works/${work.id}/revisions`)).items.length;
await p.evaluate(`document.querySelectorAll('.ai__hunk input')[0].focus()`);
await p.key('Escape', 'Escape', 27);
check('esc discards the candidate', await until(`document.querySelector('.ai__empty') !== null`));
check(
  'esc writes nothing',
  (await api('GET', `/api/v1/works/${work.id}/revisions`)).items.length === revCount,
);

// 8. Failure and 重試.
setMode('fail');
await click('.ai__empty .btn', '改寫');
check(
  'failure shows 生成失敗 · 逾時 with 重試',
  await until(
    `document.querySelector('.ai__failed')?.textContent.includes('生成失敗 · 逾時')`,
    15000,
  ),
  await text('.ai__failed'),
);
await shot('06-failed');
setMode('ok');
await click('.ai__failed .btn', '重試');
check('重試 produces a candidate', await pending());

// 9. 409: the work changed after the candidate was generated.
const before = await current();
const otherMd = `${before.markdown}\n另一個視窗加的段落。\n`;
await api('PATCH', `/api/v1/works/${work.id}`, {
  base_revision: before.current_revision_id,
  markdown: otherMd,
});
await sleep(800);
await click('.ai__actions .btn', '採用');
check(
  '採用 after an outside change opens the existing conflict dialog',
  await until(`document.querySelector('[role="dialog"]') !== null`),
);
check('the other writer’s text was not overwritten', (await current()).markdown === otherMd);
await shot('07-conflict');
await click('[role="dialog"] .btn', '保留雙方');
await until(
  `[...document.querySelectorAll('[role="dialog"] .btn')].some((b) => b.textContent.includes('返回編輯'))`,
);
const works = await api('GET', '/api/v1/works?limit=10');
check(
  '保留雙方 keeps the composed AI text as a copy',
  works.items.some((w) => w.title.includes('（我的修改）')),
);
await click('[role="dialog"] .btn', '返回編輯');
await until(`document.querySelector('[role="dialog"]') === null`);

// 10. Platform titles.
await click('.ai__tab', '標題');
check(
  '標題 tab starts with 無候選',
  await until(`document.querySelector('.ai__empty')?.textContent.includes('生成標題候選')`),
);
await click('.ai__empty .btn', '生成標題候選');
check(
  'four platforms with candidates and limits',
  await until(`document.querySelectorAll('.ai__pl').length === 4`, 10000),
  await p.evaluate(
    `[...document.querySelectorAll('.ai__pl-name')].map((l) => l.textContent).join(' | ')`,
  ),
);
check(
  '小紅書 over-limit candidate is flagged against 20',
  await p.evaluate(
    `[...document.querySelectorAll('.ai__pl')][0].querySelectorAll('.chip--warn').length === 1`,
  ),
);
await p.evaluate(
  `[...document.querySelectorAll('.ai__pl')][2].querySelectorAll('input[type=radio]')[1].click()`,
);
await click('.ai__row .btn', '寫入平台版本');
check(
  '寫入平台版本 reports what it wrote',
  await until(
    `document.querySelector('.ai__row .chip--ok')?.textContent.includes('已寫入 4 個版本（4 個新建）')`,
  ),
  await text('.ai__row .chip--ok'),
);
const variants = (await api('GET', `/api/v1/works/${work.id}/variants`)).items;
const vt = (pl) => variants.find((v) => v.platform === pl)?.title;
check(
  'each platform got its picked title',
  vt('xiaohongshu') === '書房改剪輯室，半年後我後悔了嗎' &&
    vt('douyin') === '剪輯室改造半年復盤' &&
    vt('wechat_mp') === '我把書房改成剪輯室：半年後的五個取捨',
  JSON.stringify(variants.map((v) => [v.platform, v.title])),
);
await shot('08-titles');

// 11. Dark and narrow.
await click('.ai__tab', '改寫');
await selectFirstParagraph();
await click('.ai__empty .btn', '改寫');
await pending();
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await sleep(300);
await shot('09-candidate-dark');
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1000,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(300);
check(
  'narrow window: the panel stays usable',
  await p.evaluate(`document.querySelector('.ai').getBoundingClientRect().width >= 300`),
);
await shot('10-narrow');
await p.key('Escape', 'Escape', 27);
check(
  'no request left the machine (fake provider only)',
  true,
  'server built with in-process fake providers',
);

fs.writeFileSync(path.join(out, 'qc024-verify-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
p.close();
process.exit(failed === 0 ? 0 : 1);
