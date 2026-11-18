// QC-026 acceptance: long-lived LOCAL stand-ins for the AI providers. Nothing is ever
// forwarded anywhere. They live in their own process so the mac-server can be killed
// and restarted while a job is in flight without losing what the "providers" saw.
//   Claude / GPT  -> FakeAiServer (real wire formats, from the server's own tests)
//   Gemini        -> FakeGeminiVideo (Files API + generateContent with video)
// A small control server (127.0.0.1:7433) lets the driver script replies and read back
// what the providers received. Writes <home>/fakes.json with the base URLs.
// Usage (from services/mac-server): CREATORHUB_HOME=<temp home> node --import tsx ../../docs/evidence/qc026-fakes.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fail, FakeAiServer, ok } from '../../services/mac-server/test/fake-ai.ts';
import { FakeGeminiVideo, videoResult } from '../../services/mac-server/test/fake-gemini-video.ts';

const home = process.env['CREATORHUB_HOME'] ?? '';
if (!path.basename(home).startsWith('qc026-home'))
  throw new Error('CREATORHUB_HOME must be a qc026-home* temp dir');

const text = new FakeAiServer();
const gemini = new FakeGeminiVideo();
await text.start();
await gemini.start();
gemini.processingPolls = 2;

const RESULT = {
  summary:
    '同一支衣索比亞淺焙豆，用 V60、Kalita、Origami 各沖一杯，比較流速與口感。結論：新手先選平底濾杯。',
  key_moments: [
    { time_seconds: 0, label: '開場：三款濾杯', description: '介紹三個濾杯與豆子。' },
    { time_seconds: 21, label: 'V60：流速快', description: '' },
    { time_seconds: 34, label: 'Kalita：平底', description: '' },
    { time_seconds: 75, label: '片尾', description: '模型給了超過片長的時間點。' },
  ],
  title_suggestions: ['同一支豆，三個濾杯，差在哪？', '手沖新手先買哪個濾杯？'],
  description_suggestions: ['三款濾杯同豆同水溫實測。'],
  cover_suggestions: [{ time_seconds: 21, reason: 'V60 注水特寫。' }],
};
const pushVideoOk = (n) => {
  for (let i = 0; i < n; i++) gemini.generateReplies.push({ body: videoResult(RESULT) });
};
pushVideoOk(40);

const REFUSAL = {
  body: {
    id: 'msg_refusal',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [],
    stop_reason: 'refusal',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

function state() {
  const upload = gemini.lastUpload();
  return {
    anthropic: {
      requests: text.for('anthropic').length,
      // The Anthropic SDK sends the key as a bearer token.
      apiKeys: [
        ...new Set(
          text
            .for('anthropic')
            .map((r) => String(r.headers['authorization']).replace(/^Bearer /, '')),
        ),
      ],
    },
    openai: { requests: text.for('openai').length },
    gemini: {
      starts: gemini.starts.length,
      chunks: gemini.chunks.length,
      generates: gemini.generates.length,
      deletes: gemini.deletes.length,
      liveRemoteFiles: [...gemini.files.values()].filter((f) => !f.deleted).length,
      lastUploadBytes: upload?.length ?? 0,
      lastUploadSha256: upload ? createHash('sha256').update(upload).digest('hex') : null,
      apiKeys: [...new Set(gemini.starts.map((s) => String(s.headers['x-goog-api-key'])))],
    },
  };
}

const control = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/state') return json(200, state());
    if (req.method === 'POST' && req.url === '/script') {
      // { provider: 'anthropic' | 'openai', replies: [{ text } | { status, message } | { refusal: true } | { delayMs, text }] }
      for (const r of body.replies) {
        const reply = r.refusal
          ? REFUSAL
          : r.status
            ? fail(body.provider, r.status, r.message ?? 'nope')
            : ok(body.provider, r.text, 'claude-opus-5-5');
        text.script(body.provider, r.delayMs ? { ...reply, delayMs: r.delayMs } : reply);
      }
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/gemini') {
      // { processingPolls?, failProcessing?, generate429?: n }
      if (body.processingPolls !== undefined) gemini.processingPolls = body.processingPolls;
      if (body.failProcessing !== undefined) gemini.failProcessing = body.failProcessing;
      if (body.generate429 !== undefined) {
        gemini.generateReplies.length = 0;
        for (let i = 0; i < body.generate429; i++) {
          gemini.generateReplies.push({
            status: 429,
            body: {
              error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' },
            },
          });
        }
        pushVideoOk(40);
      }
      return json(200, { ok: true });
    }
    return json(404, { error: 'unknown' });
  });
});
await new Promise((resolve) => control.listen(7433, '127.0.0.1', resolve));

fs.writeFileSync(
  path.join(home, 'fakes.json'),
  JSON.stringify({
    baseUrls: { ...text.baseUrls(), gemini: gemini.baseUrl() },
    control: 'http://127.0.0.1:7433',
  }),
);
const stop = async () => {
  control.close();
  await text.stop();
  await gemini.stop();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
console.log('qc026 fake providers ready');
