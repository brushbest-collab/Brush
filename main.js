// main.js —— v2（含 GitHub 直鏈下載 + 本機 .7z.001 後備）
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');
const sevenPath = sevenBin.path7za;

let win = null;

/* ------------ 共用 ------------ */
const state = new Map();
function send(ch, payload){ if (win && !win.isDestroyed()) try{ win.webContents.send(ch, payload); }catch{} }
function log(msg, level='info'){ send('log', { level, msg, ts: Date.now() }); }
function progress(p){ send('progress', Math.max(0, Math.min(100, Number(p)||0))); }
function pickExisting(paths){ for (const p of paths){ try{ if (p && fs.existsSync(p)) return p; }catch{} } return null; }

/* ------------ UI 入口 ------------ */
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
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html'),
  ];
  return pickExisting(c);
}

async function loadRenderer(w){
  if (process.env.ELECTRON_START_URL){ await w.loadURL(process.env.ELECTRON_START_URL); return; }
  const html = resolveHtml();
  if (!html){ dialog.showErrorBox('Renderer 未找到','沒有找到 index.html'); return; }
  await w.loadFile(html);
}

async function createWindow(){
  win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { preload: path.join(__dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, devTools:true }
  });
  win.webContents.setWindowOpenHandler(({url})=>{ shell.openExternal(url); return {action:'deny'}; });
  win.webContents.on('did-fail-load',(_e,code,desc,url)=>dialog.showErrorBox('did-fail-load',`code=${code}\n${desc}\nurl=${url}`));
  await loadRenderer(win);

  // 初始狀態
  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap();
}

/* ------------ Python bootstrap 偵測 ------------ */
function findBootstrapMarker(){
  const c = [
    path.join(__dirname, 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'pbs', 'ok'),
    path.join(process.resourcesPath, 'app', 'python', 'pbs', 'ok'),
  ];
  return pickExisting(c);
}
function detectBootstrap(){
  const marker = findBootstrapMarker();
  const found = !!marker;
  state.set('bootstrap', found);
  log(found ? `Python bootstrap marker FOUND: ${marker}` : 'Python bootstrap NOT found');
  return found;
}

/* ------------ 下載/解壓工具 ------------ */
function httpDownload(fileUrl, destPath, onProgress){
  return new Promise((resolve, reject)=>{
    const doGet = (url)=>{
      const file = fs.createWriteStream(destPath);
      https.get(url, (res)=>{
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
          file.close(); fs.unlink(destPath, ()=>{}); return doGet(res.headers.location);
        }
        if (res.statusCode !== 200){ file.close(); fs.unlink(destPath, ()=>{}); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
        const total = Number(res.headers['content-length']||0); let rec=0;
        res.on('data', (ch)=>{ rec+=ch.length; if(total && onProgress) onProgress(Math.round(rec*100/total)); });
        res.pipe(file); file.on('finish', ()=>file.close(()=>resolve(destPath)));
      }).on('error',(err)=>{ file.close(); fs.unlink(destPath, ()=>{}); reject(err); });
    };
    doGet(fileUrl);
  });
}
function sevenExtract(firstPartPath, outDir){
  return new Promise((resolve,reject)=>{
    const proc = spawn(sevenPath, ['x', firstPartPath, `-o${outDir}`, '-y']);
    proc.stdout.on('data', d=>log(String(d)));
    proc.stderr.on('data', d=>log(String(d),'warn'));
    proc.on('close', code => code===0 ? resolve(true) : reject(new Error(`7z exit ${code}`)));
  });
}

/* ------------ GitHub 模型直鏈設定（可改成你的 repo/tag/count） ------------ */
// 你可以改成實際值，或在 workflow/系統環境帶入 GH_REPO / GH_TAG / MODEL_COUNT。
const GH_REPO     = process.env.GH_REPO     || 'owner/repo';   // 例：brushbest-collab/evi-brush-desktop
const GH_TAG      = process.env.GH_TAG      || 'v105';
const MODEL_COUNT = Number(process.env.MODEL_COUNT || 0);      // 例如 28；為 0 代表不使用線上下載

const MODEL_PARTS = MODEL_COUNT > 0
  ? Array.from({length: MODEL_COUNT}, (_,i)=> {
      const n = String(i+1).padStart(3,'0');
      return `https://github.com/${GH_REPO}/releases/download/${GH_TAG}/model-pack.7z.${n}`;
    })
  : [];

