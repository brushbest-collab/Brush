const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

let win = null;

/* ---------------- common helpers ---------------- */
const state = new Map();
function send(ch, payload){ if (win && !win.isDestroyed()) { try{ win.webContents.send(ch, payload); }catch{} } }
function log(msg, level='info'){ send('log', { level, msg, ts: Date.now() }); }
function pickExisting(list){ for (const p of list){ try{ if (p && fs.existsSync(p)) return p; }catch{} } return null; }

/* ---------------- renderer loading ---------------- */
function resolveHtml(){
  const c = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'build', 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app', 'index.html'),
    path.join(process.resourcesPath, 'app', 'build', 'index.html'),
    path.join(process.resourcesPath, 'app', 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'build', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html')
  ];
  return pickExisting(c);
}
async function loadRenderer(w){
  if (process.env.ELECTRON_START_URL){ await w.loadURL(process.env.ELECTRON_START_URL); return; }
  const html = resolveHtml();
  if (!html){ dialog.showErrorBox('Renderer 未找到', 'index.html 不存在'); return; }
  await w.loadFile(html);
}
async function createWindow(){
  win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration:false, contextIsolation:true, devTools:true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action:'deny' }; });
  win.webContents.on('did-fail-load', (_e, c, d, u) => dialog.showErrorBox('did-fail-load', `code=${c}\n${d}\nurl=${u}`));
  await loadRenderer(win);
  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap();
}

/* ---------------- python bootstrap marker ---------------- */
function findBootstrapMarker(){
  const c = [
    path.join(__dirname, 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'app', 'python', 'pbs', 'ok')
  ];
  return pickExisting(c);
}
function detectBootstrap(){
  const m = findBootstrapMarker();
  const found = !!m;
  state.set('bootstrap', found);
  log(found ? `Python bootstrap marker FOUND: ${m}` : 'Python bootstrap NOT found');
  return found;
}

/* ---------------- python discovery ---------------- */
function discoverPythonExe(){
  // 1) env override
  const envExe = process.env.EVI_PYTHON_EXE && path.normalize(process.env.EVI_PYTHON_EXE);
  if (envExe && fs.existsSync(envExe)) return envExe;

  // 2) packaged python
  const packaged = pickExisting([
    path.join(process.resourcesPath, 'python', 'pythonw.exe'),
    path.join(process.resourcesPath, 'python', 'python.exe'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pythonw.exe'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'python.exe')
  ]);
  if (packaged) return packaged;

  // 3) dev python
  const dev = pickExisting([
    path.join(__dirname, 'python', 'pythonw.exe'),
    path.join(__dirname, 'python', 'python.exe')
  ]);
  if (dev) return dev;

  // 4) Windows py launcher
  try{
    const r = spawnSync('py', ['-3', '-c', 'import sys,os;print(sys.executable)'], { encoding:'utf8' });
    const p = r.stdout && r.stdout.trim();
    if (p && fs.existsSync(p)) return p;
  }catch{}

  // 5) PATH python
  try{
    const r = spawnSync('python', ['-c', 'import sys,os;print(sys.executable)'], { encoding:'utf8' });
    const p = r.stdout && r.stdout.trim();
    if (p && fs.existsSync(p)) return p;
  }catch{}

  return null;
}

function discoverEntryScript(){
  // env override
  const envEntry = process.env.EVI_PY_ENTRY && path.normalize(process.env.EVI_PY_ENTRY);
  if (envEntry && fs.existsSync(envEntry)) return envEntry;

  // packaged
  const packaged = pickExisting([
    path.join(process.resourcesPath, 'python', 'pbs', 'serve.py'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'serve.py'),
    path.join(process.resourcesPath, 'app', 'python', 'pbs', 'serve.py')
  ]);
  if (packaged) return packaged;

  // dev
  const dev = path.join(__dirname, 'python', 'pbs', 'serve.py');
  if (fs.existsSync(dev)) return dev;

  return null;
}

/* ---------------- python runner ---------------- */
let pyProc = null;

async function openDesigner(){
  try{
    if (!pyProc || pyProc.killed){
      const py = discoverPythonExe();
      const entry = discoverEntryScript();

      if (py && entry){
        log(`Start python: ${py} ${entry}`);
        const cwd = path.dirname(entry);
        pyProc = spawn(py, [entry], { cwd, windowsHide: true });
        pyProc.stdout.on('data', d => log(`[py] ${String(d).trim()}`));
        pyProc.stderr.on('data', d => log(`[py-err] ${String(d).trim()}`, 'warn'));
        pyProc.on('close', c => log(`[py] exit ${c}`));
      }else{
        log('Python exe or entry not found — open URL directly.', 'warn');
      }
    }else{
      log('Python service already running.');
    }

    const url = process.env.DESIGNER_URL || 'http://127.0.0.1:8000';
    const child = new BrowserWindow({ width: 1280, height: 800 });
    await child.loadURL(url);
    log('Open designer.');
    return true;
  }catch(err){
    log(`Open designer error: ${err.message}`, 'error');
    throw err;
  }
}

/* ---------------- IPC ---------------- */
ipcMain.handle('state:get', (_e, key) => state.get(key));
ipcMain.handle('state:set', (_e, { key, val }) => { state.set(key, val); return true; });

ipcMain.handle('dialog:openDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('designer:open', async () => openDesigner());

/* ---------------- app lifecycle ---------------- */
process.on('uncaughtException', err => dialog.showErrorBox('Main Error', String((err && err.stack) || err)));
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
