// QC-027 check in the real Electron window over CDP: the conflict dialog after
// an AI accept that hit 409 must show the candidate's base and the server's
// newer revision, not the same number twice.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc027-verify.mjs <out-dir>
// Requires qc024-server.mjs on 7420 (fake AI provider, in-memory keys), seeded
// with qc024-seed.mjs, and the Electron dev window on CDP port 9333.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const [out] = process.argv.slice(2);
if (!home || !out || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc027-verify.mjs <out-dir>');
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
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

await api('PUT', '/api/v1/ai/providers/anthropic/key', { api_key: 'sk-ant-fake-qc027-0000000000' });
await api('POST', '/api/v1/ai/providers/anthropic/consent', { notice_version: 1 });
const work = (await api('GET', '/api/v1/works?limit=10')).items[0];

await p.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await p.evaluate('location.reload()');
await sleep(1500);
for (let attempt = 0; attempt < 5; attempt++) {
  await click('nav .nav-item', '作品庫');
  await until(`document.querySelectorAll('.wcard').length > 0`);
  await click('.wcard', '書房');
  if (await until(`document.querySelector('.qc-md-editor__content p') !== null`, 3000)) break;
}

// A candidate for the first paragraph, written from r1.
await p.evaluate(`(() => {
  const para = document.querySelector('.qc-md-editor__content > p');
  const node = document.createTreeWalker(para, NodeFilter.SHOW_TEXT).nextNode();
  const r = document.createRange();
  r.setStart(node, 3);
  r.setEnd(node, 10);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
})()`);
await until(`document.querySelector('.ai__sel')?.textContent.includes('第 2 段')`);
await click('.ai__empty .btn', '改寫選取段落');
check('candidate shown', await until(`document.querySelectorAll('.ai__hunk').length > 0`, 10000));

// Another writer makes r2; this window has nothing unsaved, so it adopts r2 silently.
const before = await api('GET', `/api/v1/works/${work.id}`);
await api('PATCH', `/api/v1/works/${work.id}`, {
  base_revision: before.current_revision_id,
  markdown: `${before.markdown}\n另一個視窗加的段落。\n`,
});
check(
  'the outside edit is shown in the editor (adopted silently)',
  await until(
    `document.querySelector('.qc-md-editor__content')?.textContent.includes('另一個視窗加的段落')`,
  ),
);

await click('.ai__actions .btn', '採用');
check(
  '採用 opens the conflict dialog',
  await until(`document.querySelector('[role="dialog"]') !== null`),
);
await until(`document.querySelector('[role="dialog"]')?.textContent.includes('伺服器已是 r2')`);
const banner = await text('[role="dialog"]');
check(
  'the dialog says the candidate was based on r1 and the server is at r2',
  banner.includes('你的修改基於 r1，伺服器已是 r2'),
  /你的修改基於[^，]*，伺服器已是 \S+/.exec(banner)?.[0] ?? '',
);
await sleep(300);
await p.screenshot(path.join(out, 'qc027-01-ai-conflict-revisions.png'));

fs.writeFileSync(path.join(out, 'qc027-verify-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
p.close();
process.exit(failed === 0 ? 0 : 1);
