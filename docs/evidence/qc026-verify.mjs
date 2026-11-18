// QC-026 acceptance driver for the real Electron window over CDP: the M3 path a user takes,
// against the real mac-server and LOCAL fake providers (Claude, Gemini). Fake keys only.
// Run through qc026-run.sh (it takes the e2e lock, starts everything and cleans up).
// Usage: CREATORHUB_HOME=<temp home> QC026_SERVER_LOG=<log> node docs/evidence/qc026-verify.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const serverLog = process.env.QC026_SERVER_LOG;
const [out] = process.argv.slice(2);
if (!home || !serverLog || !out || !path.basename(home).startsWith('qc026-home')) {
  throw new Error('run through docs/evidence/qc026-run.sh');
}
const base = 'http://127.0.0.1:7420';
const control = 'http://127.0.0.1:7433';
const seed = JSON.parse(fs.readFileSync(path.join(home, 'qc026-seed.json'), 'utf8'));
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const KEYS = {
  anthropic: 'sk-ant-api03-QC026-FAKE-claude-key-0123456789',
  gemini: 'AIzaQC026-FAKE-gemini-key-0123456789abcdef',
};

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const fakes = async (method, url, body) => {
  const res = await fetch(`${control}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};
const state = () => fakes('GET', '/state');
const script = (provider, replies) => fakes('POST', '/script', { provider, replies });
const geminiMode = (m) => fakes('POST', '/gemini', m);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc026-${name}.png`));
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

/** True when the key is not in the DOM, any input, web storage, IndexedDB names or cookies. */
const keyNowhere = (key) =>
  p.evaluate(`(async () => {
    const k = ${JSON.stringify(key)};
    const inDom = document.documentElement.outerHTML.includes(k);
    const inputs = [...document.querySelectorAll('input, textarea')].some((i) => i.value.includes(k));
    let stored = false;
    try {
      for (const area of [localStorage, sessionStorage]) {
        for (let i = 0; i < area.length; i++) {
          const name = area.key(i);
          if (name.includes(k) || (area.getItem(name) ?? '').includes(k)) stored = true;
        }
      }
    } catch {}
    const cookies = document.cookie.includes(k);
    let idb = false;
    try {
      const dbs = (await indexedDB.databases?.()) ?? [];
      idb = dbs.some((d) => String(d.name).includes(k));
    } catch {}
    return !inDom && !inputs && !stored && !cookies && !idb;
  })()`);

async function openEditor() {
  for (let attempt = 0; attempt < 6; attempt++) {
    await click('nav .nav-item', '作品庫');
    await until(`document.querySelectorAll('.wcard').length > 0`);
    // The 保留雙方 copy is titled "…（我的修改）": pick the original, never the copy.
    await p.evaluate(`(() => {
      const card = [...document.querySelectorAll('.wcard')].find(
        (e) => e.textContent.includes('M3 驗收') && !e.textContent.includes('我的修改'),
      );
      card?.click();
    })()`);
    if (await until(`document.querySelector('.editor__title') !== null`, 3000)) break;
  }
  return until(`document.querySelector('.qc-md-editor__content p') !== null`);
}
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
const hunks = () => until(`document.querySelectorAll('.ai__hunk').length > 0`, 15000);
const work = () => api('GET', `/api/v1/works/${seed.workId}`);
const revisionSources = async () =>
  (await api('GET', `/api/v1/works/${seed.workId}/revisions`)).items.map((r) => r.source);
const managedFile = path.join(home, 'library', 'works', seed.workId, 'source.md');

async function typeKey(provider, key) {
  await click(`${row(provider)} .ln .btn`, '新增');
  await until(`document.querySelector('${row(provider)} input[type=password]') !== null`);
  await p.evaluate(`document.querySelector('${row(provider)} input[type=password]').focus()`);
  await p.send('Input.insertText', { text: key });
  await click(`${row(provider)} button[type=submit]`);
  await until(`document.querySelector('${row(provider)} .ai-set__notice') !== null`);
  await click(`${row(provider)} .ai-set__notice .btn`, '我已了解，啟用');
  return until(
    `document.querySelector('${row(provider)} [role=status]')?.textContent.includes('鑰匙圈 · 已啟用')`,
  );
}
const videoJobs = async () =>
  (await api('GET', '/api/v1/ai/jobs?limit=200')).items.filter(
    (j) => j.action === 'video_understanding',
  );
