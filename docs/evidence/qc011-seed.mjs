// Seed a throwaway CREATORHUB_HOME for QC-011 acceptance: managed works with
// revisions, tags and Markdown images, a mounted folder with external works,
// and an asset linked to a work. No outbound requests.
//
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc011-seed.mjs <mount-dir>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
const mountDir = process.argv[2];
if (!home || !mountDir || !home.includes('/tmp/')) {
  throw new Error('usage: CREATORHUB_HOME=<temp home> node qc011-seed.mjs <mount-dir>');
}
const base = 'http://127.0.0.1:7420';
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const auth = { authorization: `Bearer ${token}` };
const require = createRequire(
  new URL('../../services/mac-server/package.json', import.meta.url).pathname,
);
const sharp = require('sharp');

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const jpeg = (w, h, color) =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

// A managed work with several revisions and images in its own assets folder.
let desk = await api('POST', '/api/v1/works', {
  title: '我把書房改成剪輯室：半年後的取捨',
  type: 'article',
  source: 'mac-app',
  markdown: '# 我把書房改成剪輯室\n\n半年前，我把書房改成了剪輯室。\n',
});
const revs = [
  '# 我把書房改成剪輯室\n\n半年前，我把書房改成了剪輯室。這篇記下哪些改動值得，哪些我後悔了。\n',
  '# 我把書房改成剪輯室\n\n半年前，我把書房改成了剪輯室。這篇記下哪些改動值得，哪些我後悔了。\n\n## 一、桌子換成兩張\n\n原本的實木大桌很好看，但螢幕臂夾不住它的圓邊。\n\n![桌面](assets/desk-after.jpg)\n\n![舊照片](assets/desk-before.jpg)\n',
];
for (const markdown of revs) {
  desk = await api('PATCH', `/api/v1/works/${desk.id}`, {
    base_revision: desk.current_revision_id,
    markdown,
  });
}
desk = await api('PATCH', `/api/v1/works/${desk.id}`, {
  base_revision: desk.current_revision_id,
  status: 'in_review',
  tags: ['空間', '剪輯'],
});
const assetsDir = path.join(home, 'library', 'works', desk.id, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'desk-after.jpg'), await jpeg(1600, 900, '#3E4A57'));
console.log('desk', desk.id);

const kyoto = await api('POST', '/api/v1/works', {
  title: '京都紅葉季七日慢遊路線',
  type: 'image',
  source: 'api:claude-code',
  markdown: '# 京都紅葉季\n\n七天路線。\n',
});
const cover = await fetch(`${base}/api/v1/assets/uploads?filename=kyoto-arashiyama-01.jpg`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/octet-stream' },
  body: await jpeg(1200, 900, '#9E4428'),
}).then((r) => r.json());
await api('POST', `/api/v1/works/${kyoto.id}/assets`, { asset_id: cover.asset.id, role: 'cover' });
await api('POST', `/api/v1/works/${desk.id}/assets`, { asset_id: cover.asset.id, role: 'body' });
console.log('kyoto', kyoto.id, 'asset', cover.asset.id);

// A mounted folder with external works.
const writing = path.join(mountDir, '寫作');
fs.mkdirSync(path.join(writing, '工具'), { recursive: true });
fs.writeFileSync(
  path.join(writing, '工具', '2026 年我用過最順手的 6 個寫作工具.md'),
  '# 2026 年我用過最順手的 6 個寫作工具\n\n今年換了三次工具。\n',
);
fs.writeFileSync(
  path.join(writing, '台南兩天一夜小吃地圖.md'),
  '# 台南兩天一夜小吃地圖\n\n第一天。\n',
);
await api('POST', '/api/v1/mounts', { path: writing, name: '寫作' });
for (let i = 0; i < 50; i++) {
  const list = await api('GET', '/api/v1/works?limit=50');
  if (list.items.filter((w) => w.storage_mode === 'external').length === 2) break;
  await new Promise((r) => setTimeout(r, 200));
}
console.log('mounted', writing);
