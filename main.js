// main.js —— 覆蓋版（總是設定 preload）
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

// 極簡狀態存取，給 preload->renderer 用
const _state = new Map();
ipcMain.handle('state:get', (_e, key) => _state.get(key));
ipcMain.handle('state:set', (_e, { key, val }) => { _state.set(key, val); return true; });

ipcMain.handle('dialog:openDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

function pickExisting(paths) { for (const p of paths) if (fs.existsSync(p)) return p; return null; }

async function loadRenderer(w) {
  if (process.env.ELECTRON_START_URL) { await w.loadURL(process.env.ELECTRON_START_URL); return; }

  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'build', 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app', 'index.html'),
    path.join(process.resourcesPath, 'app', 'build', 'index.html'),
    path.join(process.resourcesPath, 'app', 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'build', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html'),
  ];
  const html = pickExisting(candidates);
  if (!html) {
    dialog.showErrorBox('Renderer 未找到', candidates.join('\n'));
    return;
  }
  await w.loadFile(html);
}

async function createWindow() {
  // ✅ 不再做 exists 檢查：asar 環境下可能回傳 false
  const preloadPath = path.join(__dirname, 'preload.cjs');
  console.log('[electron] preload path =', preloadPath);

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,         // ← 一律設定
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
    show: true,
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    dialog.showErrorBox('did-fail-load', `code=${code}\n${desc}\nurl=${url}`);
  });

  win.webContents.openDevTools({ mode: 'detach' });
  await loadRenderer(win);

  _state.set('appReady', true);
}

process.on('uncaughtException', (err) => dialog.showErrorBox('Main Error', String(err?.stack || err)));
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if
