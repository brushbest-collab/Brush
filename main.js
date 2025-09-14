// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store({ name: 'evi-brush' });
const isDev = !app.isPackaged;

let win;

function sendLog(msg) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', String(msg));
  }
}

function getResourcesBase() {
  // 可攜版/開發版/安裝版都能正確取到 base
  return process.env.PORTABLE_EXECUTABLE_DIR || process.resourcesPath || app.getAppPath();
}

function ensureWindow() {
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

app.whenReady().then(ensureWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) ensureWindow(); });

/* ---------- IPC handlers: 一律 try/catch，永不讓前端卡住 ---------- */

ipcMain.handle('state:get', async () => {
  try {
    const base = getResourcesBase();
    const pyDir = path.join(base, 'python');
    const pbsDir = path.join(pyDir, 'pbs');
    const okFile = path.join(pbsDir, 'ok');

    const bootstrap =
      fs.existsSync(pyDir) &&
      fs.existsSync(pbsDir) &&
      fs.existsSync(okFile);

    // 讀上次選過的模型路徑，沒有的話給空字串（讓 UI 提示选择）
    const modelRoot = store.get('modelRoot', '');

    sendLog(`[state] bootstrap=${bootstrap} base=${base} modelRoot=${modelRoot || '(none)'}`);

    return {
      ok: true,
      bootstrap,
      base,
      modelRoot,                 // 可能是空字串
      canSelect: true,           // UI 可用
    };
  } catch (err) {
    sendLog(`[state:error] ${err?.stack || err}`);
    return {
      ok: false,
      bootstrap: false,
      base: '',
      modelRoot: '',
      canSelect: true,           // 即使錯誤也不鎖 UI
      message: String(err),
    };
  }
});

ipcMain.handle('dialog:pickModelDir', async () => {
  try {
    const def = store.get('modelRoot', 'D:\\Models');
    const res = await dialog.showOpenDialog(win, {
      title: '選擇模型資料夾',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: def,
    });
    if (res.canceled || !res.filePaths?.length) return { canceled: true };

    const picked = res.filePaths[0];
    store.set('modelRoot', picked);
    sendLog(`[pick] modelRoot=${picked}`);
    return { canceled: false, modelRoot: picked };
  } catch (err) {
    sendLog(`[pick:error] ${err?.stack || err}`);
    return { canceled: true, error: String(err) };
  }
});

// 這裡預留開始下載/開啟設計頁等 IPC（不會讓 UI 卡住）
ipcMain.handle('model:download', async (_evt, _opts) => {
  sendLog('[download] TODO: 實作下載流程或呼叫既有 downloader');
  return { started: true };
});

ipcMain.handle('app:openDesign', async () => {
  // 這裡先跳個提示，之後你可以改成載入真正設計頁
  const { dialog } = require('electron');
  await dialog.showMessageBox(win, {
    type: 'info',
    message: '生成頁示範：這裡接你的鞋款設計 / Prompt UI。',
  });
  return { opened: true };
});
