/**
 * Contract between the preload script and the renderer. The renderer has no
 * Node or Electron access; everything it needs from the main process goes
 * through `window.creatorhub`.
 */
import type { ChangeEvent, UploadAssetResponse } from '@qiu-creator/contracts';

export type ConnectionInfo =
  | { ok: true; baseUrl: string; token: string }
  | { ok: false; reason: 'home_missing' | 'token_missing'; detail: string; baseUrl: string };

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

/** State of the main process's single SSE subscription to the service. */
export type EventStreamStatus = 'connecting' | 'open' | 'reconnecting';

export type UploadState = 'queued' | 'uploading' | 'succeeded' | 'failed' | 'cancelled';

/**
 * A file upload run by the main process. Uploads read straight from disk, so
 * large videos never pass through the renderer.
 */
export interface UploadItem {
  id: string;
  filename: string;
  bytes: number;
  sentBytes: number;
  state: UploadState;
  /** `direct` for files up to the single-request limit, otherwise tus. */
  transport: 'direct' | 'tus';
  error: string | null;
  /** Service error code when the service rejected the file. */
  errorCode: string | null;
  result: UploadAssetResponse | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppInfo {
  /** CREATORHUB_HOME as shown to the user (home directory abbreviated to `~`), or null. */
  home: string | null;
}

export type RevealTarget =
  { kind: 'home' } | { kind: 'asset'; id: string } | { kind: 'mount'; id: string };

export interface CreatorHubBridge {
  /** Re-reads the token each call, so a service started after the app is picked up. */
  getConnection: () => Promise<ConnectionInfo>;
  /** HTTP request to the Mac service, sent by the main process (no CORS needed on the service). */
  request: (req: ProxyRequest) => Promise<ProxyResponse>;
  appInfo: () => Promise<AppInfo>;

  /** Change events from the service's SSE feed. Returns an unsubscribe function. */
  onEvent: (listener: (event: ChangeEvent) => void) => () => void;
  onEventStatus: (listener: (status: EventStreamStatus) => void) => () => void;
  eventStatus: () => Promise<EventStreamStatus>;

  /** Opens the system file picker; chosen files are queued for upload. */
  pickAndUpload: () => Promise<number>;
  /** Queue files dropped onto the window. */
  uploadFiles: (files: readonly File[]) => Promise<number>;
  uploads: () => Promise<UploadItem[]>;
  onUploads: (listener: (items: UploadItem[]) => void) => () => void;
  cancelUpload: (id: string) => Promise<void>;
  retryUpload: (id: string) => Promise<void>;
  dismissUpload: (id: string) => Promise<void>;

  /** Opens the system folder picker; resolves with the absolute path or null when cancelled. */
  pickFolder: () => Promise<string | null>;
  reveal: (target: RevealTarget) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
}

export const IPC = {
  getConnection: 'creatorhub:get-connection',
  request: 'creatorhub:request',
  appInfo: 'creatorhub:app-info',
  event: 'creatorhub:event',
  eventStatus: 'creatorhub:event-status',
  getEventStatus: 'creatorhub:get-event-status',
  pickAndUpload: 'creatorhub:pick-and-upload',
  uploadPaths: 'creatorhub:upload-paths',
  uploads: 'creatorhub:uploads',
  uploadsChanged: 'creatorhub:uploads-changed',
  cancelUpload: 'creatorhub:cancel-upload',
  retryUpload: 'creatorhub:retry-upload',
  dismissUpload: 'creatorhub:dismiss-upload',
  pickFolder: 'creatorhub:pick-folder',
  reveal: 'creatorhub:reveal',
  copyText: 'creatorhub:copy-text',
} as const;

/**
 * Custom scheme the main process serves with the token added:
 * `qc-asset://thumbnail/<id>` and `qc-asset://stream/<id>` (Range supported).
 */
export const ASSET_SCHEME = 'qc-asset';

export function thumbnailUrl(assetId: string): string {
  return `${ASSET_SCHEME}://thumbnail/${encodeURIComponent(assetId)}`;
}

/**
 * URL for the original file, for <img>, <video> and <audio>. The only place
 * that decides how media URLs are made: today a main-process proxy that adds
 * the token; QC-010 may replace it with signed URLs without touching callers.
 */
export function assetMediaUrl(assetId: string): string {
  return `${ASSET_SCHEME}://stream/${encodeURIComponent(assetId)}`;
}
