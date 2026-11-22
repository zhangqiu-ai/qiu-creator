import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  AI_NOTICE_VERSION,
  type AiProvider,
  type AiProviderStatus,
  type WorkDetail,
} from '@qiu-creator/contracts';
import {
  buildServer,
  type BuildServerOptions,
  type CreatorHubServer,
} from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiProviders, pickProvider, RewriteSession } from '../src/renderer/ai-session.js';
import { WorkSession } from '../src/renderer/work-session.js';

/**
 * Integration (QC-024): the editor's AI sessions against a real mac-server.
 * The provider is an in-process fake injected into the server: no request
 * leaves the machine, and no key touches the Keychain.
 */
const TOKEN = 'test-token-0123456789abcdef';
const MD = '# 書房改造\n\n第一句。第二句。第三句。\n\n第二段。\n';
const PARA = '第一句。第二句。第三句。';

type ServerAi = NonNullable<BuildServerOptions['ai']>;
type FakeProvider = NonNullable<NonNullable<ServerAi['providers']>['anthropic']>;
type GenerateArgs = Parameters<FakeProvider['generateText']>;
type Reply = string | Error | ((signal: AbortSignal) => Promise<string>);

/** Scripted provider: each call takes the next reply. */
class ScriptedProvider implements FakeProvider {
  readonly id = 'anthropic' as const;
  readonly replies: Reply[] = [];
  readonly prompts: string[] = [];

  async generateText(...[request]: GenerateArgs) {
    this.prompts.push(request.prompt);
    const next = this.replies.shift() ?? new Error('no scripted reply');
    if (next instanceof Error) throw next;
    const text = typeof next === 'string' ? next : await next(request.signal);
    return {
      text,
      model: request.model,
      finish: 'stop' as const,
      usage: { input_tokens: 100, output_tokens: 20 },
    };
  }
}

class MemorySecrets {
  private readonly values = new Map<AiProvider, string>();
  get(p: AiProvider) {
    return Promise.resolve(this.values.get(p) ?? null);
  }
  set(p: AiProvider, v: string) {
    this.values.set(p, v);
    return Promise.resolve();
  }
  delete(p: AiProvider) {
    return Promise.resolve(this.values.delete(p));
  }
}

let server: CreatorHubServer;
let home: string;
let client: CreatorHubClient;
let provider: ScriptedProvider;
let work: WorkDetail;
const disposers: (() => void)[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-ai-'));
  provider = new ScriptedProvider();
  server = await buildServer({
    config: { home, token: TOKEN },
    ai: {
      secrets: new MemorySecrets(),
      providers: { anthropic: provider },
      retryBaseMs: 10,
      pollMs: 10,
      timeoutMs: 5000,
    },
  });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  work = await client.works.create({ title: '書房改造', markdown: MD, source: 'mac-app' });
});

