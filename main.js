// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// ──────────────────────────────────────────────────────────
// 小型持久化（簡單版；若你已有 electron-store 可替換成它）
// ──────────────────────────────────────────────────────────
const STORE_FILE = path.join(app.getPath('userData'), 'evi-store.json');
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveStore(obj) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), 'utf8'); } catch {}
}
const store = loadStore();

// ──────────────────────────────────────────────────────────
// Window
// ──────────────────────────────────────────────────────────
let win;
function create() {
  win = new BrowserWindow({
    width: 1160,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}
app.whenReady().then(create);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
function sendLog(msg) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', `[ui] ${msg}`);
  }
}
function getModelRoot() {
  return store.modelRoot || '';
}
function setModelRoot(p) {
  store.modelRoot = p;
  saveStore(store);
}

// 有沒有把模型解壓好？（簡單判斷：資料夾存在而且裡面有檔案）
function isModelInstalled() {
  const root = getModelRoot();
  if (!root) return false;
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return false;
    const files = fs.readdirSync(root);
    return files && files.length > 0;
  } catch { return false; }
}

// ──────────────────────────────────────────────────────────
// IPC
// ──────────────────────────────────────────────────────────
ipcMain.handle('get-state', async () => {
  return {
    bootstrap: true,
    modelRoot: getModelRoot(),
    modelInstalled: isModelInstalled()
  };
});

ipcMain.handle('select-model-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false };
  const p = r.filePaths[0];
  setModelRoot(p);
  sendLog(`選擇模型資料夾：${p}`);
  return { ok: true, path: p, modelInstalled: isModelInstalled() };
});

// 下載模型（仍示範；真正下載你已用 workflow 發佈，這裡保留按鈕）
ipcMain.handle('download-model', async () => {
  sendLog('開始下載模型（示範 / 不實作下載）');
  await new Promise(r => setTimeout(r, 800));
  sendLog('示範下載完成。');
  return { ok: true };
});

// 進入生成頁
ipcMain.handle('open-generator', async () => {
  if (!isModelInstalled()) {
    return { ok: false, message: '尚未安裝模型，請先下載 / 指定模型資料夾。' };
  }
  return { ok: true };
});

// 生成（示範版；之後把這裡改成打你的 Python 服務） 
ipcMain.handle('generate', async (_e, payload) => {
  const { style, prompt, negative, width, height, steps, cfg, seed } = payload;

  sendLog(`開始生成（示範）：style=${style}, size=${width}x${height}, steps=${steps}, cfg=${cfg}, seed=${seed}`);
  await new Promise(r => setTimeout(r, 1200));
  sendLog('生成完成（示範）。');

  // 回傳一張 base64 假圖（灰底+文字），僅供 UI 顯示
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#f2f3f5"/>
  <text x="50%" y="50%" text-anchor="middle" fill="#333" font-size="20" font-family="Segoe UI, Arial" dy="5">
    Demo: ${style}
  </text>
</svg>`;
  const img = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return { ok: true, imageDataUrl: img };
});
