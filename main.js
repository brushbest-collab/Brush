// main.js —— 完整穩定版（可直接覆蓋）
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');              // 內建 7z，可在使用者未裝 7-Zip 的情況下解壓
const sevenPath = sevenBin.path7za;

let win = null;

/* -------------------- 共用工具 -------------------- */
const state = new Map();
function send(ch, payload) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(ch, payload); } catch (_) {}
  }
}
function log(msg, level = 'info') { send('log', { level, msg, ts: Date.now() }); }
function progress(pct) { send('progress', Math.max(0, Math.min(100, Number(pct) || 0))); }

function pickExisting(paths) {
  for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}
function resolveHtml() {
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

/* -------------------- Python bootstrap 偵測 -------------------- */
function findBootstrapMarker() {
  const c = [
    path.join(__dirname, 'python', 'pbs', 'ok'),                                 // dev
    path.join(process.resourcesPath, 'python', 'pbs', 'ok'),                      // extraResources
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'ok'), // asarUnpack
    path.join(process.resourcesPath, 'app', 'python', 'pbs', 'ok')                // 某些打包結構
  ];
  return pickExisting(c);
}
function detectBootstrap() {
  const marker = findBootstrapMarker();
  const found = !!marker;
  state.set('bootstrap', found);
  log(found ? `Python bootstrap marker FOUND: ${marker}` : 'Python bootstrap NOT found');
  return found;
}

/* -------------------- 視窗載入 -------------------- */
async function loadRenderer(w) {
  if (process.env.ELECTRON_START_URL) {
    await w.loadURL(process.env.ELECTRON_START_URL);
    return;
  }
  const html = resolveHtml();
  if (!html) {
    dialog.showErrorBox('Renderer 未找到', '找不到 index.html（請確認前端輸出有打包進去）');
    return;
  }
  await w.loadFile(html);
}

async function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.cjs'); // 一律指定，不做 exists 檢查

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => dialog.showErrorBox('did-fail-load', `code=${code}\n${desc}\nurl=${url}`));

  await loadRenderer(win);

  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap();
}

/* -------------------- 下載與解壓（MODEL_PARTS 設定在這） -------------------- */
// 將下列陣列改成你 Release 上的直鏈（.7z.001, .7z.002, ...）。
// 留空時會直接略過下載流程（避免 CI 或本機測試出錯）。
const MODEL_PARTS = [
  // "https://github.com/<owner>/<repo>/releases/download/<tag>/model-pack.7z.001",
  // "https://github.com/<owner>/<repo>/releases/download/<tag>/model-pack.7z.002"
];

function httpDownload(fileUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doGet = (url) => {
      const file = fs.createWriteStream(destPath);
      https.get(url, (res) => {
        // 處理 3xx 轉址
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); fs.unlink(destPath, () => {});
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close(); fs.unlink(destPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total && typeof onProgress === 'function') onProgress(Math.round(received * 100 / total));
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
      }).on('error', (err) => {
        file.close(); fs.unlink(destPath, () => {});
        reject(err);
      });
    };
    doGet(fileUrl);
  });
}

function sevenExtract(firstPartPath, outDir) {
  return new Promise((resolve, reject) => {
    // 7za x model-pack.7z.001 -o<outDir> -y
    const proc = spawn(sevenPath, ['x', firstPartPath, `-o${outDir}`, '-y']);
    proc.stdout.on('data', d => log(String(d)));
    proc.stderr.on('data', d => log(String(d), 'warn'));
    proc.on('close', (code) => code === 0 ? resolve(true) : reject(new Error(`7z exit ${code}`)));
  });
}

/* -------------------- Python 啟動 -------------------- */
function findPythonExe() {
  const envPath = process.env.EVI_PYTHON_EXE;
  const c = [
    envPath && path.normalize(envPath),
    path.join(process.resourcesPath, 'python', 'python.exe'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'python.exe'),
    path.join(__dirname, 'python', 'python.exe')
  ].filter(Boolean);
  return pickExisting(c);
}
function findEntryScript() {
  // 依你的實際入口檔名調整，或用環境變數 EVI_PY_ENTRY 指定
  const envEntry = process.env.EVI_PY_ENTRY;
  const c = [
    envEntry && path.normalize(envEntry),
    path.join(process.resourcesPath, 'python', 'pbs', 'serve.py'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'serve.py'),
    path.join(__dirname, 'python', 'pbs', 'serve.py')
  ].filter(Boolean);
  return pickExisting(c);
}

let pyProc = null;

/* -------------------- IPC -------------------- */
ipcMain.handle('state:get', (_e, key) => state.get(key));
ipcMain.handle('state:set', (_e, { key, val }) => { state.set(key, val); return true; });

ipcMain.handle('dialog:openDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('model:download', async () => {
  try {
    const root = state.get('modelRoot');
    if (!root) throw new Error('請先選擇模型資料夾');

    if (!MODEL_PARTS.length) {
      log('No MODEL_PARTS configured, skip download (OK for dev).');
      return true;
    }

    const tmp = path.join(root, '_dl_tmp');
    fs.mkdirSync(tmp, { recursive: true });
    log('Start download…');

    for (let i = 0; i < MODEL_PARTS.length; i++) {
      const url = MODEL_PARTS[i];
      const fname = path.basename(url);
      const out = path.join(tmp, fname);
      log(`Downloading ${fname}`);
      await httpDownload(url, out, (pct) => {
        const base = (i / MODEL_PARTS.length) * 100;
        progress(Math.min(99, Math.floor(base + pct / MODEL_PARTS.length)));
      });
    }

    const firstPart = path.join(tmp, path.basename(MODEL_PARTS[0]));
    log('Extracting with 7z…');
    await sevenExtract(firstPart, root);

    progress(100);
    log('Download finished.');

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    return true;
  } catch (err) {
    log(`Download error: ${err.message}`, 'error');
    throw err;
  }
});

ipcMain.handle('designer:open', async () => {
  try {
    // 已在跑就不重啟
    if (pyProc && !pyProc.killed) {
      log('Python service already running.');
    } else {
      const pyExe = findPythonExe();
      const entry = findEntryScript();
      if (pyExe && entry) {
        log(`Start python: ${pyExe} ${entry}`);
        pyProc = spawn(pyExe, [entry], { cwd: path.dirname(entry) });
        pyProc.stdout.on('data', d => log(`[py] ${String(d).trim()}`));
        pyProc.stderr.on('data', d => log(`[py-err] ${String(d).trim()}`, 'warn'));
        pyProc.on('close', c => log(`[py] exit ${c}`));
      } else {
        log('Python exe or entry not found — open URL directly.', 'warn');
      }
    }

    // 無論是否啟動 Python，嘗試打開 UI（若服務起來就會通）
    const url = process.env.DESIGNER_URL || 'http://127.0.0.1:8000';
    const child = new BrowserWindow({ width: 1280, height: 800 });
    await child.loadURL(url);
    log('Open designer.');
    return true;
  } catch (err) {
    log(`Open designer error: ${err.message}`, 'error');
    throw err;
  }
});

/* -------------------- 啟動 & 錯誤兜底 -------------------- */
process.on('uncaughtException', (err) => dialog.showErrorBox('Main Error', String((err && err.stack) || err)));
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
