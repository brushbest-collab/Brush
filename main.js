// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const OWNER = 'brushbest-collab';      // ← 如模型分卷在別的 repo，改這裡
const REPO  = 'Brush';
const UA    = 'EVI-Brush-Desktop/1.0';

const isDev = !app.isPackaged;

function getAppRoot() { return isDev ? app.getAppPath() : process.resourcesPath; }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function existsDirNonEmpty(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; }
  catch { return false; }
}

let win;
async function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------------- GitHub：抓分卷清單 ---------------- */
function ghGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method:'GET', headers:{ 'User-Agent':UA, 'Accept':'application/vnd.github+json' } }, res => {
      let buf=''; res.setEncoding('utf8');
      res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode>=200 && res.statusCode<300) { try{ resolve(JSON.parse(buf)); }catch(e){ reject(e);} }
        else reject(new Error(`GitHub API ${res.statusCode}: ${url}\n${buf.slice(0,400)}`));
      });
    });
    req.on('error', reject); req.end();
  });
}
async function listModelAssets(tag) {
  const api = tag && tag.trim()
    ? `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag.trim())}`
    : `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
  const json = await ghGetJson(api);
  const assets = (json.assets || []).filter(a => /^model-pack\.7z\.\d{3}$/i.test(a.name));
  assets.sort((a,b)=>parseInt(a.name.split('.').pop(),10)-parseInt(b.name.split('.').pop(),10));
  return assets.map(a => ({ name:a.name, size:a.size, url:a.browser_download_url }));
}

/* ---------------- 下載（支援 302/續傳/416） ---------------- */
function downloadFollow(url, dest, onProgress, headers={}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method:'GET', headers:{ 'User-Agent':UA, ...headers } }, res => {
      const code = res.statusCode || 0;
      if ([301,302,303,307,308].includes(code) && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        res.resume(); return resolve(downloadFollow(next, dest, onProgress, headers));
      }
      if (code===200 || code===206) {
        const out = fs.createWriteStream(dest, { flags: headers.Range ? 'a' : 'w' });
        let rec = 0, total = parseInt(res.headers['content-length'] || '0',10);
        res.on('data', ch => { rec += ch.length; out.write(ch); onProgress && onProgress(rec, total); });
        res.on('end', () => out.end(resolve));
        res.on('error', e => { out.close(()=>reject(e)); });
        return;
      }
      if (code===416) { res.resume(); return resolve(); } // 視為已完成
      res.resume(); reject(new Error(`HTTP ${code} for ${url}`));
    });
    req.on('error', reject); req.end();
  });
}
async function downloadOneWithResume(asset, dest, send) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === asset.size) return;
  let start = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  const headers = start>0 ? { Range:`bytes=${start}-` } : {};
  await downloadFollow(asset.url, dest, (r,t) => {
    const done = start + r, tot = start + (t||0);
    send('dl-progress', { file: path.basename(dest), received: done, total: tot });
  }, headers);
  const now = fs.statSync(dest).size;
  if (now !== asset.size) { // server 忽略 Range → 重下
    send('log', `重新下載：${path.basename(dest)}`);
    await downloadFollow(asset.url, dest, (r,t)=>send('dl-progress',{file:path.basename(dest),received:r,total:t||asset.size}), {});
  }
}

/* ---------------- 解壓 7z ---------------- */
function find7z() {
  const cand = [
    path.join(getAppRoot(),'bin','7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '7z'
  ];
  for (const p of cand) { try { if (p.includes('\\')) { if (fs.existsSync(p)) return p; } } catch{} }
  return cand[cand.length-1];
}
function extract7z(firstPartPath, outDir, send) {
  return new Promise((resolve, reject) => {
    const seven = find7z(); ensureDir(outDir);
    send('log', `使用 7z：${seven}`);
    const child = spawn(seven, ['x','-y', firstPartPath, `-o${outDir}`], { windowsHide:true });
    child.stdout.on('data', d => send('log', d.toString()));
    child.stderr.on('data', d => send('log', d.toString()));
    child.on('close', code => code===0 ? resolve() : reject(new Error(`7z exit ${code}`)));
  });
}

/* ---------------- IPC：環境/下載/設定 ---------------- */
ipcMain.handle('env-check', async () => {
  const root   = getAppRoot();
  const pbsDir = path.join(root,'python','pbs');
  const mdlDir = path.join(root,'python','models','sd-turbo');
  const hasPbs   = fs.existsSync(path.join(pbsDir,'ok'));
  const hasModel = existsDirNonEmpty(mdlDir);
  return { root, hasPbs, hasModel };
});

ipcMain.handle('download-model', async (evt, { tag }) => {
  const send = (ch, payload) => { try { evt.sender.send(ch, payload); } catch {} };
  const root  = getAppRoot();
  const cache = path.join(root,'python','models','.cache');
  const out   = path.join(root,'python','models');
  ensureDir(cache);

  send('log', `查詢 Release（${tag ? tag : 'latest'}）...`);
  const assets = await listModelAssets(tag);
  if (!assets.length) throw new Error('Release 中找不到 model-pack.7z.### 分卷');
  send('log', `找到 ${assets.length} 個分卷，開始下載…`);

  for (let i=0;i<assets.length;i++){
    const a = assets[i], dest = path.join(cache, a.name);
    send('log', `下載 ${i+1}/${assets.length}：${a.name}（${(a.size/1048576).toFixed(1)} MB）`);
    await downloadOneWithResume(a, dest, send);
  }
  const first = path.join(cache, 'model-pack.7z.001');
  if (!fs.existsSync(first)) throw new Error('缺少第一卷 model-pack.7z.001');

  send('state', { phase:'extract' });
  send('log','全部分卷已就緒，開始解壓…');
  await extract7z(first, out, send);
  send('log','解壓完成。');
  return { ok:true };
});

/* ---------- 設定存取：userData/settings.json ---------- */
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function defaultSettings() {
  const outDefault = path.join(app.getPath('documents'), 'EVI-Brush-Outputs');
  return {
    prompt: '',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 4,
    guidance: 2.0,
    seed: -1,
    batch: 1,
    outDir: outDefault
  };
}
ipcMain.handle('settings:get', async () => {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) {
      const d = defaultSettings(); ensureDir(d.outDir);
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
      return d;
    }
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (d.outDir) ensureDir(d.outDir);
    return { ...defaultSettings(), ...d };
  } catch {
    const d = defaultSettings(); ensureDir(d.outDir); return d;
  }
});
ipcMain.handle('settings:set', async (_evt, data) => {
  const cur = await ipcMain.emit; // no-op to silence lints
  const merged = { ...defaultSettings(), ...(data||{}) };
  if (merged.outDir) ensureDir(merged.outDir);
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  return true;
});
ipcMain.handle('dialog:choose-dir', async () => {
  const r = await dialog.showOpenDialog({ properties:['openDirectory','createDirectory'] });
  if (r.canceled || !r.filePaths?.length) return null;
  return r.filePaths[0];
});
ipcMain.handle('open:path', async (_e, p) => { if (p) { await shell.openPath(p); } return true; });
