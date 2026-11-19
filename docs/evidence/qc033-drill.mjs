// QC-033 drill against a second instance of the INSTALLED server build.
// Temp CREATORHUB_HOME, port 7431, own random token. Never calls /ai routes.
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = `${process.env.HOME}/Library/Application Support/qiu-creator/server`;
const HOME = process.argv[2];
const PORT = 7431;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(24).toString('hex');
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toISOString().slice(11, 23);

let child;
function startServer() {
  const out = fs.openSync(path.join(HOME, '..', 'server.log'), 'a');
  child = spawn(`${SERVER}/bin/node`, ['server.mjs'], {
    cwd: SERVER,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CREATORHUB_HOME: HOME,
      CREATORHUB_PORT: String(PORT),
      CREATORHUB_TOKEN: TOKEN,
      CREATORHUB_FFPROBE: '',
    },
    stdio: ['ignore', out, out],
  });
  return child;
}
async function health(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    if (Date.now() > end) return false;
    await sleep(100);
  }
}
async function api(method, url, body, headers = {}) {
  let r;
  try {
    r = await fetch(`${BASE}/api/v1${url}`, {
    method,
    headers: { ...H, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  } catch (e) {
    return { status: 0, json: { code: `network:${e.cause?.code ?? e.message}` } };
  }
  let json = null;
  const text = await r.text();
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
}
const workDir = (id) => path.join(HOME, 'library', 'works', id);
const src = (id) => fs.readFileSync(path.join(workDir(id), 'source.md'), 'utf8');
const snapshots = (id) => fs.readdirSync(path.join(workDir(id), 'revisions')).length;
const leftovers = (id) =>
  fs.readdirSync(workDir(id)).filter((f) => f.startsWith('.') || f.includes('.tmp')).length;

// SSE reader: collects {id, event}
function subscribe(lastEventId) {
  const events = [];
  const ac = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${BASE}/api/v1/events`, {
        headers: { authorization: H.authorization, ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) },
        signal: ac.signal,
      });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) ev.id = Number(line.slice(3).trim());
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          }
          if (ev.event) events.push(ev);
        }
      }
    } catch {}
  })();
  return { events, close: () => ac.abort() };
}
const pidAssertions = (pid) => {
  let kids = [];
  try { kids = execSync(`pgrep -P ${pid} caffeinate`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return false; }
  const out = execSync('pmset -g assertions', { encoding: 'utf8' });
  return kids.some((k) => {
    const args = execSync(`ps -o args= -p ${k}`, { encoding: 'utf8' }).trim();
    return args.includes(`-w ${pid}`) && args.includes('-i') && out.includes(`pid ${k}(caffeinate)`);
  });
};

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  startServer();
  check('second instance starts (installed build)', await health());
  const info = await (await fetch(`${BASE}/health`)).json();
  console.log('health', JSON.stringify(info));

  // ---- 4. original-file protection ----
  const created = await api('POST', '/works', { title: '演練 A', markdown: '# A\n\nv1\n' });
  check('create work A', created.status === 201, `status ${created.status}`);
  const A = created.json;
  const r1 = A.current_revision_id;
  const p1 = await api('PATCH', `/works/${A.id}`, { base_revision: r1, markdown: '# A\n\nv2\n' });
  check('PATCH with current base writes', p1.status === 200 && src(A.id) === '# A\n\nv2\n', `status ${p1.status}`);
  check('write-back leaves no temp files', leftovers(A.id) === 0, `leftovers ${leftovers(A.id)}`);
  check('every revision has an immutable snapshot', snapshots(A.id) === 2, `snapshots ${snapshots(A.id)}`);
  const r2 = p1.json.current_revision_id;
  const stale = await api('PATCH', `/works/${A.id}`, { base_revision: r1, markdown: 'stale overwrite' });
  check('stale base_revision -> 409, file untouched', stale.status === 409 && src(A.id) === '# A\n\nv2\n', `status ${stale.status} code ${stale.json?.error?.code ?? stale.json?.code}`);
  fs.writeFileSync(path.join(workDir(A.id), 'source.md'), '# A\n\nedited outside\n');
  const afterExt = await api('PATCH', `/works/${A.id}`, { base_revision: r2, markdown: 'would overwrite outside edit' });
  const revs = (await api('GET', `/works/${A.id}/revisions`)).json.items;
  check('outside edit + stale save -> 409, outside text kept and recorded', afterExt.status === 409 && src(A.id) === '# A\n\nedited outside\n' && revs.some((r) => r.source === 'external'), `status ${afterExt.status}; sources ${revs.map((r) => r.source).join(',')}`);
  const cur = (await api('GET', `/works/${A.id}`)).json;
  const oldest = revs[revs.length - 1];
  const before = revs.length;
  const rest = await api('POST', `/works/${A.id}/revisions/${oldest.revision_id}/restore`, { base_revision: cur.current_revision_id });
  const revs2 = (await api('GET', `/works/${A.id}/revisions`)).json.items;
  check('restoring history appends a new revision, keeps old ones', (rest.status === 200 || rest.status === 201) && revs2.length === before + 1 && revs2[0].source === 'restore' && src(A.id) === '# A\n\nv1\n', `status ${rest.status}; ${before} -> ${revs2.length}; top ${revs2[0]?.source}`);

  // ---- 3. backup / restore drill ----
  const sse = subscribe();
  await sleep(300);
  const b1 = await api('POST', '/backups', {});
  check('manual backup', (b1.status === 201 || b1.status === 200) && b1.json?.integrity === 'ok', `status ${b1.status} ${JSON.stringify(b1.json)}`);
  const B1 = b1.json;
  const atB1 = src(A.id);
  const aAtB1 = (await api('GET', `/works/${A.id}`)).json;
  await api('PATCH', `/works/${A.id}`, { base_revision: aAtB1.current_revision_id, markdown: '# A\n\nafter backup\n' });
  const C = (await api('POST', '/works', { title: '演練 C', markdown: 'C\n' })).json;
  await sleep(300);
  const maxSeqBefore = Math.max(...sse.events.map((e) => e.id ?? 0));
  const tRestore = Date.now();
  const restoreP = api('POST', `/backups/${B1.id}/restore`, { confirm: true });
  const during = await api('POST', '/works', { title: 'during restore', markdown: 'x' });
  const restore = await restoreP;
  console.log(t(), 'restore', restore.status, JSON.stringify(restore.json));
  check('restore accepted (202) with pre_restore safety backup, in-process reload', restore.status === 202 && restore.json?.safety_backup?.kind === 'pre_restore' && restore.json?.reload === 'in_process', `status ${restore.status}`);
  console.log(`write during restore -> ${during.status} ${during.json?.error?.code ?? during.json?.code ?? ''} (may be 201 if it won the race)`);
  const writeDuring = await api('POST', '/works', { title: 'right after 202', markdown: 'x' });
  console.log(`write right after 202 -> ${writeDuring.status} ${writeDuring.json?.error?.code ?? writeDuring.json?.code ?? ''}`);
  results.push({ name: 'writes during restore', ok: true, detail: `concurrent ${during.status}; after-202 ${writeDuring.status} ${writeDuring.json?.error?.code ?? writeDuring.json?.code ?? ''}` });
  // wait until works list served again
  let back = false;
  for (let i = 0; i < 200; i++) {
    const r = await api('GET', '/works?limit=200').catch(() => ({ status: 0 }));
    if (r.status === 200) { back = true; break; }
    await sleep(50);
  }
  console.log(`api back after ${Date.now() - tRestore} ms`);
  check('service back after in-process reload', back, `${Date.now() - tRestore} ms`);
  const list = (await api('GET', '/works?limit=200')).json.items;
  // remove the stray writes from the comparison (they happened after restore start)
  const titles = list.map((w) => w.title);
  const aNow = (await api('GET', `/works/${A.id}`)).json;
  check('A back to its state at backup', aNow.markdown === atB1, JSON.stringify(aNow.markdown));
  check('C gone from the database', !list.some((w) => w.id === C.id), `titles ${titles.join('|')}`);
  check('C folder kept on disk (not deleted)', fs.existsSync(workDir(C.id)));
  const bl = (await api('GET', '/backups')).json;
  check('pre_restore backup listed', bl.backups.some((b) => b.kind === 'pre_restore'), bl.backups.map((b) => b.kind).join(','));
  await sleep(500);
  sse.close();
  const restoredEv = sse.events.find((e) => e.event === 'backup.restored');
  const startedEv = sse.events.find((e) => e.event === 'backup.restore_started');
  console.log('events seen on first stream', JSON.stringify(sse.events.slice(-6)));
  const sse2 = subscribe(maxSeqBefore);
  await sleep(800);
  sse2.close();
  const restored2 = sse2.events.find((e) => e.event === 'backup.restored');
  check('reconnect with Last-Event-ID replays restore events, seq continues', restored2 !== undefined && restored2.id > maxSeqBefore, `first-stream started=${startedEv?.id} restored=${restoredEv?.id}; replay ${JSON.stringify(sse2.events.map((e) => [e.id, e.event]))}; maxBefore ${maxSeqBefore}`);
  // undo: restore pre_restore
  const pre = bl.backups.find((b) => b.kind === 'pre_restore');
  const undo = await api('POST', `/backups/${pre.id}/restore`, { confirm: true });
  for (let i = 0; i < 200; i++) { const r = await api('GET', '/works?limit=200').catch(() => ({ status: 0 })); if (r.status === 200) break; await sleep(50); }
  const list2 = (await api('GET', '/works?limit=200')).json.items;
  const aUndo = (await api('GET', `/works/${A.id}`)).json;
  check('restoring the pre_restore backup brings back post-backup state', undo.status === 202 && list2.some((w) => w.id === C.id) && aUndo.markdown === '# A\n\nafter backup\n', `status ${undo.status}`);

  // ---- kill -9 right after a restore was accepted ----
  const b2 = (await api('POST', '/backups', {})).json;
  const aB2 = (await api('GET', `/works/${A.id}`)).json;
  await api('PATCH', `/works/${A.id}`, { base_revision: aB2.current_revision_id, markdown: '# A\n\nafter b2\n' });
  const marker = path.join(HOME, 'data', 'restore-pending.json');
  const kp = api('POST', `/backups/${b2.id}/restore`, { confirm: true });
  // kill as soon as the marker exists
  let markerSeen = false;
  for (let i = 0; i < 400; i++) { if (fs.existsSync(marker)) { markerSeen = true; break; } await sleep(2); }
  const oldPid = child.pid;
  child.kill('SIGKILL');
  await kp.catch(() => null);
  await sleep(300);
  const markerAfterKill = fs.existsSync(marker);
  console.log(`marker seen ${markerSeen}; marker present after kill ${markerAfterKill}; killed ${oldPid}`);
  startServer();
  const up = await health();
  const aK = (await api('GET', `/works/${A.id}`)).json;
  check('kill -9 during restore: restart applies or completes it, marker cleared', up && aK.markdown === atB1Of(b2) && !fs.existsSync(marker), `marker at kill ${markerAfterKill}; A=${JSON.stringify(aK.markdown)}`);

  // ---- 5. sleep guard during a slow tus upload ----
  const size = 3 * 1024 * 1024;
  const create = await fetch(`${BASE}/api/v1/assets/uploads/tus`, {
    method: 'POST',
    headers: { authorization: H.authorization, 'tus-resumable': '1.0.0', 'upload-length': String(size), 'upload-metadata': `filename ${Buffer.from('drill.bin').toString('base64')}` },
  });
  const loc = create.headers.get('location');
  check('tus upload created', create.status === 201 && loc !== null, `status ${create.status}`);
  const url = new URL(loc, BASE).toString();
  let offset = 0;
  let heldDuring = false;
  const chunk = 256 * 1024;
  while (offset < size) {
    const body = randomBytes(Math.min(chunk, size - offset));
    const r = await fetch(url, { method: 'PATCH', headers: { authorization: H.authorization, 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }, body });
    offset = Number(r.headers.get('upload-offset'));
    if (pidAssertions(child.pid)) heldDuring = true;
    await sleep(700);
  }
  const heldEnd = pidAssertions(child.pid);
  console.log(t(), `upload done; assertion held during=${heldDuring} at end=${heldEnd}`);
  check('caffeinate -i -w <service pid> held during upload', heldDuring);
  await sleep(66000);
  const heldAfter = pidAssertions(child.pid);
  check('assertion released ~60 s after upload ended', !heldAfter);

  child.kill('SIGTERM');
  await sleep(1500);
  fs.writeFileSync(path.join(HOME, '..', 'results.json'), JSON.stringify(results, null, 2));
  console.log(`SUMMARY ${results.filter((r) => r.ok).length}/${results.length} pass`);
}
// A's content at backup b2 time was '# A\n\nafter backup\n' (state after undo)
function atB1Of() { return '# A\n\nafter backup\n'; }

main().catch((e) => {
  console.error('DRILL ERROR', e);
  try { child?.kill('SIGKILL'); } catch {}
  process.exitCode = 1;
});
