const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('evi', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  pickModelRoot: () => ipcRenderer.invoke('model:pick-root'),
  downloadModel: () => ipcRenderer.invoke('model:download'),
  openDesigner: () => ipcRenderer.invoke('ui:open-designer'),

  onLog: (cb) => ipcRenderer.on('log', (_, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('progress', (_, percent) => cb(percent))
});
