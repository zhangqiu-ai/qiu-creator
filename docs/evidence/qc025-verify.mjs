// QC-025 acceptance driver for the real Electron window over CDP.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc025-verify.mjs <out-dir>
// Requires qc025-server.mjs on 7420 (fake Gemini, in-memory keys), seeded with
// qc025-seed.mjs, and the Electron dev window on CDP port 9333.
// Only fake key strings are typed; screenshots show the password field masked.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const [out] = process.argv.slice(2);
if (!home || !out || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc025-verify.mjs <out-dir>');
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
const FAKE_GEMINI_KEY = 'AIzaFAKE-qc025-not-a-real-key-0000';
const FAKE_CLAUDE_KEY = 'sk-ant-FAKE-qc025-not-a-real-key-00';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc025-${name}.png`));
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
const nav = (name) => click('nav .nav-item', name);
const row = (provider) => `.ai-set[data-provider="${provider}"]`;
const keyNowhere = (key) =>
  p.evaluate(`(() => {
    const k = ${JSON.stringify(key)};
    const inDom = document.documentElement.outerHTML.includes(k);
    const inputs = [...document.querySelectorAll('input')].some((i) => i.value.includes(k));
    let stored = false;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if ((localStorage.getItem(name) ?? '').includes(k)) stored = true;
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const name = sessionStorage.key(i);
        if ((sessionStorage.getItem(name) ?? '').includes(k)) stored = true;
      }
    } catch {}
    return !inDom && !inputs && !stored;
  })()`);
async function typeKey(provider, key) {
  await click(`${row(provider)} .ln .btn`, '新增');
  await until(`document.querySelector('${row(provider)} input[type=password]') !== null`);
  await p.evaluate(`document.querySelector('${row(provider)} input[type=password]').focus()`);
  await p.send('Input.insertText', { text: key });
}

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

// 1. Navigation and the no-key state.
check(
  'navigation has AI 工作台 between 匯入任務 and 平台預覽',
  (
    await p.evaluate(
      `[...document.querySelectorAll('nav .nav-item')].map((n) => n.textContent.trim()).join(',')`,
    )
  ).startsWith('作品庫,素材庫,匯入任務,AI 工作台,平台預覽,設定'),
);
await nav('AI 工作台');
check(
  'no Gemini key: 未設定 Gemini 金鑰 with 前往設定; 改用本地模型 disabled',
  await until(
    `document.querySelector('.aiw__result')?.textContent.includes('未設定 Gemini 金鑰') && [...document.querySelectorAll('.aiw__result .btn')].find((b) => b.textContent.includes('改用本地模型'))?.disabled === true`,
  ),
);
check(
  'models: Gemini selectable; Claude, GPT and 本地模型 disabled with reasons',
  await p.evaluate(
    `[...document.querySelectorAll('.aiw__opt--off')].map((o) => o.textContent).join('|') === 'Claude不支援視頻|GPT不支援視頻|本地模型延後提供'`,
  ),
);
await shot('01-no-key');
await click('.aiw__result .btn', '前往設定');
check(
  '前往設定 opens 設定 focused on AI 服務',
  await until(`document.activeElement?.id === 'set-ai'`),
);
await shot('02-settings-ai');

// 2. Keys: password field, stored write-only, cleared, never shown again.
await typeKey('gemini', FAKE_GEMINI_KEY);
check(
  'the key field is a password field',
  await p.evaluate(`document.querySelector('${row('gemini')} input').type === 'password'`),
);
await shot('03-key-entry');
await click(`${row('gemini')} button[type=submit]`);
check(
  'saved: 待確認告知, field gone',
  await until(
    `document.querySelector('${row('gemini')} [role=status]')?.textContent.includes('待確認告知') && document.querySelector('${row('gemini')} input[type=password]') === null`,
  ),
);
check('the key is nowhere in the window, inputs or web storage', await keyNowhere(FAKE_GEMINI_KEY));
const providers = await api('GET', '/api/v1/ai/providers');
check(
  'the API never returns the key',
  !JSON.stringify(providers).includes(FAKE_GEMINI_KEY) &&
    providers.items.find((x) => x.provider === 'gemini').key_configured === true,
);
check(
  'the notice says the content goes to Google',
  (await text(`${row('gemini')} .ai-set__notice`)).includes('Google'),
);
await shot('04-consent-needed');

await typeKey('anthropic', FAKE_CLAUDE_KEY);
await click(`${row('anthropic')} button[type=submit]`);
await until(`document.querySelector('${row('anthropic')} .ai-set__notice') !== null`);
await click(`${row('anthropic')} .ai-set__notice .btn`, '我已了解，啟用');
check(
  '我已了解，啟用 turns Claude ready, with its model',
  await until(
    `document.querySelector('${row('anthropic')} [role=status]')?.textContent.includes('鑰匙圈 · 已啟用') && document.querySelector('${row('anthropic')} select')?.value === 'claude-opus-5-5'`,
  ),
);
check('Claude key not exposed either', await keyNowhere(FAKE_CLAUDE_KEY));
await p.evaluate(`(() => {
  const sel = document.querySelector('${row('anthropic')} select');
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  set.call(sel, 'claude-sonnet-5-5');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await until(`document.querySelector('${row('anthropic')} select')?.value === 'claude-sonnet-5-5'`);
check(
  'model switch is saved',
  (await api('GET', '/api/v1/ai/providers')).items.find((x) => x.provider === 'anthropic')
    .text_model === 'claude-sonnet-5-5',
);
await p.evaluate(`document.querySelector('#ai-budget').focus()`);
await p.send('Input.insertText', { text: '0.005' });
await click('.ai-budget button[type=submit]');
check(
  'monthly reminder saved',
  await until(`document.querySelector('.ai-budget')?.textContent.includes('超過 $0.005 時提醒')`),
);
await shot('05-settings-ready');
await click(`${row('anthropic')} .btn`, '刪除金鑰');
await until(`document.querySelector('.scrim') !== null`);
await shot('06-delete-confirm');
await click('.scrim .btn', '刪除');
check(
  '刪除金鑰 after confirmation: 未設定',
  await until(
    `document.querySelector('${row('anthropic')} [role=status]')?.textContent.includes('未設定')`,
  ),
);

// 3. Workbench: pick, estimate, confirm with notice, progress, cancel.
await nav('AI 工作台');
check(
  'empty: 選擇素材庫的視頻來分析',
  await until(`document.querySelector('.aiw__empty')?.textContent.includes('選擇素材庫的視頻')`),
);
await click('.aiw__empty .btn', '選擇視頻');
check(
  'picker lists the library video',
  await until(`document.querySelectorAll('.aiw-pick__item').length === 1`),
);
await sleep(400);
await shot('07-picker');
await click('.aiw-pick__item');
check(
  'estimate shown with 估算 before anything is sent',
  await until(`document.querySelector('.aiw__est')?.textContent.includes('估算')`),
  await text('.aiw__est'),
);
await click('.aiw__setup .btn--primary', '分析');
check(
  'confirm dialog: Gemini notice, size, duration, model, max cost (估算)',
  await until(
    `(() => { const d = document.querySelector('.scrim'); return d && d.textContent.includes('首次使用 Gemini') && d.textContent.includes('0:56') && d.textContent.includes('最多花費') && d.textContent.includes('同意並上傳分析'); })()`,
  ),
);
check(
  'over the monthly reminder: the dialog warns',
  await p.evaluate(`document.querySelector('.scrim .aiw__over') !== null`),
);
await shot('08-confirm');
setMode('slow');
await sleep(400);
await click('.scrim .btn--primary', '同意並上傳分析');
check(
  'upload and analysis progress',
  await until(
    `document.querySelector('.aiw__run-label')?.textContent.includes('處理影片中')`,
    20000,
  ),
  await text('.aiw__run-label'),
);
check(
  '同意 confirmed the Gemini notice',
  (await api('GET', '/api/v1/ai/providers')).items.find((x) => x.provider === 'gemini').ready,
);
await shot('09-running');
const runningJob = (await api('GET', '/api/v1/ai/jobs?limit=5')).items[0];
await click('.aiw__run .btn', '取消');
let cancelled = null;
for (let i = 0; i < 50; i++) {
  cancelled = await api('GET', `/api/v1/ai/jobs/${runningJob.id}`);
  if (cancelled.status === 'cancelled') break;
  await sleep(100);
}
check('取消 cancels the job', cancelled?.status === 'cancelled', cancelled?.status);

// 4. Result.
setMode('ok');
await sleep(400);
await click('.aiw__setup .btn--primary', '分析');
await until(`document.querySelector('.scrim') !== null`);
check(
  'second time: no notice, 上傳並分析',
  await p.evaluate(
    `!document.querySelector('.scrim').textContent.includes('首次使用') && [...document.querySelectorAll('.scrim .btn')].some((b) => b.textContent === '上傳並分析')`,
  ),
);
await click('.scrim .btn--primary', '上傳並分析');
check('result arrives', await until(`document.querySelector('.aiw__done') !== null`, 30000));
await until(
  `[...document.querySelectorAll('.aiw__frame video')].every((v) => v.readyState >= 2)`,
  8000,
);
check(
  'result marked 待核驗 with the disclaimer',
  (await text('.aiw__done-head')).includes('待核驗') && (await text('.aiw__disclaimer')).length > 0,
);
check(
  'time points, with 超出片長 on the one past the end',
  await p.evaluate(
    `document.querySelectorAll('.aiw__chap').length === 6 && [...document.querySelectorAll('.aiw__chap')][5].textContent.includes('超出片長')`,
  ),
);
check(
  'cover suggestions show the frame at their time',
  await p.evaluate(
    `[...document.querySelectorAll('.aiw__frame video')].map((v) => Math.round(v.currentTime)).join() === '21,34,50'`,
  ),
);
check(
  'titles and descriptions with 複製',
  await p.evaluate(`document.querySelectorAll('.aiw__cand').length === 4`),
);
await click('.aiw__cand .btn', '複製');
check(
  '複製 → 已複製',
  await until(`document.querySelector('.aiw__cand')?.textContent.includes('已複製')`),
);
check(
  'usage card: month total, Gemini line, over-reminder warning, recent jobs',
  await until(
    `document.querySelector('.aiw__usage .aiw__over') !== null && document.querySelectorAll('.aiw__job').length >= 2 && document.querySelector('.aiw__providers')?.textContent.includes('Gemini')`,
  ),
);
await sleep(800);
await shot('10-result');

// 5. A time point opens the asset viewer there.
await p.evaluate(`[...document.querySelectorAll('.aiw__chap')][2].click()`);
check(
  'time point opens the asset viewer playing from that second',
  await until(
    `(() => { const v = document.querySelector('.viewer__media'); return v && v.currentTime >= 20.5; })()`,
    10000,
  ),
  await p.evaluate(`document.querySelector('.viewer__media')?.currentTime`),
);
await p.evaluate(`document.querySelector('.viewer__media')?.pause()`);
await shot('11-viewer-at-time');

// 6. Reuse, explicit re-analysis, failure, last result.
await nav('AI 工作台');
await until(`document.querySelector('.aiw__empty .btn') !== null`);
await click('.aiw__empty .btn', '選擇視頻');
await until(`document.querySelectorAll('.aiw-pick__item').length === 1`);
await click('.aiw-pick__item');
check(
  'an analysed video shows its result straight away',
  await until(`document.querySelector('.aiw__done') !== null`),
);
const jobsBefore = (await api('GET', '/api/v1/ai/jobs?limit=200')).total;
await click('.aiw__setup .btn--primary', '重新分析');
check(
  'reuse dialog says re-analysing charges again',
  await until(
    `document.querySelector('.scrim')?.textContent.includes('已分析過此影片') && document.querySelector('.scrim').textContent.includes('重新分析會再次上傳並計費')`,
  ),
);
await shot('12-reuse');
await click('.scrim .btn', '沿用結果');
await until(`document.querySelector('.scrim') === null`);
check(
  '沿用結果 sends nothing',
  (await api('GET', '/api/v1/ai/jobs?limit=200')).total === jobsBefore,
);
setMode('fail');
await sleep(400);
await click('.aiw__setup .btn--primary', '重新分析');
await until(`document.querySelector('.scrim') !== null`);
await click('.scrim .btn', '重新分析');
check(
  'explicit 重新分析 asks to confirm the charge again',
  await until(`document.querySelector('.scrim')?.textContent.includes('重新分析會再次計費')`),
);
await click('.scrim .btn--primary', '上傳並分析');
check(
  'failure: 分析失敗 with 429 reason, 重試 and 查看上次結果',
  await until(
    `(() => { const f = document.querySelector('.aiw__failed'); return f && f.textContent.includes('429') && f.textContent.includes('重試') && f.textContent.includes('查看上次結果'); })()`,
    30000,
  ),
  await text('.aiw__failed'),
);
await shot('13-failed');
await click('.aiw__failed .btn', '查看上次結果');
check(
  '查看上次結果 shows the earlier result',
  await until(`document.querySelector('.aiw__done') !== null`),
);
check(
  'history marks the failed job',
  await until(
    `[...document.querySelectorAll('.aiw__job')].some((j) => j.textContent.includes('失敗'))`,
  ),
);
setMode('ok');

// 7. Dark and narrow.
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await sleep(500);
await shot('14-result-dark');
await nav('設定');
await until(`document.querySelector('.ai-set') !== null`);
await sleep(300);
await shot('15-settings-dark');
await p.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1000,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});
await nav('AI 工作台');
await until(`document.querySelector('.aiw__empty .btn') !== null`);
await click('.aiw__empty .btn', '選擇視頻');
await until(`document.querySelectorAll('.aiw-pick__item').length === 1`);
await click('.aiw-pick__item');
await until(`document.querySelector('.aiw__done') !== null`);
await sleep(800);
check(
  'narrow window: no horizontal overflow',
  await p.evaluate(
    `document.querySelector('main.page').scrollWidth <= document.querySelector('main.page').clientWidth + 1`,
  ),
);
await shot('16-narrow');
check('Gemini key still not exposed at the end', await keyNowhere(FAKE_GEMINI_KEY));

fs.writeFileSync(path.join(out, 'qc025-verify-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
p.close();
process.exit(failed === 0 ? 0 : 1);
