// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store({
  name: 'settings',
  defaults: {
    modelRoot: '',   // 使用者選的模型資料夾
  },
});

let win;

/** 判斷 bootstrap 標記是否存在（你的打包流程會在 python/pbs/ok 寫入 ok） */
function checkBootstrap() {
  try {
    const okFile = path.join(process.resourcesPath, 'python', 'pbs', 'ok');
    return fs.existsSync(okFile);
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

/** 這裡把所有 Renderer 會呼叫的 IPC handler 註冊好 */
function registerIpc() {
  // 目前狀態（給 UI 首次載入）
  ipcMain.handle('state:get', async () => {
    const modelRoot = store.get('modelRoot', '');
    return { modelRoot, bootstrap: checkBootstrap() };
  });

  // 選擇模型資料夾
  ipcMain.handle('model:pick-root', async () => {
    const ret = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '選擇模型資料夾',
    });

    if (!ret.canceled && ret.filePaths && ret.filePaths[0]) {
      const p = ret.filePaths[0];
      store.set('modelRoot', p);
      // 通知前端狀態改變（可選）
      win.webContents.send('state:update', {
        modelRoot: p,
        bootstrap: checkBootstrap(),
      });
      return { ok: true, path: p };
    }
    return { ok: false };
  });
}

app.whenReady().then(() => {
  registerIpc();         // <<<< 必須先註冊，再建立視窗
  createWindow();
});

app.on('window-all-closed', () => app.quit());
