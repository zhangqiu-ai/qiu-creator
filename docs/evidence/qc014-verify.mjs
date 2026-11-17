// QC-014 acceptance driver: three parties change the same work and the same platform
// version, in the real Electron window (CDP), a real mac-server (FSEvents watcher) and
// the files on disk.
//   APP   the Electron window        EXT   an external editor writing the .md file
//   AGENT a write-scoped agent token (with and without preconditions)
// Run through qc014-run.sh (it takes the e2e lock, starts everything and cleans up).
// Usage: CREATORHUB_HOME=<temp home> QC014_MOUNT_DIR=<temp folder> node docs/evidence/qc014-verify.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const mountDir = process.env.QC014_MOUNT_DIR;
const [out] = process.argv.slice(2);
if (!home || !mountDir || !out || !path.basename(home).startsWith('qc014-home')) {
  throw new Error('run through docs/evidence/qc014-run.sh');
}
const base = 'http://127.0.0.1:7420';
const seed = JSON.parse(fs.readFileSync(path.join(home, 'qc014-seed.json'), 'utf8'));
const ownerToken = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();

/** One HTTP call; never throws on 4xx so the status itself can be asserted. */
async function call(token, method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: res.status,
    json,
    code: json?.error?.code,
    current: json?.error?.details?.current_revision,
  };
}
const app = (method, url, body, headers) => call(ownerToken, method, url, body, headers);
const agent = (method, url, body, headers) => call(seed.agentToken, method, url, body, headers);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const shot = (name) => p.screenshot(path.join(out, `qc014-${name}.png`));
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
// The conflict dialog disables 保留雙方 / 手動合併 until it has loaded the server's version;
// a click before that does nothing. Wait for an enabled button, then click it.
const clickEnabled = async (selector, text, timeout = 10000) => {
  const ready = await until(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled)`,
    timeout,
  );
  return ready && (await click(selector, text));
};
const openWork = async (title) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    await click('nav .nav-item', '作品庫');
    await until(`document.querySelectorAll('.wcard, .tbl__open').length > 0`);
    await click('.wcard, .tbl__open', title);
    if (
      await until(
        `document.querySelector('.editor__title')?.value === ${JSON.stringify(title)}`,
        3000,
      )
    ) {
      await until(`document.querySelector('.editor__doc [contenteditable]') !== null`);
      return;
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
const workOf = async (id) => (await app('GET', `/api/v1/works/${id}`)).json;
const history = async (id) => {
  const list = (await app('GET', `/api/v1/works/${id}/revisions`)).json.items;
  const out = [];
  for (const rev of list) {
    const d = (await app('GET', `/api/v1/works/${id}/revisions/${rev.revision_id}`)).json;
    out.push({ source: rev.source, markdown: d.markdown });
  }
  return out; // newest first
};
const dialogOpen = () =>
  until(`document.querySelector('[role=dialog]')?.textContent.includes('衝突')`, 10000);
const waitUntilMarkdown = async (id, pred, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const w = await workOf(id);
    if (pred(w)) return w;
    if (Date.now() > end) return w;
    await sleep(200);
  }
};

const managedFile = path.join(home, 'library', 'works', seed.managedId, 'source.md');
const mountedFile = path.join(mountDir, 'ext-note.md');
const MANAGED = 'M2 驗收 托管';
const MOUNTED = 'M2 驗收 外部掛載';

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

// ===================================================================================
// A. Managed work: EXT edits the file, then APP saves
// ===================================================================================
await openWork(MANAGED);
const m0 = await workOf(seed.managedId);
const EXT_TEXT = '# M2 驗收 托管\n\nTypora 改過這一段。\n';
fs.writeFileSync(managedFile, EXT_TEXT);
await focusEditorEnd();
await p.send('Input.insertText', { text: '我的修改A' });
check('A1 APP autosaves after an outside edit: 409 opens the conflict dialog', await dialogOpen());
await shot('01-managed-conflict');
check(
  'A1 the outside edit is still on disk (not overwritten)',
  fs.readFileSync(managedFile, 'utf8') === EXT_TEXT,
);
const afterConflict = await workOf(seed.managedId);
check(
  'A1 the server recorded the outside edit as an external revision, my text was not written',
  afterConflict.markdown === EXT_TEXT &&
    afterConflict.current_revision_id !== m0.current_revision_id &&
    (await history(seed.managedId))[0].source === 'external' &&
    !(await history(seed.managedId)).some((h) => h.markdown.includes('我的修改A')),
);
check(
  'A1 the 保留雙方 button was clickable',
  await clickEnabled('[role=dialog] button', '保留雙方'),
);
await until(
  `[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.includes('返回編輯'))`,
);
await clickEnabled('[role=dialog] button', '返回編輯');
const copies = (await app('GET', '/api/v1/works?limit=50')).json.items.filter(
  (w) => w.title === `${MANAGED}（我的修改）`,
);
check(
  'A1 保留雙方 keeps my text as a separate work and the original shows the outside version',
  copies.length === 1 &&
    (await workOf(copies[0].id)).markdown.includes('我的修改A') &&
    (await workOf(seed.managedId)).markdown === EXT_TEXT &&
    (await until(
      `document.querySelector('.editor__doc [contenteditable]')?.textContent.includes('Typora 改過這一段')`,
    )),
);

// ---- AGENT preconditions on the managed work ----
const cur = (await workOf(seed.managedId)).current_revision_id;
check(
  'A2 AGENT without base_revision/If-Match: 428, nothing changes',
  (await agent('PATCH', `/api/v1/works/${seed.managedId}`, { markdown: 'blind' })).status === 428 &&
    (await workOf(seed.managedId)).current_revision_id === cur,
);
{
  const stale = await agent('PATCH', `/api/v1/works/${seed.managedId}`, {
    base_revision: m0.current_revision_id,
    markdown: 'stale',
  });
  check(
    'A2 stale base_revision: 409 and current_revision given',
    stale.status === 409 && stale.current === cur,
  );
  const staleHdr = await agent(
    'PATCH',
    `/api/v1/works/${seed.managedId}`,
    { markdown: 'stale' },
    { 'if-match': `"${m0.current_revision_id}"` },
  );
  check('A2 stale If-Match: 409', staleHdr.status === 409);
  const wild = await agent(
    'PATCH',
    `/api/v1/works/${seed.managedId}`,
    { markdown: 'wild' },
    { 'if-match': '*' },
  );
  check('A2 If-Match * is refused', wild.status >= 400);
}
const AGENT_TEXT = '# M2 驗收 托管\n\nAGENT 改的段落。\n';
check(
  'A2 AGENT with the fresh base: 200',
  (
    await agent('PATCH', `/api/v1/works/${seed.managedId}`, {
      base_revision: cur,
      markdown: AGENT_TEXT,
    })
  ).status === 200,
);
check(
  'A2 a clean window shows the agent change live, without a notice',
  (await until(
    `document.querySelector('.editor__doc [contenteditable]')?.textContent.includes('AGENT 改的段落')`,
    10000,
  )) && (await p.evaluate(`document.querySelector('.banner--warn') === null`)),
);

// ---- dirty window + AGENT save: a notice, never a silent overwrite ----
await focusEditorEnd();
await p.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
const A3_TEXT = '# M2 驗收 托管\n\nAGENT 第二次。\n';
await agent('PATCH', `/api/v1/works/${seed.managedId}`, {
  base_revision: (await workOf(seed.managedId)).current_revision_id,
  markdown: A3_TEXT,
});
check(
  'A3 AGENT saves while the window has unsaved typing: the window shows the external-change notice',
  await until(
    `document.querySelector('.banner--warn')?.textContent.includes('檔案已在外部修改')`,
    10000,
  ),
);
await p.send('Input.insertText', { text: '中' });
check(
  'A3 my typing is kept in the window and the agent version is what is stored',
  (await editorText()).includes('中') && (await workOf(seed.managedId)).markdown === A3_TEXT,
);
await shot('02-managed-agent-notice');
await click('.banner--warn .btn', '捨棄我的修改並重新載入');
check(
  'A3 捨棄我的修改並重新載入 shows the agent version',
  await until(
    `document.querySelector('.editor__doc [contenteditable]')?.textContent.includes('AGENT 第二次')`,
  ),
);

// ===================================================================================
// B. Mounted external file (real FSEvents watcher)
// ===================================================================================
await openWork(MOUNTED);
const n0 = await workOf(seed.mountedId);
const N_EXT1 = '# M2 驗收 外部掛載\n\nVS Code 改過。\n';
fs.writeFileSync(mountedFile, N_EXT1);
const n1 = await waitUntilMarkdown(seed.mountedId, (w) => w.markdown === N_EXT1);
check(
  'B1 outside edit of the mounted file becomes an external revision',
  n1.markdown === N_EXT1 && (await history(seed.mountedId))[0].source === 'external',
);
check(
  'B1 a clean window shows it live, without a notice',
  (await until(
    `document.querySelector('.editor__doc [contenteditable]')?.textContent.includes('VS Code 改過')`,
    15000,
  )) && (await p.evaluate(`document.querySelector('.banner--warn') === null`)),
);

await focusEditorEnd();
await p.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
const N_EXT2 = '# M2 驗收 外部掛載\n\nVS Code 第二次改。\n';
fs.writeFileSync(mountedFile, N_EXT2);
check(
  'B2 outside edit while the window has unsaved typing: notice, no silent reload',
  await until(
    `document.querySelector('.banner--warn')?.textContent.includes('檔案已在外部修改')`,
    20000,
  ),
);
await p.send('Input.insertText', { text: '我的N' });
check('B2 the file on disk is not overwritten', fs.readFileSync(mountedFile, 'utf8') === N_EXT2);
await shot('03-mounted-external-notice');
await click('.banner--warn .btn', '比對並合併');
check('B2 比對並合併 opens the conflict dialog', await dialogOpen());
check(
  'B2 the 保留雙方 button was clickable',
  await clickEnabled('[role=dialog] button', '保留雙方'),
);
await until(
  `[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.includes('返回編輯'))`,
);
await clickEnabled('[role=dialog] button', '返回編輯');
const nCopies = (await app('GET', '/api/v1/works?limit=50')).json.items.filter(
  (w) => w.title === `${MOUNTED}（我的修改）`,
);
const nCopyMarkdown = nCopies.length === 1 ? (await workOf(nCopies[0].id)).markdown : null;
check(
  'B2 保留雙方: my text is a separate work, the mounted file keeps the outside version',
  nCopies.length === 1 &&
    nCopyMarkdown.includes('我的N') &&
    fs.readFileSync(mountedFile, 'utf8') === N_EXT2,
  JSON.stringify({
    copies: nCopies.length,
    copyMarkdown: nCopyMarkdown,
    titles: (await app('GET', '/api/v1/works?limit=50')).json.items.map((w) => w.title),
    file: fs.readFileSync(mountedFile, 'utf8'),
  }),
);
const nCur = (await workOf(seed.mountedId)).current_revision_id;
check(
  'B3 AGENT without a precondition on the mounted work: 428',
  (await agent('PATCH', `/api/v1/works/${seed.mountedId}`, { markdown: 'blind' })).status === 428,
);
check(
  'B3 AGENT with a stale base_revision: 409',
  (
    await agent('PATCH', `/api/v1/works/${seed.mountedId}`, {
      base_revision: n0.current_revision_id,
      markdown: 'stale',
    })
  ).status === 409 && fs.readFileSync(mountedFile, 'utf8') === N_EXT2,
);
const N_AGENT = '# M2 驗收 外部掛載\n\nAGENT 改了外部檔。\n';
check(
  'B3 AGENT with the fresh base: 200, and the file in the folder is updated atomically',
  (
    await agent('PATCH', `/api/v1/works/${seed.mountedId}`, {
      base_revision: nCur,
      markdown: N_AGENT,
    })
  ).status === 200 && fs.readFileSync(mountedFile, 'utf8') === N_AGENT,
);
const nHist = await history(seed.mountedId);
check(
  'B3 every version is still in history (original, both outside edits, agent)',
  [n0.markdown, N_EXT1, N_EXT2, N_AGENT].every((t) => nHist.some((h) => h.markdown === t)),
);

// ---- the file disappears ----
fs.rmSync(mountedFile);
check(
  'B4 file removed outside: the window turns read-only with the original path',
  await until(
    `document.querySelector('.banner--bad')?.textContent.includes('找不到原檔，唯讀')`,
    20000,
  ),
);
await shot('04-mounted-missing');
const gone = await agent('PATCH', `/api/v1/works/${seed.mountedId}`, {
  base_revision: (await workOf(seed.mountedId)).current_revision_id,
  markdown: 'zombie',
});
check(
  'B4 AGENT write is refused (409 source_missing) and the file is not recreated',
  gone.status === 409 && gone.code === 'source_missing' && !fs.existsSync(mountedFile),
);
fs.writeFileSync(mountedFile, N_AGENT);
check(
  'B4 file put back: editable again, nothing was lost',
  (await until(
    `document.querySelector('.banner--bad') === null && document.querySelector('.editor__doc [contenteditable]')?.getAttribute('contenteditable') === 'true'`,
    20000,
  )) && (await workOf(seed.mountedId)).markdown === N_AGENT,
);

// ===================================================================================
// C. Platform versions: four platforms independent, three parties on one platform
// ===================================================================================
const PLATFORMS = ['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels'];
const NAMES = {
  xiaohongshu: '小紅書',
  wechat_mp: '公眾號',
  douyin: '抖音',
  wechat_channels: '視頻號',
};
const original = (await workOf(seed.managedId)).markdown;
check(
  'C0 AGENT creates the four platform drafts from the original (write scope)',
  (await agent('POST', `/api/v1/works/${seed.managedId}/variants`, {})).status === 200 ||
    (await app('GET', `/api/v1/works/${seed.managedId}/variants`)).json.items.length === 4,
);
const variant = async (platform) =>
  (await app('GET', `/api/v1/works/${seed.managedId}/variants/${platform}`)).json;
const waitVariant = async (platform, pred) => {
  for (let i = 0; i < 80; i++) {
    const v = await variant(platform);
    if (pred(v)) return v;
    await sleep(100);
  }
  return variant(platform);
};

await openWork(MANAGED);
await click('.editor__actions .btn', '預覽');
await until(`document.querySelector('.pv__work') !== null`);
const tab = async (name) => {
  await click('.pv-tab', name);
  return until(
    `document.querySelector('.pv__title')?.textContent === ${JSON.stringify(`${name}版本`)}`,
  );
};
const setField = async (selector, value) => {
  await p.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); })()`,
  );
  await p.key('a', 'KeyA', 65, 4);
  await p.send('Input.insertText', { text: value });
};

