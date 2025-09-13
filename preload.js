const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('evi', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => {
    const handler = (_ev, payload) => cb(payload);
    ipcRenderer.on('app-state', handler);
    return () => ipcRenderer.off('app-state', handler);
  },
  chooseModelDir: () => ipcRenderer.invoke('choose-model-dir'),
  log: (...a) => ipcRenderer.send('renderer-log', ...a)
});
