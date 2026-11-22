import dns from 'node:dns';
import fs from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ImportErrorCode } from '@qiu-creator/contracts';
import { checkAddress } from './ip-policy.js';

/** A failed download. `retryable` failures (network, 5xx, 408/429, timeouts) may succeed later. */
export class DownloadError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, order: 'verbatim' });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export interface DownloadOptions {
  resolver?: Resolver;
  maxBytes: number;
  maxRedirects?: number;
  /** TCP/TLS connect deadline per hop. */
  connectTimeoutMs?: number;
  /** Abort when no bytes arrive for this long. */
  idleTimeoutMs?: number;
  /** Deadline for the whole download including redirects. */
  totalTimeoutMs?: number;
  /**
   * Test seam: where to actually open the socket for an already-validated
   * IP. Production never sets this; the policy checks still run on the real
   * resolved address.
   */
  connectOverride?: (address: string, port: number) => { host: string; port: number };
  /** Content types to accept instead of the import defaults (e.g. images only, QC-070). */
  allowedContentTypes?: readonly RegExp[];
  /** Cancels the download (QC-070: the user cancelled the AI job). */
  signal?: AbortSignal;
  /**
   * An origin the user configured themselves (QC-070: the New API relay,
   * which may live on the LAN): hops to exactly this origin skip the
   * public-address check. Every other hop, including redirects away from it,
   * is checked as usual.
   */
  trustedOrigin?: string;
}

export interface DownloadResult {
  finalUrl: string;
  bytes: number;
  contentType: string | null;
  /** From Content-Disposition, else the last URL path segment. */
  suggestedName: string;
}

const ALLOWED_CONTENT_TYPES = [
  /^image\//,
  /^video\//,
  /^audio\//,
  /^text\/(markdown|x-markdown|plain)$/,
  /^application\/octet-stream$/,
  /^binary\/octet-stream$/,
];

function contentTypeAllowed(
  header: string | undefined,
  allowed: readonly RegExp[] = ALLOWED_CONTENT_TYPES,
): boolean {
  // No Content-Type: let the magic-byte check decide.
  if (header === undefined || header.trim() === '') return true;
  const type = (header.split(';')[0] ?? '').trim().toLowerCase();
  return allowed.some((re) => re.test(type));
}

function filenameFrom(res: IncomingMessage, url: URL): string {
  const cd = res.headers['content-disposition'];
  if (cd !== undefined) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd)?.[1];
    if (star !== undefined) {
      try {
        return decodeURIComponent(star.trim());
      } catch {
        // fall through to plain filename
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd)?.[1];
    if (plain !== undefined && plain.trim() !== '') return plain.trim();
  }
  let base = path.posix.basename(url.pathname);
  try {
    base = decodeURIComponent(base);
  } catch {
    // keep the raw segment
  }
  return base === '' || base === '/' ? 'download' : base;
}

/** Validate scheme/host shape before any network activity. Throws `url_rejected`. */
export function assertFetchableUrl(raw: string, trustedOrigin?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadError('url_rejected', 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError(
      'url_rejected',
      `scheme ${url.protocol} is not allowed; use http or https`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new DownloadError('url_rejected', 'URLs with embedded credentials are not allowed');
  }
  if (trustedOrigin !== undefined && url.origin === trustedOrigin) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0 && !checkAddress(host).allowed) {
    throw new DownloadError('blocked_address', `address ${host} is not publicly routable`);
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new DownloadError('blocked_address', `host ${host} is local`);
  }
  return url;
}

