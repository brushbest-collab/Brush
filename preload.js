// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("evi", {
  // 狀態
  getState: () => ipcRenderer.invoke("state:get"),

  // 選資料夾
  pickModelRoot: () => ipcRenderer.invoke("model:pick-root"),

  // 下載（含續傳 / 302 兼容在主程序處理）
  downloadAll: () => ipcRenderer.invoke("model:download-all"),

  // 開啟設計/生成
  goDesign: () => ipcRenderer.invoke("ui:go"),

  // UI 輔助
  alert: (msg) => ipcRenderer.invoke("ui:alert", String(msg)),

  // 訂閱事件
  onLog: (cb) => ipcRenderer.on("evt:log", cb),
  onProgress: (cb) => ipcRenderer.on("evt:progress", cb),
  onState: (cb) => ipcRenderer.on("evt:state", cb)
});