const openVideo = async () => {
  await nav('AI 工作台');
  await until(`document.querySelector('.aiw__empty .btn, .aiw__setup') !== null`);
  if (await p.evaluate(`document.querySelector('.aiw__empty .btn') !== null`)) {
    await click('.aiw__empty .btn', '選擇視頻');
    await until(`document.querySelectorAll('.aiw-pick__item').length === 1`);
    await click('.aiw-pick__item');
  }
  // The button stays disabled until the estimate has loaded.
  await until(`document.querySelector('.aiw__est')?.textContent.includes('估算')`, 15000);
};
const analyze = async (label = '分析') => {
  await click('.aiw__setup .btn--primary', label);
  return until(`document.querySelector('.scrim') !== null`);
};
const waitSucceeded = async (n, timeout = 90000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const jobs = await videoJobs();
    if (jobs.filter((j) => j.status === 'succeeded').length >= n) return true;
    if (Date.now() > end) return false;
    await sleep(200);
  }
};
/** Re-analyse the opened video: reuse dialog -> 重新分析 -> charge confirmation. Resolves at the final dialog. */
const openReanalysis = async () => {
  await analyze('重新分析');
  await until(`document.querySelector('.scrim')?.textContent.includes('已分析過此影片')`);
  await click('.scrim .btn', '重新分析');
  return until(`document.querySelector('.scrim')?.textContent.includes('重新分析會再次計費')`);
};
const waitServer = async () => {
  let down = false;
  for (let i = 0; i < 200; i++) {
    const up = await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) down = true;
    if (up && down) return true;
    await sleep(100);
  }
  return false;
};

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

// =========================================================================================
// 0. Nothing configured: the editor panel and the workbench send nothing.
// =========================================================================================
check('0 start: no AI keys, no AI jobs', (await api('GET', '/api/v1/ai/jobs')).total === 0);
await openEditor();
check(
  '0 editor AI panel says 尚未設定 AI 金鑰 and cannot send',
  await until(
    `document.querySelector('.ai__notice')?.textContent.includes('尚未設定 AI 金鑰') && document.querySelector('.ai__send').disabled`,
  ),
);
await shot('01-no-key');

// =========================================================================================
// 1. Keys and consent through Settings; the keys stay out of the window and the storage.
// =========================================================================================
await nav('設定');
await until(`document.querySelector('.ai-set') !== null`);
check(
  '1 Claude key entered in a password field, notice confirmed',
  await typeKey('anthropic', KEYS.anthropic),
);
check(
  '1 Gemini key entered in a password field, notice confirmed',
  await typeKey('gemini', KEYS.gemini),
);
check('1 the Claude key is nowhere in the window or web storage', await keyNowhere(KEYS.anthropic));
check('1 the Gemini key is nowhere in the window or web storage', await keyNowhere(KEYS.gemini));
const providers = await api('GET', '/api/v1/ai/providers');
check(
  '1 the API reports the keys as stored without returning them',
  providers.items.filter((x) => x.ready).length === 2 &&
    !JSON.stringify(providers).includes(KEYS.anthropic) &&
    !JSON.stringify(providers).includes(KEYS.gemini),
);
await shot('02-settings-ready');

// =========================================================================================
// 2. A rewrite is only a candidate; an outside edit makes accepting a 409; adoption is undoable.
// =========================================================================================
const ORIGINAL = (await work()).markdown;
const baseRevisions = (await revisionSources()).length;
await openEditor();
check(
  '2 the panel uses Claude · 雲端',
  await until(`document.querySelector('.ai__provider')?.textContent.includes('Claude · 雲端')`),
);
await selectFirstParagraph();
await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`);
const REWRITE_A =
  '剛搬進來時，我以為一張大桌子就夠了。真正拖慢剪輯的，是線材、散熱和風扇。這半年，我做了五個取捨。';
await script('anthropic', [{ text: REWRITE_A }]);
await click('.ai__empty .btn', '改寫選取段落');
check('2 a candidate with a diff appears', await hunks());
await shot('03-candidate');
check(
  '2 the candidate is not written: text, file and history are unchanged',
  (await work()).markdown === ORIGINAL &&
    fs.readFileSync(managedFile, 'utf8') === ORIGINAL &&
    (await revisionSources()).length === baseRevisions,
);
check(
  '2 the provider received the real key and only one request',
  (await state()).anthropic.apiKeys.length === 1 &&
    (await state()).anthropic.apiKeys[0] === KEYS.anthropic,
);

// An outside editor saves the file while the candidate is on screen.
const EXT_TEXT = `${ORIGINAL}\nTypora 補了一段。\n`;
fs.writeFileSync(managedFile, EXT_TEXT);
await click('.ai__actions .btn', '採用');
check(
  '2 accepting after the outside edit opens the conflict dialog (409)',
  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('衝突')`, 10000),
);
await shot('04-conflict');
check(
  '2 the outside edit is still on disk and no AI revision was written',
  fs.readFileSync(managedFile, 'utf8') === EXT_TEXT &&
    !(await revisionSources()).includes('ai_accepted'),
);
await click('[role="dialog"] .btn', '保留雙方');
await until(
  `[...document.querySelectorAll('[role="dialog"] .btn')].some((b) => b.textContent.includes('返回編輯'))`,
);
check(
  '2 保留雙方 keeps the AI text as a separate work',
  (await api('GET', '/api/v1/works?limit=20')).items.some((w) => w.title.includes('（我的修改）')),
);
await click('[role="dialog"] .btn', '返回編輯');
await until(`document.querySelector('[role="dialog"]') === null`);
check('2 the original work now shows the outside version', (await work()).markdown === EXT_TEXT);

