// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('evi', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  downloadModel: () => ipcRenderer.invoke('download-model'),
  onLog: (cb) => ipcRenderer.on('dl-log', (_e, m) => cb(m)),
  onStart: (cb) => ipcRenderer.on('dl-start', (_e, d) => cb(d)),
  onProg: (cb) => ipcRenderer.on('dl-progress', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('dl-done', (_e, d) => cb(d)),
});
