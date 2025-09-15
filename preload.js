// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  pickModelRoot: () => ipcRenderer.invoke('model:pick-root'),
  onStateUpdate: (cb) => ipcRenderer.on('state:update', (_e, s) => cb(s)),
});
