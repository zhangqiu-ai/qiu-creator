/**
 * Contract between the preload script and the renderer. The renderer has no
 * Node or Electron access; everything it needs from the main process goes
 * through `window.creatorhub`.
 */

export type ConnectionInfo =
  | { ok: true; baseUrl: string; token: string }
  | { ok: false; reason: 'home_missing' | 'token_missing'; detail: string };

export interface ProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface CreatorHubBridge {
  /** Re-reads the token each call, so a service started after the app is picked up. */
  getConnection: () => Promise<ConnectionInfo>;
  /** HTTP request to the Mac service, sent by the main process (no CORS needed on the service). */
  request: (req: ProxyRequest) => Promise<ProxyResponse>;
}

export const IPC = {
  getConnection: 'creatorhub:get-connection',
  request: 'creatorhub:request',
} as const;
