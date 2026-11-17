// Seed a throwaway CREATORHUB_HOME for QC-013: one work with 12 linked images.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc013-seed.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
if (!home || !home.includes('/tmp/')) throw new Error('CREATORHUB_HOME must be a temp dir');
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

const work = await api('POST', '/api/v1/works', {
  title: '京都紅葉季七日慢遊路線',
  type: 'image',
  source: 'mac-app',
  markdown:
    '# 京都紅葉季七日慢遊路線\n\n十一月中旬到京都，七天只走五個區域，不趕行程。\n\n## 第一天：嵐山\n\n清晨六點到竹林，人少光好。\n\n## 第二天：東福寺\n\n通天橋的紅葉最密。\n',
});
const colors = [
  '#9E4428',
  '#C8662F',
  '#A86522',
  '#7A6A58',
  '#3E4A57',
  '#2F3B34',
  '#93332A',
  '#5E4130',
  '#55606A',
  '#E2A15B',
  '#8A5300',
  '#24508F',
];
for (const [i, color] of colors.entries()) {
  const data = await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  const up = await fetch(
    `${base}/api/v1/assets/uploads?filename=kyoto-${String(i + 1).padStart(2, '0')}.jpg`,
    {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: data,
    },
  ).then((r) => r.json());
  await api('POST', `/api/v1/works/${work.id}/assets`, {
    asset_id: up.asset.id,
    role: i === 0 ? 'cover' : 'body',
  });
}
console.log('work', work.id);
