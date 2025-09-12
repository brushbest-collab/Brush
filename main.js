const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const isDev = !app.isPackaged;
let win;

function appRoot() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function create() {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(create);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

process.on('uncaughtException', e => { if (win) win.webContents.send('dl:log', `FATAL: ${e.message}`); });
process.on('unhandledRejection', e => { if (win) win.webContents.send('dl:log', `REJECT: ${e}`); });

/* ---------- PBS 檢查（一定回應） ---------- */
ipcMain.handle('check-pbs', async () => {
  try {
    const p = path.join(appRoot(), 'python', 'pbs');
    return fs.existsSync(p) ? 'ok' : 'missing';
  } catch (e) {
    return 'missing';
  }
});

/* ---------- 回傳 UI 事件 ---------- */
function sendLog(msg) { if (win && !win.isDestroyed()) win.webContents.send('dl:log', msg); }
function sendProgress(current, total, label) {
  if (win && !win.isDestroyed()) win.webContents.send('dl:progress', { current, total, label });
}

/* ---------- 追 302 的 HTTP ---------- */
function requestWithRedirect(method, url, headers = {}, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'EVI-Brush-Downloader', 'Accept': '*/*', ...headers }
    };
    const req = https.request(opts, res => {
      const { statusCode, headers: h } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && h.location && maxRedirects > 0) {
        const next = new URL(h.location, url).toString();
        res.resume();
        resolve(requestWithRedirect(method, next, headers, maxRedirects - 1));
        return;
      }
      resolve({ statusCode, headers: h, stream: res, finalUrl: url });
    });
    req.on('error', reject);
    req.end();
  });
}
async function headWithRedirect(url) { return requestWithRedirect('HEAD', url); }

/* ---------- 續傳下載（處理 416 / 重試 / 302） ---------- */
async function downloadWithResume(sourceUrl, destFile, label, maxRetries = 6) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  let attempt = 0, delay = 1500;

  while (attempt <= maxRetries) {
    try {
      const head = await headWithRedirect(sourceUrl);
      if (!(head.statusCode >= 200 && head.statusCode < 400)) throw new Error(`HEAD ${head.statusCode}`);

      const total = parseInt(head.headers['content-length'] || '0', 10);
      const acceptRanges = (head.headers['accept-ranges'] || '').toLowerCase().includes('bytes');
      const part = destFile + '.part';
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;

      let start = 0;
      if (acceptRanges && total > 0 && have > 0 && have < total) start = have;
      if (have > total && total > 0) { try { fs.unlinkSync(part); } catch {} }

      sendLog(`開始下載：${label}（${(start/1048576).toFixed(1)}MB / ${(total/1048576).toFixed(1)}MB）`);
      const headers = start > 0 ? { Range: `bytes=${start}-` } : {};

      const res = await requestWithRedirect('GET', head.finalUrl, headers);
      if (res.statusCode === 416) {
        try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch {}
        attempt++; sendLog('HTTP 416：續傳點無效，清除暫存後重試…');
        await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 12000); continue;
      }
      if (![200, 206].includes(res.statusCode)) throw new Error(`GET ${res.statusCode}`);

      const ws = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
      let received = start;
      await new Promise((resolve, reject) => {
        res.stream.on('data', chunk => { received += chunk.length; sendProgress(received, total || received, label); });
        res.stream.on('error', reject);
        ws.on('error', reject);
        res.stream.pipe(ws); ws.on('finish', resolve);
      });

      const finalSize = fs.statSync(part).size;
      if (total > 0 && finalSize !== total) throw new Error(`size-mismatch: ${finalSize} != ${total}`);
      if (fs.existsSync(destFile)) try { fs.unlinkSync(destFile); } catch {}
      fs.renameSync(part, destFile);
      sendProgress(total || finalSize, total || finalSize, label);
      sendLog(`完成：${label}`);
      return;
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      sendLog(`下載失敗（第 ${attempt} 次重試）：${e.message}`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 12000);
    }
  }
}

/* ---------- 下載一組分卷 ---------- */
ipcMain.handle('models:start', async (_evt, { owner, repo, tag, baseName, parts, outDir }) => {
  const out = outDir || path.join(appRoot(), 'python', 'models', 'sd-turbo');
  const tasks = [];
  for (let i = 1; i <= parts; i++) {
    const idx = String(i).padStart(3, '0');
    const fname = `${baseName}.${idx}`;
    const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${fname}`;
    tasks.push({ url, fname });
  }
  for (let i = 0; i < tasks.length; i++) {
    const { url, fname } = tasks[i];
    await downloadWithResume(url, path.join(out, fname), `下載 ${i+1}/${tasks.length}：${fname}`);
  }
  sendLog('全部分卷下載完成。');
  return 'ok';
});
