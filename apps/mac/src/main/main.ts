import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetRecordSchema, MountSchema, WorkSchema } from '@qiu-creator/contracts';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import { isLanguagePreference } from '@qiu-creator/i18n';
import {
  ASSET_SCHEME,
  IPC,
  type AppInfo,
  type MotionPreference,
  type ProxyRequest,
  type RevealTarget,
} from '../shared/bridge.js';
import { motionPreference } from './motion.js';
import { parsePersistedTabs } from '../shared/tabs.js';
import {
  APP_INDEX_URL,
  APP_SCHEME,
  appFilePath,
  appResponseHeaders,
  isAppUrl,
  rendererOrigin,
} from './app-protocol.js';
import { abbreviateHome, assetServicePath, forwardableRange, resolveInsideHome } from './assets.js';
import { readConnection, resolveConfig } from './config.js';
import { cardFrameRequest } from './card-frame.js';
import { contentSecurityPolicy } from './csp.js';
import { LanguageController } from './language.js';
import { menuTemplate } from './menu.js';
import {
  isThemeSource,
  migrateLanguage,
  readPreferences,
  writePreferences,
} from './preferences.js';
import { EventRelay } from './event-relay.js';
import { PasteFiles } from './paste-files.js';
import { performProxyRequest } from './proxy.js';
import { readEventStream } from './sse.js';
import { UploadManager, type UploadConnection } from './uploads.js';

/**
 * The Mac service (mac-server) is owned by launchd, not by this app. The app
 * never starts or stops it: when it is not reachable the renderer shows
 * "服務未運行" with a retry, and closing windows leaves the service alone.
 */

// e2e against a packaged build (QC-061): the e2e entry script, which sets the test
// profile in development, cannot run inside a packaged app, so the profile is set here.
// The real app never sets this variable.
const e2eProfile = process.env['CREATORHUB_E2E_PROFILE'];
if (e2eProfile !== undefined && e2eProfile !== '') {
  app.setPath('userData', e2eProfile);
  app.setPath('sessionData', e2eProfile);
}
const devServerUrl = process.env['VITE_DEV_SERVER_URL'] ?? null;
/**
 * e2e sets this so a run never takes the user's screen: no Dock icon or ⌘Tab entry (QC-060),
 * windows are never shown on any screen (QC-064; Playwright drives and captures them over
 * CDP), no native dialogs, Finder is not opened. The real app never sets it.
 */
const backgroundRun = process.env['CREATORHUB_E2E_BACKGROUND'] === '1';
const config = resolveConfig(process.env, app.isPackaged);

protocol.registerSchemesAsPrivileged([
  // corsEnabled (QC-046): the video editor draws a frame of a `crossorigin` video onto a canvas.
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, stream: true, corsEnabled: true },
  },
  // The built renderer (QC-031): a secure origin of its own, so 'self' and module scripts work.
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function connection(): UploadConnection | null {
  const info = readConnection(config, process.env);
  return info.ok ? { baseUrl: info.baseUrl, token: info.token } : null;
}

