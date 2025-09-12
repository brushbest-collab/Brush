// main.js — 使用 .ready 標記、可手動「重新下載模型」的版本
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const GH_OWNER = 'brushbest-collab';
const GH_REPO  = 'Brush';
const RELEASE_TAG = 'latest';            // 或填固定版本 'v73'
const ASSET_PREFIX = 'model-pack.7z.';   // 分割檔前綴
const CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_REDIRECT = 5;
const MAX_RETRY = 5;

const isDev = !app.isPackaged;
const resPath = (...p) => path.join(isDev ? process.cwd() : process.resourcesPath, ...p);

// 重要路徑
const PY_DIR       = resPath('python');
const PBS_DIR      = resPath('python', 'pbs');
const MODELS_ROOT  = resPath('python', 'models');
const MODEL_TARGET = path.join(MODELS_ROOT, 'sd-turbo');
const MODEL_READY  = path.join(MODEL_TARGET, '.ready');
const TMP_DIR      = resPath('downloads');

function resolve7z() {
  try { return require('7zip-bin').path7za; } catch {}
  const cands = [
    path.join(process.resourcesPath, 'bin', '7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ];
  return cands.find(p => fs.existsSync(p)) || null;
}

// ---------- 視窗 ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1024, height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function buildMenu(win) {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open models folder',
          click: () => shell.openPath(MODEL_TARGET)
        },
        {
          label: 'Redownload model (clean & fetch)',
          click: async () => {
            try { await cleanModel(); } catch {}
            ensureModel(win).catch(() => {});
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Open project', click: () => shell.openExternal(`https://github.com/${GH_OWNER}/${GH_REPO}`)}] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 基本 I/O ----------
function ensureDirs() {
  [PY_DIR, PBS_DIR, MODELS_ROOT, TMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
  const ok = path.join(PBS_DIR, 'ok');
  if (!fs.existsSync(ok)) fs.writeFileSync(ok, 'ok');
}
const existsModel = () => fs.existsSync(MODEL_READY);

async function cleanModel() {
  const rmrf = (p) => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); };
  rmrf(MODEL_TARGET);
  rmrf(TMP_DIR);
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ---------- HTTP(302)+續傳 ----------
function requestWithRedirect(url, options = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        if (hops >= MAX_REDIRECT) { res.resume(); return reject(new Error('Too many redirects')); }
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(requestWithRedirect(next, options, hops + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}
function streamToBuffer(s) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    s.on('data', d => chunks.push(d));
    s.on('end',  () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}
async function headSize(url) {
  const res = await requestWithRedirect(url, {
    method: 'HEAD',
    headers: { 'User-Agent': 'EVI-Brush-Downloader' }
  });
  const len = Number(res.headers['content-length'] || 0);
  res.resume();
  if (!len) throw new Error(`Cannot get size for ${url}`);
  return len;
}
async function downloadRange(url, dest, onProgress) {
  const tmp = dest + '.part';
  const total = await headSize(url);
  let done = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  if (done > total) { fs.truncateSync(tmp, 0); done = 0; }
  const fd = fs.openSync(tmp, 'a');
  try {
    while (done < total) {
      const end = Math.min(done + CHUNK_SIZE - 1, total - 1);
      const headers = {
        'User-Agent': 'EVI-Brush-Downloader',
        'Accept': 'application/octet-stream',
        'Range': `bytes=${done}-${end}`,
      };
      const res = await requestWithRedirect(url, { headers });
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      const buf = await streamToBuffer(res);
      fs.writeSync(fd, buf, 0, buf.length, done);
      done += buf.length;
      onProgress && onProgress(Math.min(done, total), total);
    }
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dest);
}
async function withRetry(fn, tag) {
  let last;
  for (let i = 0; i < MAX_RETRY; i++) {
    try { return await fn(); } catch (e) { last = e; }
  }
  throw new Error(`${tag} failed after ${MAX_RETRY} retries: ${last}`);
}

async function listReleaseAssets() {
  const apiBase = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases`;
  const api = (RELEASE_TAG === 'latest') ? `${apiBase}/latest` : `${apiBase}/tags/${encodeURIComponent(RELEASE_TAG)}`;
  const res = await requestWithRedirect(api, {
    headers: {
      'User-Agent': 'EVI-Brush-Downloader',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const json = JSON.parse((await streamToBuffer(res)).toString('utf8'));
  const assets = (json.assets || [])
    .filter(a => a && a.name && a.name.startsWith(ASSET_PREFIX))
    .map(a => ({ name: a.name, url: a.browser_download_url }))
    .sort((a, b) => Number(a.name.split('.').pop()) - Number(b.name.split('.').pop()));
  if (!assets.length) throw new Error(`No assets matched "${ASSET_PREFIX}" on ${RELEASE_TAG}`);
  return assets;
}

async function downloadAllParts(win) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const assets = await listReleaseAssets();
  for (const a of assets) {
    const out = path.join(TMP_DIR, a.name);
    if (fs.existsSync(out)) { win?.webContents.send('dl-log', `✔ ${a.name} (exists)`); continue; }
    let lastPct = -1;
    win?.webContents.send('dl-log', `↓ ${a.name}`);
    await withRetry(() => downloadRange(a.url, out, (w, t) => {
      const pct = Math.floor((w / t) * 100);
      if (pct !== lastPct) { lastPct = pct; win?.webContents.send('dl-progress', { file: a.name, pct }); }
    }), `download ${a.name}`);
  }
  return path.join(TMP_DIR, assets[0].name); // .001
}

async function extract7z(firstPart, outDir, win) {
  const seven = resolve7z();
  if (!seven) throw new Error('Cannot find 7-Zip (please add dep "7zip-bin" or install 7-Zip).');
  fs.mkdirSync(outDir, { recursive: true });
  win?.webContents.send('dl-log', 'Extracting …');
  await new Promise((resolve, reject) => {
    const p = spawn(seven, ['x', firstPart, `-o${outDir}`, '-y'], { stdio: isDev ? 'inherit' : 'ignore' });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`7z exit ${code}`)));
  });
  // 寫入標記檔，之後以標記為準
  fs.writeFileSync(MODEL_READY, 'ok');
}

// ---------- 啟動流程 ----------
function log(win, msg) { win?.webContents.send('dl-log', msg); }

async function ensureModel(win) {
  ensureDirs();
  if (existsModel()) { log(win, 'Python bootstrap found. Model present.'); return; }

  log(win, 'Model not found. Start downloading …');
  try {
    const first = await downloadAllParts(win);   // 回傳 .001
    await extract7z(first, MODELS_ROOT, win);
    if (!existsModel()) throw new Error('Model extracted but .ready missing.');
    log(win, 'Model ready.');
  } catch (err) {
    dialog.showErrorBox('模型下載失敗', String(err?.message || err));
    throw err;
  }
}

// ---------- Electron ----------
function bootstrap() {
  const win = createWindow();
  buildMenu(win);
  ensureModel(win).catch(() => {});
}

app.whenReady().then(bootstrap);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('check-pbs', async () => {
  try { return fs.existsSync(path.join(PBS_DIR, 'ok')) ? 'ok' : 'missing'; }
  catch { return 'missing'; }
});
