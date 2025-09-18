// main.js — GitHub Release 自動下載（私有/公開皆可）+ 401 自動降級 + 直接路徑探測 + 本機分卷備援
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');
const sevenPath = sevenBin.path7za;

let win = null;

/* ---------- 共用 ---------- */
const state = new Map();
const VERBOSE = String(process.env.GH_VERBOSE || '0') === '1';
function send(ch, payload){ if (win && !win.isDestroyed()) { try { win.webContents.send(ch, payload); } catch {} } }
function log(msg, level='info'){ send('log', { level, msg, ts: Date.now() }); }
function progress(p){ send('progress', Math.max(0, Math.min(100, Number(p)||0))); }
function pickExisting(paths){ for (const p of paths){ try{ if (p && fs.existsSync(p)) return p; }catch{} } return null; }

/* ---------- UI 載入 ---------- */
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
  if (!state.has('modelRoot')) state.set('modelRoot', null);
  detectBootstrap();
}

/* ---------- Python bootstrap 偵測 ---------- */
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
  const marker = findBootstrapMarker();
  const found = !!marker;
  state.set('bootstrap', found);
  log(found ? `Python bootstrap marker FOUND: ${marker}` : 'Python bootstrap NOT found');
  return found;
}

/* ---------- 設定（app.config.json / env） ---------- */
function readAppConfig(){
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'app.config.json'),
    path.join(process.resourcesPath, 'app', 'app.config.json'),
    path.join(process.resourcesPath, 'app.asar', 'app.config.json'),
    path.join(__dirname, 'app.config.json')
  ];
  const p = pickExisting(candidates);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; }
}
function ghConfig(){
  const cfg = readAppConfig() || {};
  const repoDefault = 'brushbest-collab/evi-brush-desktop';
  const tagDefault  = 'v105';
  const repo  = process.env.GH_REPO || cfg.gh_repo || repoDefault;
  let   tag   = process.env.GH_TAG  || cfg.gh_tag  || tagDefault;
  if (!tag) { try { tag = 'v' + app.getVersion(); } catch {} }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || cfg.gh_token || '';
  log(`[gh] repo=${repo||'-'} tag=${tag||'-'} token=${token ? 'yes' : 'no'}`);
  return { repo, tag, token };
}

