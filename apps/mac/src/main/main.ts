import path from 'node:path';
import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC, type ProxyRequest } from '../shared/bridge.js';
import { readConnection, resolveConfig } from './config.js';
import { contentSecurityPolicy } from './csp.js';
import { performProxyRequest } from './proxy.js';

/**
 * The Mac service (mac-server) is owned by launchd, not by this app. The app
 * never starts or stops it: when it is not reachable the renderer shows
 * "服務未運行" with a retry, and closing windows leaves the service alone.
 */

const devServerUrl = process.env['VITE_DEV_SERVER_URL'] ?? null;
const config = resolveConfig(process.env, app.isPackaged);

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

/** Only our own renderer may use the bridge. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return devServerUrl !== null ? url.startsWith(devServerUrl) : url.startsWith('file://');
}

function registerIpc(): void {
  ipcMain.handle(IPC.getConnection, (event) => {
    if (!isTrustedSender(event)) throw new Error('untrusted sender');
    return readConnection(config, process.env);
  });
  ipcMain.handle(IPC.request, (event, req: unknown) => {
    if (!isTrustedSender(event)) throw new Error('untrusted sender');
    if (!isProxyRequest(req)) throw new Error('invalid request');
    return performProxyRequest(config.baseUrl, req);
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
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays in the Dock. The service is independent either way.
  if (process.platform !== 'darwin') app.quit();
});
