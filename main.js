// ===== main.js (完整覆蓋) =====
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const sevenBin = require('7zip-bin');

const isDev = !app.isPackaged;

// =============== 視窗 ===============
function create() {
  const win = new BrowserWindow({
    width: 1024,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}
app.whenReady().then(create);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// =============== 路徑與檢查工具 ===============
const DEFAULT_D_DIR = 'D:\\EVI-Brush\\models\\sd-turbo';

// 優先用 D 槽固定路徑；若不可用則回退 userData
function resolveModelDir() {
  const envOverride = process.env.EVI_MODEL_DIR; // 你也可用環境變數手動指定
  if (envOverride && ensureWritableDir(envOverride)) return envOverride;

  if (isWindowsDriveExists('D:')) {
    // D 槽存在 → 試著用 D 槽
    if (ensureWritableDir(DEFAULT_D_DIR)) return DEFAULT_D_DIR;
  }
  // 回退到使用者資料夾
  const fallback = path.join(app.getPath('userData'), 'models', 'sd-turbo');
  ensureWritableDir(fallback);
  return fallback;
}

// 嘗試建立資料夾並測試可寫
function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const test = path.join(dir, '.__wtest');
    fs.writeFileSync(test, 'ok');
    fs.rmSync(test, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isWindowsDriveExists(rootLikeD) {
  try { return fs.existsSync(rootLikeD + '\\'); } catch { return false; }
}

// 暫存位置：放 7z 分卷
function getTempDir() {
  const tmp = path.join(app.getPath('temp'), 'evi-brush-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

// 清理暫存分卷
function cleanTemp() {
  const d = getTempDir();
  if (!fs.existsSync(d)) return;
  try {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('model-pack.7z.')) {
        try { fs.rmSync(path.join(d, f), { force: true }); } catch {}
      }
    }
  } catch {}
}

// 取得某路徑所在磁碟剩餘空間（Bytes）
function getFreeBytesFor(p) {
  if (process.platform !== 'win32') return 0; // 這裡只針對 Windows
  const drive = path.parse(p).root.replace(/\\$/, ''); // e.g. "D:"
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile','-Command', `(Get-PSDrive -Name ${drive.replace(':','')}).Free`],
      { encoding: 'utf8' }
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

// =============== 下載（支援 302 + Range 續傳） ===============
function downloadWithResume(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const startAt = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'EVI-Brush-Desktop/1.0',
        ...(startAt > 0 ? { 'Range': `bytes=${startAt}-` } : {})
      }
    }, res => {
      // 追隨重新導向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadWithResume(res.headers.location, dest, onProgress));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206)
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));

      const total = Number(res.headers['content-length'] || 0) + startAt;
      let loaded = startAt;

      const ws = fs.createWriteStream(dest, { flags: startAt > 0 ? 'a' : 'w' });
      res.on('data', chunk => {
        loaded += chunk.length;
        if (typeof onProgress === 'function') onProgress({ url, loaded, total });
      });
      res.pipe(ws);
      ws.on('finish', () => ws.close(resolve));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// 7z：由 001 自動解完整分卷
function extract7z001To(targetDir, head001) {
  return new Promise((resolve, reject) => {
    const seven = sevenBin.path7za; // 內建 7za.exe
    const args  = ['x', '-y', '-aoa', `-o${targetDir}`, head001];
    const p = spawn(seven, args, { stdio: ['ignore','pipe','pipe'] });

    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`7z exit ${code}\n${out}\n${err}`));
    });
  });
}

// =============== IPC：提供前端呼叫 ===============

// 回傳實際模型安裝路徑（給 UI 顯示）
ipcMain.handle('get-model-dir', async () => resolveModelDir());

// 下載 + 解壓模型
// 參數格式：{ assets: [{ name, browser_download_url }, ...], assumedTotalGB?: number }
ipcMain.handle('download-model', async (_evt, { assets = [], assumedTotalGB = 40 }) => {
  if (!assets.length) throw new Error('找不到可下載的模型分卷清單。');

  const modelDir = resolveModelDir();     // 優先 D 槽
  const tempDir  = getTempDir();

  // 檢查目標磁碟空間：使用估算值（可自行改成總 Content-Length × 1.1）
  const needBytes = Math.max(assumedTotalGB, 40) * 1024 * 1024 * 1024; // 至少 40GB
  const freeBytes = getFreeBytesFor(modelDir);
  if (freeBytes > 0 && freeBytes < needBytes) {
    throw new Error(`目標磁碟（${path.parse(modelDir).root}）剩餘 ${(freeBytes/1e9).toFixed(1)} GB，不足 ${(needBytes/1e9).toFixed(0)} GB。請改路徑或釋放空間。`);
  }

  // 1) 清除舊暫存
  cleanTemp();

  // 2) 逐一下載分卷到 tempDir
  for (const a of assets) {
    const url  = a.browser_download_url || a.url || a;
    const name = a.name || path.basename(url);
    const to   = path.join(tempDir, name);
    await downloadWithResume(url, to); // 如需顯示進度，可傳 onProgress
  }

  // 3) 確認頭卷存在
  const head = path.join(tempDir, 'model-pack.7z.001');
  if (!fs.existsSync(head)) throw new Error('找不到 model-pack.7z.001，請確認 Release 資產完整。');

  // 4) 先清空目標資料夾（避免殘檔/權限）
  try { fs.rmSync(modelDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(modelDir, { recursive: true });

  // 5) 解壓全部分卷到 modelDir
  await extract7z001To(modelDir, head);

  // 6) 成功 → 刪暫存
  cleanTemp();

  return { ok: true, modelDir };
});
