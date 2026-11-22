/**
 * Contract between the preload script and the renderer. The renderer has no
 * Node or Electron access; everything it needs from the main process goes
 * through `window.creatorhub`.
 */
import type { ChangeEvent, UploadAssetResponse } from '@qiu-creator/contracts';
import type { LanguagePreference, Locale } from '@qiu-creator/i18n';
import type { PersistedTabs } from './tabs.js';

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
  /** The user's home directory, to show other paths (mount folders) as `~/…`. */
  userHome: string;
}

export type RevealTarget =
  | { kind: 'home' }
  /** `<CREATORHUB_HOME>/backups` (QC-031). */
  | { kind: 'backups' }
  | { kind: 'asset'; id: string }
  | { kind: 'mount'; id: string }
  /** An external work's file (QC-052); managed works have none to show. */
  | { kind: 'work'; id: string };

/** 外觀: follow macOS, or pin light or dark (QC-038). */
export type ThemeSource = 'system' | 'light' | 'dark';

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
  /** Queue dropped files for insertion into a work (QC-039); resolves with their upload ids. */
  insertFiles: (files: readonly File[]) => Promise<string[]>;
  /**
   * Queue bytes without a file on disk (a pasted clipboard image, QC-039): the
   * main process keeps them in a temporary file until the upload settles.
   */
  insertBytes: (name: string, data: Uint8Array) => Promise<string>;
  /**
   * Upload the JPEG frame the App grabbed for a video card with `needs_frame`
   * (QC-061); the main process adds the token and checks every argument.
   */
  putCardFrame: (
    workId: string,
    data: Uint8Array,
    frame: { version: string; source: string; timeSeconds: number },
  ) => Promise<{ ok: boolean; status: number; code: string | null }>;

  /** Opens the system folder picker; resolves with the absolute path or null when cancelled. */
  pickFolder: () => Promise<string | null>;
  reveal: (target: RevealTarget) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
  /** The saved theme choice (applied by the main process before the window paints). */
  getTheme: () => Promise<ThemeSource>;
  /** Save and apply a theme choice to every window. */
  setTheme: (theme: ThemeSource) => Promise<void>;
  /** The language choice and the language in use (QC-042). */
  getLanguage: () => Promise<LanguageState>;
  /** Save a language choice; every window, the menu and dialogs switch at once. */
  setLanguage: (preference: LanguagePreference) => Promise<LanguageState>;
  /** The language in use changed (a new choice, or macOS changed while following the system). */
  onLanguage: (listener: (state: LanguageState) => void) => () => void;
  /** Editor tabs saved at the last launch (QC-047), or null. */
  getTabs: () => Promise<PersistedTabs | null>;
  /** Save the open tabs to the app preferences. */
  setTabs: (tabs: PersistedTabs) => Promise<void>;
  /** A tab command from the native menu (⌘W, ⌘⇧[ ], ⌘1–9). */
  onTabCommand: (listener: (command: TabCommand) => void) => () => void;
}

/**
 * Editor tab commands sent by the menu bar (QC-047). `close` is ⌘W: the
 * renderer closes the visible tab, or the window when no tab is showing.
 */
export type TabCommand =
  | 'close'
  | 'next'
  | 'previous'
  | `jump-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  /** 設定… (⌘,) in the app menu (QC-057): opens 設定 on the page shown last. */
  | 'settings';

export const TAB_COMMANDS: readonly TabCommand[] = [
  'settings',
  'close',
  'next',
  'previous',
  'jump-1',
  'jump-2',
  'jump-3',
  'jump-4',
  'jump-5',
  'jump-6',
  'jump-7',
  'jump-8',
  'jump-9',
];

/** 設定 → 外觀 → 語言 (QC-042): the choice, and what it resolves to right now. */
export interface LanguageState {
  preference: LanguagePreference;
  locale: Locale;
  /** The language macOS prefers, shown on the 跟隨系統 card. */
  systemLocale: Locale;
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
  insertPaths: 'creatorhub:insert-paths',
  insertBytes: 'creatorhub:insert-bytes',
  putCardFrame: 'creatorhub:put-card-frame',
  pickFolder: 'creatorhub:pick-folder',
  reveal: 'creatorhub:reveal',
  copyText: 'creatorhub:copy-text',
  getTheme: 'creatorhub:get-theme',
  setTheme: 'creatorhub:set-theme',
  getLanguage: 'creatorhub:get-language',
  setLanguage: 'creatorhub:set-language',
  languageChanged: 'creatorhub:language-changed',
  getTabs: 'creatorhub:get-tabs',
  setTabs: 'creatorhub:set-tabs',
  tabCommand: 'creatorhub:tab-command',
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
