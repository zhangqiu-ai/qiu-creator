// Seed a throwaway CREATORHUB_HOME for QC-014 (run against a live mac-server on 7420).
// Usage: CREATORHUB_HOME=<temp home> QC014_MOUNT_DIR=<temp folder> node docs/evidence/qc014-seed.mjs
// Creates: one managed work (with 4 linked images), one mounted external work,
// and an agent token with read+write scope. Writes <home>/qc014-seed.json.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
const mountDir = process.env.QC014_MOUNT_DIR;
if (!home || !mountDir || !path.basename(home).startsWith('qc014-home')) {
  throw new Error('CREATORHUB_HOME must be a qc014-home* temp dir and QC014_MOUNT_DIR must be set');
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

const managed = await api('POST', '/api/v1/works', {
  title: 'M2 驗收 托管',
  type: 'image',
  source: 'mac-app',
  markdown: '# M2 驗收 托管\n\n托管作品的第一段。\n\n第二段。\n',
});
const colors = ['#9E4428', '#3E4A57', '#2F3B34', '#24508F'];
const assetIds = [];
for (const [i, color] of colors.entries()) {
  const data = await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  const up = await fetch(`${base}/api/v1/assets/uploads?filename=m2-${i + 1}.jpg`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    body: data,
  }).then((r) => r.json());
  await api('POST', `/api/v1/works/${managed.id}/assets`, {
    asset_id: up.asset.id,
    role: i === 0 ? 'cover' : 'body',
  });
  assetIds.push(up.asset.id);
}

fs.writeFileSync(
  path.join(mountDir, 'ext-note.md'),
  '# M2 驗收 外部掛載\n\n外部原稿第一段。\n\n第二段。\n',
);
const mount = await api('POST', '/api/v1/mounts', { path: mountDir });
let mounted;
for (let i = 0; i < 100 && !mounted; i++) {
  mounted = (await api('GET', '/api/v1/works?limit=50')).items.find(
    (w) => w.external_path === 'ext-note.md',
  );
  if (!mounted) await new Promise((r) => setTimeout(r, 100));
}
if (!mounted) throw new Error('mounted work was not indexed');

const agent = await api('POST', '/api/v1/tokens', {
  name: 'qc014-agent',
  scopes: ['read', 'write'],
});

fs.writeFileSync(
  path.join(home, 'qc014-seed.json'),
  `${JSON.stringify(
    {
      managedId: managed.id,
      mountedId: mounted.id,
      mountId: mount.id,
      assetIds,
      agentToken: agent.secret,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log('seeded', { managed: managed.id, mounted: mounted.id });
