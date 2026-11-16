import type { ErrorCode } from '@qiu-creator/contracts';

/** An expected failure that maps to a uniform `{ error: { code, message, details } }` response. */
export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export const notFound = (what: string): ServiceError =>
  new ServiceError(404, 'not_found', `${what} not found`);
