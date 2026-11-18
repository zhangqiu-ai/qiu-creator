// QC-025 acceptance server: the real mac-server with the local fake Gemini
// (Files API + generateContent, from the server's tests) and an in-memory key
// store. Nothing is sent to any AI service and the Keychain is never touched;
// Claude and GPT point at a closed local port so nothing could leave either.
// Usage (from services/mac-server):
//   CREATORHUB_HOME=<temp home> npx tsx ../../docs/evidence/qc025-server.mjs
// `<home>/fake-ai-mode` is read every 200 ms: `ok` (default), `slow` (Gemini
// keeps the file PROCESSING for ~20 s), `fail` (generateContent answers 429
// until the automatic retries are used up).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../services/mac-server/src/config.ts';
import { buildServer } from '../../services/mac-server/src/server.ts';
import { FakeGeminiVideo, videoResult } from '../../services/mac-server/test/fake-gemini-video.ts';

const home = process.env['CREATORHUB_HOME'] ?? '';
if (!home.includes('/tmp/')) throw new Error('CREATORHUB_HOME must be a temp dir');

const fake = new FakeGeminiVideo();
await fake.start();
fake.processingPolls = 2;

const RESULT = {
  summary:
    '同一支衣索比亞淺焙豆，用 V60、Kalita、Origami 各沖一杯，比較流速、口感與容錯。結論：新手先選平底濾杯。',
  key_moments: [
    { time_seconds: 0, label: '開場：三款濾杯，同一支豆', description: '介紹三個濾杯與豆子。' },
    { time_seconds: 9, label: '研磨度與水溫設定', description: '中細研磨、92 度。' },
    { time_seconds: 21, label: 'V60：流速快，酸質明亮', description: '' },
    { time_seconds: 34, label: 'Kalita：平底，萃取穩定', description: '' },
    { time_seconds: 47, label: '盲測結果與建議', description: '新手先選平底濾杯。' },
    { time_seconds: 75, label: '片尾', description: '模型給了超過片長的時間點。' },
  ],
  title_suggestions: [
    '同一支豆，三個濾杯，差在哪？',
    '手沖新手先買哪個濾杯？三款實測',
    'V60、Kalita、Origami 盲測對比',
  ],
  description_suggestions: ['三款濾杯同豆同水溫實測，告訴你新手該先買哪一個。'],
  cover_suggestions: [
    { time_seconds: 21, reason: 'V60 注水特寫。' },
    { time_seconds: 34, reason: '三個濾杯並排。' },
    { time_seconds: 50, reason: '盲測結果。' },
  ],
};

let lastMode = '';
setInterval(() => {
  let mode = 'ok';
  try {
    mode = fs.readFileSync(path.join(home, 'fake-ai-mode'), 'utf8').trim();
  } catch {
    // default
  }
  if (mode === lastMode) return;
  lastMode = mode;
  fake.processingPolls = mode === 'slow' ? 20 : 2;
  fake.generateReplies.length = 0;
  if (mode === 'fail') {
    for (let i = 0; i < 4; i++) {
      fake.generateReplies.push({
        status: 429,
        body: { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } },
      });
    }
  } else {
    for (let i = 0; i < 20; i++) fake.generateReplies.push({ body: videoResult(RESULT) });
  }
}, 200);

const values = new Map();
const secrets = {
  get: (p) => Promise.resolve(values.get(p) ?? null),
  set: (p, v) => {
    values.set(p, v);
    return Promise.resolve();
  },
  delete: (p) => Promise.resolve(values.delete(p)),
};

const config = loadConfig();
const { app } = await buildServer({
  config,
  ai: {
    secrets,
    baseUrls: {
      gemini: fake.baseUrl(),
      anthropic: 'http://127.0.0.1:9',
      openai: 'http://127.0.0.1:9',
    },
    retryBaseMs: 200,
    video: { chunkBytes: 256 * 1024, pollMs: 1000, processingTimeoutMs: 120_000 },
  },
});
process.once('SIGTERM', () => {
  void app.close().then(async () => {
    await fake.stop();
    process.exit(0);
  });
});
await app.listen({ host: config.host, port: config.port });
console.log('qc025 fake-ai server ready');
