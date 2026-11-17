import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { ServiceError } from '../errors.js';

const KEY_BYTES = 32;
/** Default lifetime of a signed media URL. Long enough for a video to be watched and seeked. */
export const DEFAULT_SIGNED_URL_TTL_MS = 60 * 60 * 1000;

export interface SignedUrl {
  /** Path plus query, relative to the server base URL. */
  url: string;
  expiresAt: Date;
}

export interface SignedQuery {
  exp?: string | undefined;
  p?: string | undefined;
  sig?: string | undefined;
}

/**
 * Load the HMAC key from `keyFile`, creating it (mode 0600) on first use. The
 * key lives with the data, so signed URLs survive restarts; deleting the file
 * and restarting invalidates every URL already handed out.
 */
export function loadOrCreateSigningKey(keyFile: string): Buffer {
  try {
    fs.writeFileSync(keyFile, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
  }
  const key = fs.readFileSync(keyFile);
  if (key.length !== KEY_BYTES) {
    throw new Error(`media signing key ${keyFile} is corrupt (expected ${KEY_BYTES} bytes)`);
  }
  return key;
}

/**
 * Short-lived, path-bound signed URLs for media that must load without an
 * Authorization header (`<img>`/`<video>` in the Electron renderer, later a
 * WebView on iPhone/iPad).
 *
 * The signature covers the exact canonical path, the expiry and the principal
 * that asked for it, so a URL opens one file only, only until it expires, and
 * only while that principal's token is still valid (a revoked agent token kills
 * its URLs immediately). The bearer token itself never appears in a URL.
 */
export class MediaUrlSigner {
  constructor(
    private readonly key: Buffer,
    readonly ttlMs: number = DEFAULT_SIGNED_URL_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Expiry shared by every URL signed in one response, rounded to whole seconds. */
  expiry(): Date {
    return new Date(Math.floor((this.now() + this.ttlMs) / 1000) * 1000);
  }

  sign(pathname: string, principalId: string, expiresAt: Date = this.expiry()): SignedUrl {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const params = new URLSearchParams({
      exp: String(exp),
      p: principalId,
      sig: this.mac(pathname, principalId, exp),
    });
    return { url: `${pathname}?${params.toString()}`, expiresAt };
  }

  /**
   * Check a signed request for `pathname` (the canonical path rebuilt from the
   * route params, never the raw URL). Returns the principal id and the seconds
   * left. Every failure is the same 403 so the response reveals nothing.
   */
  verify(pathname: string, query: SignedQuery): { principalId: string; secondsLeft: number } {
    const { exp, p, sig } = query;
    if (exp === undefined || p === undefined || sig === undefined || !/^\d{1,12}$/.test(exp)) {
      throw invalid();
    }
    const expSeconds = Number(exp);
    const secondsLeft = expSeconds - Math.floor(this.now() / 1000);
    // Expired, or further out than this server would ever sign (forged/old key).
    if (secondsLeft <= 0 || secondsLeft > Math.ceil(this.ttlMs / 1000) + 1) throw invalid();
    const expected = Buffer.from(this.mac(pathname, p, expSeconds), 'base64url');
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    return { principalId: p, secondsLeft };
  }

  private mac(pathname: string, principalId: string, exp: number): string {
    return createHmac('sha256', this.key)
      .update(`v1\n${principalId}\n${String(exp)}\n${pathname}`)
      .digest('base64url');
  }
}

function invalid(): ServiceError {
  return new ServiceError(403, 'forbidden', 'media link is invalid or expired');
}

/** Path with every segment percent-encoded: the single canonical form that gets signed. */
export function encodePathSegments(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** Remove signature parameters from a URL before it is logged. */
export function redactSignedUrl(url: string): string {
  return url.replace(/([?&]sig=)[^&]*/g, '$1[REDACTED]');
}
