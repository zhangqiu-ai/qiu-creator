import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DownloadSettings } from '../src/imports/import-service.js';
import type { ResolvedAddress, Resolver } from '../src/net/safe-download.js';

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * A local stand-in for the internet. Tests never reach real hosts: fake DNS
 * maps names to (public-looking) addresses, the importer validates those, and
 * `connectOverride` sends the pinned connection here instead.
 */
export interface Upstream {
  port: number;
  /** Route table: path → handler. Missing paths answer 404. */
  routes: Map<string, Handler>;
  /** Paths requested, in order. */
  hits: string[];
  /** Pinned addresses the importer asked to connect to, in order. */
  connects: string[];
  /** Hostnames looked up through the fake resolver, in order. */
  lookups: string[];
  /** Fake DNS: name → answers; a function lets a test change answers per call (rebinding). */
  dns: Map<string, ResolvedAddress[] | ((call: number) => ResolvedAddress[])>;
  resolver: Resolver;
  download: (extra?: Partial<DownloadSettings>) => DownloadSettings;
  close: () => Promise<void>;
}

export const PUBLIC_IP = '93.184.216.34';
export const PUBLIC_IP_2 = '151.101.1.69';

export const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });

export async function startUpstream(): Promise<Upstream> {
  const routes = new Map<string, Handler>();
  const hits: string[] = [];
  const connects: string[] = [];
  const lookups: string[] = [];
  const dns: Upstream['dns'] = new Map([
    ['cdn.example.com', [v4(PUBLIC_IP)]],
    ['other.example.net', [v4(PUBLIC_IP_2)]],
    ['internal.example.com', [v4('10.0.0.5')]],
  ]);
  const calls = new Map<string, number>();
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    hits.push(pathname);
    const handler = routes.get(pathname);
    if (handler) handler(req, res);
    else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const resolver: Resolver = (hostname) => {
    lookups.push(hostname);
    const n = (calls.get(hostname) ?? 0) + 1;
    calls.set(hostname, n);
    const entry = dns.get(hostname);
    if (entry === undefined) return Promise.reject(new Error(`ENOTFOUND ${hostname}`));
    return Promise.resolve(typeof entry === 'function' ? entry(n) : entry);
  };

  return {
    port,
    routes,
    hits,
    connects,
    lookups,
    dns,
    resolver,
    download: (extra = {}) => ({
      resolver,
      connectOverride: (address) => {
        connects.push(address);
        return { host: '127.0.0.1', port };
      },
      connectTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      ...extra,
    }),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      });
    },
  };
}

/** Serve fixed bytes with a content type. */
export function serve(
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): Handler {
  return (_req, res) => {
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(body.length),
      ...extra,
    });
    res.end(body);
  };
}

export function redirect(location: string, status = 302): Handler {
  return (_req, res) => {
    res.writeHead(status, { location });
    res.end();
  };
}
