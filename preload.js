const { contextBridge, ipcRenderer } = require("electron");

// 小工具：把主行程傳回來的事件回呼給前端
function subscribe(channel, handler) {
  const listener = (_, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state"), // { bootstrap, installed, modelRoot }
  pickModelRoot: () => ipcRenderer.invoke("pick-model-root"),

  // 下載模型：opts = { partSizeMB, tag }, onEvent(event)
  downloadModel: (opts, onEvent) => {
    const channel = `dl:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const unsubscribe = subscribe(channel, (payload) => onEvent?.(payload));
    return ipcRenderer
      .invoke("download-model", { ...opts, channel })
      .finally(unsubscribe);
  },

  startDesigner: () => ipcRenderer.invoke("start-ui"),
});
