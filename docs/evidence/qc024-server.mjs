// QC-024 acceptance server: the real mac-server with an in-process fake AI
// provider and an in-memory key store. Nothing is sent to any AI service and
// the Keychain is never touched.
// Usage (from services/mac-server):
//   CREATORHUB_HOME=<temp home> npx tsx ../../docs/evidence/qc024-server.mjs
// The fake reads `<home>/fake-ai-mode` on every call: `ok` (default), `slow`
// (waits 6 s unless stopped), `fail` (timeout, after the automatic retries).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../services/mac-server/src/config.ts';
import { ProviderError } from '../../services/mac-server/src/ai/provider.ts';
import { buildServer } from '../../services/mac-server/src/server.ts';

const home = process.env['CREATORHUB_HOME'] ?? '';
if (!home.includes('/tmp/')) throw new Error('CREATORHUB_HOME must be a temp dir');

const REWRITES = {
  '剛搬進來時，我以為書房只要一張大桌子就夠了。後來發現，真正耽誤剪輯的是線材、散熱和那台一直在響的風扇。所以這半年我陸續做了很多很多調整。':
    '剛搬進來時，我以為一張大桌子就夠了。真正拖慢剪輯的，是線材、散熱和那台一直響的風扇。這半年，我做了五個取捨。',
};

const TITLES = {
  xiaohongshu: [
    '書房改剪輯室，半年後我後悔了嗎',
    '12㎡ 書房變剪輯室｜5 個取捨',
    '半年前把書房改成剪輯室，現在的真實感受與五個取捨',
  ],
  wechat_mp: ['我把書房改成剪輯室：半年後的五個取捨', '一間書房的半年改造：安靜、散熱與取捨'],
  douyin: ['書房改剪輯室半年，這 5 件事最值得', '剪輯室改造半年復盤'],
  wechat_channels: ['半年前，我把書房改成了剪輯室', '書房剪輯室：五個取捨'],
};

const mode = () => {
  try {
    return fs.readFileSync(path.join(home, 'fake-ai-mode'), 'utf8').trim();
  } catch {
    return 'ok';
  }
};

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('timeout', 'aborted'));
    });
  });

/** @param {'anthropic' | 'gemini' | 'openai'} id */
function fake(id) {
  return {
    id,
    async generateText(request) {
      const m = mode();
      if (m === 'fail') throw new ProviderError('timeout', 'fake provider timed out');
      await wait(m === 'slow' ? 6000 : 700, request.signal);
      let text;
      if (request.jsonSchema !== undefined) {
        const props = request.jsonSchema['properties'] ?? {};
        text = JSON.stringify(
          Object.fromEntries(Object.keys(props).map((p) => [p, { titles: TITLES[p] ?? [] }])),
        );
      } else {
        const target =
          /<要改寫的段落>\n([\s\S]*?)\n<\/要改寫的段落>/.exec(request.prompt) ??
          /<原文>\n([\s\S]*?)\n<\/原文>/.exec(request.prompt);
        const original = target?.[1]?.trim() ?? '';
        text = REWRITES[original] ?? original.replace(/。/g, '！');
      }
      return {
        text,
        model: request.model,
        finish: 'stop',
        usage: { input_tokens: 800, output_tokens: 120 },
      };
    },
  };
}

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
    providers: { anthropic: fake('anthropic'), gemini: fake('gemini'), openai: fake('openai') },
    retryBaseMs: 200,
  },
});
process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
await app.listen({ host: config.host, port: config.port });
console.log('qc024 fake-ai server ready');
