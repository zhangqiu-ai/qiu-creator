import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { AI_NOTICE_VERSION, type AiProvider, type WorkDetail } from '@qiu-creator/contracts';
import {
  buildServer,
  type BuildServerOptions,
  type CreatorHubServer,
} from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiProviders, RewriteSession } from '../src/renderer/ai-session.js';
import { WorkSession } from '../src/renderer/work-session.js';

/**
 * QC-027: the conflict dialog says 「你的修改基於 rA，伺服器已是 rB」. rA must be
 * the revision the draft was really based on, even when `baseRevision` has
 * already moved to the server's revision (an SSE echo adopted silently, or a
 * fetch that finished while the user was typing).
 */
const TOKEN = 'test-token-0123456789abcdef';
const MD = '# 書房\n\n第一句。第二句。\n';

type ServerAi = NonNullable<BuildServerOptions['ai']>;
type FakeProvider = NonNullable<NonNullable<ServerAi['providers']>['anthropic']>;

class OneReplyProvider implements FakeProvider {
  readonly id = 'anthropic' as const;
  constructor(private readonly text: string) {}
  generateText(...[request]: Parameters<FakeProvider['generateText']>) {
    return Promise.resolve({
      text: this.text,
      model: request.model,
      finish: 'stop' as const,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
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
let work: WorkDetail;
const disposers: (() => void)[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-cb-'));
  server = await buildServer({
    config: { home, token: TOKEN },
    ai: {
      secrets: new MemorySecrets(),
      providers: { anthropic: new OneReplyProvider('第一句改。第二句。') },
      retryBaseMs: 10,
      pollMs: 10,
    },
  });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  work = await client.works.create({ title: '書房', markdown: MD, source: 'mac-app' });
});

afterEach(async () => {
  for (const d of disposers.splice(0)) d();
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function session(): WorkSession {
  const ws = new WorkSession(client, work, { autosaveMs: 10_000 });
  disposers.push(() => {
    ws.dispose();
  });
  return ws;
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('conflict base revision (QC-027)', () => {
  it('AI accept after a silently adopted outside edit: based on the candidate source, not the server', async () => {
    await client.ai.setKey('anthropic', 'sk-ant-fake-0123456789abcdef');
    await client.ai.consent('anthropic', AI_NOTICE_VERSION);
    const ws = session();
    const rewrite = new RewriteSession(client, ws, new AiProviders(client), 20);
    disposers.push(() => {
      rewrite.dispose();
    });
    await rewrite.generate({ mode: 'polish', range: null });
    await until(() => rewrite.snapshot.phase === 'pending', 'candidate');
    const source = rewrite.snapshot.candidate?.result.source_revision;
    expect(source).toBe(work.current_revision_id);

    // Another window writes; the SSE echo is adopted silently (nothing unsaved here).
    const other = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MD}別處加的。\n`,
    });
    await ws.remoteRevision(other.current_revision_id, 'edit');
    expect(ws.snapshot.baseRevision).toBe(other.current_revision_id);

    expect(await rewrite.accept()).toBe('conflict');
    expect(ws.snapshot).toMatchObject({
      status: 'conflict',
      conflictRevision: other.current_revision_id,
      conflictBase: work.current_revision_id,
    });
    expect(ws.snapshot.conflictBase).not.toBe(ws.snapshot.conflictRevision);
  });

  it('ordinary save 409: based on the revision the save was sent with', async () => {
    const ws = session();
    const other = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MD}別處加的。\n`,
    });
    ws.edit({ markdown: `${MD}我加的。\n` });
    await ws.save();
    expect(ws.snapshot).toMatchObject({
      status: 'conflict',
      conflictRevision: other.current_revision_id,
      conflictBase: work.current_revision_id,
    });
  });

  it('比對並合併 after typing during a remote fetch: based on the draft’s own revision', async () => {
    const ws = session();
    const other = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MD}別處加的。\n`,
    });
    // The fetch of the newer revision is in flight when the user starts typing.
    const fetching = ws.remoteRevision(other.current_revision_id, 'edit');
    ws.edit({ markdown: `${MD}我正在打字。\n` });
    await fetching;
    expect(ws.snapshot.remote).toMatchObject({
      revisionId: other.current_revision_id,
      draftBase: work.current_revision_id,
    });
    // baseRevision already points at the server's revision here; the dialog must not use it.
    expect(ws.snapshot.baseRevision).toBe(other.current_revision_id);
    ws.compareRemote();
    expect(ws.snapshot).toMatchObject({
      status: 'conflict',
      conflictRevision: other.current_revision_id,
      conflictBase: work.current_revision_id,
    });
  });

  it('比對並合併 with unsaved edits: based on the unchanged base', async () => {
    const ws = session();
    ws.edit({ markdown: `${MD}未儲存。\n` });
    const other = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MD}別處加的。\n`,
    });
    await ws.remoteRevision(other.current_revision_id, 'external');
    ws.compareRemote();
    expect(ws.snapshot).toMatchObject({
      conflictRevision: other.current_revision_id,
      conflictBase: work.current_revision_id,
    });
  });

  it('clears the conflict base once the draft is replaced from the server', async () => {
    const ws = session();
    await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MD}別處加的。\n`,
    });
    ws.edit({ markdown: `${MD}我加的。\n` });
    await ws.save();
    expect(ws.snapshot.conflictBase).toBe(work.current_revision_id);
    await ws.reloadFromServer();
    expect(ws.snapshot).toMatchObject({ status: 'saved', conflictBase: null });
  });
});