let allSim = true;
for (const platform of PLATFORMS) {
  await tab(NAMES[platform]);
  const sim = await until(
    `document.querySelector('.pp-sim')?.textContent === '模擬' && document.body.textContent.includes('版面為模擬')`,
  );
  if (!sim) allSim = false;
}
check('C1 every platform preview is labelled 模擬 (badge and footer text)', allSim);

const edits = {
  xiaohongshu: ['M2 小紅書標題', 'M2 小紅書正文'],
  wechat_mp: ['M2 公眾號標題', '# M2 公眾號\n\nM2 公眾號正文'],
  douyin: ['M2 抖音', 'M2 抖音描述'],
  wechat_channels: ['M2 視頻號', 'M2 視頻號描述'],
};
for (const platform of PLATFORMS) {
  const [title, body] = edits[platform];
  await tab(NAMES[platform]);
  await setField('#pv-title', title);
  await setField('#pv-body', body);
  await sleep(1200);
}
let independent = true;
for (const platform of PLATFORMS) {
  const [title, body] = edits[platform];
  const v = await waitVariant(platform, (x) => x.title === title && x.body === body);
  if (v.title !== title || v.body !== body) independent = false;
}
check('C2 each platform keeps its own title and body (no cross-writes)', independent);

await tab('抖音');
await until(`document.querySelectorAll('.pv-thumbs .pv-thumb').length > 0`);
const dyIds = (await variant('douyin')).image_asset_ids;
if (dyIds.length >= 2) {
  await p.evaluate(
    `[...document.querySelectorAll('.pv-thumbs')][0].querySelectorAll('button.pv-thumb')[1].click()`,
  );
  await click('.pv-imgbar .btn', '設為封面');
}
const dy = await waitVariant(
  'douyin',
  (v) => dyIds.length >= 2 && v.cover_asset_id === v.image_asset_ids[1],
);
const before = await Promise.all(PLATFORMS.map(variant));
check(
  'C3 setting the 抖音 cover changes only 抖音',
  dyIds.length >= 2 &&
    dy.cover_asset_id === dy.image_asset_ids[1] &&
    before
      .filter((v) => v.platform !== 'douyin')
      .every((v) => v.cover_asset_id !== dy.cover_asset_id || v.image_asset_ids.length === 0),
);
check(
  'C3 the original was not changed by any platform edit',
  (await workOf(seed.managedId)).markdown === original,
);
await shot('05-four-platforms-douyin');

