import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '@qiu-creator/contracts';
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export function errorBody(
  code: ErrorResponse['error']['code'],
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
