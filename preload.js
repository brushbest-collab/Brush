// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('state:init'),
  pickRoot: () => ipcRenderer.invoke('model:pick-root'),
  downloadModel: (root) => ipcRenderer.invoke('model:download', { root }),
  openGenerator: () => ipcRenderer.invoke('app:open-generator'),
  onLog: (cb) => ipcRenderer.on('ui:log', (_, msg) => cb?.(msg)),
  onProgress: (cb) => ipcRenderer.on('ui:progress', (_, p) => cb?.(p))
});
