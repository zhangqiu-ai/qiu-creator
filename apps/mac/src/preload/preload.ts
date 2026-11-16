import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type ConnectionInfo,
  type CreatorHubBridge,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/bridge.js';

const bridge: CreatorHubBridge = {
  getConnection: () => ipcRenderer.invoke(IPC.getConnection) as Promise<ConnectionInfo>,
  request: (req: ProxyRequest) => ipcRenderer.invoke(IPC.request, req) as Promise<ProxyResponse>,
};

contextBridge.exposeInMainWorld('creatorhub', bridge);