// Regenerate on the current text, adopt, then undo from history.
await openEditor();
await selectFirstParagraph();
await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`);
await script('anthropic', [{ text: REWRITE_A }]);
await click('.ai__empty .btn', '改寫選取段落');
await hunks();
const beforeAdopt = await work();
await click('.ai__actions .btn', '採用');
check(
  '2 採用 shows 已採用',
  await until(`document.querySelector('.ai__done')?.textContent.includes('已採用')`, 10000),
);
const adopted = await work();
check(
  '2 the adopted text is a new ai_accepted revision, written to the file',
  adopted.markdown !== beforeAdopt.markdown &&
    fs.readFileSync(managedFile, 'utf8') === adopted.markdown &&
    (await revisionSources())[0] === 'ai_accepted',
);
await shot('05-adopted');
await click('.ai__undo');
await until(`document.querySelector('.ai__done') === null`);
const undone = await work();
check(
  '2 復原 restores the text from before as a new revision; every version is kept',
  undone.markdown === beforeAdopt.markdown &&
    (await revisionSources()).slice(0, 4).join() === 'restore,ai_accepted,external,create' &&
    fs.readFileSync(managedFile, 'utf8') === beforeAdopt.markdown,
  (await revisionSources()).join(),
);

// =========================================================================================
// 3. Platform suggestions are candidates until the user writes them.
// =========================================================================================
await click('.ai__tab', '標題');
await until(`document.querySelector('.ai__empty')?.textContent.includes('生成標題候選')`);
await script('anthropic', [
  {
    text: JSON.stringify({
      xiaohongshu: { titles: ['書房改剪輯室，半年後的五個取捨', '剪輯室改造記'] },
      wechat_mp: { titles: ['我把書房改成剪輯室：半年後的五個取捨'] },
      douyin: { titles: ['書房改剪輯室半年復盤'] },
      wechat_channels: { titles: ['書房剪輯室五取捨'] },
    }),
  },
]);
const variantsBefore = (await api('GET', `/api/v1/works/${seed.workId}/variants`)).items.length;
await click('.ai__empty .btn', '生成標題候選');
check(
  '3 title candidates for four platforms appear',
  await until(`document.querySelectorAll('.ai__pl').length === 4`, 15000),
);
check(
  '3 nothing was written: no platform version was created or changed, the work is unchanged',
  (await api('GET', `/api/v1/works/${seed.workId}/variants`)).items.length === variantsBefore &&
    (await work()).markdown === undone.markdown,
);
await shot('06-titles');
await click('.ai__row .btn', '寫入平台版本');
check(
  '3 only the explicit 寫入平台版本 creates the four versions',
  (await until(
    `document.querySelector('.ai__row .chip--ok')?.textContent.includes('已寫入 4 個版本')`,
    10000,
  )) && (await api('GET', `/api/v1/works/${seed.workId}/variants`)).items.length === 4,
);

// =========================================================================================
// 4. Video: straight to Gemini, no duplicate sends, a service crash is survived, result reused.
// =========================================================================================
await openVideo();
await geminiMode({ processingPolls: 40 });
check(
  '4 the workbench estimates before anything is sent',
  await until(`document.querySelector('.aiw__est')?.textContent.includes('估算')`),
);
const sentBefore = (await state()).gemini;
check('4 estimating sent nothing to Gemini', sentBefore.starts === 0 && sentBefore.generates === 0);
check('4 a confirm dialog opens before anything is sent', await analyze());
check(
  '4 …with size, duration and 最多花費 (估算)',
  await p.evaluate(
    `document.querySelector('.scrim')?.textContent.includes('0:56') && document.querySelector('.scrim').textContent.includes('最多花費')`,
  ),
);
await shot('07-confirm');
// A double click in the window, plus three parallel requests as if from a second client.
await p.evaluate(
  `(() => { const b = [...document.querySelectorAll('.scrim .btn--primary')].find((x) => x.textContent.includes('上傳並分析')); b.click(); b.click(); })()`,
);
await Promise.all(
  [1, 2, 3].map(() =>
    api('POST', `/api/v1/assets/${seed.assetId}/ai/video-understanding`, { reanalyze: true }),
  ),
);
check(
  '4 progress is shown',
  await until(`document.querySelector('.aiw__run-label') !== null`, 20000),
);
await until(`document.querySelector('.aiw__run-label')?.textContent.includes('處理影片中')`, 30000);
check(
  '4 exactly one analysis job exists for the video',
  (await videoJobs()).length === 1,
  (await videoJobs()).length,
);
await shot('08-processing');

// The service crashes (SIGKILL) while Gemini is still processing the upload.
fs.writeFileSync(path.join(home, 'restart-request'), '');
check('4 the service went down and came back', await waitServer());
await geminiMode({ processingPolls: 1 });
check(
  '4 after the restart the job runs on and the result appears in the window',
  await until(`document.querySelector('.aiw__done') !== null`, 90000),
);
const afterRestart = await state();
const vjobs = await videoJobs();
check(
  '4 one job, succeeded, analysed and billed once',
  vjobs.length === 1 && vjobs[0].status === 'succeeded' && afterRestart.gemini.generates === 1,
);
check(
  '4 the original file was sent as it is (same bytes), no extra data',
  afterRestart.gemini.lastUploadSha256 === seed.videoSha256 &&
    afterRestart.gemini.lastUploadBytes === seed.videoBytes,
);
check(
  '4 no copy of the video is left at Gemini',
  afterRestart.gemini.liveRemoteFiles === 0,
  JSON.stringify(afterRestart.gemini),
);
await until(`document.querySelectorAll('.aiw__chap').length > 0`);
check(
  '4 the result is marked 待核驗 with a disclaimer; a time point past the end is flagged',
  (await text('.aiw__done-head')).includes('待核驗') &&
    (await text('.aiw__disclaimer')).length > 0 &&
    (await p.evaluate(
      `[...document.querySelectorAll('.aiw__chap')].some((c) => c.textContent.includes('超出片長'))`,
    )),
);
await shot('09-result');
const usage1 = (await api('GET', '/api/v1/ai/usage')).by_provider.find(
  (x) => x.provider === 'gemini',
);
check(
  '4 usage counts one Gemini job with a cost',
  usage1?.jobs === 1 && usage1.cost_usd > 0,
  JSON.stringify(usage1),
);

// Reuse is free; re-analysing is deliberate and billed.
await nav('設定');
await openVideo();
check(
  '4 opening the analysed video shows its stored result at once',
  await until(`document.querySelector('.aiw__done') !== null`),
);
const startsBeforeReuse = (await state()).gemini.starts;
await click('.aiw__setup .btn--primary', '重新分析');
await until(`document.querySelector('.scrim')?.textContent.includes('已分析過此影片')`);
await click('.scrim .btn', '沿用結果');
await until(`document.querySelector('.scrim') === null`);
check(
  '4 沿用結果 sends nothing and costs nothing',
  (await videoJobs()).length === 1 &&
    (await state()).gemini.starts === startsBeforeReuse &&
    (await api('GET', '/api/v1/ai/usage')).by_provider.find((x) => x.provider === 'gemini').jobs ===
      1,
);
check('4 重新分析 asks again about the charge', await openReanalysis());
await shot('10-reanalyze-confirm');
await click('.scrim .btn--primary', '上傳並分析');
await waitSucceeded(2);
await sleep(300);
const jobsAfter = await videoJobs();
check(
  '4 only the deliberate 重新分析 made a second job, and it was billed',
  jobsAfter.filter((j) => j.status === 'succeeded').length === 2 &&
    (await api('GET', '/api/v1/ai/usage')).by_provider.find((x) => x.provider === 'gemini').jobs ===
      2,
);

// =========================================================================================
// 5. Failure reasons, retry and cancel are visible.
// =========================================================================================
await geminiMode({ generate429: 3 });
await openReanalysis();
await click('.scrim .btn--primary', '上傳並分析');
check(
  '5 Gemini 429 that does not clear: 分析失敗 · 請求太頻繁（429） with 重試 and 查看上次結果',
  await until(
    `(() => { const f = document.querySelector('.aiw__failed'); return f && f.textContent.includes('請求太頻繁（429）') && f.textContent.includes('重試') && f.textContent.includes('查看上次結果'); })()`,
    60000,
  ),
  await text('.aiw__failed'),
);
const failedJob = (await videoJobs()).find((j) => j.status === 'failed');
check(
  '5 the failed job records the code and 3 attempts',
  failedJob?.error_code === 'rate_limited' && failedJob.attempts === 3,
  JSON.stringify([failedJob?.error_code, failedJob?.attempts]),
);
await shot('11-failed-429');
await click('.aiw__failed .btn', '重試');
check(
  '5 重試 runs the same job again and succeeds',
  (await waitSucceeded(3)) &&
    (await until(
      `document.querySelector('.aiw__done') !== null && document.querySelector('.aiw__failed') === null`,
      20000,
    )),
);

await geminiMode({ processingPolls: 1000 });
await openReanalysis();
await click('.scrim .btn--primary', '上傳並分析');
await until(`document.querySelector('.aiw__run-label')?.textContent.includes('處理影片中')`, 30000);
await click('.aiw__run .btn', '取消');
const cancelledJob = await (async () => {
  for (let i = 0; i < 80; i++) {
    const j = (await videoJobs()).find((x) => x.status === 'cancelled');
    if (j) return j;
    await sleep(100);
  }
  return null;
})();
check('5 取消 cancels the analysis', cancelledJob !== null);
let live = -1;
for (let i = 0; i < 80; i++) {
  live = (await state()).gemini.liveRemoteFiles;
  if (live === 0) break;
  await sleep(100);
}
check('5 …and the uploaded copy at Gemini is deleted', live === 0);
await geminiMode({ processingPolls: 1 });

// Text failures in the editor panel.
await openEditor();
await selectFirstParagraph();
await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`);
await script('anthropic', [
  { status: 429, message: 'rate limit' },
  { status: 429, message: 'rate limit' },
  { status: 429, message: 'rate limit' },
]);
await click('.ai__empty .btn', '改寫選取段落');
check(
  '5 Claude 429 that does not clear: 生成失敗 · 請求太頻繁（429） with 重試',
  await until(
    `document.querySelector('.ai__failed')?.textContent.includes('請求太頻繁（429）')`,
    30000,
  ),
  await text('.ai__failed'),
);
await script('anthropic', [{ text: REWRITE_A }]);
await click('.ai__failed .btn', '重試');
check('5 重試 produces a candidate', await hunks());
// Escape discards the candidate only while focus is inside the panel.
await p.evaluate(`document.querySelectorAll('.ai__hunk input')[0].focus()`);
await p.key('Escape', 'Escape', 27);
await until(`document.querySelector('.ai__empty') !== null`);

