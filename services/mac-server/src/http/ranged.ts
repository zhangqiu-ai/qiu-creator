import { parseRange } from '@qiu-creator/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StreamTarget } from '../assets/asset-service.js';
import { errorBody } from './app-type.js';

/**
 * Send an opened file with HTTP Range support (200 / 206 / 416). The stream is
 * always bounded to the stat'ed size: an unbounded stream kept keep-alive
 * connections busy after the body was sent (blocking `app.close()`), and the
 * bound keeps Content-Length truthful if the file grows while streaming.
 */
export function sendRanged(
  req: FastifyRequest,
  reply: FastifyReply,
  target: StreamTarget,
): FastifyReply {
  reply.header('accept-ranges', 'bytes').header('content-type', target.mimeType);
  const range = parseRange(req.headers.range, target.size);
  if (range.kind === 'unsatisfiable') {
    target.close();
    return reply
      .code(416)
      .header('content-range', `bytes */${String(target.size)}`)
      .header('content-type', 'application/json; charset=utf-8')
      .send(errorBody('range_not_satisfiable', 'requested range is outside the file'));
  }
  if (range.kind === 'partial') {
    const { start, end } = range.range;
    return reply
      .code(206)
      .header('content-range', `bytes ${String(start)}-${String(end)}/${String(target.size)}`)
      .header('content-length', end - start + 1)
      .send(target.open(start, end));
  }
  if (target.size === 0) {
    target.close();
    return reply.code(200).header('content-length', 0).send(Buffer.alloc(0));
  }
  return reply
    .code(200)
    .header('content-length', target.size)
    .send(target.open(0, target.size - 1));
}
