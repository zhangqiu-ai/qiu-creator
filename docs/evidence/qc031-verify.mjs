// QC-031 check in the real built Electron window (qc-app://) over CDP, against
// the real QC-030 service on a non-default port.
// Usage: CREATORHUB_HOME=<temp home> CREATORHUB_PORT=7555 \
//   node docs/evidence/qc031-verify.mjs <out-dir> <phase>
// phase `a` (service started with QC031_RELOAD=in_process): settings, back up
//   now, SSE, integrity failed, restore round trip, refusals, CSP and images,
//   dark and narrow.
// phase `b` (service restarted with QC031_RELOAD=restart and the backups
//   folder read-only): daily failure (last_error), restart_required, 503
//   restoring from the editor; the runner then restarts the service in place.
// phase `c` (service back, pending restore applied on start): the app leaves
//   還原中 by itself and refetches.
import fs from 'node:fs';
import path from 'node:path';
import { connectPage, sleep } from './qc002-cdp.mjs';

const home = process.env.CREATORHUB_HOME;
const port = process.env.CREATORHUB_PORT ?? '7420';
const [out, phase] = process.argv.slice(2);
if (!home || !out || !phase || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp> node qc031-verify.mjs <out-dir> <a|b|c>');
}
fs.mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${port}`;
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const backupsDir = path.join(home, 'backups');

const resultsFile = path.join(out, 'qc031-verify-results.json');
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
function check(name, ok, detail = '') {
  results.push({ phase, name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const p = await connectPage(9333);
const until = async (expr, timeout = 10_000) => {
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
  p.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent).join(' | ')`,
  );
const nav = (name) => click('nav .nav-item', name);
/** Click the innermost element whose text includes `label` (e.g. a work card's title). */
const clickText = (label) =>
  p.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const all = [...document.querySelectorAll('main *')].filter((e) => e.textContent.includes(label));
    const el = all.find((e) => ![...e.children].some((c) => c.textContent.includes(label)));
    if (!el) return false;
    el.click();
    return true;
  })()`);
const reload = async () => {
  await p.evaluate('window.__qc031 = 1');
  await p.send('Page.reload', { ignoreCache: true });
  await until(`window.__qc031 === undefined && document.readyState === 'complete'`, 15_000);
  await sleep(1500);
};
const shot = (name) => p.screenshot(path.join(out, `qc031-${name}.png`));
const scrollTo = (selector) =>
  p.evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`,
  );
