// ==== 原本的引用，補上 dialog ====
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
let pyProc = null;

// ==== [新增] 自動更新依賴（有裝 electron-log 則用；沒裝就回落 console）====
const log = (() => {
  try {
    const l = require('electron-log');
    l.transports.file.level = 'info';
    return l;
  } catch (e) {
    return {
      info: console.log,
      warn: console.warn,
      error: console.error,
      transports: { file: {} },
    };
  }
})();

let autoUpdater = null;
try {
  // 需要在 package.json dependencies 安裝 electron-updater
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  log.warn('[Updater] electron-updater not installed, auto update disabled');
}

// ==== 原本的程式 ====
async function waitForServer(url, attempts=100, delay=300) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      http.get(url, res => { clearInterval(timer); resolve(); }).on('error', _ => {
        if (tries >= attempts) { clearInterval(timer); reject(new Error('Server not responding')); }
      });
    }, delay);
  });
}

function startPython() {
  const pyRoot = app.isPackaged ? path.join(process.resourcesPath, 'python') : path.join(__dirname, 'python');
  const isWin = process.platform === 'win32';
  const pythonExe = isWin ? path.join(pyRoot, 'venv', 'Scripts', 'python.exe') : path.join(pyRoot, 'venv', 'bin', 'python');
  const serverScript = path.join(pyRoot, 'server.py');

  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: "1",
    HF_HOME: path.join(pyRoot, 'hf_home'),
    HF_HUB_OFFLINE: "1"
  });
  pyProc = spawn(pythonExe, [serverScript], { cwd: pyRoot, env });

  pyProc.stdout.on('data', (d) => console.log(`[py] ${d}`));
  pyProc.stderr.on('data', (d) => console.error(`[py] ${d}`));
  pyProc.on('close', (c) => console.log(`Python exited: ${c}`));
  return pyProc;
}

async function createWindow () {
  const win = new BrowserWindow({ width: 1280, height: 860 });
  if (!pyProc) { startPython(); }
  try {
    await waitForServer('http://127.0.0.1:7860');
    win.loadURL('http://127.0.0.1:7860');
  } catch(e) {
    win.loadURL('data:text/html,<h2>Backend did not start. Run freeze script to bundle Python & model, then rebuild installer.</h2>');
  }
}

// ==== App lifecycle ====
app.whenReady().then(() => {
  createWindow();

  // ==== [新增] 自動更新（僅在打
