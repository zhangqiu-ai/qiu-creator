import fs from 'node:fs';
import path from 'node:path';
import type { ChangeEvent } from '@qiu-creator/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngBytes } from './fixtures.js';
import { createClient, type FetchLike } from '@qiu-creator/api-client';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js';

let s: TestServer;
beforeEach(async () => {
  s = await startTestServer();
});
afterEach(async () => {
  await s.close();
});

/**
 * Collect events until `until` matches, using the api-client SSE reader.
 *
 * The stream starts at the feed's current seq (taken before subscribing) via
 * Last-Event-ID, so events committed by `act` are delivered however long the
 * connection takes to attach. Never wait a fixed time for the attach: on a busy
 * machine that is a race, and a missed event is not replayed otherwise.
 */
async function collect(
  srv: TestServer,
  until: (events: ChangeEvent[]) => boolean,
  act: () => Promise<void>,
  lastEventId: number = srv.feed.latestSeq(),
): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const controller = new AbortController();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolveDone = r));
  const reading = srv.client.events.subscribe(
    (e) => {
      events.push(e);
      if (until(events)) {
        resolveDone();
        controller.abort();
      }
    },
    { signal: controller.signal, lastEventId },
  );
  await act();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 5000);
  await Promise.race([done, reading]);
  clearTimeout(timeout);
  controller.abort();
  await reading.catch(() => undefined);
  return events;
}

describe('GET /api/v1/events (SSE)', () => {
  it('requires the bearer token', async () => {
    const res = await fetch(`${s.baseUrl}/api/v1/events`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('streams work create/update events with SSE framing', async () => {
    let workId = '';
    const events = await collect(
      s,
      (ev) => ev.some((e) => e.action === 'work.updated'),
      async () => {
        const work = await s.client.works.create({ title: '事件', markdown: 'v1' });
        workId = work.id;
        await s.client.works.patch(work.id, {
          base_revision: work.current_revision_id,
          markdown: 'v2',
        });
      },
    );
    expect(events.map((e) => [e.entity, e.entity_id, e.action])).toEqual([
      ['work', workId, 'work.created'],
      ['work', workId, 'work.updated'],
    ]);
    expect(events[1]?.seq).toBeGreaterThan(events[0]?.seq ?? Infinity);
  });

  it('emits work.external_revision when source.md was changed outside the app', async () => {
    const work = await s.client.works.create({ title: '外部', markdown: 'v1' });
    const events = await collect(
      s,
      (ev) => ev.some((e) => e.action === 'work.external_revision'),
      async () => {
        fs.writeFileSync(
          path.join(s.home, 'library', 'works', work.id, 'source.md'),
          'edited in Typora',
        );
        await s.client.works.get(work.id);
      },
    );
    const ext = events.find((e) => e.action === 'work.external_revision');
    expect(ext).toMatchObject({ entity: 'work', entity_id: work.id });
    const revisions = await s.client.works.revisions(work.id);
    expect(ext?.data['revision_id']).toBe(revisions.items[0]?.revision_id);
  });

  // QC-016: a loaded machine can attach the SSE stream later than
  // the action under test. The helper must still see events committed before it
  // attached, so it must not depend on how long attaching takes.
  it('collect sees events committed before the stream attached', async () => {
    const slowAttach: FetchLike = async (input, init) => {
      if (input.endsWith('/api/v1/events')) await new Promise((r) => setTimeout(r, 400));
      return fetch(input, init);
    };
    const client = createClient({ baseUrl: s.baseUrl, token: TEST_TOKEN, fetch: slowAttach });
    const events = await collect(
      { ...s, client },
      (ev) => ev.some((e) => e.action === 'work.created'),
      async () => {
        await s.client.works.create({ title: 'early', markdown: 'v1' });
      },
    );
    expect(events.map((e) => e.action)).toContain('work.created');
  });

  it('streams asset and job events for an upload', async () => {
    const events = await collect(
      s,
      (ev) =>
        ev.some((e) => e.action === 'asset.updated' && e.data['thumbnail_status'] === 'ready'),
      async () => {
        await s.client.assets.upload({ data: await pngBytes(), filename: 'a.png' });
      },
    );
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['asset.created', 'job.queued', 'job.running', 'asset.updated']),
    );
  });

  it('replays missed events after Last-Event-ID', async () => {
    const a = await s.client.works.create({ title: 'A' });
    const seqAfterA = s.feed.latestSeq();
    const b = await s.client.works.create({ title: 'B' });
    const c = await s.client.works.create({ title: 'C' });

    const events = await collect(
      s,
      (ev) => ev.length >= 2,
      () => Promise.resolve(),
      seqAfterA,
    );
    expect(events.map((e) => e.entity_id)).toEqual([b.id, c.id]);
    expect(events.map((e) => e.entity_id)).not.toContain(a.id);
  });

  it('does not publish changes from a rolled-back transaction', () => {
    const before = s.feed.latestSeq();
    expect(() =>
      s.db.transaction(() => {
        s.feed.record('work', 'x', 'work.updated');
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(s.feed.latestSeq()).toBe(before);
  });
});

describe('Chinese full-text search', () => {
  it('finds works by a Chinese substring of the body and by short Chinese terms', async () => {
    await s.client.works.create({ title: '秋天', markdown: '今年京都的紅葉比往年更早轉紅。' });
    await s.client.works.create({ title: 'Other', markdown: 'nothing here' });
    expect((await s.client.works.list({ q: '紅葉比往年' })).items.map((w) => w.title)).toEqual([
      '秋天',
    ]);
    expect((await s.client.works.list({ q: '秋天' })).items.map((w) => w.title)).toEqual(['秋天']);
    expect((await s.client.works.list({ q: '大阪城' })).total).toBe(0);
  });
});
