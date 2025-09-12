// main.js  — 完整可覆蓋版
// ----------------------------------------------------
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// ====== 可調參數 ======
const GH_OWNER = 'brushbest-collab';
const GH_REPO  = 'Brush';
const RELEASE_TAG = 'latest';              // 或填 'v73' 這類固定版本
const ASSET_PREFIX = 'model-pack.7z.';     // 分割檔共同前綴
const CHUNK_SIZE = 16 * 1024 * 1024;       // 單次請求 16MB
const MAX_REDIRECT = 5;
const MAX_RETRY = 5;

// 嘗試取得 7-Zip 可執行檔
function resolve7z() {
  try { return require('7zip-bin').path7za; } catch (_) { /* ignore */ }
  const cand = [
    path.join(process.resourcesPath, 'bin', '7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ];
  for (const p of cand) { if (fs.existsSync(p)) return p; }
  return null;
}

const isDev = !app.isPackaged;
function resPath(...p) {
  // 開發時取專案根；打包後取 resources
  const base = isDev ? process.cwd() : process.resourcesPath;
  return path.join(base, ...p);
}

// 目錄路徑
const PY_DIR   = resPath('python');
const PBS_DIR  = resPath('python', 'pbs');
const MODELS_ROOT = resPath('python', 'models');
const MODEL_TARGET = path.join(MODELS_ROOT, 'sd-turbo'); // 解壓後的最終資料夾
const TMP_DIR  = resPath('downloads');

// 建立視窗
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

// ---------------------------------------------
// 基本 I/O
function ensureDirs() {
  for (const d of [PY_DIR, PBS_DIR, MODELS_ROOT, TMP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // pbs/ok
  const okFile = path.join(PBS_DIR, 'ok');
  if (!fs.existsSync(okFile)) fs.writeFileSync(okFile, 'ok');
}

function existsModel() {
  try {
    return fs.existsSync(MODEL_TARGET) && fs.readdirSync(MODEL_TARGET).length > 0;
  } catch { return false; }
}

// ---------------------------------------------
// 下載相關工具（自動跟隨 302 / 續傳 / 重試）

function requestWithRedirect(url, options = {}, redirCount = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirCount >= MAX_REDIRECT) {
          res.resume(); // 丟棄
          return reject(new Error(`Too many redirects for ${url}`));
        }
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(requestWithRedirect(next, options, redirCount + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

// 以 Range 下載到檔案（可續傳）
async function downloadRange(url, dest, onProgress) {
  const tmp = dest + '.part';
  const total = await getRemoteSize(url);
  let written = 0;

  // 已有暫存，續傳
  if (fs.existsSync(tmp)) {
    const stat = fs.statSync(tmp);
    written = stat.size;
    if (written > total) fs.truncateSync(tmp, 0);
  }

  const fd = fs.openSync(tmp, 'a');
  try {
    while (written < total) {
      const end = Math.min(written + CHUNK_SIZE - 1, total - 1);
      const headers = {
        'User-Agent': 'EVI-Brush-Downloader',
        'Accept': 'application/octet-stream',
        'Range': `bytes=${written}-${end}`,
      };
      const res = await requestWithRedirect(url, { headers });
      if (res.statusCode === 416) {
        // 範圍不合法，視為已完成
        break;
      }
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      const buf = await streamToBuffer(res);
      fs.writeSync(fd, buf, 0, buf.length, written);
      written += buf.length;
      if (onProgress) onProgress(Math.min(written, total), total);
    }
  } finally { fs.closeSync(fd); }

  fs.renameSync(tmp, dest);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function getRemoteSize(url) {
  const res = await requestWithRedirect(url, {
    method: 'HEAD',
    headers: { 'User-Agent': 'EVI-Brush-Downloader' }
  });
  const len = Number(res.headers['content-length'] || 0);
  if (!len) throw new Error(`Cannot get size for ${url}`);
  res.resume();
  return len;
}

// 列出 Release 的所有分割資產
async function listReleaseAssets() {
  const apiBase = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases`;
  const api = (RELEASE_TAG === 'latest')
    ? `${apiBase}/latest`
    : `${apiBase}/tags/${encodeURIComponent(RELEASE_TAG)}`;
  const res = await requestWithRedirect(api, {
    headers: {
      'User-Agent': 'EVI-Brush-Downloader',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const body = await streamToBuffer(res);
  const json = JSON.parse(body.toString('utf8'));

  const assets = (json.assets || [])
    .filter(a => typeof a.name === 'string' && a.name.startsWith(ASSET_PREFIX))
    .map(a => ({ name: a.name, url: a.browser_download_url }));

  // 依 .001 .002 … 排序
  assets.sort((a, b) => {
    const na = Number(a.name.split('.').pop());
    const nb = Number(b.name.split('.').pop());
    return na - nb;
  });
  if (!assets.length) {
    throw new Error(`No assets matched "${ASSET_PREFIX}" on release ${RELEASE_TAG}`);
  }
  return assets;
}

// 重試包裝
async function withRetry(fn, label) {
  let lastErr;
  for (let i = 0; i < MAX_RETRY; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw new Error(`${label} failed after ${MAX_RETRY} retries: ${lastErr}`);
}

// 下載全部分割檔
async function downloadAllParts(win) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const assets = await listReleaseAssets();

  for (const a of assets) {
    const dest = path.join(TMP_DIR, a.name);
    if (fs.existsSync(dest)) {
      win?.webContents.send('dl-log', `✔ ${a.name} (exists)`);
      continue;
    }
    win?.webContents.send('dl-log', `↓ ${a.name}`);
    let lastPct = -1;
    await withRetry(
      () => downloadRange(a.url, dest, (w, t) => {
        const pct = Math.floor((w / t) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          win?.webContents.send('dl-progress', { file: a.name, pct });
        }
      }),
      `download ${a.name}`
    );
  }
  return assets.map(a => path.join(TMP_DIR, a.name));
}

// 解壓 7z 分割檔（只要給 .001，7z 會自動串其餘分割）
async function extract7z(firstPartPath, outDir, win) {
  const seven = resolve7z();
  if (!seven) throw new Error('Unable to find 7-Zip (7z/7za). Please add dependency "7zip-bin" or install 7-Zip.');

  fs.mkdirSync(outDir, { recursive: true });

  win?.webContents.send('dl-log', 'Extracting model pack …');
  await new Promise((resolve, reject) => {
    const p = spawn(seven, ['x', firstPartPath, `-o${outDir}`, '-y'], {
      stdio: isDev ? 'inherit' : 'ignore'
    });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`7z exit ${code}`)));
  });
}

// ---------------------------------------------
// 啟動流程

async function ensureModel(win) {
  ensureDirs();
  if (existsModel()) {
    win?.webContents.send('dl-log', 'Python bootstrap found. Model present.');
    return;
  }
  win?.webContents.send('dl-log', 'Model not found. Start downloading …');

  try {
    const parts = await downloadAllParts(win);
    // 只給 .001 就好
    const first = parts.find(p => /\.001$/i.test(p));
    if (!first) throw new Error('Cannot find .001 part.');
    await extract7z(first, MODELS_ROOT, win);

    // 解壓後再檢查
    if (!existsModel()) {
      throw new Error('Model extracted but not found at python/models/sd-turbo');
    }
    win?.webContents.send('dl-log', 'Model ready.');
  } catch (err) {
    dialog.showErrorBox('模型下載失敗', String(err && err.message || err));
    throw err;
  }
}

// ---------------------------------------------
// Electron 事件

function bootstrap() {
  const win = createWindow();
  // 前端想顯示進度可監聽 'dl-progress' / 'dl-log'
  ensureModel(win).catch(() => { /* 已經彈錯誤框 */ });
}

app.whenReady().then(bootstrap);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// 提供給 Renderer 簡單查詢
ipcMain.handle('check-pbs', async () => {
  try { return fs.existsSync(path.join(PBS_DIR, 'ok')) ? 'ok' : 'missing'; }
  catch { return 'missing'; }
});
