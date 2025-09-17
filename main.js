// main.js —— GitHub Release 自動下載（支援私有）+ 本機分卷備援 + Python 服務啟動
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');
const sevenPath = sevenBin.path7za;

let win = null;

/* ---------- 共用 ---------- */
const state = new Map();
function send(ch, payload){ if (win && !win.isDestroyed()) try{ win.webContents.send(ch, payload); }catch{} }
function log(msg, level='info'){ send('log', { level, msg, ts: Date.now() }); }
function progress(p){ send('progress', Math.max(0, Math.min(100, Number(p)||0))); }
function pickExisting(paths){ for (const p of paths){ try{ if (p && fs.existsSync(p)) return p; }catch{} } return null; }

/* ---------- UI 載入 ---------- */
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
  win.webContents.setWindowOpenHandler(({url})=>{ shell.openExternal(url); return {action:'deny'}; });
  win.webContents.on('did-fail-load',(_e,code,desc,url)=>dialog.showErrorBox('did-fail-load',`code=${code}\n${desc}\nurl=${url}`));
  await loadRenderer(win);
  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap();
}

/* ---------- Python bootstrap 偵測 ---------- */
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
  const found = !!marker;
  state.set('bootstrap', found);
  log(found ? `Python bootstrap marker FOUND: ${marker}` : 'Python bootstrap NOT found');
  return found;
}

/* ---------- 讀設定（支援 app.config.json / 環境變數） ---------- */
function readAppConfig() {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'app.config.json'),
    path.join(process.resourcesPath, 'app', 'app.config.json'),
    path.join(process.resourcesPath, 'app.asar', 'app.config.json'),
    path.join(__dirname, 'app.config.json')
  ];
  const p = pickExisting(candidates);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function ghConfig() {
  const cfg = readAppConfig() || {};
  const repo  = process.env.GH_REPO || cfg.gh_repo || '';
  let   tag   = process.env.GH_TAG  || cfg.gh_tag  || '';
  if (!tag) { try { tag = 'v' + app.getVersion(); } catch {} }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || cfg.gh_token || '';
  log(`[gh] repo=${repo||'-'} tag=${tag||'-'} token=${token ? 'yes' : 'no'}`);
  return { repo, tag, token };
}

/* ---------- GitHub Release（支援私有） ---------- */
function fetchReleaseAssets(repo, tag, token) {
  return new Promise((resolve) => {
    if (!repo || !tag) return resolve([]);
    const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const headers = { 'User-Agent':'evi-brush-desktop', 'Accept':'application/vnd.github+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.get(api, { headers, timeout: 15000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchReleaseAssetsFromUrl(res.headers.location, token).then(resolve);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve([]); }
      let buf=''; res.setEncoding('utf8');
      res.on('data', c => buf+=c);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          const assets = Array.isArray(json.assets) ? json.assets : [];
          const list = assets
            .filter(a => /model-pack\.7z\.\d{3}$/i.test(a.name))
            .sort((a,b) => Number(a.name.match(/(\
