import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
const SERVER = process.argv[2],
  HOME = process.argv[3],
  PORT = 7431,
  BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(24).toString('hex');
const AUTH = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toISOString().slice(11, 19);
fs.mkdirSync(HOME, { recursive: true });
const out = fs.openSync(`${HOME}/../server.log`, 'a');
const child = spawn(`${SERVER}/bin/node`, ['server.mjs'], {
  cwd: SERVER,
  stdio: ['ignore', out, out],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CREATORHUB_HOME: HOME,
    CREATORHUB_PORT: String(PORT),
    CREATORHUB_TOKEN: TOKEN,
    CREATORHUB_FFPROBE: '',
  },
});
const held = () => {
  let kids;
  try {
    kids = execSync(`pgrep -P ${child.pid} caffeinate`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return 'none';
  }
  const a = execSync('pmset -g assertions', { encoding: 'utf8' });
  return kids
    .map(
      (k) =>
        `${execSync(`ps -o args= -p ${k}`, { encoding: 'utf8' }).trim()} assertion=${a.includes(`pid ${k}(caffeinate)`)}`,
    )
    .join('; ');
};
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  console.log(t(), 'idle before upload:', held());
  const size = 3 * 1024 * 1024;
  const c = await fetch(`${BASE}/api/v1/assets/uploads/tus`, {
    method: 'POST',
    headers: {
      ...AUTH,
      'tus-resumable': '1.0.0',
      'upload-length': String(size),
      'upload-metadata': `filename ${Buffer.from('drill.bin').toString('base64')}`,
    },
  });
  const url = new URL(c.headers.get('location'), BASE).toString();
  let offset = 0,
    during = [];
  while (offset < size) {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...AUTH,
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      body: randomBytes(Math.min(256 * 1024, size - offset)),
    });
    if (r.status !== 204) {
      console.log('PATCH status', r.status);
      break;
    }
    offset = Number(r.headers.get('upload-offset'));
    during.push(held());
    await sleep(700);
  }
  console.log(
    t(),
    `upload finished offset=${offset}/${size}; held during each chunk: ${during.filter((h) => h.includes('assertion=true')).length}/${during.length}; sample: ${during[0]}`,
  );
  const end = Date.now();
  let releasedAt = null;
  while (Date.now() - end < 90000) {
    if (held() === 'none') {
      releasedAt = Date.now() - end;
      break;
    }
    await sleep(1000);
  }
  console.log(
    t(),
    `released ${releasedAt === null ? 'NOT within 90 s' : `after ${Math.round(releasedAt / 1000)} s`}`,
  );
} finally {
  child.kill('SIGTERM');
  await sleep(1500);
  console.log(
    'instance stopped; caffeinate children left:',
    (() => {
      try {
        return execSync(`pgrep -P ${child.pid}`, { encoding: 'utf8' });
      } catch {
        return 'none';
      }
    })(),
  );
}
