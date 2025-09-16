// preload.cjs
const { contextBridge, ipcRenderer } = require('electron');

// —— 簡單的狀態存取（主程序用 Map 暫存）
contextBridge.exposeInMainWorld('store', {
  getState: (key) => ipcRenderer.invoke('state:get', key),
  setState: (key, val) => ipcRenderer.invoke('state:set', { key, val }),
});

// —— App 對渲染端暴露的常用 API
contextBridge.exposeInMainWorld('electron', {
  onLog: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('log', listener);
    // 回傳解除綁定函式
    return () => ipcRenderer.removeListener('log', listener);
  },
  openDir: () => ipcRenderer.invoke('dialog:openDir'),
  downloadModel: (url) => ipcRenderer.invoke('model:download', url),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
});