function currentMotion(): MotionPreference {
  return motionPreference(process.env, backgroundRun, powerMonitor.getCurrentThermalState());
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

/** Pasted images are queued from temporary files (QC-039); see PasteFiles. */
// Under this profile's userData, not the shared temp folder: a second instance (dev, tests)
// clearing it at start must not touch another instance's pastes.
const pasteFiles = new PasteFiles(path.join(app.getPath('userData'), 'qiu-creator-paste'));
// Anything left by a crash or a forced quit goes now.
pasteFiles.clearAll();

const uploads = new UploadManager({
  connection,
  t: (key, params) => language().t(key, params),
  onChange: (items) => {
    broadcast(IPC.uploadsChanged, items);
    pasteFiles.settle(items);
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
  if (v['kind'] === 'home' || v['kind'] === 'backups') return true;
  return (
    (v['kind'] === 'asset' || v['kind'] === 'mount' || v['kind'] === 'work') &&
    typeof v['id'] === 'string'
  );
}

/** Only our own renderer may use the bridge. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url ?? '', devServerUrl);
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
/** Opens Finder; a background run does not (QC-060), the answers stay what a real open gives. */
const finder = {
  openPath: (p: string): Promise<string> =>
    backgroundRun ? Promise.resolve('') : shell.openPath(p),
  showItemInFolder: (p: string): void => {
    if (!backgroundRun) shell.showItemInFolder(p);
  },
};

async function reveal(target: RevealTarget): Promise<boolean> {
  if (config.home === null) return false;
  if (target.kind === 'home') {
    await finder.openPath(config.home);
    return true;
  }
  if (target.kind === 'backups') {
    // shell.openPath answers with an error message (not a throw) when the folder is missing.
    return (await finder.openPath(path.join(config.home, 'backups'))) === '';
  }
  if (target.kind === 'asset') {
    const asset = AssetRecordSchema.safeParse(
      await serviceGet(`/api/v1/assets/${encodeURIComponent(target.id)}`),
    );
    if (!asset.success) return false;
    const mountId = asset.data.mount_id ?? null;
    let root = config.home;
    if (mountId !== null) {
      // Mounted files are indexed in place; their path is relative to the mount root.
      const mount = MountSchema.safeParse(
        await serviceGet(`/api/v1/mounts/${encodeURIComponent(mountId)}`),
      );
      if (!mount.success || !path.isAbsolute(mount.data.root_path)) return false;
      root = mount.data.root_path;
    }
    const full = resolveInsideHome(root, asset.data.path);
    if (full === null) return false;
    finder.showItemInFolder(full);
    return true;
  }
  if (target.kind === 'work') {
    // Only an external work has a file of its own to show (QC-052): its mount root plus its path.
    const work = WorkSchema.safeParse(
      await serviceGet(`/api/v1/works/${encodeURIComponent(target.id)}`),
    );
    if (!work.success) return false;
    const { mount_id: mountId, external_path: rel } = work.data;
    if (work.data.storage_mode !== 'external' || mountId == null || rel == null) return false;
    const mount = MountSchema.safeParse(
      await serviceGet(`/api/v1/mounts/${encodeURIComponent(mountId)}`),
    );
    if (!mount.success || !path.isAbsolute(mount.data.root_path)) return false;
    const full = resolveInsideHome(mount.data.root_path, rel);
    if (full === null) return false;
    finder.showItemInFolder(full);
    return true;
  }
  const mount = MountSchema.safeParse(
    await serviceGet(`/api/v1/mounts/${encodeURIComponent(target.id)}`),
  );
  if (!mount.success || !path.isAbsolute(mount.data.root_path)) return false;
  await finder.openPath(mount.data.root_path);
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
  handle(IPC.motionMode, () => currentMotion());
  handle(IPC.request, (req) => {
    if (!isProxyRequest(req)) throw new Error('invalid request');
    return performProxyRequest(config.baseUrl, req);
  });
  handle(IPC.appInfo, (): AppInfo => ({
    home: config.home === null ? null : abbreviateHome(config.home, os.homedir()),
    userHome: os.homedir(),
  }));
  handle(IPC.getEventStatus, () => {
    // A renderer asking for status after the user pressed 重試 should not wait out the backoff.
    if (relay.currentStatus === 'reconnecting') relay.restart();
    return relay.currentStatus;
  });

  handle(IPC.pickAndUpload, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: language().t('main.pickUploadTitle'),
      buttonLabel: language().t('main.pickUploadButton'),
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
    };
    // No native dialog in a background run: it would take focus (QC-060).
    if (backgroundRun) return 0;
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
  handle(IPC.insertPaths, (paths) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
      throw new Error('invalid paths');
    }
    return uploads.addWithIds(paths as string[]);
  });
  handle(IPC.putCardFrame, async (workId, data, frame) => {
    const req = cardFrameRequest(workId, data, frame);
    const conn = connection();
    if (req === null) throw new Error('invalid card frame');
    if (conn === null) return { ok: false, status: 0, code: null };
    const res = await fetch(`${conn.baseUrl}${req.path}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${conn.token}`,
        'content-type': 'image/jpeg',
        accept: 'application/json',
      },
      body: Buffer.from(req.body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    let code: string | null = null;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      code = typeof body?.error?.code === 'string' ? body.error.code : null;
    }
    return { ok: res.ok, status: res.status, code };
  });
  handle(IPC.insertBytes, async (name, data) => {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) throw new Error('invalid paste');
    const file = await pasteFiles.write(name, data);
    const [id] = await uploads.addWithIds([file]);
    if (id === undefined) throw new Error('could not queue the pasted file');
    pasteFiles.track(id, file);
    return id;
  });
  handle(IPC.uploads, () => uploads.list());
  handle(IPC.cancelUpload, (id) => {
    if (typeof id === 'string') uploads.cancel(id);
  });
  handle(IPC.retryUpload, (id) => {
    if (typeof id === 'string') uploads.retry(id);
  });
  handle(IPC.dismissUpload, (id) => {
    if (typeof id !== 'string') return;
    uploads.dismiss(id);
    // 移除 on a failed pasted image: its temporary file is no longer needed.
    pasteFiles.release(id);
  });

  handle(IPC.pickFolder, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: language().t('main.pickFolderTitle'),
      buttonLabel: language().t('main.pickFolderButton'),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    if (backgroundRun) return null;
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
  handle(IPC.getTheme, () => readPreferences(preferencesFile()).theme);
  handle(IPC.setTheme, (theme) => {
    if (!isThemeSource(theme)) throw new Error('invalid theme');
    writePreferences(preferencesFile(), { ...readPreferences(preferencesFile()), theme });
    // Drives prefers-color-scheme in every window and the native controls.
    nativeTheme.themeSource = theme;
  });
  handle(IPC.getLanguage, () => language().current);
  handle(IPC.setLanguage, (preference) => {
    if (!isLanguagePreference(preference)) throw new Error('invalid language');
    writePreferences(preferencesFile(), {
      ...readPreferences(preferencesFile()),
      language: preference,
    });
    return language().setPreference(preference);
  });
  handle(IPC.getTabs, () => readPreferences(preferencesFile()).tabs);
  handle(IPC.setTabs, (tabs) => {
    const parsed = parsePersistedTabs(tabs);
    if (parsed === null) throw new Error('invalid tabs');
    writePreferences(preferencesFile(), { ...readPreferences(preferencesFile()), tabs: parsed });
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
      // Only this app's own renderer may read the bytes (a cover frame grabbed from the player).
      const origin = rendererOrigin(request.headers.get('origin'), devServerUrl);
      if (origin !== null) {
        out.set('access-control-allow-origin', origin);
        out.set('vary', 'origin');
      }
      if (!res.ok) return new Response(null, { status: res.status, headers: out });
      return new Response(res.body, { status: res.status, headers: out });
    } catch {
      clearTimeout(timer);
      return new Response(null, { status: 502 });
    }
  });
}

