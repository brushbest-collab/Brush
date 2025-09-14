// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState:        () => ipcRenderer.invoke('get-state'),
  pickModelDir:    () => ipcRenderer.invoke('pick-model-dir'),
  setModelRoot:    (dir) => ipcRenderer.invoke('set-model-root', dir),
  downloadModel:   () => ipcRenderer.invoke('download-model'),
  openDesign:      () => ipcRenderer.invoke('open-design'),

  onLog:      (cb) => ipcRenderer.on('ui-log', (_e, s) => cb(s)),
  onProgress: (cb) => ipcRenderer.on('ui-progress', (_e, v) => cb(v)),
});
