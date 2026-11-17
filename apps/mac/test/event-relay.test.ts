import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@qiu-creator/api-client';
import type { ChangeEvent } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventRelay, type Subscribe } from '../src/main/event-relay.js';
import { parseSse, readEventStream } from '../src/main/sse.js';
import type { EventStreamStatus } from '../src/shared/bridge.js';

function event(seq: number): ChangeEvent {
  return {
    seq,
    entity: 'job',
    entity_id: `j${seq}`,
    action: 'job.queued',
    data: {},
    created_at: '2026-11-17T00:00:00.000Z',
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('parseSse', () => {
  it('splits blocks, keeps comments and incomplete rest', () => {
    const { blocks, rest } = parseSse(
      'retry: 3000\n: connected seq=7\n\nid: 8\nevent: job.queued\ndata: {"a":1}\n\nid: 9\nda',
    );
    expect(blocks).toEqual([
      { comments: ['connected seq=7'], data: '' },
      { id: '8', event: 'job.queued', data: '{"a":1}', comments: [] },
    ]);
    expect(rest).toBe('id: 9\nda');
  });

  it('accepts CRLF line endings', () => {
    expect(parseSse('data: x\r\n\r\n').blocks[0]?.data).toBe('x');
  });
});

describe('EventRelay', () => {
  it('reconnects with Last-Event-ID and delivers each seq once', async () => {
    const seen: number[] = [];
    const statuses: EventStreamStatus[] = [];
    const calls: (number | undefined)[] = [];
    let round = 0;
    const holder: { relay?: EventRelay } = {};
    const subscribe: Subscribe = (handlers, options) => {
      calls.push(options.lastEventId);
      round += 1;
      if (round === 1) {
        handlers.onOpen(5);
        handlers.onEvent(event(6));
        handlers.onEvent(event(7));
        return Promise.reject(new Error('dropped'));
      }
      if (round === 2) {
        handlers.onOpen(undefined);
        handlers.onEvent(event(7)); // replayed duplicate
        handlers.onEvent(event(8));
        holder.relay?.stop();
        return Promise.resolve();
      }
      return Promise.resolve();
    };
    const relay = new EventRelay({
      connect: () => subscribe,
      onEvent: (e) => seen.push(e.seq),
      onStatus: (s) => statuses.push(s),
      sleep: noSleep,
    });
    holder.relay = relay;
    relay.start();
    await vi.waitFor(() => {
      expect(seen).toEqual([6, 7, 8]);
    });
    expect(calls).toEqual([undefined, 7]);
    expect(statuses).toEqual(['open', 'reconnecting', 'open']);
  });

  it('starts from the service-reported seq so the first reconnect does not replay history', async () => {
    const calls: (number | undefined)[] = [];
    const holder: { relay?: EventRelay } = {};
    const relay = new EventRelay({
      connect: () => (handlers, options) => {
        calls.push(options.lastEventId);
        if (calls.length === 1) {
          handlers.onOpen(42);
          return Promise.resolve();
        }
        holder.relay?.stop();
        return Promise.resolve();
      },
      onEvent: () => undefined,
      onStatus: () => undefined,
      sleep: noSleep,
    });
    holder.relay = relay;
    relay.start();
    await vi.waitFor(() => {
      expect(calls).toEqual([undefined, 42]);
    });
  });

  it('waits with backoff while no token is available', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const relay = new EventRelay({
      connect: () => {
        attempts += 1;
        return null;
      },
      onEvent: () => undefined,
      onStatus: () => undefined,
      backoffMs: [10, 20, 40],
      sleep: (ms) => {
        delays.push(ms);
        if (delays.length >= 4) relay.stop();
        return Promise.resolve();
      },
    });
    relay.start();
    await vi.waitFor(() => {
      expect(delays.length).toBe(4);
    });
    expect(delays).toEqual([20, 40, 40, 40]);
    expect(attempts).toBe(4);
    expect(relay.currentStatus).toBe('reconnecting');
  });
});

describe('readEventStream against mac-server', () => {
  const TOKEN = 'test-token-0123456789abcdef';
  let server: CreatorHubServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    await server?.app.close();
    if (home !== undefined) fs.rmSync(home, { recursive: true, force: true });
  });

  it('opens, receives live events, and resumes after the service restarts', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-sse-'));
    server = await buildServer({ config: { home, token: TOKEN } });
    const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const port = new URL(baseUrl).port;
    const client = createClient({ baseUrl, token: TOKEN });

    const received: ChangeEvent[] = [];
    const statuses: EventStreamStatus[] = [];
    const relay = new EventRelay({
      connect: () => (handlers, options) =>
        readEventStream({ baseUrl, token: TOKEN, ...options }, handlers),
      onEvent: (e) => received.push(e),
      onStatus: (s) => statuses.push(s),
      backoffMs: [20],
    });
    relay.start();
    await vi.waitFor(() => {
      expect(relay.currentStatus).toBe('open');
    });

    const first = await client.works.create({ title: 'A', type: 'article', markdown: 'a\n' });
    await vi.waitFor(() => {
      expect(received.some((e) => e.entity_id === first.id && e.action === 'work.created')).toBe(
        true,
      );
    });

    // Service goes away; a change happens while the app is disconnected.
    await server.app.close();
    await vi.waitFor(() => {
      expect(relay.currentStatus).toBe('reconnecting');
    });
    server = await buildServer({ config: { home, token: TOKEN } });
    const offline = await createClient({
      baseUrl: await server.app.listen({ host: '127.0.0.1', port: Number(port) }),
      token: TOKEN,
    }).works.create({ title: 'B', type: 'article', markdown: 'b\n' });

    await vi.waitFor(
      () => {
        expect(received.some((e) => e.entity_id === offline.id)).toBe(true);
      },
      { timeout: 5000 },
    );
    const seqs = received.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(statuses.filter((s) => s === 'open').length).toBeGreaterThanOrEqual(2);
    relay.stop();
  });

  it('rejects on a wrong token', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-sse-'));
    server = await buildServer({ config: { home, token: TOKEN } });
    const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      readEventStream(
        { baseUrl, token: 'wrong-token-0123456789', signal: new AbortController().signal },
        { onOpen: () => undefined, onEvent: () => undefined },
      ),
    ).rejects.toThrow('HTTP 401');
  });

  it('gives up on a silent stream after the idle timeout', async () => {
    const silent = (): Promise<Response> =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: () => undefined })));
    await expect(
      readEventStream(
        {
          baseUrl: 'http://127.0.0.1:1',
          token: 't',
          signal: new AbortController().signal,
          idleTimeoutMs: 30,
          fetch: silent,
        },
        { onOpen: () => undefined, onEvent: () => undefined },
      ),
    ).rejects.toThrow('idle timeout');
  });
});
