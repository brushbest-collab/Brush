// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EVI', {
  check: () => ipcRenderer.invoke('env-check'),
  downloadModel: (tag) => ipcRenderer.invoke('download-model', { tag: tag || '' }),

  onLog:       (fn) => ipcRenderer.on('log', (_, m) => fn(m)),
  onProgress:  (fn) => ipcRenderer.on('dl-progress', (_, p) => fn(p)),
  onState:     (fn) => ipcRenderer.on('state', (_, s) => fn(s))
});
