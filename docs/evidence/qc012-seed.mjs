// Seed a throwaway CREATORHUB_HOME for QC-012 acceptance: images, a video, a
// markdown file, mounts and agent tokens. No outbound request is made. Never point this at a real library.
//
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc012-seed.mjs <mounts-dir>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
const mountsDir = process.argv[2];
if (!home || !mountsDir || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp home> node qc012-seed.mjs <mounts-dir>');
}
const base = 'http://127.0.0.1:7420';
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const auth = { authorization: `Bearer ${token}` };
const require = createRequire(
  new URL('../../services/mac-server/package.json', import.meta.url).pathname,
);
const sharp = require('sharp');

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function upload(name, data) {
  const res = await fetch(`${base}/api/v1/assets/uploads?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    body: data,
  });
  return res.status;
}

const images = [
  ['kyoto-arashiyama-01.jpg', 4032, 3024, '#9E4428'],
  ['kyoto-tofukuji-02.jpg', 4032, 3024, '#C8662F'],
  ['desk-after.jpg', 2400, 1350, '#3E4A57'],
  ['tainan-map.png', 1600, 2000, '#A86522'],
  ['outfit-03.jpg', 3000, 4000, '#7A6A58'],
  ['tools-cover.png', 1920, 1080, '#2F3B34'],
];
for (const [name, w, h, color] of images) {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: color } });
  const data = name.endsWith('.png') ? await img.png().toBuffer() : await img.jpeg().toBuffer();
  console.log('upload', name, await upload(name, data));
}

const ftyp = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
console.log(
  'upload video',
  await upload('beef-final.mp4', Buffer.concat([ftyp, Buffer.alloc(256 * 1024, 7)])),
);
console.log(
  'upload markdown',
  await upload('寫作工具評測.md', Buffer.from('# 寫作工具評測\n\n草稿。\n')),
);

// URL imports of literal private addresses are refused synchronously (url_rejected); the
// verify script exercises that through the dialog instead.

const writing = path.join(mountsDir, '寫作');
const drive = path.join(mountsDir, '外接硬碟-剪輯腳本');
fs.mkdirSync(writing, { recursive: true });
fs.mkdirSync(drive, { recursive: true });
fs.writeFileSync(path.join(writing, '2026 年我用過最順手的 6 個寫作工具.md'), '# 工具\n\n內容。\n');
fs.writeFileSync(path.join(writing, '台南兩天一夜小吃地圖.md'), '# 台南\n\n內容。\n');
fs.writeFileSync(path.join(drive, '分鏡.md'), '# 分鏡\n');
for (const [p, name] of [
  [writing, '寫作'],
  [drive, '外接硬碟-剪輯腳本'],
]) {
  console.log('mount', name, (await api('POST', '/api/v1/mounts', { path: p, name })).status);
}

for (const [name, scopes] of [
  ['n8n-flow', ['read']],
  ['cursor-agent', ['read', 'import']],
  ['claude-code', ['read', 'import', 'write']],
]) {
  const r = await api('POST', '/api/v1/tokens', { name, scopes });
  console.log('token', name, r.status);
  if (name === 'cursor-agent') {
    console.log('revoke', name, (await api('DELETE', `/api/v1/tokens/${r.json.token.id}`)).status);
  }
}
