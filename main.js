const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenZip = require('7zip-bin'); // 內含 7za 可在各平台使用

// === 設定區（請依你的 repo 修改） ===
const OWNER_REPO = process.env.EVI_OWNER_REPO || 'brushbest-collab/Brush'; // e.g. 'owner/repo'
const MODEL_REL = path.join('python', 'models', 'sd-turbo');
const PBS_REL   = path.join('python', 'pbs');
// ===================================

const isDev = !app.isPackaged;

function resourcesBase() {
  // 打包後：resourcesPath；開發時：專案根目錄
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}
function absJoin(...p) {
  return path.join(resourcesBase(), ...p);
}

function ensureDirs() {
  // 確保 python/pbs 與 python/models/sd-turbo 兩個資料夾存在
  try { fs.mkdirSync(absJoin(PBS_REL),   { recursive: true }); } catch {}
  try { fs.mkdirSync(absJoin(MODEL_REL), { recursive: true }); } catch {}

  // 在 pbs 放一個 ok 檔讓外部檢查
  try {
    const okFile = path.join(absJoin(PBS_REL), 'ok');
    if (!fs.existsSync(okFile)) fs.writeFileSync(okFile, 'ok', { encoding: 'ascii' });
  } catch {}
}

function hasModel() {
  const dir = absJoin(MODEL_REL);
  if (!fs.existsSync(dir)) return false;
  try {
    const list = fs.readdirSync(dir);
    // 只要有任何檔案（或子資料夾）就視為已有模型
    return list.length > 0;
  } catch {
    return false;
  }
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'evi-brush-desktop' } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, { headers: { 'User-Agent': 'evi-brush-desktop' } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' - ' + url));
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
  });
}

async function downloadAndExtractModel(targetDir) {
  const latest = await fetchJSON(`https://api.github.com/repos/${OWNER_REPO}/releases/latest`);

  // 抓取所有 model-pack.7z.001/.002... 分卷
  const parts = (latest.assets || [])
    .map(a => a.browser_download_url)
    .filter(u => /model-pack\.7z\.\d{3}$/i.test(u))
    .sort((a, b) => a.localeCompare(b)); // 001, 002, 003...

  if (!parts.length) throw new Error('最新 Release 未找到 model-pack.7z.001 分卷');

  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'evi-model-'));
  // 下載所有分卷
  for (let i = 0; i < parts.length; i++) {
    const url = parts[i];
    const suffix = url.split('.').pop(); // 001 / 002 / ...
    const local = path.join(tmpDir, `model-pack.7z.${suffix}`);
    await downloadFile(url, local);
    console.log('[model] downloaded', local);
  }

  // 解壓第一卷，7z 會自動串接後續分卷
  const firstPart = path.join(tmpDir, 'model-pack.7z.001');
  await new Promise((resolve, reject) => {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
    const child = spawn(sevenZip.path7za, ['x', '-y', `-o${targetDir}`, firstPart], { stdio: 'inherit' });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('7z exit ' + code)));
  });

  console.log('[model] extracted to', targetDir);
}

async function ensureModelOnStart() {
  ensureDirs();
  if (hasModel()) return;

  const result = dialog.showMessageBoxSync({
    type: 'info',
    buttons: ['下載（建議）', '跳過'],
    defaultId: 0,
    cancelId: 1,
    title: '需要下載模型',
    message: '偵測不到 SDXL-Turbo 模型，是否自動從最新 Release 下載並安裝？'
  });
  if (result !== 0) return;

  try {
    await downloadAndExtractModel(absJoin(MODEL_REL));
    dialog.showMessageBox({ type: 'info', message: '模型下載完成！' });
  } catch (e) {
    dialog.showErrorBox('模型下載失敗', String(e?.message || e));
  }
}

function create() {
  const win = new BrowserWindow({
    width: 1024,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  await ensureModelOnStart(); // 啟動前確保模型可用（若無會引導下載）
  create();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/** IPC: 與原本相容的 pbs 檢查 */
ipcMain.handle('check-pbs', async () => {
  try {
    const p = absJoin(PBS_REL);
    return fs.existsSync(p) ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
});

/** （可選）提供模型狀態給前端 */
ipcMain.handle('model-status', async () => {
  try { return hasModel() ? 'ready' : 'missing'; } catch { return 'missing'; }
});
