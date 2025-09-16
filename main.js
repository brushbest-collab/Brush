// main.js  —— CommonJS 版本（覆蓋用）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let win;

/** 需要載入 ESM 模組時用這個助手 */
async function importESM(p) {
  // 轉成 file:// URL，避免打包/Windows 路徑問題
  const url = pathToFileURL(p).href;
  const mod = await import(url);
  return mod.default ?? mod; // 兼容 default export / named export
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // 若有 preload 檔是 CJS： preload: path.join(__dirname, 'preload.cjs')
      // 若 preload 是 ESM，請用動態 import（見下）
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 如果你的前端是本地 html：
  // await win.loadFile(path.join(__dirname, 'index.html'));
  // 如果是 Dev Server：
  // await win.loadURL('http://localhost:5173');

  // ===== 關鍵：把原本 require('./index.js') 改成這樣 =====
  // 假設要載入的 ESM 在 resources 內相對路徑如下（依你的專案調整）
  const esmPath = path.join(__dirname, 'index.js'); // <— 把這裡換成你原本 require 的路徑
  const esm = await importESM(esmPath);

  // 如果 ESM 有 default 匯出一個啟動函式：
  if (typeof esm === 'function') {
    await esm(win);
  } else if (typeof esm.start === 'function') {
    await esm.start(win);
  }
  // =====================================================
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // macOS 慣例：除非使用者 Cmd+Q，否則保留 app
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