/* ------------ Python 啟動 ------------ */
function findPythonExe(){
  const c = [
    process.env.EVI_PYTHON_EXE && path.normalize(process.env.EVI_PYTHON_EXE),
    path.join(process.resourcesPath,'python','python.exe'),
    path.join(process.resourcesPath,'app.asar.unpacked','python','python.exe'),
    path.join(__dirname,'python','python.exe')
  ].filter(Boolean);
  return pickExisting(c);
}
function findEntryScript(){
  const c = [
    process.env.EVI_PY_ENTRY && path.normalize(process.env.EVI_PY_ENTRY),
    path.join(process.resourcesPath,'python','pbs','serve.py'),
    path.join(process.resourcesPath,'app.asar.unpacked','python','pbs','serve.py'),
    path.join(__dirname,'python','pbs','serve.py')
  ].filter(Boolean);
  return pickExisting(c);
}

let pyProc = null;

/* ------------ IPC ------------ */
ipcMain.handle('state:get', (_e,key)=>state.get(key));
ipcMain.handle('state:set', (_e,{key,val})=>{ state.set(key,val); return true; });

ipcMain.handle('dialog:openDir', async ()=>{
  const r = await dialog.showOpenDialog({ properties:['openDirectory','createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('model:download', async ()=>{
  const root = state.get('modelRoot');
  if (!root) throw new Error('請先選擇模型資料夾');

  // 有配置線上分卷 → 下載
  if (MODEL_PARTS.length){
    try{
      const tmp = path.join(root, '_dl_tmp'); fs.mkdirSync(tmp,{recursive:true});
      log('Start download…');
      for (let i=0;i<MODEL_PARTS.length;i++){
        const url = MODEL_PARTS[i];
        const fname = path.basename(url);
        const out = path.join(tmp, fname);
        log(`Downloading ${fname}`);
        await httpDownload(url, out, pct=>{
          const base = (i/MODEL_PARTS.length)*100;
          progress(Math.min(99, Math.floor(base + pct/MODEL_PARTS.length)));
        });
      }
      const first = path.join(tmp, path.basename(MODEL_PARTS[0]));
      log('Extracting with 7z…');
      await sevenExtract(first, root);
      progress(100); log('Download finished.');
      try{ fs.rmSync(tmp,{recursive:true,force:true}); }catch{}
      return true;
    }catch(err){
      log(`Download error: ${err.message}`, 'error');
      throw err;
    }
  }

  // 沒配置線上分卷 → 走本機檔案選擇
  log('No MODEL_PARTS configured, skip download (OK for dev).');
  const r = await dialog.showOpenDialog({
    title: '選擇 model-pack.7z.001',
    properties: ['openFile'],
    filters: [{ name: '7z split first part', extensions: ['001'] }]
  });
  if (r.canceled || !r.filePaths[0]) return true; // 使用者取消就直接返回
  const firstPartPath = r.filePaths[0];
  log(`Extract from local: ${firstPartPath}`);
  await sevenExtract(firstPartPath, root);
  progress(100); log('Local extract finished.');
  return true;
});

ipcMain.handle('designer:open', async ()=>{
  try{
    if (pyProc && !pyProc.killed){
      log('Python service already running.');
    }else{
      const py = findPythonExe();
      const entry = findEntryScript();
      if (py && entry){
        log(`Start python: ${py} ${entry}`);
        pyProc = spawn(py, [entry], { cwd: path.dirname(entry) });
        pyProc.stdout.on('data', d=>log(`[py] ${String(d).trim()}`));
        pyProc.stderr.on('data', d=>log(`[py-err] ${String(d).trim()}`, 'warn'));
        pyProc.on('close', c=>log(`[py] exit ${c}`));
      }else{
        log('Python exe or entry not found — open URL directly.', 'warn');
      }
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
});

/* ------------ 啟動 ------------ */
process.on('uncaughtException', err => dialog.showErrorBox('Main Error', String((err && err.stack) || err)));
app.whenReady().then(createWindow);
app.on('window-all-closed', ()=>{ if (process.platform !== 'darwin') app.quit(); });
app.on('activate', ()=>{ if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
