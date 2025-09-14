// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('evi', {
  getState: () => ipcRenderer.invoke('get-state'),
  selectModelDir: () => ipcRenderer.invoke('select-model-dir'),
  downloadModel: () => ipcRenderer.invoke('download-model'),
  openGenerator: () => ipcRenderer.invoke('open-generator'),
  generate: (cfg) => ipcRenderer.invoke('generate', cfg),
  onLog: (cb) => {
    ipcRenderer.removeAllListeners('log');
    ipcRenderer.on('log', (_e, msg) => cb?.(msg));
  }
});
