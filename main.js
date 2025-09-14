// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
let win;

/* -------------------- 簡易設定儲存器（無外部套件） -------------------- */
let storePath = null;
let storeCache = null;

function ensureStoreLoaded() {
  if (!storePath) {
    // userData 例如：C:\Users\<你>\AppData\Roaming\evi-brush-desktop
    storePath = path.join(app.getPath('userData'), 'evi-brush.json');
  }
  if (storeCache === null) {
    try {
      const txt = fs.readFileSync(storePath, 'utf8');
      storeCache = JSON.parse(txt);
    } catch {
      storeCache = {};
    }
  }
  return storeCache;
}
function storeGet(key, defVal) {
  const s = ensureStoreLoaded();
  return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : defVal;
}
function storeSet(key, val) {
  const s = ensureStoreLoaded();
  s[key] = val;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    sendLog(`[store:save:error] ${e?.stack || e}`);
  }
}

/* -------------------- 共用工具 -------------------- */
function sendLog(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('log', String(msg));
}
function getResourcesBase() {
  return process.env.PORTABLE_EXECUTABLE_DIR || process.resourcesPath || app.getAppPath();
}

/* -------------------- 建立視窗 -------------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* -------------------- IPC：一律 try/catch，永不讓前端卡住 -------------------- */
ipcMain.handle('state:get', async () => {
  try {
    const base = getResourcesBase();
    const pyDir  = path.join(base, 'python');
    const pbsDir = path.join(pyDir, 'pbs');
    const okFile = path.join(pbsDir, 'ok');

    const bootstrap =
      fs.existsSync(pyDir) &&
      fs.existsSync(pbsDir) &&
      fs.existsSync(okFile);

    const modelRoot = storeGet('modelRoot', ''); // 可能是空字串
    sendLog(`[state] bootstrap=${bootstrap} base=${base} modelRoot=${modelRoot || '(none)'}`);

    return {
      ok: true,
      bootstrap,
      base,
      modelRoot,
      canSelect: true,
    };
  } catch (err) {
    sendLog(`[state:error] ${err?.stack || err}`);
    return {
      ok: false,
      bootstrap: false,
      base: '',
      modelRoot: '',
      canSelect: true,
      message: String(err),
    };
  }
});

ipcMain.handle('dialog:pickModelDir', async () => {
  try {
    const def = storeGet('modelRoot', 'D:\\Models');
    const res = await dialog.showOpenDialog(win, {
      title: '選擇模型資料夾',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: def,
    });
    if (res.canceled || !res.filePaths?.length) return { canceled: true };
    const picked = res.filePaths[0];
    storeSet('modelRoot', picked);
    sendLog(`[pick] modelRoot=${picked}`);
    return { canceled: false, modelRoot: picked };
  } catch (err) {
    sendLog(`[pick:error] ${err?.stack || err}`);
    return { canceled: true, error: String(err) };
  }
});

ipcMain.handle('model:download', async (_evt, _opts) => {
  sendLog('[download] TODO: 這裡接你的實際下載流程（分卷/續傳/302 轉址處理）');
  return { started: true };
});

ipcMain.handle('app:openDesign', async () => {
  const { dialog } = require('electron');
  await dialog.showMessageBox(win, {
    type: 'info',
    message: '生成頁示範：這裡接你的鞋款設計 / Prompt UI。',
  });
  return { opened: true };
});
