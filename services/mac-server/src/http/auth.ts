import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of a presented Authorization header against the expected token. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;
  // Hash both sides so the comparison is fixed-length and leaks nothing about token length.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}
