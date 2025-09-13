const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const log = (...a) => console.log('[main]', ...a);

// 解析應用根目錄（封包後是 resourcesPath，開發時是專案根）
function getAppRoot() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

// 檢查 python/pbs/ok 是否存在（輕量）
function checkBootstrap() {
  try {
    const okFile = path.join(getAppRoot(), 'python', 'pbs', 'ok');
    const exists = fs.existsSync(okFile);
    log('bootstrap ok ?', exists, '->', okFile);
    return { ok: exists, path: okFile };
  } catch (e) {
    log('checkBootstrap error', e);
    return { ok: false, path: null, error: String(e) };
  }
}

// 讀取 / 儲存偏好（存 userData）
function prefFile() {
  return path.join(app.getPath('userData'), 'pref.json');
}
function loadPref() {
  try {
    const p = prefFile();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}
function savePref(obj) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(prefFile(), JSON.stringify(obj, null, 2));
  } catch (e) {
    log('savePref error', e);
  }
}

// 解析模型根目錄（預設 D:\EVI\Models，如果沒有 D 碟則放 userData\models）
function resolveModelRoot() {
  const pref = loadPref();
  if (pref.modelRoot && typeof pref.modelRoot === 'string') {
    return pref.modelRoot;
  }
  const dDrive = process.platform === 'win32' && fs.existsSync('D:\\');
  const def = dDrive ? 'D:\\EVI\\Models' : path.join(app.getPath('userData'), 'models');
  return def;
}

// 建立視窗
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 820,
    show: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('did-finish-load', () => {
    log('did-finish-load -> send app-state');
    // 立即送一次狀態，避免前端永遠停在 checking
    sendState();
  });
}

function currentState() {
  const bs = checkBootstrap();
  const modelRoot = resolveModelRoot();
  const state = {
    ok: true,
    bootstrap: bs,
    modelRoot,
    userData: app.getPath('userData'),
    appRoot: getAppRoot(),
    isDev
  };
  return state;
}

function sendState() {
  try {
    const state = currentState();
    win.webContents.send('app-state', state);
  } catch (e) {
    log('sendState error', e);
  }
}

// IPCs
ipcMain.handle('get-state', () => {
  log('ipc get-state');
  return currentState();
});

ipcMain.handle('choose-model-dir', async () => {
  const def = resolveModelRoot();
  const res = await dialog.showOpenDialog(win, {
    title: '選擇模型根目錄',
    defaultPath: def,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths?.length) return { canceled: true };
  const modelRoot = res.filePaths[0];
  const pref = loadPref();
  pref.modelRoot = modelRoot;
  savePref(pref);
  log('set modelRoot ->', modelRoot);
  return { canceled: false, modelRoot };
});

ipcMain.on('renderer-log', (_e, ...args) => log('[renderer]', ...args));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
