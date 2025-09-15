const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// --- 簡單的使用者設定（只存 modelRoot） ---
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return { modelRoot: '' };
  }
}
function saveSettings(st) {
  try { fs.writeFileSync(settingsFile, JSON.stringify(st, null, 2)); } catch {}
}
let settings = loadSettings();

// --- 同時支援 dev 與 packaged 的 python 路徑 ---
function resolvePythonBase() {
  const candidates = [
    path.join(process.resourcesPath, 'python'), // packaged
    path.join(__dirname, 'python'),             // dev
    path.join(process.cwd(), 'python')          // fallback
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function checkBootstrap() {
  const base = resolvePythonBase();
  if (!base) return false;
  return fs.existsSync(path.join(base, 'pbs', 'ok'));
}

// --- IPC handlers ---
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
  // 你可以在此啟動 Python / WebUI / 推進工作流程
  // 目前先顯示提示訊息
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'evi-brush-desktop',
    message: '生成頁示範：這裡接你的鞋款設計 / Prompt UI 。\n\n' +
             `bootstrap=${state?.bootstrap}, modelRoot=${state?.modelRoot || ''}`
  });
  return true;
});

// --- 建立視窗 ---
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