await script('anthropic', [{ status: 401, message: `invalid x-api-key: ${KEYS.anthropic}` }]);
await click('.ai__empty .btn', '改寫選取段落');
check(
  '5 an invalid key (the provider even echoes it): 生成失敗 · 金鑰無效, not retried',
  await until(`document.querySelector('.ai__failed')?.textContent.includes('金鑰無效')`, 20000),
);
await shot('12-failed-key');
const keyFailed = (await api('GET', '/api/v1/ai/jobs?limit=50')).items.find(
  (j) => j.error_code === 'invalid_key',
);
check(
  '5 the stored error and the window do not contain the key',
  keyFailed?.attempts === 1 &&
    !JSON.stringify(keyFailed).includes(KEYS.anthropic) &&
    (await keyNowhere(KEYS.anthropic)),
);

// =========================================================================================
// 6. Withdrawing consent stops everything before it is sent.
// =========================================================================================
await nav('設定');
await until(`document.querySelector('.ai-set') !== null`);
const sentText = (await state()).anthropic.requests;
const sentVideo = (await state()).gemini.generates;
for (const provider of ['anthropic', 'gemini']) {
  await click(`${row(provider)} .btn`, '撤回確認');
  await until(`document.querySelector('.scrim') !== null`);
  await click('.scrim .btn', '撤回');
  await until(
    `document.querySelector('${row(provider)} [role=status]')?.textContent.includes('待確認告知')`,
  );
}
await openEditor();
check(
  '6 after withdrawing, the editor panel asks for the notice again and cannot send',
  await until(
    `document.querySelector('.ai__notice')?.textContent.includes('尚未確認雲端 AI 使用告知') && document.querySelector('.ai__send').disabled`,
  ),
);
await shot('13-consent-withdrawn');
await openVideo();
const refused = await api('POST', `/api/v1/assets/${seed.assetId}/ai/video-understanding`, {
  reanalyze: true,
});
check(
  '6 the API answers 409 ai_consent_required for a new analysis',
  refused?.error?.code === 'ai_consent_required',
  JSON.stringify(refused?.error),
);
check(
  '6 nothing was sent while consent was withdrawn',
  (await state()).anthropic.requests === sentText && (await state()).gemini.generates === sentVideo,
);
await nav('設定');
for (const provider of ['anthropic', 'gemini']) {
  await click(`${row(provider)} .ai-set__notice .btn`, '我已了解，啟用');
  await until(
    `document.querySelector('${row(provider)} [role=status]')?.textContent.includes('鑰匙圈 · 已啟用')`,
  );
}

