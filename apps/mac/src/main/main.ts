import os from 'node:os';
import path from 'node:path';
import { AssetRecordSchema, MountSchema } from '@qiu-creator/contracts';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  ASSET_SCHEME,
  IPC,
  type AppInfo,
  type ProxyRequest,
  type RevealTarget,
} from '../shared/bridge.js';
import { abbreviateHome, assetServicePath, forwardableRange, resolveInsideHome } from './assets.js';
import { readConnection, resolveConfig } from './config.js';
import { contentSecurityPolicy } from './csp.js';
import { EventRelay } from './event-relay.js';
import { performProxyRequest } from './proxy.js';
import { readEventStream } from './sse.js';
import { UploadManager, type UploadConnection } from './uploads.js';

/**
 * The Mac service (mac-server) is owned by launchd, not by this app. The app
 * never starts or stops it: when it is not reachable the renderer shows
 * "服務未運行" with a retry, and closing windows leaves the service alone.
 */

const devServerUrl = process.env['VITE_DEV_SERVER_URL'] ?? null;
const config = resolveConfig(process.env, app.isPackaged);

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, stream: true } },
]);

function connection(): UploadConnection | null {
  const info = readConnection(config, process.env);
  return info.ok ? { baseUrl: info.baseUrl, token: info.token } : null;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const relay = new EventRelay({
  connect: () => {
    const conn = connection();
    if (conn === null) return null;
    return (handlers, options) => readEventStream({ ...conn, ...options }, handlers);
  },
  onEvent: (event) => {
    broadcast(IPC.event, event);
  },
  onStatus: (status) => {
    broadcast(IPC.eventStatus, status);
  },
});

const uploads = new UploadManager({
  connection,
  onChange: (items) => {
    broadcast(IPC.uploadsChanged, items);
  },
});

function isProxyRequest(value: unknown): value is ProxyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['url'] === 'string' &&
    typeof v['method'] === 'string' &&
    typeof v['headers'] === 'object' &&
    v['headers'] !== null &&
    Object.values(v['headers']).every((h) => typeof h === 'string') &&
    (v['body'] === null || typeof v['body'] === 'string')
  );
}

function isRevealTarget(value: unknown): value is RevealTarget {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['kind'] === 'home') return true;
  return (v['kind'] === 'asset' || v['kind'] === 'mount') && typeof v['id'] === 'string';
}

/** Only our own renderer may use the bridge. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return devServerUrl !== null ? url.startsWith(devServerUrl) : url.startsWith('file://');
}

/** GET a JSON resource from the service with the owner token (main-process lookups only). */
async function serviceGet(pathname: string): Promise<unknown> {
  const conn = connection();
  if (conn === null) return null;
  const res = await fetch(`${conn.baseUrl}${pathname}`, {
    headers: { authorization: `Bearer ${conn.token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok ? ((await res.json()) as unknown) : null;
}

/**
 * Reveal paths the service knows about. The renderer only names an asset or
 * mount id; the main process looks the path up, so a compromised renderer
 * cannot point Finder at arbitrary locations.
 */
async function reveal(target: RevealTarget): Promise<boolean> {
  if (config.home === null) return false;
  if (target.kind === 'home') {
    await shell.openPath(config.home);
    return true;
  }
  if (target.kind === 'asset') {
    const asset = AssetRecordSchema.safeParse(
      await serviceGet(`/api/v1/assets/${encodeURIComponent(target.id)}`),
    );
    if (!asset.success) return false;
    const full = resolveInsideHome(config.home, asset.data.path);
    if (full === null) return false;
    shell.showItemInFolder(full);
    return true;
  }
  const mount = MountSchema.safeParse(
    await serviceGet(`/api/v1/mounts/${encodeURIComponent(target.id)}`),
  );
  if (!mount.success || !path.isAbsolute(mount.data.root_path)) return false;
  await shell.openPath(mount.data.root_path);
  return true;
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) throw new Error('untrusted sender');
      return fn(...args);
    });
  };

  handle(IPC.getConnection, () => readConnection(config, process.env));
  handle(IPC.request, (req) => {
    if (!isProxyRequest(req)) throw new Error('invalid request');
    return performProxyRequest(config.baseUrl, req);
  });
  handle(IPC.appInfo, (): AppInfo => ({
    home: config.home === null ? null : abbreviateHome(config.home, os.homedir()),
  }));
  handle(IPC.getEventStatus, () => {
    // A renderer asking for status after the user pressed 重試 should not wait out the backoff.
    if (relay.currentStatus === 'reconnecting') relay.restart();
    return relay.currentStatus;
  });

  handle(IPC.pickAndUpload, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: '上傳素材',
      buttonLabel: '上傳',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
    };
    const result =
      win === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options);
    return result.canceled ? 0 : uploads.add(result.filePaths);
  });
  // Paths come from the preload script (webUtils.getPathForFile on dropped File objects).
  handle(IPC.uploadPaths, (paths) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
      throw new Error('invalid paths');
    }
    return uploads.add(paths as string[]);
  });
  handle(IPC.uploads, () => uploads.list());
  handle(IPC.cancelUpload, (id) => {
    if (typeof id === 'string') uploads.cancel(id);
  });
  handle(IPC.retryUpload, (id) => {
    if (typeof id === 'string') uploads.retry(id);
  });
  handle(IPC.dismissUpload, (id) => {
    if (typeof id === 'string') uploads.dismiss(id);
  });

  handle(IPC.pickFolder, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: '掛載資料夾',
      buttonLabel: '掛載',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result =
      win === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(IPC.reveal, (target) => {
    if (!isRevealTarget(target)) throw new Error('invalid target');
    return reveal(target);
  });
  handle(IPC.copyText, async (text) => {
    if (typeof text !== 'string' || text.length > 10_000) throw new Error('invalid text');
    await clipboard.writeText(text);
  });
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

/**
 * `qc-asset://thumbnail/<id>` and `qc-asset://stream/<id>`: the main process
 * adds the token so <img>, <video> and <audio> work without it. Streams pass
 * through a single Range header and are not buffered, so seeking in a large
 * video only reads the bytes it needs.
 */
function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const target = assetServicePath(request.url);
    const conn = connection();
    if (target === null || conn === null || request.method !== 'GET') {
      return new Response(null, { status: 404 });
    }
    const headers: Record<string, string> = { authorization: `Bearer ${conn.token}` };
    const range =
      target.resource === 'stream' ? forwardableRange(request.headers.get('range')) : null;
    if (range !== null) headers['range'] = range;
    // Time out waiting for headers only; a long video may take minutes to play through.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 15_000);
    try {
      const res = await fetch(`${conn.baseUrl}${target.path}`, {
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const out = new Headers();
      for (const name of PASS_HEADERS) {
        const value = res.headers.get(name);
        if (value !== null) out.set(name, value);
      }
      if (!res.ok) return new Response(null, { status: res.status, headers: out });
      return new Response(res.body, { status: res.status, headers: out });
    } catch {
      clearTimeout(timer);
      return new Response(null, { status: 502 });
    }
  });
}

function hardenSession(): void {
  const csp = contentSecurityPolicy(devServerUrl);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'qiu-creator',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // No in-app navigation away from the renderer; external links open in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl !== null && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl !== null) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

void app.whenReady().then(() => {
  hardenSession();
  registerAssetProtocol();
  registerIpc();
  relay.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  relay.stop();
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays in the Dock. The service is independent either way.
  if (process.platform !== 'darwin') app.quit();
});
