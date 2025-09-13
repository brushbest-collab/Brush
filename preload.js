// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EVI', {
  // 環境與模型
  check:         ()    => ipcRenderer.invoke('env-check'),
  downloadModel: (tag) => ipcRenderer.invoke('download-model', { tag: tag || '' }),
  onLog:         (fn)  => ipcRenderer.on('log',        (_e, m) => fn(m)),
  onProgress:    (fn)  => ipcRenderer.on('dl-progress',(_e, p) => fn(p)),
  onState:       (fn)  => ipcRenderer.on('state',      (_e, s) => fn(s)),

  // 設定
  getSettings:   ()        => ipcRenderer.invoke('settings:get'),
  saveSettings:  (data)    => ipcRenderer.invoke('settings:set', data),
  chooseDir:     ()        => ipcRenderer.invoke('dialog:choose-dir'),
  openPath:      (target)  => ipcRenderer.invoke('open:path', target)
});
