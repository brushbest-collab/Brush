// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;

/* ===== 下載來源設定（可依需要修改） ===== */
const GH_OWNER = process.env.EVI_GH_OWNER || 'brushbest-collab';
const GH_REPO  = process.env.EVI_GH_REPO  || 'Brush';
const GH_TAG   = process.env.EVI_GH_TAG   || 'v73';
const ASSET_PREFIX = process.env.EVI_ASSET_PREFIX || 'model-pack.7z.';  // 多分卷前綴
/* ===================================== */

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/** 解析打包後實際可寫入的 python 目錄
 *  支援：
 *  - resources/app.asar.unpacked/python     （asarUnpack）
 *  - resources/app/python                   （不打 asar）
 *  - resources/python                        （extraResources）
 *  - 可攜版：<exe 同層>/python
 */
function getPythonDir() {
  if (isDev) return path.join(__dirname, 'python');

  const res = process.resourcesPath;
  const candidates = [
    path.join(res, 'app.asar.unpacked', 'python'),
    path.join(res, 'app', 'python'),
    path.join(res, 'python'),
    path.join(process.cwd(), 'python')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  // 都沒有就建立首選路徑
  const preferred = path.join(res, 'app.asar.unpacked', 'python');
  ensureDir(preferred);
  return preferred;
}

function hasModelDir() {
  try {
    const p = path.join(getPythonDir(), 'models', 'sd-turbo');
    return fs.existsSync(p) && fs.readdirSync(p).length > 0;
  } catch { return false; }
}

/* ---------------- GitHub API & 下載 ---------------- */
function getJson(url, headers = {}) {
  const h = {
    'User-Agent': 'evi-brush-downloader',
    'Accept': 'application/vnd.github+json',
    ...headers
  };
  return new Promise((resolve, reject) => {
    https.get(url, { headers: h }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} - ${url}`));
        }
      });
    }).on('error', reject);
  });
}

function downloadWithRedirect(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    let start = 0;
    if (fs.existsSync(dest)) start = fs.statSync(dest).size;

    const headers = { 'User-Agent': 'evi-brush-downloader' };
    if (start > 0) headers['Range'] = `bytes=${start}-`;

    const req = https.get(url, { headers }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`Redirect without Location for ${url}`));
        req.destroy();
        return resolve(downloadWithRedirect(loc, dest, onProgress));
      }
      if (res.statusCode < 200 || res.statusCode >= 300)
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));

      const total = (parseInt(res.headers['content-length'] || '0', 10) + start) || 0;
      const ws = fs.createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' });
      let done = start;

      res.on('data', chunk => {
        ws.write(chunk);
        done += chunk.length;
        if (onProgress) onProgress(done, total);
      });
      res.on('end', () => { ws.end(); resolve(); });
      res.on('error', err => { ws.close(); reject(err); });
    });
    req.on('error', reject);
  });
}

async function getReleaseParts(owner, repo, tag, prefix) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const json = await getJson(url);
  const list = (json.assets || [])
    .filter(a => a && a.name && a.browser_download_url && a.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!list.length) throw new Error(`No assets matched "${prefix}" on ${owner}/${repo}@${tag}`);
  return list.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size || 0 }));
}

/* ---------------- 解壓（可選） ---------------- */
function find7z() {
  const candidates = [
    '7z', '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ];
  for (const c of candidates) {
    try {
      if (c.includes('\\')) { if (fs.existsSync(c)) return c; }
      else { return c; }
    } catch {}
  }
  return null;
}
function extract7z(firstPartPath, outDir) {
  return new Promise((resolve) => {
    const bin = find7z();
    if (!bin) return resolve({ ok: false, msg: '找不到 7-Zip（已下載分卷，請自行解壓）' });
    ensureDir(outDir);
    const p = spawn(bin, ['x', '-y', `-o${outDir}`, firstPartPath], { stdio: 'ignore' });
    p.on('close', code => resolve({ ok: code === 0, msg: code === 0 ? '解壓完成' : `7z exit ${code}` }));
  });
}

/* ---------------- 視窗 & IPC ---------------- */
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1060, height: 720,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('get-status', async () => {
  const pythonDir = getPythonDir();

  // 確保 pbs/ok 一定存在（避免 UI 因 hasPbs=false 不顯示下載按鈕）
  const pbsDir = path.join(pythonDir, 'pbs');
  ensureDir(pbsDir);
  const okFile = path.join(pbsDir, 'ok');
  try { if (!fs.existsSync(okFile)) fs.writeFileSync(okFile, 'ok'); } catch {}

  const modelDir = path.join(pythonDir, 'models', 'sd-turbo');
  const hasModel = fs.existsSync(modelDir) && fs.readdirSync(modelDir).length > 0;

  return { pythonDir, modelDir, hasPbs: true, hasModel, isDev };
});

ipcMain.handle('download-model', async () => {
  try {
    const pythonDir = getPythonDir();
    const packDir   = path.join(pythonDir, 'models', 'packs');
    ensureDir(packDir);

    const parts = await getReleaseParts(GH_OWNER, GH_REPO, GH_TAG, ASSET_PREFIX);
    win.webContents.send('dl-log', `找到 ${parts.length} 個分卷，開始下載…`);

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const dest = path.join(packDir, p.name);
      win.webContents.send('dl-start', { index: i + 1, total: parts.length, name: p.name, size: p.size });
      await downloadWithRedirect(p.url, dest, (done, total) => {
        win.webContents.send('dl-progress', { name: p.name, done, total });
      });
      win.webContents.send('dl-done', { name: p.name });
    }

    const first = path.join(packDir, parts[0].name);
    const outDir = path.join(pythonDir, 'models', 'sd-turbo');
    const { ok, msg } = await extract7z(first, outDir);
    win.webContents.send('dl-log', ok ? '解壓完成。' : msg);

    return { ok: true, message: ok ? '模型下載並解壓完成' : msg, outDir };
  } catch (err) {
    dialog.showErrorBox('模型下載失敗', String(err && err.message || err));
    return { ok: false, message: String(err && err.message || err) };
  }
});