/* ---------- 低階 HTTP ---------- */
function httpRequest(url, headers, opts = {}){
  const { method='GET', timeout=15000 } = opts;
  return new Promise((resolve,reject)=>{
    const req = https.request(url, { method, headers, timeout }, (res)=>{
      let buf = Buffer.alloc(0);
      res.on('data', c => buf = Buffer.concat([buf, c]));
      res.on('end', ()=> resolve({ status: res.statusCode || 0, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.on('timeout', ()=>{ req.destroy(new Error('ETIMEDOUT')); });
    req.end();
  });
}

/* ---------- API 取資產（可指定是否帶 token） ---------- */
async function fetchReleaseAssetsViaApi(repo, tag, tokenOrEmpty){
  const headers = { 'User-Agent':'evi-brush-desktop', 'Accept':'application/vnd.github+json' };
  if (tokenOrEmpty) headers['Authorization'] = `Bearer ${tokenOrEmpty}`;

  // tags/{tag}
  const url1 = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const r1 = await httpRequest(url1, headers);
  if (VERBOSE || r1.status !== 200) {
    const sample = r1.body.toString('utf8').slice(0, 400).replace(/\s+/g,' ');
    log(`[gh] GET ${url1} -> ${r1.status} ${sample ? `(body: ${sample})` : ''}`);
  }
  if (r1.status === 200){
    const json = JSON.parse(r1.body.toString('utf8'));
    if (Array.isArray(json.assets) && json.assets.length){
      return json.assets
        .filter(a=>/model-pack\.7z\.\d{3}$/i.test(a.name))
        .sort((a,b)=>Number(a.name.match(/(\d{3})$/)[1]) - Number(b.name.match(/(\d{3})$/)[1]))
        .map(a=>({ name:a.name, id:a.id, publicUrl:a.browser_download_url, apiUrl:a.url }));
    }
  }
  // releases?per_page
  const url2 = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const r2 = await httpRequest(url2, headers);
  if (VERBOSE || r2.status !== 200) {
    const sample = r2.body.toString('utf8').slice(0, 400).replace(/\s+/g,' ');
    log(`[gh] GET ${url2} -> ${r2.status} ${sample ? `(body: ${sample})` : ''}`);
  }
  if (r2.status === 200){
    const arr = JSON.parse(r2.body.toString('utf8'));
    const rel = Array.isArray(arr) ? arr.find(x => x && x.tag_name === tag) : null;
    if (rel && Array.isArray(rel.assets)){
      const assets = rel.assets
        .filter(a=>/model-pack\.7z\.\d{3}$/i.test(a.name))
        .sort((a,b)=>Number(a.name.match(/(\d{3})$/)[1]) - Number(b.name.match(/(\d{3})$/)[1]))
        .map(a=>({ name:a.name, id:a.id, publicUrl:a.browser_download_url, apiUrl:a.url }));
      if (assets.length) return assets;
    }
  }
  return [];
}

/* ---------- 不走 API，直接路徑探測 ---------- */
async function urlExistsHEAD(url){
  const r = await httpRequest(url, { 'User-Agent':'evi-brush-desktop' }, { method:'HEAD', timeout:10000 });
  // GitHub 會 302 轉到 objects.githubusercontent.com，2xx/3xx 都視為存在
  return r.status >= 200 && r.status < 400;
}
async function probeDirectAssets(repo, tag, prefix='model-pack.7z.', maxParts=120){
  const list = [];
  for (let i=1;i<=maxParts;i++){
    const nn = String(i).padStart(3,'0');
    const name = `${prefix}${nn}`;
    const url  = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
    try{
      if (await urlExistsHEAD(url)){
        list.push({ name, id:i, publicUrl:url, apiUrl:null });
      }else if (list.length){ break; } // 已找到開頭，遇到第一個不存在就停
    }catch{}
  }
  if (list.length) log(`[gh] Found ${list.length} parts via direct download probing.`);
  return list;
}

/* ---------- 取得資產（整合邏輯） ---------- */
async function fetchReleaseAssets(repo, tag, token){
  // 1) 先帶 token
  const a1 = await fetchReleaseAssetsViaApi(repo, tag, token || '');
  if (a1.length) return a1;

  // 2) 如果剛才是帶 token 且 API 回 401，或單純沒找到，改用「不帶 token」再試（公開專案）
  const a2 = await fetchReleaseAssetsViaApi(repo, tag, '');
  if (a2.length) return a2;

  // 3) 直接路徑探測（不靠 API）
  const a3 = await probeDirectAssets(repo, tag);
  return a3;
}

/* ---------- 下載/解壓 ---------- */
function httpDownload(url, destPath, headers){
  return new Promise((resolve, reject)=>{
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers }, (res)=>{
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(destPath, ()=>{});
        return httpDownload(res.headers.location, destPath, headers).then(resolve, reject);
      }
      if (res.statusCode !== 200){ file.close(); fs.unlink(destPath, ()=>{}); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      res.pipe(file); file.on('finish', ()=>file.close(()=>resolve(destPath)));
    });
    req.on('error', err=>{ file.close(); fs.unlink(destPath, ()=>{}); reject(err); });
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

/* ---------- Python 啟動 ---------- */
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

/* ---------- IPC ---------- */
ipcMain.handle('state:get', (_e,key)=>state.get(key));
ipcMain.handle('state:set', (_e,{key,val})=>{ state.set(key,val); return true; });

ipcMain.handle('dialog:openDir', async ()=>{
  const r = await dialog.showOpenDialog({ properties:['openDirectory','createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('model:download', async ()=>{
  const root = state.get('modelRoot');
  if (!root) throw new Error('請先選擇模型資料夾');

  const { repo, tag, token } = ghConfig();
  const assets = await fetchReleaseAssets(repo, tag, token);
  if (assets.length > 0){
    try{
      const tmp = path.join(root, '_dl_tmp'); fs.mkdirSync(tmp,{recursive:true});
      log(`Found ${assets.length} parts on GitHub (${repo} @ ${tag}). Start download…`);
      for (let i=0;i<assets.length;i++){
        const a = assets[i];
        // 私有（用 API）需要 Accept: application/octet-stream；公開走 publicUrl
        const useApi = !!(token && a.apiUrl);
        const url = useApi ? a.apiUrl : a.publicUrl;
        const headers = { 'User-Agent':'evi-brush-desktop' };
        if (useApi){ headers['Authorization'] = `Bearer ${token}`; headers['Accept'] = 'application/octet-stream'; }
        const out = path.join(tmp, a.name);
        log(`Downloading ${a.name}`);
        await httpDownload(url, out, headers);
        progress(Math.round(((i+1)/assets.length)*99));
      }
      const first = path.join(tmp, assets[0].name);
      log('Extracting with 7z…');
      await sevenExtract(first, root);
      progress(100); log('Download finished.');
      try{ fs.rmSync(tmp,{recursive:true,force:true}); }catch{}
      return true;
    }catch(err){
      log(`Online download failed: ${err.message}`, 'error');
    }
  } else {
    log('No online model assets found after API/public probing.');
  }

  // 最後備援：本機 .001
  log('Fallback to local .7z.001 picker.');
  const r = await dialog.showOpenDialog({
    title: '選擇 model-pack.7z.001',
    properties: ['openFile'],
    filters: [{ name: '7z split first part', extensions: ['001'] }]
  });
  if (r.canceled || !r.filePaths[0]) { log('User cancelled picker. 若要用本機分卷，請把 model-pack.7z.001~N 置於同一資料夾，再選第 1 個 .001 檔。'); return 'cancelled'; }
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

/* ---------- 啟動 ---------- */
process.on('uncaughtException', err => dialog.showErrorBox('Main Error', String((err && err.stack) || err)));
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