const backupSection = '[aria-labelledby="set-backup"]';
const rows = () => p.evaluate(`document.querySelectorAll('.backup__row').length`);
const media = async (scheme, width = 1440, height = 900) => {
  await p.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await p.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
};
const openSettings = async () => {
  await nav('設定');
  await until(`document.querySelector('${backupSection} .backup__row, .backup__empty') !== null`);
  await scrollTo(backupSection);
  await sleep(300);
};
const listBackups = async () => (await api('GET', '/api/v1/backups')).body.backups;
/** Click 還原 on the row whose time matches the backup (rows are newest first, as the API). */
async function clickRestoreFor(id) {
  await click('.ln--more button', '顯示全部');
  await sleep(200);
  const all = await listBackups();
  const index = all.findIndex((b) => b.id === id);
  return p.evaluate(`(() => {
    const row = document.querySelectorAll('.backup__row')[${index}];
    const btn = row?.querySelector('button');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
}

if (phase === 'a') {
  await media('light');
  await reload();
  check(
    'renderer is served from qc-app://',
    (await p.evaluate('location.href')).startsWith('qc-app://renderer/'),
  );

  // 1. Settings: version, the daily backup made 3 s after start, schedule, folder.
  await openSettings();
  await until(`document.querySelectorAll('.backup__row').length >= 1`, 15_000);
  const service = await text('[aria-labelledby="set-service"] .ln');
  check('version line shows source run', service.includes('從原始碼執行'), service);
  const card = await text(`${backupSection} .card .ln`);
  check(
    'daily schedule, retention and folder shown',
    card.includes('每日自動備份') && card.includes('保留最新 14 份') && card.includes('backups'),
    card.slice(0, 200),
  );
  check('first daily backup listed', (await text('.backup__row')).includes('每日'));
  await shot('01-settings-backups');

  // 2. 立即備份.
  const before = await rows();
  await click(`${backupSection} button`, '立即備份');
  check(
    'manual backup appears with 已備份',
    (await until(`document.querySelectorAll('.backup__row').length === ${before + 1}`)) &&
      (await until(`document.querySelector('.backup__ok') !== null`)),
  );
  check('newest row is 手動 and 完整', (await text('.backup__row:first-child')).includes('手動'));
  await shot('02-backup-now');

  // 3. SSE: a backup made by another client shows up without a reload.
  const n = await rows();
  await api('POST', '/api/v1/backups');
  check(
    'backup.created from another client updates the list live',
    await until(`document.querySelectorAll('.backup__row').length === ${n + 1}`, 5000),
  );

  // 4. A backup whose integrity check failed cannot be restored.
  const oldest = (await listBackups()).at(-1);
  const sidecar = path.join(backupsDir, `${oldest.id}.json`);
  const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  fs.writeFileSync(sidecar, JSON.stringify({ ...meta, integrity: 'failed' }));
  await api('POST', '/api/v1/backups'); // triggers backup.created → list reload
  await until(
    `[...document.querySelectorAll('.backup__row')].some((r) => r.textContent.includes('檢查未通過'))`,
  );
  const failedRowDisabled = await p.evaluate(`(() => {
    const row = [...document.querySelectorAll('.backup__row')].find((r) => r.textContent.includes('檢查未通過'));
    return row?.querySelector('button')?.disabled === true;
  })()`);
  check('integrity failed row: chip and disabled 還原', failedRowDisabled);
  await scrollTo('.backup__list');
  await shot('03-integrity-failed');
  fs.writeFileSync(sidecar, JSON.stringify(meta));

  // 5. Restore round trip: a work made after the backup disappears.
  const target = (await listBackups())[0];
  const created = await api('POST', '/api/v1/works', {
    title: '還原後應該消失的作品',
    markdown: '這篇在備份之後才建立。',
  });
  check('work created after the backup', created.status === 201, created.status);
  await openSettings();
  await clickRestoreFor(target.id);
  await until(`document.querySelector('.dialog') !== null`);
  const dialog = await text('.dialog');
  check(
    'confirm dialog says the current state is backed up first',
    dialog.includes('還原前會先自動備份目前的狀態') && dialog.includes('備份目前狀態並還原'),
  );
  check(
    'cancel has the initial focus',
    await p.evaluate(`document.activeElement?.textContent === '取消'`),
  );
  await shot('04-restore-confirm');
  await click('.dialog button', '備份目前狀態並還原');
  const sawRestoring = await until(
    `document.querySelector('.backup__notice[aria-busy="true"]') !== null`,
    3000,
  );
  if (sawRestoring) await shot('05-restoring');
  check('還原中 shown while the service reloads', sawRestoring);
  check(
    'restore finishes after the service reloads',
    await until(`document.querySelector('.backup__notice--ok') !== null`, 30_000),
  );
  const done = await text('.backup__notice--ok');
  check('done notice names the safety backup', done.includes('還原前'), done);
  check(
    'sidebar back to 服務運行中',
    (await text('.side__foot')).includes('服務運行中'),
    await text('.side__foot'),
  );
  check(
    'list refetched: newest is the pre_restore backup',
    (await text('.backup__row:first-child')).includes('還原前'),
  );
  await shot('06-restored');
  await nav('作品庫');
  await sleep(1500);
  const library = await text('main');
  check(
    'library refetched: the post-backup work is gone',
    !library.includes('還原後應該消失的作品') &&
      (await api('GET', '/api/v1/works?limit=50')).body.items.every(
        (w) => w.title !== '還原後應該消失的作品',
      ),
  );

  // 6. Refused: a damaged backup that still says ok.
  await openSettings();
  await click('.backup__notice button', '知道了');
  const victim = (await listBackups()).find((b) => b.kind === 'manual');
  fs.writeFileSync(path.join(backupsDir, `${victim.id}.sqlite`), 'not a database');
  await clickRestoreFor(victim.id);
  await until(`document.querySelector('.dialog') !== null`);
  await click('.dialog button', '備份目前狀態並還原');
  await until(`document.querySelector('.backup__notice--bad') !== null`);
  const refused = await text('.backup__notice--bad');
  check(
    '409 backup_not_restorable: data unchanged, reason shown',
    refused.includes('不能還原') && refused.includes('資料沒有變更'),
    refused,
  );
  await shot('07-refused-not-restorable');
  await click('.backup__notice button', '關閉');

  // 7. 409 backup_failed (safety backup impossible) and 500 on 立即備份.
  const good = (await listBackups()).find((b) => b.kind === 'daily');
  fs.chmodSync(backupsDir, 0o500);
  try {
    await clickRestoreFor(good.id);
    await until(`document.querySelector('.dialog') !== null`);
    await click('.dialog button', '備份目前狀態並還原');
    await until(`document.querySelector('.backup__notice--bad') !== null`);
    const failed = await text('.backup__notice--bad');
    check(
      '409 backup_failed: definite, nothing restored, detail from details.detail',
      failed.includes('所以沒有還原；資料沒有變更') && !failed.includes('無法確定'),
      failed,
    );
    await shot('08-refused-backup-failed');
    await click('.backup__notice button', '關閉');
    await click(`${backupSection} button`, '立即備份');
    await until(`document.querySelector('${backupSection} .ln__err') !== null`);
    const createErr = await text(`${backupSection} .ln__err`);
    check(
      '500 backup_failed on 立即備份 with reason',
      createErr.includes('沒有產生副本'),
      createErr,
    );
    await shot('09-backup-now-failed');
  } finally {
    fs.chmodSync(backupsDir, 0o700);
  }
  await click(`${backupSection} button`, '立即備份');
  check(
    'a later successful backup clears the old failure',
    await until(
      `document.querySelector('${backupSection} .ln__err') === null && document.querySelector('.backup__ok') !== null`,
    ),
  );

  // 8. Images from the service on port 7555 load; third-party images are blocked by CSP.
  const works = (await api('GET', '/api/v1/works?limit=50')).body.items;
  const post = works.find((w) => w.title.includes('書房'));
  check('mounted work with images is indexed', post !== undefined);
  await nav('作品庫');
  await until(`document.body.innerText.includes(${JSON.stringify(post?.title ?? '')})`);
  await clickText(post.title);
  await until(
    `[...document.querySelectorAll('main img')].some((i) => i.src.startsWith('${base}') && i.complete && i.naturalWidth > 0)`,
    15_000,
  );
  const imgs = await p.evaluate(
    `[...document.querySelectorAll('main img')].map((i) => ({ src: i.src.slice(0, 60), w: i.naturalWidth }))`,
  );
  check(
    `Markdown image from ${base} is shown`,
    imgs.some((i) => i.src.startsWith(base) && i.w > 0),
    JSON.stringify(imgs),
  );
  check(
    'external https image in the Markdown is not loaded',
    !imgs.some((i) => i.src.startsWith('https://')),
    JSON.stringify(imgs),
  );
  const csp = await p.evaluate(`new Promise((resolve) => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI));
    const img = new Image();
    img.onload = () => resolve({ loaded: true, violations });
    img.onerror = () => setTimeout(() => resolve({ loaded: false, violations }), 200);
    img.src = 'https://example.com/qc031-csp-probe.png';
  })`);
  check(
    'CSP blocks a third-party image',
    !csp.loaded && csp.violations.some((v) => v.startsWith('img-src')),
    JSON.stringify(csp),
  );
  const fetchBlocked = await p.evaluate(
    `fetch('https://example.com/').then(() => false, () => true)`,
  );
  check('CSP blocks fetch to a third party', fetchBlocked);
  await shot('10-editor-image-port-7555');

  // 9. Dark and narrow.
  await media('dark');
  await openSettings();
  await shot('11-settings-dark');
  await clickRestoreFor((await listBackups())[0].id);
  await until(`document.querySelector('.dialog') !== null`);
  await shot('12-restore-confirm-dark');
  await click('.dialog button', '取消');
  await media('light', 1000, 800);
  await openSettings();
  await shot('13-settings-narrow');
  await media('dark', 760, 800);
  await openSettings();
  await shot('14-settings-narrow-dark');
  await media('light');
}

if (phase === 'b') {
  // Service restarted with QC031_RELOAD=restart and backups/ read-only.
  await media('light');
  await reload();
  await openSettings();
  check(
    'daily backup failure shows last_error (backup.failed)',
    await until(`document.body.innerText.includes('上次自動備份失敗')`, 20_000),
    await text(`${backupSection} .card .ln__err`),
  );
  check(
    'overdue next daily reads 即將執行, not a past time',
    (await text(`${backupSection} .card .ln`)).includes('下次 即將執行'),
  );
  await shot('15-daily-failed');
  fs.chmodSync(backupsDir, 0o700);
  const target = (await listBackups()).find((b) => b.integrity === 'ok' && b.kind === 'daily');
  await clickRestoreFor(target.id);
  await until(`document.querySelector('.dialog') !== null`);
  await click('.dialog button', '備份目前狀態並還原');
  check(
    'restart_required notice',
    await until(`document.querySelector('.backup__notice--warn') !== null`),
    await text('.backup__notice--warn'),
  );
  await shot('16-restart-required');

  // A write from another page meets 503 restoring.
  await nav('作品庫');
  await until(`document.querySelector('main') !== null`);
  await sleep(800);
  const works = (await api('GET', '/api/v1/works?limit=50')).body.items;
  const post = works.find((w) => w.title.includes('書房'));
  await clickText(post.title);
  await until(`document.querySelector('[contenteditable="true"]') !== null`, 10_000);
  await p.evaluate(`(() => {
    const el = document.querySelector('[contenteditable="true"]');
    el.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
  })()`);
  await p.send('Input.insertText', { text: '還原期間的修改' });
  check(
    'editor save during a restore says the service is restoring',
    await until(`document.body.innerText.includes('服務正在還原資料庫，請稍候再試')`, 15_000),
  );
  check(
    'sidebar shows 還原中 after a 503 restoring',
    (await text('.side__foot')).includes('還原中'),
    await text('.side__foot'),
  );
  await shot('17-editor-503-restoring');
}

if (phase === 'c') {
  // The runner restarted the service; the pending restore was applied on start.
  check(
    'app leaves 還原中 once the service is back',
    await until(
      `document.querySelector('.side__foot')?.textContent.includes('服務運行中')`,
      75_000,
    ),
    await text('.side__foot'),
  );
  check(
    'editor draft kept in the window',
    (await p.evaluate('document.body.innerText')).includes('還原期間的修改'),
  );
  await shot('18-back-after-restart');
}

fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.phase === phase && !r.ok);
console.log(
  `${phase}: ${results.filter((r) => r.phase === phase).length - failed.length}/${results.filter((r) => r.phase === phase).length}`,
);
p.close();
process.exit(0);
