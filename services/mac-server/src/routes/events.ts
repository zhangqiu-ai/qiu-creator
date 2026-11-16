import type { ServerResponse } from 'node:http';
import { EVENTS_PATH, type ChangeEvent } from '@qiu-creator/contracts';
import { z } from 'zod';
import type { ChangeFeed } from '../events/change-feed.js';
import type { App } from '../http/app-type.js';

export const HEARTBEAT_MS = 15_000;

const EventsQuerySchema = z.object({
  /** Resume after this seq (same as the `Last-Event-ID` header, which wins when both are sent). */
  since: z.coerce.number().int().min(0).optional(),
});

function writeEvent(res: ServerResponse, event: ChangeEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.action}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * `GET /api/v1/events`: Server-Sent Events for work, asset and job changes.
 * Requires the bearer token like every `/api` route, so clients use a
 * fetch-based SSE reader (browser `EventSource` cannot send headers; tokens
 * are never accepted in the URL). Reconnecting with `Last-Event-ID` replays
 * missed events from the durable change log.
 */
export function registerEventRoutes(app: App, feed: ChangeFeed, heartbeatMs = HEARTBEAT_MS): void {
  const open = new Set<ServerResponse>();

  // End streams before Fastify waits for connections to drain on close.
  app.addHook('preClose', (done) => {
    for (const res of open) res.end();
    open.clear();
    done();
  });

  app.get(
    EVENTS_PATH,
    {
      schema: {
        description:
          'Server-Sent Events stream of change events (event name = action, id = seq, data = ChangeEvent JSON). Send `Last-Event-ID` or `?since=` to replay missed events. A `: ping` comment is sent every 15s.',
        querystring: EventsQuerySchema,
      },
    },
    (req, reply) => {
      const header = req.headers['last-event-id'];
      const fromHeader =
        typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : undefined;
      const since = fromHeader ?? req.query.since ?? feed.latestSeq();

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 3000\n: connected seq=${since}\n\n`);
      open.add(res);

      // Subscribe before replaying so nothing committed in between is lost; dedupe by seq.
      let last = since;
      const send = (event: ChangeEvent): void => {
        if (event.seq <= last) return;
        last = event.seq;
        writeEvent(res, event);
      };
      const unsubscribe = feed.subscribe(send);
      for (let batch = feed.since(since); batch.length > 0; batch = feed.since(last)) {
        for (const event of batch) send(event);
      }

      const ping = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      ping.unref();
      const cleanup = (): void => {
        clearInterval(ping);
        unsubscribe();
        open.delete(res);
      };
      req.raw.on('close', cleanup);
      res.on('close', cleanup);
    },
  );
}
