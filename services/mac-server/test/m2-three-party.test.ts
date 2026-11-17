/**
 * M2 acceptance (QC-014): three parties change the same work at once —
 *   APP   the Mac app: reads a revision, saves with `base_revision`
 *   AGENT a write-scoped agent token, with and without a precondition
 *   EXT   an external editor writing the .md file directly (managed `source.md`
 *         and a file inside a mounted folder)
 * Whatever the order, every write is either accepted and kept in history, or
 * answered with 409/428 and not applied. Nothing is silently overwritten, and an
 * outside edit always becomes an `external` revision before anything else lands.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { Platform } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { pngBytes } from './fixtures.js';
import { authHeaders, startTestServer, type StartOptions, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(extra: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({
    jobs: { pollMs: 5 },
    // Polling keeps mount tests deterministic when the machine is busy (see QC-007).
    mounts: { stabilityMs: 150, writePollMs: 30, backend: 'polling', pollIntervalMs: 40 },
    ...extra,
  });
  servers.push(s);
  return s;
}

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-m2-')));
  dirs.push(dir);
  return dir;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition not met; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the request to be rejected').toBeInstanceOf(ApiError);
  return err as ApiError;
}

/** PATCH with explicit headers/body, for precondition cases the typed client hides. */
async function rawPatch(
  s: TestServer,
  workId: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; code: string | undefined; current: string | undefined }> {
  const res = await fetch(`${s.baseUrl}/api/v1/works/${workId}`, {
    method: 'PATCH',
    headers: {
      ...(token === undefined ? authHeaders() : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; details?: { current_revision?: string } };
  } | null;
  return {
    status: res.status,
    code: json?.error?.code,
    current: json?.error?.details?.current_revision,
  };
}

interface Rig {
  s: TestServer;
  /** The Mac app's client (owner token). */
  app: CreatorHubClient;
  /** An agent with a write-scoped token. */
  agent: CreatorHubClient;
  agentToken: string;
  workId: string;
  /** Absolute path of the .md an external editor would open. */
  file: string;
  /** Edit the file like Typora or VS Code would. */
  ext: (text: string) => void;
  /** Wait until the outside edit is recorded as an `external` revision. */
  settle: (text: string) => Promise<void>;
  kind: 'managed' | 'external';
}

async function makeRig(kind: 'managed' | 'external', initial: string): Promise<Rig> {
  const s = await start();
  const created = await s.client.tokens.create({ name: 'agent', scopes: ['read', 'write'] });
  const agent = createClient({ baseUrl: s.baseUrl, token: created.secret });
  let workId: string;
  let file: string;
  if (kind === 'managed') {
    workId = (await s.client.works.create({ title: '三方', markdown: initial })).id;
    file = path.join(s.home, 'library', 'works', workId, 'source.md');
  } else {
    const dir = tmpDir();
    file = path.join(dir, 'note.md');
    fs.writeFileSync(file, initial);
    const mount = await s.client.mounts.create({ path: dir });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const found = (await s.client.works.list({ limit: 50 })).items.find(
      (w) => w.external_path === 'note.md',
    );
    if (!found) throw new Error('mounted file was not indexed');
    workId = found.id;
  }
  const ext = (text: string): void => {
    fs.writeFileSync(file, text);
  };
  const settle = async (text: string): Promise<void> => {
    // Managed works are reconciled when the work is read; mounted ones also by the watcher.
    await waitFor(
      async () => (await s.client.works.get(workId)).markdown,
      (md) => md === text,
    );
  };
  return {
    s,
    app: s.client,
    agent,
    agentToken: created.secret,
    workId,
    file,
    ext,
    settle,
    kind,
  };
}

/** Markdown of every revision, newest first. */
async function history(r: Rig): Promise<{ markdown: string; source: string; id: string }[]> {
  const list = await r.app.works.revisions(r.workId);
  const out: { markdown: string; source: string; id: string }[] = [];
  for (const rev of list.items) {
    const detail = await r.app.works.revision(r.workId, rev.revision_id);
    out.push({ markdown: detail.markdown, source: rev.source, id: rev.revision_id });
  }
  return out;
}

/**
 * The no-silent-overwrite invariant: every text that was accepted (or typed
 * into the file by the outside editor) is still readable from history, and the
 * file on disk equals the current revision.
 */
async function assertNothingLost(r: Rig, kept: string[]): Promise<void> {
  const current = await r.app.works.get(r.workId);
  const texts = (await history(r)).map((h) => h.markdown);
  for (const text of kept) expect(texts, `history lost ${JSON.stringify(text)}`).toContain(text);
  expect(fs.readFileSync(r.file, 'utf8')).toBe(current.markdown);
}

describe.each(['managed', 'external'] as const)('three parties, %s work', (kind) => {
  it('APP saves from a stale revision after an outside edit: 409, the outside edit survives', async () => {
    const r = await makeRig(kind, 'v1 original');
    const seen = await r.app.works.get(r.workId); // the app opened r1
    r.ext('v2 from the outside editor');
    await r.settle('v2 from the outside editor');

    const err = await failure(
      r.app.works.patch(r.workId, { base_revision: seen.current_revision_id, markdown: 'v2 app' }),
    );
    expect(err.status).toBe(409);
    const now = await r.app.works.get(r.workId);
    expect(err.currentRevision).toBe(now.current_revision_id);
    expect(now.current_revision_id).not.toBe(seen.current_revision_id);
    expect(now.markdown).toBe('v2 from the outside editor');
    expect(fs.readFileSync(r.file, 'utf8')).toBe('v2 from the outside editor');
    expect((await history(r))[0]?.source).toBe('external');
    expect((await history(r)).map((h) => h.markdown)).not.toContain('v2 app');
    await assertNothingLost(r, ['v1 original', 'v2 from the outside editor']);
  });

  it('APP edit-in-flight: after the 409 it reloads, re-applies on the new revision and nothing is lost', async () => {
    const r = await makeRig(kind, 'base');
    const seen = await r.app.works.get(r.workId);
    r.ext('base + outside line');
    await r.settle('base + outside line');
    const conflict = await failure(
      r.app.works.patch(r.workId, { base_revision: seen.current_revision_id, markdown: 'mine' }),
    );
    expect(conflict.status).toBe(409);
    // The user picks "merge": the merged text is saved against the revision it was compared with.
    const latest = await r.app.works.get(r.workId);
    const saved = await r.app.works.patch(r.workId, {
      base_revision: latest.current_revision_id,
      markdown: 'base + outside line + mine',
    });
    expect(saved.markdown).toBe('base + outside line + mine');
    await assertNothingLost(r, ['base', 'base + outside line', 'base + outside line + mine']);
  });

  it('AGENT without base_revision or If-Match gets 428 and changes nothing', async () => {
    const r = await makeRig(kind, 'v1');
    const before = await r.app.works.get(r.workId);
    const noPrecondition = await rawPatch(
      r.s,
      r.workId,
      {},
      { markdown: 'agent blind' },
      r.agentToken,
    );
    expect(noPrecondition.status).toBe(428);
    const after = await r.app.works.get(r.workId);
    expect(after.current_revision_id).toBe(before.current_revision_id);
    expect(after.markdown).toBe('v1');
    expect(fs.readFileSync(r.file, 'utf8')).toBe('v1');
  });

  it('AGENT preconditions: stale base_revision 409, stale If-Match 409, wildcard refused, disagreement 409, matching If-Match alone accepted', async () => {
    const r = await makeRig(kind, 'v1');
    const r1 = (await r.app.works.get(r.workId)).current_revision_id;
    const r2 = (await r.app.works.patch(r.workId, { base_revision: r1, markdown: 'v2' }))
      .current_revision_id;

    const staleBody = await rawPatch(
      r.s,
      r.workId,
      {},
      { base_revision: r1, markdown: 'x1' },
      r.agentToken,
    );
    expect([staleBody.status, staleBody.current]).toEqual([409, r2]);
    const staleHeader = await rawPatch(
      r.s,
      r.workId,
      { 'if-match': `"${r1}"` },
      { markdown: 'x2' },
      r.agentToken,
    );
    expect([staleHeader.status, staleHeader.current]).toEqual([409, r2]);
    const wildcard = await rawPatch(
      r.s,
      r.workId,
      { 'if-match': '*' },
      { markdown: 'x3' },
      r.agentToken,
    );
    expect(wildcard.status).toBeGreaterThanOrEqual(400);
    expect(wildcard.status).not.toBe(200);
    const disagree = await rawPatch(
      r.s,
      r.workId,
      { 'if-match': `"${r1}"` },
      { base_revision: r2, markdown: 'x4' },
      r.agentToken,
    );
    expect(disagree.status).toBe(409);
    expect((await r.app.works.get(r.workId)).markdown).toBe('v2'); // none of them applied

    const ok = await rawPatch(
      r.s,
      r.workId,
      { 'if-match': `"${r2}"` },
      { markdown: 'v3 agent' },
      r.agentToken,
    );
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(r.file, 'utf8')).toBe('v3 agent');
    await assertNothingLost(r, ['v1', 'v2', 'v3 agent']);
  });

  it('outside edit, then AGENT saves from the revision it read before: 409; the outside edit is not overwritten', async () => {
    const r = await makeRig(kind, 'v1');
    const read = (await r.agent.works.get(r.workId)).current_revision_id;
    r.ext('edited by hand');
    // No GET in between: the server must notice the outside edit while handling this PATCH.
    const err = await failure(
      r.agent.works.patch(r.workId, { base_revision: read, markdown: 'agent text' }),
    );
    expect(err.status).toBe(409);
    expect(fs.readFileSync(r.file, 'utf8')).toBe('edited by hand');
    const now = await r.app.works.get(r.workId);
    expect(now.markdown).toBe('edited by hand');
    expect(err.currentRevision).toBe(now.current_revision_id);
    expect((await history(r))[0]?.source).toBe('external');
    await assertNothingLost(r, ['v1', 'edited by hand']);
  });

  it('all three from the same base, in every order: exactly one accepted write per revision, every loser gets 409', async () => {
    const orders: ('app' | 'agent' | 'ext')[][] = [
      ['app', 'agent', 'ext'],
      ['agent', 'app', 'ext'],
      ['ext', 'app', 'agent'],
      ['ext', 'agent', 'app'],
      ['app', 'ext', 'agent'],
      ['agent', 'ext', 'app'],
    ];
    for (const order of orders) {
      const r = await makeRig(kind, 'base');
      const base = (await r.app.works.get(r.workId)).current_revision_id;
      const results: Record<string, number> = {};
      const accepted = ['base'];
      for (const who of order) {
        const text = `${who} wrote this`;
        if (who === 'ext') {
          r.ext(text);
          accepted.push(text);
          continue;
        }
        const client = who === 'app' ? r.app : r.agent;
        try {
          await client.works.patch(r.workId, { base_revision: base, markdown: text });
          results[who] = 200;
          accepted.push(text);
        } catch (e) {
          expect(e).toBeInstanceOf(ApiError);
          results[who] = (e as ApiError).status;
        }
      }
      const label = order.join('>');
      // Whoever comes first among app/agent wins unless ext went first; later app/agent are refused.
      const apiOrder = order.filter((w) => w !== 'ext');
      const extFirst =
        order[0] === 'ext' || order.indexOf('ext') < order.indexOf(apiOrder[0] ?? 'app');
      if (extFirst) {
        expect(results, label).toEqual({ app: 409, agent: 409 });
      } else {
        expect(results[apiOrder[0] ?? ''], label).toBe(200);
        expect(results[apiOrder[1] ?? ''], label).toBe(409);
      }
      // Settle whatever the outside editor did, then nothing may be missing.
      const finalFile = fs.readFileSync(r.file, 'utf8');
      await r.settle(finalFile);
      await assertNothingLost(r, accepted);
    }
  });

  it('ten concurrent saves from the same base: exactly one wins, nine get 409, history has the winner once', async () => {
    const r = await makeRig(kind, 'base');
    const base = (await r.app.works.get(r.workId)).current_revision_id;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? r.app : r.agent).works
          .patch(r.workId, { base_revision: base, markdown: `writer ${String(i)}` })
          .then(
            () => 200,
            (e: unknown) => (e as ApiError).status,
          ),
      ),
    );
    expect(outcomes.filter((c) => c === 200)).toHaveLength(1);
    expect(outcomes.filter((c) => c === 409)).toHaveLength(9);
    const texts = (await history(r)).map((h) => h.markdown);
    expect(texts.filter((t) => t.startsWith('writer '))).toHaveLength(1);
    expect(fs.readFileSync(r.file, 'utf8')).toBe(texts[0]);
  });

  it('restore from a stale revision is refused (409) and a fresh one is a new revision that keeps every earlier version', async () => {
    const r = await makeRig(kind, 'v1');
    const first = (await r.app.works.get(r.workId)).current_revision_id;
    const second = await r.app.works.patch(r.workId, { base_revision: first, markdown: 'v2' });
    const stale = await failure(r.agent.works.restore(r.workId, first, { base_revision: first }));
    expect(stale.status).toBe(409);
    expect((await r.app.works.get(r.workId)).markdown).toBe('v2');

    const restored = await r.agent.works.restore(r.workId, first, {
      base_revision: second.current_revision_id,
    });
    expect(restored.markdown).toBe('v1');
    expect(fs.readFileSync(r.file, 'utf8')).toBe('v1');
    expect((await history(r)).map((h) => h.markdown)).toEqual(expect.arrayContaining(['v1', 'v2']));
    expect((await r.app.works.revisions(r.workId)).items).toHaveLength(3);
  });

  it('every outside edit between two app saves becomes its own external revision', async () => {
    const r = await makeRig(kind, 'a');
    for (const text of ['b typed outside', 'c typed outside', 'd typed outside']) {
      r.ext(text);
      await r.settle(text);
    }
    const sources = (await history(r)).map((h) => h.source);
    expect(sources.filter((s) => s === 'external')).toHaveLength(3);
    await assertNothingLost(r, ['a', 'b typed outside', 'c typed outside', 'd typed outside']);
    // And the content hash recorded on each revision matches the text.
    const list = (await r.app.works.revisions(r.workId)).items;
    const texts = (await history(r)).map((h) => h.markdown);
    list.forEach((rev, i) => {
      expect(rev.content_hash).toBe(sha(texts[i] ?? ''));
    });
  });
});

