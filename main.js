// main.js - 非 DEMO：真實下載 + 302 redirect + 斷點續傳 + 7z 解壓
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { https } = require('follow-redirects'); // 自動跟隨 3xx
const sevenBin = require('7zip-bin'); // 內建 7z 可攜執行檔

// ====== 你的 GitHub 倉庫資訊（公開專案不需要 token）======
const GH_OWNER = 'brushbest-collab';
const GH_REPO  = 'Brush';
const ASSET_PREFIX = 'model-pack.7z.'; // 會自動抓 001..NNN
// ========================================================

// ---------- 持久化設定 ----------
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
function pickDefaultModelRoot() {
  // 優先 D:\Models（若 D 槽存在），否則 C:\Models
  const dDrive = path.parse(process.env.SystemDrive || 'C:').root.replace(/\\?$/, '\\');
  let best = 'C:\\Models';
  try {
    if (fs.existsSync('D:\\')) best = 'D:\\Models';
  } catch {}
  return best;
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function isModelInstalled(modelRoot) {
  try {
    const cands = [
      path.join(modelRoot, 'sdxl-turbo', 'sd_xl_turbo_1.0.safetensors'),
      path.join(modelRoot, 'sdxl-turbo', 'sd_xl_turbo_1.0.fp16.safetensors'),
    ];
    return cands.some(p => fs.existsSync(p) && fs.statSync(p).size > 100*1024*1024);
  } catch { return false; }
}

// ---------- 視窗與 UI 溝通 ----------
let win = null;
function send(channel, payload) { try { win?.webContents.send(channel, payload); } catch {} }
function logUi(line) { send('ui-log', line); }
function setProgress(ratio) { send('ui-progress', Math.max(0, Math.min(1, ratio || 0))); }

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    }
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
  // win.webContents.openDevTools({ mode: 'detach' });
}

// ---------- GitHub API：取得最新 release 的資產清單 ----------
function httpJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'evi-brush-desktop',
        'Accept': 'application/vnd.github+json',
        ...headers,
      }
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}\n${buf}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function fetchLatestAssets() {
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;
  const data = await httpJSON(api);
  const tag = data.tag_name;
  const assets = (data.assets || [])
    .filter(a => a.name.startsWith(ASSET_PREFIX))
    .map(a => ({ name: a.name, tag }));
  if (!assets.length) throw new Error('Latest release 未找到模型分卷。');
  // 依名稱排序（001..NNN）
  assets.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return assets; // [{name, tag}]
}

// ---------- 斷點續傳下載（自動跟隨 302） ----------
function downloadFileWithResume(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));

    let start = 0;
    try { if (fs.existsSync(dest)) start = fs.statSync(dest).size; } catch {}
    const out = fs.createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' });

    const req = https.get(url, {
      headers: {
        'User-Agent': 'evi-brush-desktop',
        'Accept': 'application/octet-stream',
        ...(start > 0 ? { Range: `bytes=${start}-` } : {}),
        ...headers,
      }
    }, res => {
      // 有些 CDN 會對 range 回 200，這裡若 200 且我們是續傳 -> 重新從 0
      if (start > 0 && res.statusCode === 200) {
        out.close();
        fs.unlinkSync(dest);
        return resolve(downloadFileWithResume(url, dest, headers));
      }
      if (![200, 206].includes(res.statusCode)) {
        out.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.on('data', chunk => out.write(chunk));
      res.on('end', () => { out.end(); resolve(); });
    });

    req.on('error', err => { out.close(); reject(err); });
  });
}

// ---------- 一次下載所有分卷並解壓 ----------
async function downloadAllAndExtract(modelRoot) {
  const assets = await fetchLatestAssets(); // [{name, tag}]
  const tag = assets[0].tag;
  const dlDir = path.join(app.getPath('userData'), 'downloads', tag);
  ensureDir(dlDir);

  let done = 0;
  for (const a of assets) {
    const url = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(a.name)}`;
    const dest = path.join(dlDir, a.name);
    logUi(`開始下載：${a.name}`);
    await downloadFileWithResume(url, dest);
    done += 1;
    setProgress(done / assets.length * 0.9); // 90% 給下載，10% 解壓
    logUi(`完成：${a.name}`);
  }

  // 解壓：7z 只要指定 .001，會自動吃到同資料夾其餘分卷
  const firstPart = path.join(dlDir, assets[0].name);
  const outDir   = path.join(modelRoot, 'sdxl-turbo');
  ensureDir(outDir);

  logUi('開始解壓縮（7z）...');
  await sevenExtract(firstPart, outDir);
  logUi('解壓縮完成。');

  // 驗證是否裝好
  if (!isModelInstalled(modelRoot)) {
    throw new Error('模型解壓後仍未發現 safetensors，請檢查壓縮檔是否完整。');
  }
  setProgress(1);
}

function sevenExtract(first7zPart, outDir) {
  return new Promise((resolve, reject) => {
    const exe = sevenBin.path7za; // 可攜 7za
    const args = ['x', '-y', `-o${outDir}`, first7zPart];
    const p = spawn(exe, args, { windowsHide: true });

    p.stdout.on('data', d => logUi(d.toString().trimEnd()));
    p.stderr.on('data', d => logUi(d.toString().trimEnd()));
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`7z exit ${code}`));
    });
  });
}

// ---------- IPC ----------
ipcMain.handle('get-state', async () => {
  const s = loadSettings();
  let modelRoot = s.modelRoot || pickDefaultModelRoot();
  ensureDir(modelRoot);
  const installed = isModelInstalled(modelRoot);
  return { bootstrap: true, modelRoot, installed };
});

ipcMain.handle('pick-model-dir', async () => {
  const s = loadSettings();
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: s.modelRoot || pickDefaultModelRoot()
  });
  if (r.canceled || !r.filePaths?.length) return null;
  s.modelRoot = r.filePaths[0];
  saveSettings(s);
  return { modelRoot: s.modelRoot, installed: isModelInstalled(s.modelRoot) };
});

ipcMain.handle('set-model-root', async (_e, dir) => {
  const s = loadSettings();
  s.modelRoot = dir;
  saveSettings(s);
  return { modelRoot: s.modelRoot, installed: isModelInstalled(s.modelRoot) };
});

ipcMain.handle('download-model', async () => {
  const s = loadSettings();
  const modelRoot = s.modelRoot || pickDefaultModelRoot();
  ensureDir(modelRoot);
  try {
    logUi('開始下載模型（自動續傳 / 302 兼容）...');
    setProgress(0.01);
    await downloadAllAndExtract(modelRoot);
    logUi('模型下載與安裝完成。');
    return { ok: true, installed: isModelInstalled(modelRoot) };
  } catch (e) {
    logUi(`下載 / 解壓錯誤：${e.message}`);
    throw e;
  }
});

ipcMain.handle('open-design', async () => {
  dialog.showMessageBox(win, {
    type: 'info',
    message: '生成頁示範：這裡接你的鞋款設計 / Prompt UI。\n（目前為占位界面）'
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
