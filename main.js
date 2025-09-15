const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

let mainWindow = null;

// -------------------- Settings (只存模型路徑) --------------------
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return { modelRoot: '' }; }
}
function saveSettings(st) {
  try { fs.writeFileSync(settingsFile, JSON.stringify(st, null, 2)); } catch {}
}
let settings = loadSettings();

// -------------------- Python bootstrap 檢查 --------------------
function resolvePythonBase() {
  const cands = [
    path.join(process.resourcesPath, 'python'), // packaged
    path.join(__dirname, 'python'),             // dev
    path.join(process.cwd(), 'python')
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}
function checkBootstrap() {
  const base = resolvePythonBase();
  return !!(base && fs.existsSync(path.join(base, 'pbs', 'ok')));
}

// -------------------- Log helper --------------------
function sendLog(m) {
  if (mainWindow) mainWindow.webContents.send('log:append', m);
}

// -------------------- HTTP + 302 follow + Range 續傳 --------------------
function httpsGetFollow(url, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      res => {
        // Redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          resolve(httpsGetFollow(next, options, maxRedirects - 1));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function downloadWithResume(url, dest, retries = 5) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  let start = 0;
  if (fs.existsSync(dest)) start = fs.statSync(dest).size;

  let res;
  try {
    res = await httpsGetFollow(url, {
      headers: start ? { Range: `bytes=${start}-` } : {}
    });
  } catch (e) {
    if (retries > 0) return downloadWithResume(url, dest, retries - 1);
    throw e;
  }

  if (res.statusCode === 416) {
    // 已完整
    return;
  }
  if (res.statusCode && res.statusCode >= 400) {
    throw new Error(`HTTP ${res.statusCode} for ${url}`);
  }

  const total =
    (parseInt(res.headers['content-length'] || '0', 10) || 0) + start;
  const writeStream = fs.createWriteStream(dest, { flags: start ? 'a' : 'w' });

  let received = start;
  let lastTick = Date.now();

  await new Promise((resolve, reject) => {
    res.on('data', chunk => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 700) {
        const pct = total ? ((received / total) * 100).toFixed(1) : '?';
        sendLog(`下載中：${path.basename(dest)}  ${Math.round(received / 1e6)}MB / ${total ? Math.round(total / 1e6) : '?'}MB (${pct}%)`);
        lastTick = now;
      }
    });
    res.pipe(writeStream);
    res.on('end', () => writeStream.close(resolve));
    res.on('error', err => {
      writeStream.close();
      reject(err);
    });
  });

  // 簡單檢查
  if (total && received !== total) {
    if (retries > 0) {
      sendLog(`大小不符，重試：${path.basename(dest)}（剩餘重試 ${retries}）`);
      return downloadWithResume(url, dest, retries - 1);
    }
    throw new Error(`Size mismatch for ${path.basename(dest)}`);
  }
}

// -------------------- 7z 解壓 --------------------
function spawnP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    p.stdout.on('data', d => sendLog(String(d).trim()));
    p.stderr.on('data', d => sendLog(String(d).trim()));
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function extract7z(firstPart, outDir) {
  const pyBase = resolvePythonBase() || '';
  const seven = path.join(pyBase, 'tools', '7za.exe'); // 請放這個檔
  if (!fs.existsSync(seven)) {
    sendLog('未找到 7za.exe（python/tools/7za.exe）。請先放入 7-zip 自解版，或手動解壓。');
    return false;
  }
  await fs.promises.mkdir(outDir, { recursive: true });
  await spawnP(seven, ['x', firstPart, `-o${outDir}`, '-y']);
  return true;
}

// -------------------- 下載模型（可續傳 / 302 兼容 / 分卷） --------------------
// 這裡改成你的 Release 設定： base URL、檔名前綴、份數（例如 900MB/卷 302 份）
const BASE_URL = 'https://github.com/<OWNER>/<REPO>/releases/download/<TAG>/';
const PREFIX   = 'model-pack.7z.'; // 會自動接 001 ~ NNN
const PARTS    = 19;                // ← 改成你實際份數，例如 302
const TEMP_DIR = path.join(app.getPath('temp'), 'evi-model-dl');

ipcMain.handle('model:download', async (_e, modelRoot) => {
  if (!modelRoot) throw new Error('modelRoot is empty');
  sendLog('開始下載模型 …');

  try {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });

    // 逐卷下載
    for (let i = 1; i <= PARTS; i++) {
      const idx = String(i).padStart(3, '0');
      const file = `${PREFIX}${idx}`;
      const url  = BASE_URL + file;
      const dest = path.join(TEMP_DIR, file);
      sendLog(`開始下載：${file}`);
      await downloadWithResume(url, dest);
      sendLog(`完成：${file}`);
    }

    // 解壓（從 .001 觸發會自動串接後面各卷）
    const first = path.join(TEMP_DIR, `${PREFIX}001`);
    const out   = path.join(modelRoot, 'sdxl_turbo_1.0'); // 或你想要的資料夾名稱
    const ok    = await extract7z(first, out);

    if (ok) {
      sendLog('模型解壓完成 ✓');
    } else {
      sendLog('模型下載完成，但未解壓（缺 7za）。請以 7-Zip 將 .001 解壓到：' + out);
    }

    sendLog('全部完成。');
    return true;
  } catch (err) {
    sendLog('下載/解壓發生錯誤：' + (err && err.message ? err.message : String(err)));
    throw err;
  }
});

// -------------------- 既有 IPC --------------------
ipcMain.handle('state:get', async () => {
  return {
    bootstrap: checkBootstrap(),
    modelRoot: settings.modelRoot || ''
  };
});

ipcMain.handle('model:pick-root', async () => {
  const ret = await dialog.showOpenDialog(mainWindow, {
    title: '選擇模型資料夾',
    properties: ['openDirectory', 'dontAddToRecent']
  });
  if (ret.canceled || !ret.filePaths?.[0]) return null;
  settings.modelRoot = ret.filePaths[0];
  saveSettings(settings);
  return settings.modelRoot;
});

ipcMain.handle('design:start', async (_ev, state) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'evi-brush-desktop',
    message: '生成頁示範：這裡接你的鞋款設計 / Prompt UI 。\n\n' +
             `bootstrap=${state?.bootstrap}, modelRoot=${state?.modelRoot || ''}`
  });
  return true;
});

// -------------------- Window --------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
