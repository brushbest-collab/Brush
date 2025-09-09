
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
let pyProc = null;

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

app.whenReady().then(() => { createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => { if (pyProc) { try { pyProc.kill(); } catch(e){} } });
