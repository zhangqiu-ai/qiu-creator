import type { ChangeEvent } from '@qiu-creator/contracts';
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppInfo,
  type ConnectionInfo,
  type CreatorHubBridge,
  type EventStreamStatus,
  type ProxyRequest,
  type ProxyResponse,
  type RevealTarget,
  type UploadItem,
  type LanguageState,
  type ThemeSource,
} from '../shared/bridge.js';

function listen(channel: string, listener: (payload: unknown) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const bridge: CreatorHubBridge = {
  getConnection: () => ipcRenderer.invoke(IPC.getConnection) as Promise<ConnectionInfo>,
  request: (req: ProxyRequest) => ipcRenderer.invoke(IPC.request, req) as Promise<ProxyResponse>,
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,

  onEvent: (listener) =>
    listen(IPC.event, (p) => {
      listener(p as ChangeEvent);
    }),
  onEventStatus: (listener) =>
    listen(IPC.eventStatus, (p) => {
      listener(p as EventStreamStatus);
    }),
  eventStatus: () => ipcRenderer.invoke(IPC.getEventStatus) as Promise<EventStreamStatus>,

  pickAndUpload: () => ipcRenderer.invoke(IPC.pickAndUpload) as Promise<number>,
  // Only real File objects from a drop or file input have a path; the renderer cannot invent one.
  uploadFiles: (files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter((p) => p !== '');
    return ipcRenderer.invoke(IPC.uploadPaths, paths) as Promise<number>;
  },
  insertFiles: (files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter((p) => p !== '');
    return ipcRenderer.invoke(IPC.insertPaths, paths) as Promise<string[]>;
  },
  insertBytes: (name, data) => ipcRenderer.invoke(IPC.insertBytes, name, data) as Promise<string>,
  uploads: () => ipcRenderer.invoke(IPC.uploads) as Promise<UploadItem[]>,
  onUploads: (listener) =>
    listen(IPC.uploadsChanged, (p) => {
      listener(p as UploadItem[]);
    }),
  cancelUpload: (id) => ipcRenderer.invoke(IPC.cancelUpload, id) as Promise<void>,
  retryUpload: (id) => ipcRenderer.invoke(IPC.retryUpload, id) as Promise<void>,
  dismissUpload: (id) => ipcRenderer.invoke(IPC.dismissUpload, id) as Promise<void>,

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,
  reveal: (target: RevealTarget) => ipcRenderer.invoke(IPC.reveal, target) as Promise<boolean>,
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text) as Promise<void>,
  getTheme: () => ipcRenderer.invoke(IPC.getTheme) as Promise<ThemeSource>,
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme) as Promise<void>,
  getLanguage: () => ipcRenderer.invoke(IPC.getLanguage) as Promise<LanguageState>,
  setLanguage: (preference) =>
    ipcRenderer.invoke(IPC.setLanguage, preference) as Promise<LanguageState>,
  onLanguage: (listener) =>
    listen(IPC.languageChanged, (p) => {
      listener(p as LanguageState);
    }),
};

contextBridge.exposeInMainWorld('creatorhub', bridge);