// ---- three parties on 小紅書 ----
await tab('小紅書');
const x0 = await variant('xiaohongshu');
await p.evaluate(`document.querySelector('#pv-title').focus()`);
await p.send('Input.insertText', { text: '・我的' });
await p.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
const aTitle = 'AGENT 改的小紅書標題';
check(
  'C4 AGENT edits 小紅書 with its fresh revision: 200',
  (
    await agent('PATCH', `/api/v1/works/${seed.managedId}/variants/xiaohongshu`, {
      base_revision: x0.revision,
      title: aTitle,
    })
  ).status === 200,
);
// EXT edits the original at the same time; the other three platforms must not move.
const beforeOthers = await Promise.all(['wechat_mp', 'douyin', 'wechat_channels'].map(variant));
fs.writeFileSync(managedFile, '# M2 驗收 托管\n\nTypora 又改了原稿。\n');
await agent('GET', `/api/v1/works/${seed.managedId}`); // reconcile
await sleep(800);
const afterOthers = await Promise.all(['wechat_mp', 'douyin', 'wechat_channels'].map(variant));
check(
  'C4 an outside edit of the original does not touch any platform version',
  JSON.stringify(beforeOthers.map((v) => [v.revision, v.title, v.body])) ===
    JSON.stringify(afterOthers.map((v) => [v.revision, v.title, v.body])),
);
check(
  'C4 APP with unsaved typing sees the conflict notice; AGENT version is what is stored',
  (await until(
    `document.querySelector('.pv-banner')?.textContent.includes('小紅書版本已在其他地方更新')`,
    10000,
  )) && (await variant('xiaohongshu')).title === aTitle,
);
await p.send('Input.insertText', { text: '' });
await shot('06-variant-conflict');
await click('.pv-banner .btn', '以我的修改覆蓋');
const mine = await waitVariant('xiaohongshu', (v) => v.title.endsWith('・我的'));
check(
  'C4 以我的修改覆蓋 writes mine on top of the latest revision; the agent version stays in history',
  mine.revision === x0.revision + 2 &&
    (
      await app('GET', `/api/v1/works/${seed.managedId}/variants/xiaohongshu/revisions`)
    ).json.items.some((r) => r.title === aTitle),
);
check(
  'C4 AGENT from the old revision: 409 with the current revision; without any base: 428',
  (
    await agent('PATCH', `/api/v1/works/${seed.managedId}/variants/xiaohongshu`, {
      base_revision: x0.revision,
      title: 'stale',
    })
  ).status === 409 &&
    (
      await agent('PATCH', `/api/v1/works/${seed.managedId}/variants/xiaohongshu`, {
        title: 'blind',
      })
    ).status === 428,
);

fs.writeFileSync(
  path.join(out, 'qc014-verify-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
p.close();
process.exit(failed.length === 0 ? 0 : 1);
