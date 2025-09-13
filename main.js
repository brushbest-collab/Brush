// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const OWNER = 'brushbest-collab';        // ← 如需更換，改這裡
const REPO  = 'Brush';                   // ← 如需更換，改這裡
const UA    = 'EVI-Brush-Desktop/1.0';   // GitHub API 需要 UA

const isDev = !app.isPackaged;

// 取得可寫入的根資料夾：打包後是 resources；開發時是專案根
function getAppRoot() {
  return isDev ? app.getAppPath() : process.resourcesPath;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function existsDirNonEmpty(p) {
  try {
    if (!fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (!st.isDirectory()) return false;
    const list = fs.readdirSync(p);
    return list.length > 0;
  } catch {
    return false;
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  await win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

// ------- GitHub API：抓取最新 release 的模型分卷清單 -------
function ghGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } },
      res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', d => (buf += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`GitHub API ${res.statusCode} for ${url}\n${buf.slice(0, 400)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function listModelAssets(tag /* 可為空：latest */) {
  let api;
  if (tag && tag.trim()) {
    api = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag.trim())}`;
  } else {
    api = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
  }
  const json = await ghGetJson(api);
  const assets = (json.assets || []).filter(a => /^model-pack\.7z\.\d{3}$/i.test(a.name));
  assets.sort((a, b) => {
    const na = parseInt(a.name.split('.').pop(), 10);
    const nb = parseInt(b.name.split('.').pop(), 10);
    return na - nb;
  });
  return assets.map(a => ({
    name: a.name,
    size: a.size,
    url: a.browser_download_url
  }));
}

// ------- 下載（支援 302 / 續傳 / 416 調整） -------
function downloadFollow(url, dest, onProgress, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers: { 'User-Agent': UA, ...headers } },
      res => {
        const code = res.statusCode || 0;

        // 重新導向
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(downloadFollow(next, dest, onProgress, headers));
        }

        // 接受續傳 206 或全檔 200
        if (code === 206 || code === 200) {
          const out = fs.createWriteStream(dest, { flags: headers.Range ? 'a' : 'w' });
          let received = 0;
          const total = parseInt(res.headers['content-length'] || '0', 10);

          res.on('data', chunk => {
            received += chunk.length;
            out.write(chunk);
            onProgress && onProgress(received, total);
          });
          res.on('end', () => {
            out.end(() => resolve());
          });
          res.on('error', err => {
            out.close(() => reject(err));
          });
          return;
        }

        // Range 超過（已完整）→ 視為完成
        if (code === 416) {
          res.resume();
          return resolve();
        }

        // 其他錯誤
        res.resume();
        reject(new Error(`HTTP ${code} for ${url}`));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function downloadOneWithResume(asset, dest, send) {
  // 已完整
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (st.size === asset.size) return;
  }

  // 續傳
  let start = 0;
  if (fs.existsSync(dest)) start = fs.statSync(dest).size;

  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;

  await downloadFollow(asset.url, dest, (r, t) => {
    const done = start + r;
    const tot  = start + (t || 0);
    send('dl-progress', { file: path.basename(dest), received: done, total: tot });
  }, headers);

  // 若 server 回 200 忽略 Range，檔案大小應該等於 asset.size；若不等，重來一次完整下
  const now = fs.statSync(dest).size;
  if (now !== asset.size) {
    send('log', `重新下載（伺服器忽略 Range）：${path.basename(dest)}`);
    await downloadFollow(asset.url, dest, (r, t) => {
      send('dl-progress', { file: path.basename(dest), received: r, total: t || asset.size });
    }, {});
  }
}

// ------- 解壓 7z 分卷 -------
function find7z() {
  // 優先找 resources/bin/7za.exe
  const cand = [
    path.join(getAppRoot(), 'bin', '7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '7z' // PATH
  ];
  for (const p of cand) {
    try {
      if (p.includes('\\') && fs.existsSync(p)) return p;
    } catch {}
  }
  return cand[cand.length - 1]; // 可能是 '7z'
}

function extract7z(firstPartPath, outDir, send) {
  return new Promise((resolve, reject) => {
    const seven = find7z();
    ensureDir(outDir);
    send('log', `使用 7z：${seven}`);
    const args = ['x', '-y', firstPartPath, `-o${outDir}`];
    const cp = spawn(seven, args, { windowsHide: true });
    cp.stdout.on('data', d => send('log', d.toString()));
    cp.stderr.on('data', d => send('log', d.toString()));
    cp.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`7z exit ${code}`));
    });
  });
}

// ------- IPC：環境檢查、下載模型 -------
ipcMain.handle('env-check', async () => {
  const root    = getAppRoot();
  const pyRoot  = path.join(root, 'python');
  const pbsDir  = path.join(pyRoot, 'pbs');
  const mdlDir  = path.join(pyRoot, 'models', 'sd-turbo');

  const hasPbs   = fs.existsSync(path.join(pbsDir, 'ok'));
  const hasModel = existsDirNonEmpty(mdlDir);

  return {
    root,
    hasPbs,
    hasModel
  };
});

ipcMain.handle('download-model', async (evt, { tag }) => {
  const winSend = (ch, payload) => {
    try { evt.sender.send(ch, payload); } catch {}
  };

  const root    = getAppRoot();
  const pyRoot  = path.join(root, 'python');
  const cache   = path.join(pyRoot, 'models', '.cache');
  const outDir  = path.join(pyRoot, 'models'); // 解壓根目錄
  ensureDir(cache);

  winSend('log', `查詢 Release（${tag ? tag : 'latest'}）...`);
  const assets = await listModelAssets(tag);
  if (!assets.length) throw new Error('Release 中找不到 model-pack.7z.### 分卷');

  winSend('log', `找到 ${assets.length} 個分卷，開始下載（支援 302 / 續傳）...`);

  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const dest = path.join(cache, a.name);
    winSend('log', `開始下載 ${i + 1}/${assets.length}：${a.name}（${(a.size / 1048576).toFixed(1)} MB）`);
    await downloadOneWithResume(a, dest, winSend);
    winSend('log', `完成：${a.name}`);
  }

  const firstPart = path.join(cache, 'model-pack.7z.001');
  if (!fs.existsSync(firstPart)) throw new Error('缺少第一卷 model-pack.7z.001');

  winSend('state', { phase: 'extract' });
  winSend('log', '全部分卷已就緒，開始解壓...');
  await extract7z(firstPart, outDir, winSend);

  winSend('log', '解壓完成。建議保留分卷，之後可離線復原（如需可手動刪除 .cache）。');
  return { ok: true };
});

// ------- App lifecycle -------
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
