const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  pickRoot: () => ipcRenderer.invoke('model:pick-root'),
  startDesign: (state) => ipcRenderer.invoke('design:start', state),
  downloadModel: (modelRoot) => ipcRenderer.invoke('model:download', modelRoot),
  onLog: (fn) => ipcRenderer.on('log:append', (_e, m) => fn(m))
});
