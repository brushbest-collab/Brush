// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

// ------------------------ 下載來源區（請改成你的實際資訊） ------------------------
const BASE_URL = 'https://github.com/brushbest-collab/Brush/releases/download/v73/'; // ← 你的 Release base URL（最後必須保留 /）
const PREFIX   = 'model-pack.7z.';   // ← 分卷檔案前綴，ex: model-pack.7z.
const PARTS    = 19;                 // ← 分卷份數（例：19 或 302）
// ---------------------------------------------------------------------------

// 可放 GH_TOKEN 支援私有 release
const COMMON_HEADERS = {};
if (process.env.GH_TOKEN) {
  COMMON_HEADERS['Authorization'] = `token ${process.env.GH_TOKEN}`;
}

// 簡單設定檔（存使用者選的 modelRoot）
const userConfPath = path.join(app.getPath('userData'), 'evi-brush.json');
function readConf() {
  try { return JSON.parse(fs.readFileSync(userConfPath, 'utf8')); }
  catch { return {}; }
}
function writeConf(obj) {
  fs.mkdirSync(path.dirname(userConfPath), { recursive: true });
  fs.writeFileSync(userConfPath, JSON.stringify(obj, null, 2), 'utf8');
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function get7zExe() {
  // 先找 app 內建的 7za，否則用系統的 7z/7za
  const embed = path.join(process.resourcesPath, 'resources', '7za.exe');
  if (process.platform === 'win32' && exists(embed)) return embed;
  // mac / linux 可改放 resources/7za (自行提供)；退而求其次找系統 PATH
  return process.platform === 'win32' ? '7z' : '7za';
}

function checkBootstrap() {
  // 判斷安裝包內沒被刪的 bootstrap 檔（有就顯示「Python bootstrap found」）
  const p = path.join(process.resourcesPath, 'python', 'pbs', 'ok');
  return exists(p);
}

let win;
async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      sandbox: false
    }
  });
  await win.loadFile('index.html');
}

// ---- 下載工具：處理 302 與 Range 續傳 ----
function httpsGetFollow(url, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirect = 10;
    let redirected = 0;

    function once(u) {
      const req = https.request(u, { method: 'GET', ...options }, res => {
        // 302 / 301 / 307
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (++redirected > maxRedirect) {
            reject(new Error('Too many redirects'));
            return;
          }
          const next = new URL(res.headers.location, u).toString();
          req.destroy();
          once(next);
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    }
    once(url);
  });
}

async function downloadWithResume(url, localFile, onProgress, headers = {}) {
  // 續傳：若已下載過就從當前大小開始
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  let start = 0;
  if (exists(localFile)) {
    start = fs.statSync(localFile).size;
  }

  const opts = { headers: { ...COMMON_HEADERS, ...headers } };
  if (start > 0) {
    opts.headers['Range'] = `bytes=${start}-`;
  }

  const res = await httpsGetFollow(url, opts);
  if (![200, 206].includes(res.statusCode)) {
    throw new Error(`HTTP ${res.statusCode} for ${url}`);
  }

  const total = Number(res.headers['content-length'] || 0) + start;
  const ws = fs.createWriteStream(localFile, { flags: 'a' });
  let read = start;

  return new Promise((resolve, reject) => {
    res.on('data', chunk => {
      read += chunk.length;
      ws.write(chunk);
      onProgress?.(read, total);
    });
    res.on('end', () => ws.end(resolve));
    res.on('error', reject);
  });
}

// ---- 解壓 7z .001 ----
async function extract7z(firstPartPath, outDir, sendLog) {
  return new Promise((resolve, reject) => {
    const exe = get7zExe();
    const args = ['x', '-y', `-o${outDir}`, firstPartPath];
    sendLog?.(`[core] 使用 7z 解壓：${exe} ${args.join(' ')}`);

    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => sendLog?.(d.toString().trimEnd()));
    child.stderr.on('data', d => sendLog?.(d.toString().trimEnd()));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`7z exit ${code}`));
    });
  });
}

// ---- IPC ----
ipcMain.handle('state:init', () => {
  const conf = readConf();
  return { bootstrap: checkBootstrap(), modelRoot: conf.modelRoot || '' };
});

ipcMain.handle('model:pick-root', async () => {
  const ret = await dialog.showOpenDialog({
    title: '選擇模型目錄',
    properties: ['openDirectory', 'createDirectory']
  });
  if (ret.canceled || !ret.filePaths?.[0]) return '';
  const root = ret.filePaths[0];
  writeConf({ ...readConf(), modelRoot: root });
  return root;
});

ipcMain.handle('model:download', async (e, { root }) => {
  const sendLog = msg => e.sender.send('ui:log', msg);
  const sendProg = p => e.sender.send('ui:progress', p);

  if (!root) throw new Error('modelRoot not set');

  const tmpDir = path.join(root, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  sendLog(`[ui] 選擇模型資料夾：${root}`);
  sendLog(`[ui] 開始下載模型（正式）…`);

  // 下載所有分卷
  for (let idx = 1; idx <= PARTS; idx++) {
    const part = String(idx).padStart(3, '0');
    const name = `${PREFIX}${part}`;
    const url = `${BASE_URL}${name}`;
    const local = path.join(tmpDir, name);

    sendLog(`[ui] 下載 ${name} …`);
    let last = 0;
    await downloadWithResume(
      url,
      local,
      (read, total) => {
        const now = Date.now();
        // 0.2 秒回報一次避免太頻繁
        if (now - last > 200) {
          sendProg({ current: idx - 1 + read / (total || 1), total: PARTS });
          last = now;
        }
      }
    );
    sendLog(`[ui] 完成 ${name}`);
    sendProg({ current: idx, total: PARTS });
  }

  // 解壓第一卷（7z 會自動讀取 .002 …）
  const first = path.join(tmpDir, `${PREFIX}001`);
  sendLog('[ui] 下載全部分卷完成，開始解壓…');
  await extract7z(first, root, sendLog);

  // 清理暫存
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  sendLog('[ui] 模型安裝完成。');
  return true;
});

ipcMain.handle('app:open-generator', async () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'EVI Brush Desktop',
    message: '這裡接入你的鞋款設計 / Prompt 生成 UI。',
    buttons: ['OK']
  });
  return true;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
