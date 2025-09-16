// main.js —— 通用且健壯（CommonJS）
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

function pickExisting(paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

async function loadRenderer(targetWin) {
  // DEV 模式支援用環境變數指定 URL（例如 Vite/React Dev Server）
  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) {
    await targetWin.loadURL(startUrl);
    return;
  }

  // 打包後常見位置（electron-builder / asar）
  const candidates = [
    // 專案根目錄執行（未打包）：
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'build', 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),

    // 打包後 resources 目錄（不同打包器的可能結構）：
    path.join(process.resourcesPath, 'app', 'index.html'),
    path.join(process.resourcesPath, 'app', 'build', 'index.html'),
    path.join(process.resourcesPath, 'app', 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'build', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html'),
  ];

  const htmlPath = pickExisting(candidates);
  if (!htmlPath) {
    dialog.showErrorBox(
      'Renderer 未找到',
      [
        '無法找到 index.html。請確認打包時有把前端產物包含進去：',
        '  - 若用 CRA/webpack：把 build/ 整個夾帶入檔案清單',
        '  - 若用 Vite：把 dist/ 夾帶入檔案清單',
        '',
        '已嘗試路徑：',
        ...candidates.map(p => `• ${p}`),
      ].join('\n')
    );
    return;
  }
  await targetWin.loadFile(htmlPath);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), // 沒有可拿掉
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
    show: true
  });

  // 設置各種診斷事件
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    dialog.showErrorBox('did-fail-load', `code=${code}\n${desc}\nurl=${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('Renderer 崩潰', JSON.stringify(details, null, 2));
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[electron] renderer did-finish-load');
  });

  // 自動開 DevTools（方便你現在排查；之後可註解）
  win.webContents.openDevTools({ mode: 'detach' });

  // ✅ 這裡才是載入畫面的正確方式
  await loadRenderer(win);
}

process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Main Uncaught Exception', String(err?.stack || err));
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