/** Resolve once and require every returned address to be public; the first is pinned. */
async function resolvePinned(
  url: URL,
  resolver: Resolver,
  trustedOrigin?: string,
): Promise<ResolvedAddress> {
  const trusted = trustedOrigin !== undefined && url.origin === trustedOrigin;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  if (literal !== 0) {
    const verdict = checkAddress(host);
    if (!verdict.allowed && !trusted)
      throw new DownloadError('blocked_address', `address ${host} is not publicly routable`);
    return { address: host, family: literal === 6 ? 6 : 4 };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new DownloadError(
      'network_error',
      `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (addresses.length === 0)
    throw new DownloadError('network_error', `no addresses for ${host}`, true);
  for (const a of addresses) {
    if (!trusted && !checkAddress(a.address).allowed) {
      throw new DownloadError(
        'blocked_address',
        `${host} resolves to non-public address ${a.address}`,
      );
    }
  }
  const first = addresses[0];
  if (first === undefined)
    throw new DownloadError('network_error', `no addresses for ${host}`, true);
  return first;
}

class TooLarge extends Error {}

/**
 * Download `rawUrl` into `dest` with SSRF protection:
 * - http/https only, no embedded credentials;
 * - every hop's host is resolved once, all addresses must be public, and the
 *   socket is pinned to the checked IP (no second lookup → no DNS rebinding);
 * - redirects are re-validated hop by hop, at most `maxRedirects`;
 * - Content-Type allowlist, Content-Length precheck, streamed byte limit;
 * - connect, idle and total timeouts.
 * No cookies or credentials are sent; compression is refused so byte counts are real.
 */
export async function safeDownload(
  rawUrl: string,
  dest: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const resolver = options.resolver ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? 5;
  const total = new AbortController();
  const totalTimer = setTimeout(
    () => {
      total.abort(new DownloadError('timeout', 'download took too long', true));
    },
    options.totalTimeoutMs ?? 30 * 60 * 1000,
  );
  const cancel = (): void => {
    total.abort(new DownloadError('network_error', 'download cancelled'));
  };
  if (options.signal?.aborted === true) cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    let url = assertFetchableUrl(rawUrl, options.trustedOrigin);
    for (let hop = 0; ; hop++) {
      const pinned = await resolvePinned(url, resolver, options.trustedOrigin);
      const { res, failure } = await request(url, pinned, options, total.signal);
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        res.resume();
        if (hop >= maxRedirects) {
          throw new DownloadError('too_many_redirects', `more than ${maxRedirects} redirects`);
        }
        url = assertFetchableUrl(
          new URL(res.headers.location, url).toString(),
          options.trustedOrigin,
        );
        continue;
      }
      if (status !== 200) {
        res.resume();
        const retryable = status >= 500 || status === 408 || status === 429;
        throw new DownloadError('http_error', `server answered HTTP ${status}`, retryable);
      }
      const contentType = res.headers['content-type'];
      if (!contentTypeAllowed(contentType, options.allowedContentTypes)) {
        res.resume();
        throw new DownloadError(
          'unsupported_content_type',
          `content type ${String(contentType)} is not allowed`,
        );
      }
      const declared = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        res.destroy();
        throw new DownloadError(
          'payload_too_large',
          `declared size ${declared} exceeds ${options.maxBytes} bytes`,
        );
      }

      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > options.maxBytes) cb(new TooLarge());
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(res, counter, fs.createWriteStream(dest, { flags: 'wx' }), {
          signal: total.signal,
        });
      } catch (err) {
        fs.rmSync(dest, { force: true });
        if (err instanceof TooLarge) {
          throw new DownloadError(
            'payload_too_large',
            `download exceeded ${options.maxBytes} bytes`,
          );
        }
        throw failure() ?? toDownloadError(err, total.signal);
      }
      return {
        finalUrl: url.toString(),
        bytes,
        contentType: contentType ?? null,
        suggestedName: filenameFrom(res, url),
      };
    }
  } catch (err) {
    throw toDownloadError(err, total.signal);
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

function toDownloadError(err: unknown, total: AbortSignal): DownloadError {
  if (err instanceof DownloadError) return err;
  if (total.aborted && total.reason instanceof DownloadError) return total.reason;
  const message = err instanceof Error ? err.message : String(err);
  return new DownloadError('network_error', message, true);
}

/**
 * Open one GET. `failure()` reports a timeout raised by this request after the
 * response started (the body stream itself only says "aborted").
 */
function request(
  url: URL,
  pinned: ResolvedAddress,
  options: DownloadOptions,
  signal: AbortSignal,
): Promise<{ res: IncomingMessage; failure: () => DownloadError | undefined }> {
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port === '' ? defaultPort : Number(url.port);
  const target = options.connectOverride?.(pinned.address, port) ?? { host: pinned.address, port };
  const family = net.isIP(target.host) === 6 ? 6 : 4;
  // Hand the pinned address to the socket instead of letting Node re-resolve the name.
  const lookup: LookupFunction = (_hostname, opts, cb) => {
    if (opts.all === true) {
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: target.host, family },
      ]);
    } else {
      cb(null, target.host, family);
    }
  };
  const transport = url.protocol === 'https:' ? https : http;

  let failure: DownloadError | undefined;
  const fail = (err: DownloadError): DownloadError => {
    failure ??= err;
    return failure;
  };
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      lookup,
      agent: false,
      signal,
      headers: {
        host: url.host,
        'user-agent': 'CreatorHub-Importer/1.0',
        accept: '*/*',
        'accept-encoding': 'identity',
      },
    });
    const connectTimer = setTimeout(() => {
      req.destroy(
        fail(new DownloadError('timeout', `could not connect to ${url.host} in time`, true)),
      );
    }, options.connectTimeoutMs ?? 10_000);
    req.on('socket', (socket) => {
      const clear = (): void => {
        clearTimeout(connectTimer);
      };
      if (socket.connecting)
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', clear);
      else clear();
    });
    req.setTimeout(options.idleTimeoutMs ?? 60_000, () => {
      req.destroy(fail(new DownloadError('timeout', `no data from ${url.host} in time`, true)));
    });
    req.on('response', (res) => {
      clearTimeout(connectTimer);
      res.on('error', () => undefined); // surfaced through pipeline
      resolve({ res, failure: () => failure });
    });
    req.on('error', (err) => {
      clearTimeout(connectTimer);
      reject(toDownloadError(err, signal));
    });
    req.end();
  });
}
