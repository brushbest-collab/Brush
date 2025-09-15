const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  pickRoot: () => ipcRenderer.invoke('model:pick-root'),
  startDesign: (state) => ipcRenderer.invoke('design:start', state),
  onLog: (fn) => ipcRenderer.on('log:append', (_e, m) => fn(m))
});
