const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkPbs: () => ipcRenderer.invoke('check-pbs')
});