describe('mounted file disappears while the app and an agent hold it', () => {
  it('writes are refused with 409 source_missing, nothing is recreated, and saving resumes once the file is back', async () => {
    const r = await makeRig('external', 'kept');
    const rev = (await r.app.works.get(r.workId)).current_revision_id;
    fs.rmSync(r.file);
    await waitFor(
      async () => (await r.app.works.get(r.workId)).external_state,
      (st) => st === 'missing',
    );
    for (const client of [r.app, r.agent]) {
      const err = await failure(
        client.works.patch(r.workId, { base_revision: rev, markdown: 'zombie' }),
      );
      expect(err.status).toBe(409);
      expect(err.code).toBe('source_missing');
    }
    expect(fs.existsSync(r.file)).toBe(false);

    fs.writeFileSync(r.file, 'kept');
    await waitFor(
      async () => (await r.app.works.get(r.workId)).external_state,
      (st) => st === 'present',
    );
    const back = await r.app.works.get(r.workId);
    const saved = await r.agent.works.patch(r.workId, {
      base_revision: back.current_revision_id,
      markdown: 'kept + agent',
    });
    expect(saved.markdown).toBe('kept + agent');
    expect(fs.readFileSync(r.file, 'utf8')).toBe('kept + agent');
  });
});

describe('same platform version, three parties', () => {
  const PLATFORM: Platform = 'xiaohongshu';

  async function variantRig(): Promise<Rig> {
    const r = await makeRig('managed', '# 標題\n\n正文');
    await r.app.variants.generate(r.workId, { platforms: [PLATFORM] });
    return r;
  }

  it('APP and AGENT from the same variant revision: one wins, the other gets 409 with the new revision, nothing leaks to the original', async () => {
    const r = await variantRig();
    const v1 = await r.app.variants.get(r.workId, PLATFORM);
    const work = await r.app.works.get(r.workId);
    const outcomes = await Promise.all([
      r.app.variants
        .patch(r.workId, PLATFORM, { base_revision: v1.revision, title: 'app title' })
        .then(
          () => 'app' as const,
          (e: unknown) => e as ApiError,
        ),
      r.agent.variants
        .patch(r.workId, PLATFORM, { base_revision: v1.revision, title: 'agent title' })
        .then(
          () => 'agent' as const,
          (e: unknown) => e as ApiError,
        ),
    ]);
    const winners = outcomes.filter((o) => typeof o === 'string');
    const losers = outcomes.filter((o): o is ApiError => o instanceof ApiError);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.status).toBe(409);
    expect(losers[0]?.currentVariantRevision).toBe(v1.revision + 1);
    const now = await r.app.variants.get(r.workId, PLATFORM);
    expect(now.title).toBe(winners[0] === 'app' ? 'app title' : 'agent title');
    expect((await r.app.works.get(r.workId)).current_revision_id).toBe(work.current_revision_id);
  });

  it('an outside edit of source.md does not touch any platform version; redrafting needs a base and keeps history', async () => {
    const r = await variantRig();
    const v1 = await r.app.variants.patch(r.workId, PLATFORM, {
      base_revision: (await r.app.variants.get(r.workId, PLATFORM)).revision,
      title: '我改過的小紅書標題',
    });
    r.ext('# 外部改的標題\n\n外部改的正文');
    await r.settle('# 外部改的標題\n\n外部改的正文');
    const after = await r.app.variants.get(r.workId, PLATFORM);
    expect(after).toMatchObject({ title: '我改過的小紅書標題', revision: v1.revision });

    const blind = await failure(r.agent.variants.redraft(r.workId, PLATFORM));
    expect(blind.status).toBe(428);
    const redrafted = await r.agent.variants.redraft(r.workId, PLATFORM, v1.revision);
    expect(redrafted.revision).toBe(v1.revision + 1);
    expect(redrafted.body).toContain('外部改的正文');
    const revisions = await r.app.variants.revisions(r.workId, PLATFORM);
    expect(revisions.items.map((x) => x.title)).toEqual(
      expect.arrayContaining(['我改過的小紅書標題']),
    );
  });

  // DEFECT (reported to the director, not fixed on this branch): variant revision numbers
  // restart at 1 after delete + recreate, so a window still holding revision 1 of the deleted
  // version writes straight over the recreated one (200 instead of 409). `it.fails` keeps the
  // expected behaviour on record and turns red the moment the defect is fixed.
  it.fails(
    'refuses a stale variant save made against a version that was deleted and recreated',
    async () => {
      const r = await variantRig();
      const v1 = await r.app.variants.get(r.workId, PLATFORM); // the app has revision 1 open
      await r.agent.variants.remove(r.workId, PLATFORM, v1.revision);
      await r.agent.variants.generate(r.workId, { platforms: [PLATFORM] }); // a new draft, also revision 1
      const err = await failure(
        r.app.variants.patch(r.workId, PLATFORM, {
          base_revision: v1.revision,
          title: 'written from a stale view',
        }),
      );
      expect(err.status).toBe(409);
    },
  );

  it('four platforms edited by different parties keep their own title, body and cover', async () => {
    const r = await makeRig('managed', '# 原稿\n\n原稿正文');
    const covers: string[] = [];
    for (let i = 0; i < 4; i++) {
      const up = await r.app.assets.upload({
        data: await pngBytes(120 + i, 90 + i),
        filename: `c${String(i)}.png`,
      });
      await r.app.workAssets.link(r.workId, {
        asset_id: up.asset.id,
        role: i === 0 ? 'cover' : 'body',
      });
      covers.push(up.asset.id);
    }
    expect(covers).toHaveLength(4);
    await r.app.variants.generate(r.workId);
    const platforms: Platform[] = ['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels'];
    const writers = [r.app, r.agent, r.app, r.agent];
    for (const [i, platform] of platforms.entries()) {
      const current = await r.app.variants.get(r.workId, platform);
      await writers[i]?.variants.patch(r.workId, platform, {
        base_revision: current.revision,
        title: `標題 ${platform}`,
        body: `正文 ${platform}`,
        image_asset_ids: [covers[i] ?? ''],
        cover_asset_id: covers[i] ?? null,
      });
    }
    for (const [i, platform] of platforms.entries()) {
      const v = await r.app.variants.get(r.workId, platform);
      expect(v.title, platform).toBe(`標題 ${platform}`);
      expect(v.body, platform).toBe(`正文 ${platform}`);
      expect(v.cover_asset_id, platform).toBe(covers[i]);
      expect(v.revision, platform).toBe(2); // each platform counts its own revisions
    }
    expect((await r.app.works.get(r.workId)).markdown).toBe('# 原稿\n\n原稿正文');
  });
});
