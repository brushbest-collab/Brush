// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('evi', {
  // invoke/handle
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),

  // subscribe progress/log from main
  on: (channel, listener) => {
    ipcRenderer.on(channel, (_, payload) => listener(_, payload));
  },
  once: (channel, listener) => {
    ipcRenderer.once(channel, (_, payload) => listener(_, payload));
  },
  removeAll: (channel) => ipcRenderer.removeAllListeners(channel),

  // 小工具：帶超時的 invoke
  invokeWithTimeout: (channel, data, ms = 8000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      ipcRenderer
        .invoke(channel, data)
        .then((r) => { clearTimeout(t); resolve(r); })
        .catch((e) => { clearTimeout(t); reject(e); });
    }),
});
