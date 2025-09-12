const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('evi', {
  checkPbs: async () => {
    try { return await ipcRenderer.invoke('check-pbs'); }
    catch { return 'missing'; }
  },
  startModels: async (cfg) => {
    try { return await ipcRenderer.invoke('models:start', cfg); }
    catch (e) { throw new Error(e?.message || String(e)); }
  },
  onLog: (cb) => on('dl:log', cb),
  onProgress: (cb) => on('dl:progress', cb)
});
