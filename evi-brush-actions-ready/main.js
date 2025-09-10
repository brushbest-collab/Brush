const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let pyProc = null;

function pyRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'python')           // 安裝版：resources/python
    : path.join(__dirname, 'resources', 'python');         // 開發版：resources/python
}

function startBackendIfAny() {
  const root = pyRoot();
  const marker = path.join(root, 'pbs');

  if (!fs.existsSync(marker)) {
    dialog.showErrorBox(
      'Backend did not start.',
      'portable Python bootstrap not found (python/pbs).'
    );
    return;
  }

  const venvPy = path.join(root, 'venv', 'Scripts', 'python.exe'); // Windows
  const server = path.join(root, 'server.py');
  if (fs.existsSync(venvPy) && fs.existsSync(server)) {
    pyProc = spawn(venvPy, [server], { cwd: root, stdio: 'ignore' });
    pyProc.on('error', (e) => console.error('Python error:', e));
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: { contextIsolation: true }
  });
  // 你自己的前端頁面，沒有的話放個 index.html
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  startBackendIfAny();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', () => {
  if (pyProc) {
    try { pyProc.kill(); } catch (_) {}
  }
});
