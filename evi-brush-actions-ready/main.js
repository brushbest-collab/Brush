'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

function logToFile(msg) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  logToFile(`uncaughtException: ${err.stack || err.message}`);
});

let pyProc = null;

async function waitForServer(url, attempts = 100, delay = 300) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      http.get(url, () => { clearInterval(timer); resolve(); })
        .on('error', () => {
          if (tries >= attempts) { clearInterval(timer); reject(new Error('Server not responding')); }
        });
    }, delay);
  });
}

function startPython() {
  try {
    const pyRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'python')
      : path.join(__dirname, 'python');

    const isWin = process.platform === 'win32';
    const pythonExe = isWin
      ? path.join(pyRoot, 'venv', 'Scripts', 'python.exe')
      : path.join(pyRoot, 'venv', 'bin', 'python');
    const serverScript = path.join(pyRoot, 'server.py');

    const env = Object.assign({}, process.env, {
      PYTHONUNBUFFERED: '1',
      HF_HOME: path.join(pyRoot, 'hf_home'),
      HF_HUB_OFFLINE: '1',
    });

    pyProc = spawn(pythonExe, [serverScript], { cwd: pyRoot, env });
    pyProc.stdout.on('data', (d) => logToFile(`[py] ${d}`));
    pyProc.stderr.on('data', (d) => logToFile(`[py-err] ${d}`));
    pyProc.on('close', (c) => logToFile(`Python exited: ${c}`));
  } catch (e) {
    logToFile(`startPython error: ${e.stack || e.message}`);
  }
  return pyProc;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  if (!pyProc) startPython();

  try {
    await waitForServer('http://127.0.0.1:7860');
    await win.loadURL('http://127.0.0.1:7860');
  } catch (e) {
    logToFile(`waitForServer fail: ${e.message}`);
    await win.loadURL('data:text/html,<h2>Backend did not start. Please rebuild with Python + model.</h2>');
  }

  return win;
}

function setupAutoUpdater(win) {
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', async () => {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: 'A new version is available. Download now?',
      });
      if (r.response === 0) autoUpdater.downloadUpdate();
    });
    autoUpdater.on('update-downloaded', async () => {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: 'Update downloaded. Restart to install?',
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', (e) => logToFile(`updater error: ${e.stack || e.message}`));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (e) {
    logToFile(`setupAutoUpdater error: ${e.stack || e.message}`);
  }
}

app.whenReady().then(async () => {
  const win = await createWindow();
  setupAutoUpdater(win);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => { if (pyProc) { try { pyProc.kill(); } catch (_) {} } });
