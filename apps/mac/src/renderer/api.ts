import {
  ApiError,
  createClient,
  type CreatorHubClient,
  type FetchLike,
} from '@qiu-creator/api-client';
import type { CreatorHubBridge, ProxyRequest, ProxyResponse } from '../shared/bridge.js';

/** Turn a fetch call into a bridge request (headers flattened, body as text). */
export function toProxyRequest(input: string, init: RequestInit = {}): ProxyRequest {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('only string bodies are supported');
  }
  return { url: input, method: init.method ?? 'GET', headers, body: body ?? null };
}

export function fromProxyResponse(res: ProxyResponse): Response {
  const nullBody = res.status === 204 || res.status === 304;
  return new Response(nullBody ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export function bridgeFetch(request: (req: ProxyRequest) => Promise<ProxyResponse>): FetchLike {
  return async (input, init) => fromProxyResponse(await request(toProxyRequest(input, init)));
}

export type ConnectResult =
  | { ok: true; client: CreatorHubClient; baseUrl: string }
  | { ok: false; reason: 'home_missing' | 'service_down' | 'unauthorized'; baseUrl: string };

/** Resolve the token, then prove the service is up and accepts it. */
export async function connect(
  bridge: Pick<CreatorHubBridge, 'getConnection' | 'request'>,
): Promise<ConnectResult> {
  const info = await bridge.getConnection();
  if (!info.ok) {
    return {
      ok: false,
      reason: info.reason === 'home_missing' ? 'home_missing' : 'service_down',
      baseUrl: info.baseUrl,
    };
  }
  const client = createClient({
    baseUrl: info.baseUrl,
    token: info.token,
    fetch: bridgeFetch(bridge.request),
  });
  try {
    await client.health();
    await client.works.list({ limit: 1 });
  } catch (err) {
    const reason = err instanceof ApiError && err.status === 401 ? 'unauthorized' : 'service_down';
    return { ok: false, reason, baseUrl: info.baseUrl };
  }
  return { ok: true, client, baseUrl: info.baseUrl };
}

declare global {
  interface Window {
    creatorhub?: CreatorHubBridge;
  }
}
