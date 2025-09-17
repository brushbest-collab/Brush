// main.js —— 含 bootstrap 偵測（覆蓋/合併用）
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
const state = new Map();

function send(channel, payload){ if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function log(msg, level='info'){ send('log', { level, msg, ts: Date.now() }); }
function progress(p){ send('progress', p); }

function pickExisting(paths){ for (const p of paths){ try{ if (fs.existsSync(p)) return p; } catch(_){} } return null; }

function resolveHtml(){
  const c = [
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
  return pickExisting(c);
}

/* ✅ 這段：同時支援 DEV、打包到 app.asar.unpacked、或 extraResources/python/ */
function findPythonBootstrapMarker(){
  const c = [
    path.join(__dirname, 'python', 'pbs', 'ok'),                               // dev
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'ok'), // asarUnpack
    path.join(process.resourcesPath, 'app', 'python', 'pbs', 'ok'),              // 某些打包配置
    path.join(process.resourcesPath, 'python', 'pbs', 'ok')                      // extraResources（推薦）
  ];
  return pickExisting(c);
}

function detectBootstrap(){
  const marker = findPythonBootstrapMarker();
  const found = !!marker;
  state.set('bootstrap', found);
  log(found ? `Python bootstrap marker FOUND: ${marker}` : 'Python bootstrap NOT found');
  return found;
}

async function loadRenderer(w){
  if (process.env.ELECTRON_START_URL) { await w.loadURL(process.env.ELECTRON_START_URL); return; }
  const html = resolveHtml();
  if (!html) {
    dialog.showErrorBox('Renderer 未找到', '沒有找到 index.html');
    return;
  }
  await w.loadFile(html);
}

async function createWindow(){
  const preloadPath = path.join(__dirname, 'preload.cjs');

  win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, devTools: true }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => dialog.showErrorBox('did-fail-load', `code=${code}\n${desc}\nurl=${url}`));

  await loadRenderer(win);

  // 初始化狀態
  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap(); // ✅ 啟動即偵測並更新狀態
}

// ---------- IPC ----------
ipcMain.handle('state:get', (_e, key) => state.get(key));
ipcMain.handle('state:set', (_e, { key, val }) => { state.set(key, val); return true; });
ipcMain.handle('dialog:openDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('model:download', async () => {
  log('Start download…'); for (let i=0;i<=100;i+=5){ progress(i); await new Promise(r=>setTimeout(r,30)); }
  log('Download finished.'); return true;
});
ipcMain.handle('designer:open', async () => { log('Open designer.'); return true; });

process.on('uncaughtException', (err) => dialog.showErrorBox('Main Error', String((err && err.stack) || err)));
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
