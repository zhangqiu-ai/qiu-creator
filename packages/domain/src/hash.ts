import { createHash } from 'node:crypto';

/** Lowercase hex sha256 of a UTF-8 string or raw bytes. */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
