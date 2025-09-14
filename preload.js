// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('evi', {
  getState: () => ipcRenderer.invoke('state:get'),
  pickModelDir: () => ipcRenderer.invoke('dialog:pickModelDir'),
  startDownload: (opts) => ipcRenderer.invoke('model:download', opts || {}),
  openDesign: () => ipcRenderer.invoke('app:openDesign'),
  onLog: (cb) => {
    const handler = (_e, m) => cb?.(m);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.off('log', handler);
  },
});
