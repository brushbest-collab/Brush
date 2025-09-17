// main.js —— 最佳解法版：GitHub Release 自動下載 + 本機分卷後備
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');           // 內建 7z
const sevenPath = sevenBin.path7za;

let win = null;

/* ---------------- 共用 ---------------- */
const state = new Map();
function send(ch, payload){ if (win && !win.isDestroyed()) try{ win.webContents.send(ch, payload); }catch{} }
function log(msg, level='info'){ send('log', { level, msg, ts: Date.now() }); }
function progress(p){ send('progress', Math.max(0, Math.min(100, Number(p)||0))); }
function pickExisting(paths){ for (const p of paths){ try{ if (p && fs.existsSync(p)) return p; }catch{} } return null; }

/* ---------------- UI 載入 ---------------- */
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
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html')
  ];
  return pickExisting(c);
}
async function loadRenderer(w){
  if (process.env.ELECTRON_START_URL){ await w.loadURL(process.env.ELECTRON_START_URL); return; }
  const html = resolveHtml();
  if (!html){ dialog.showErrorBox('Renderer 未找到','沒有找到 index.html'); return; }
  await w.loadFile(html);
}
async function createWindow(){
  win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { preload: path.join(__dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, devTools:true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action:'deny' }; });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => dialog.showErrorBox('did-fail-load', `code=${code}\n${desc}\nurl=${url}`));
  await loadRenderer(win);
  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap();
}

/* ---------------- Python bootstrap 偵測 ---------------- */
function findBootstrapMarker(){
  const c = [
    path.join(__dirname, 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'app', 'python', 'pbs', 'ok')
  ];
  return pickExisting(c);
}
function detectBootstrap(){
  const marker = findBootstrapMarker();
  const found = !!ma