afterEach(async () => {
  for (const d of disposers.splice(0)) d();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function ready(): Promise<void> {
  await client.ai.setKey('anthropic', 'sk-ant-fake-0123456789abcdef');
  await client.ai.consent('anthropic', AI_NOTICE_VERSION);
}

function open() {
  const ws = new WorkSession(client, work, { autosaveMs: 10_000 });
  const providers = new AiProviders(client);
  const rewrite = new RewriteSession(client, ws, providers, 20);
  disposers.push(() => {
    rewrite.dispose();
    ws.dispose();
  });
  return { ws, rewrite, providers };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const paraRange = { start: MD.indexOf(PARA), end: MD.indexOf(PARA) + PARA.length };

describe('pickProvider', () => {
  const status = (provider: AiProvider, key: boolean, ready: boolean) =>
    ({ provider, key_configured: key, ready }) as AiProviderStatus;

  it('takes the first ready provider in order, or says what is missing', () => {
    expect(
      pickProvider([status('openai', true, true), status('gemini', true, true)]).provider?.provider,
    ).toBe('gemini');
    expect(pickProvider([status('anthropic', false, false)])).toEqual({
      provider: null,
      block: 'key',
    });
    expect(pickProvider([status('openai', true, false)])).toEqual({
      provider: null,
      block: 'consent',
    });
  });
});

describe('RewriteSession', () => {
  it('shows 前往設定 instead of sending anything when no key is set', async () => {
    const { rewrite } = open();
    await rewrite.generate({ mode: 'polish', range: null });
    expect(rewrite.snapshot).toMatchObject({ phase: 'idle', block: 'key' });
    expect(provider.prompts).toHaveLength(0);
  });

  it('turns a key removed after the lookup into the same notice', async () => {
    await ready();
    const { rewrite } = open();
    await rewrite.loadProvider();
    expect(rewrite.snapshot.provider?.provider).toBe('anthropic');
    await client.ai.deleteKey('anthropic');
    await rewrite.generate({ mode: 'polish', range: null });
    expect(rewrite.snapshot).toMatchObject({ phase: 'idle', block: 'key' });
  });

  it('accepts part of a candidate hunk by hunk, then 復原 restores it as a new revision', async () => {
    await ready();
    const { ws, rewrite } = open();
    provider.replies.push('第一句改好了。第二句。第三句也改了。');
    await rewrite.generate({ mode: 'polish', instruction: '更口語', range: paraRange });
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate');
    const c = rewrite.snapshot.candidate;
    expect(c?.original).toBe(PARA);
    expect(c?.hunks).toBe(2);
    expect(provider.prompts[0]).toContain('更口語');

    rewrite.toggle(0); // keep the first sentence
    expect(rewrite.lengths()).toEqual({ before: 9, after: 12 });
    expect(await rewrite.accept()).toBe('accepted');
    const accepted = await client.works.get(work.id);
    expect(accepted.markdown).toBe('# 書房改造\n\n第一句。第二句。第三句也改了。\n\n第二段。\n');
    expect(ws.snapshot.draft.markdown).toBe(accepted.markdown);
    expect(rewrite.snapshot.done).toMatchObject({
      label: '已部分採用',
      revisionId: accepted.current_revision_id,
      previousRevisionId: work.current_revision_id,
    });
    const revs = await client.works.revisions(work.id);
    expect(revs.items[0]?.source).toBe('ai_accepted');

    expect(await rewrite.undo()).toBe('restored');
    const undone = await client.works.get(work.id);
    expect(undone.markdown).toBe(MD);
    expect(undone.current_revision_id).not.toBe(work.current_revision_id);
    expect((await client.works.revisions(work.id)).items.map((r) => r.source).slice(0, 2)).toEqual([
      'restore',
      'ai_accepted',
    ]);
    expect(rewrite.snapshot).toMatchObject({
      done: null,
      phase: 'idle',
      notice: '原稿已變更，請重新生成',
    });
  });

  it('插入 keeps the original and adds the candidate after it', async () => {
    await ready();
    const { rewrite } = open();
    provider.replies.push('全新的一段。');
    await rewrite.generate({ mode: 'expand', range: paraRange });
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate');
    expect(await rewrite.insert()).toBe('accepted');
    expect((await client.works.get(work.id)).markdown).toBe(
      `# 書房改造\n\n${PARA}\n\n全新的一段。\n\n第二段。\n`,
    );
    expect(rewrite.snapshot.done?.label).toBe('已插入');
  });

  it('saves pending edits before generating, so the candidate is based on them', async () => {
    await ready();
    const { ws, rewrite } = open();
    const edited = MD.replace('第二段。', '第二段改了。');
    ws.edit({ markdown: edited });
    provider.replies.push('改寫。');
    await rewrite.generate({ mode: 'polish', range: null });
    expect((await client.works.get(work.id)).markdown).toBe(edited);
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate');
    expect(rewrite.snapshot.candidate?.source).toBe(edited);
  });

  it('opens the conflict flow with the composed text when the work changed meanwhile', async () => {
    await ready();
    const { ws, rewrite } = open();
    provider.replies.push('第一句改。第二句。第三句。');
    await rewrite.generate({ mode: 'polish', range: paraRange });
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate');
    const other = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MD}別處加的。\n`,
    });
    expect(await rewrite.accept()).toBe('conflict');
    expect(ws.snapshot).toMatchObject({
      status: 'conflict',
      conflictRevision: other.current_revision_id,
    });
    expect(ws.snapshot.draft.markdown).toBe(MD.replace('第一句。', '第一句改。'));
    // Nothing was overwritten on the server.
    expect((await client.works.get(work.id)).markdown).toBe(`${MD}別處加的。\n`);
  });

  it('shows a failure with its reason and retries the same job', async () => {
    await ready();
    const { rewrite } = open();
    provider.replies.push(new Error('boom'), '第一句。');
    await rewrite.generate({ mode: 'shorten', range: paraRange });
    await until(() => rewrite.snapshot.phase === 'failed', 'failure');
    expect(rewrite.snapshot.failure?.code).toBe('unknown');
    await rewrite.retry();
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate after retry');
    expect(rewrite.snapshot.candidate?.result.text).toBe('第一句。');
  });

  it('stops a running generation', async () => {
    await ready();
    const { rewrite } = open();
    let started = false;
    provider.replies.push(
      (signal) =>
        new Promise((_, reject) => {
          started = true;
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    await rewrite.generate({ mode: 'polish', range: null });
    await until(() => started, 'provider call');
    const jobs = await client.ai.jobs({ work_id: work.id });
    await rewrite.stop();
    expect(rewrite.snapshot.phase).toBe('idle');
    const id = jobs.items[0]?.id ?? '';
    expect((await client.ai.job(id)).status).toBe('cancelled');
  });

  it('says so when the candidate changes nothing, and 捨棄 clears a candidate', async () => {
    await ready();
    const { rewrite } = open();
    provider.replies.push(PARA, '第一句改。第二句。第三句。');
    await rewrite.generate({ mode: 'polish', range: paraRange });
    await until(() => rewrite.snapshot.notice !== null, 'no-change notice');
    expect(rewrite.snapshot).toMatchObject({ phase: 'idle', notice: '這次沒有產生修改' });
    await rewrite.retry();
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate');
    rewrite.discard();
    expect(rewrite.snapshot).toMatchObject({ phase: 'idle', candidate: null });
    expect((await client.works.get(work.id)).markdown).toBe(MD);
  });
});