/** Serve the built renderer with the CSP for the actual service address (no file:// pages). */
function registerAppProtocol(csp: string): void {
  const root = path.join(__dirname, '..', 'dist');
  protocol.handle(APP_SCHEME, async (request) => {
    const file = request.method === 'GET' ? appFilePath(request.url, root) : null;
    if (file === null) return new Response(null, { status: 404 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, { status: 200, headers: appResponseHeaders(file, csp) });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

function hardenSession(): void {
  const csp = contentSecurityPolicy(devServerUrl, config.baseUrl);
  if (devServerUrl === null) registerAppProtocol(csp);
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
      // e2e (QC-064): the window stays hidden, so keep it rendering and its timers and
      // animation frames running as if it were in front.
      ...(backgroundRun ? { backgroundThrottling: false, paintWhenInitiallyHidden: true } : {}),
    },
  });

  // e2e (QC-064): never shown, not even inactive, so it cannot cover the user's windows
  // or take their clicks.
  if (!backgroundRun) {
    win.once('ready-to-show', () => {
      win.show();
    });
  }

  // No in-app navigation away from the renderer; external links open in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl !== null && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') && !backgroundRun) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl !== null) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadURL(APP_INDEX_URL);
  }
}

function preferencesFile(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

/**
 * 語言 (QC-042). Read from the preferences before the first window opens;
 * every change rebuilds the menu and tells each window, which re-renders in
 * place (no reload, nothing unsaved is lost).
 */
let languageController: LanguageController | null = null;
function language(): LanguageController {
  if (languageController === null) {
    // An upgrade from before 語言 keeps 繁體中文; a new install follows the system.
    migrateLanguage(preferencesFile());
    languageController = new LanguageController(readPreferences(preferencesFile()).language, () =>
      app.getPreferredSystemLanguages(),
    );
    languageController.onChange((state) => {
      applyMenu();
      broadcast(IPC.languageChanged, state);
    });
  }
  return languageController;
}

function applyMenu(): void {
  const t = language().t;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(t, 'qiu-creator', {
        devTools: !app.isPackaged,
        // ⌘W and the other tab items go to the window in front (QC-047).
        onTabCommand: (command) => {
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          win?.webContents.send(IPC.tabCommand, command);
        },
      }),
    ),
  );
}

void app.whenReady().then(() => {
  // A hot Mac switches the renderer to the lite motion set, and back when it cools (QC-065).
  let lastMotion = currentMotion();
  powerMonitor.on('thermal-state-change', () => {
    const next = currentMotion();
    if (next === lastMotion) return;
    lastMotion = next;
    broadcast(IPC.motionModeChanged, next);
  });
  if (backgroundRun) {
    // An accessory app has no Dock icon and no ⌘Tab entry, and showing its windows does
    // not activate it.
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
  // The packaged app gets its icon from the bundle; a dev run shows the same one in the Dock.
  if (!app.isPackaged) {
    const icon = path.join(__dirname, '..', 'build', 'icon.png');
    if (existsSync(icon)) app.dock?.setIcon(icon);
  }
  // The saved 外觀 applies before the first window paints (QC-038).
  nativeTheme.themeSource = readPreferences(preferencesFile()).theme;
  // …and the saved 語言, so the menu and the first frame are already in it (QC-042).
  applyMenu();
  // Following the system: macOS posts this when the preferred languages change;
  // focusing the app re-checks too, in case the notification was missed.
  systemPreferences.subscribeNotification('AppleLanguagePreferencesChangedNotification', () => {
    language().refresh();
  });
  app.on('browser-window-focus', () => {
    language().refresh();
  });
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
  pasteFiles.clearAll();
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays in the Dock. The service is independent either way.
  if (process.platform !== 'darwin') app.quit();
});