// =========================================================================================
// 7. The monthly reminder only reminds.
// =========================================================================================
await p.evaluate(`document.querySelector('#ai-budget').focus()`);
await p.send('Input.insertText', { text: '0.001' });
await click('.ai-budget button[type=submit]');
await until(`document.querySelector('.ai-budget')?.textContent.includes('超過 $0.001 時提醒')`);
await openVideo();
const reachedFinal = await openReanalysis();
const dialogText = await p.evaluate(
  `document.querySelector('.scrim')?.textContent.slice(0, 200) ?? '(no dialog)'`,
);
check(
  '7 over the reminder the dialog warns',
  reachedFinal && (await p.evaluate(`document.querySelector('.scrim .aiw__over') !== null`)),
  dialogText,
);
await shot('14-over-reminder');
const jobsBeforeReminder = (await videoJobs()).filter((j) => j.status === 'succeeded').length;
await click('.scrim .btn--primary', '上傳並分析');
check('7 …but the analysis still runs and succeeds', await waitSucceeded(jobsBeforeReminder + 1));
check(
  '7 the usage card shows the over-reminder notice',
  await until(`document.querySelector('.aiw__usage .aiw__over') !== null`),
);

// =========================================================================================
// 8. Secrets and traffic: window, storage, requests, service log, data directory.
// =========================================================================================
for (const [provider, key] of Object.entries(KEYS)) {
  check(
    `8 the ${provider} key is nowhere in the window, inputs, web storage, IndexedDB or cookies`,
    await keyNowhere(key),
  );
}
const resources = await p.evaluate(`performance.getEntriesByType('resource').map((e) => e.name)`);
const hosts = new Set(
  resources.map((u) => {
    try {
      return new URL(u).host || new URL(u).protocol;
    } catch {
      return u;
    }
  }),
);
const foreign = [...hosts].filter(
  (h) =>
    !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) &&
    !/^(qc-asset|data|blob|devtools|file):?$/.test(h),
);
check(
  '8 the window made no request to any non-local host',
  foreign.length === 0,
  foreign.join(','),
);
const log = fs.readFileSync(serverLog, 'utf8');
check(
  '8 the service log has the request lines (it was really on)',
  log.includes('"method":"POST"') || log.includes('incoming request'),
  `${log.length} bytes`,
);
for (const [provider, key] of Object.entries(KEYS)) {
  check(`8 the ${provider} key is not in the service log`, !log.includes(key));
}
check(
  '8 no work text, prompt or AI output is in the service log',
  !log.includes('剛搬進來時') &&
    !log.includes('Typora 補了一段') &&
    !log.includes('五個取捨') &&
    !log.includes('三款濾杯'),
);
let leaked = '';
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name !== 'server.log' && e.name !== 'electron.log' && e.name !== 'fakes.log') {
      const b = fs.readFileSync(f);
      for (const key of Object.values(KEYS)) if (b.includes(key)) leaked += `${f} `;
    }
  }
};
walk(home);
check(
  '8 no key is in any file of the data directory (database, WAL, library, cache)',
  leaked === '',
  leaked,
);
const dbText = JSON.stringify((await api('GET', '/api/v1/ai/jobs?limit=200')).items);
check('8 no stored AI job contains a key', !Object.values(KEYS).some((k) => dbText.includes(k)));

fs.writeFileSync(
  path.join(out, 'qc026-verify-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
p.close();
process.exit(failed.length === 0 ? 0 : 1);
