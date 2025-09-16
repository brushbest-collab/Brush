// preload.cjs —— 覆蓋版
const { contextBridge, ipcRenderer } = require('electron');

try {
  console.log('[preload] loaded');
} catch {}

contextBridge.exposeInMainWorld('store', {
  getState: (key) => ipcRenderer.invoke('state:get', key),
  setState: (key, val) => ipcRenderer.invoke('state:set', { key, val }),
});

contextBridge.exposeInMainWorld('electron', {
  onLog: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
  openDir: () => ipcRenderer.invoke('dialog:openDir'),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
});
