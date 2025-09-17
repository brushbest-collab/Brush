// main.js —— 穩定版（請整檔覆蓋）
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;

// --- 簡易全域狀態（給 preload/renderer 讀寫） ---
const state = new Map();

// 安全傳訊
function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch (_) {}
  }
}

function log(msg, level = 'info') {
  send('log', { level, msg, ts: Date.now() });
}
function progress(pct) { send('progress', pct); }

function pickExisting(paths) {
  for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch(_) {} }
  return null;
}

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
  // ✅ 一律指定 preload（不要做 exists 檢查，asar 下可能判斷錯）
  const preloadPath = path.join(__dirname, 'preload.cjs');

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
  });

  // 外部連結用預設瀏覽器開啟
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    dialog.showErrorBox('did-fail-load', `code=${code}\n${desc}\nurl=${url}`);
  });

  // 如需除錯可開啟
  // win.webContents.openDevTools({ mode: 'detach' });

  await loadRenderer(win);

  // 初始化預設狀態
  if (!state.has('bootstrap')) state.set('bootstrap', false);
  if (!state.has('modelRoot')) state.set('modelRoot', null);
}

// ---------- IPC：renderer 互動 ----------
ipcMain.handle('state:get', (_e, key) => state.get(key));
ipcMain.handle('state:set', (_e, { key, val }) => { state.set(key, val); return true; });

ipcMain.handle('dialog:openDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// 範例：下載流程（可自行換成真實邏輯）
ipcMain.handle('model:download', async () => {
  log('Start download…');
  for (let i = 0; i <= 100; i += 5) {
    progress(i);
    await new Promise(r => setTimeout(r, 40));
  }
  log('Download finished.');
  return true;
});

// 範例：開啟設計器
ipcMain.handle('designer:open', async () => {
  log('Open designer.');
  return true;
});

// 全域錯誤兜底
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Main Error', String((err && err.stack) || err));
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
