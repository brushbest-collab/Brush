// main.js  — 完整可覆蓋（處理 GitHub 302、續傳、HTTP 416、自動重試）

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

/* -------------------- IPC: 啟動/查詢 PBS -------------------- */
ipcMain.handle('check-pbs', async () => {
  try {
    const p = path.join(appRoot(), 'python', 'pbs');
    return fs.existsSync(p) ? 'ok' : 'missing';
  } catch { return 'missing'; }
});

/* -------------------- 工具：向 renderer 回報 -------------------- */
function sendLog(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('dl:log', msg);
}
function sendProgress(current, total, label) {
  if (win && !win.isDestroyed()) win.webContents.send('dl:progress', { current, total, label });
}

/* -------------------- HTTP 基礎（支援 302 連續轉址） -------------------- */
function requestWithRedirect(method, url, headers = {}, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'EVI-Brush-Downloader',
        'Accept': '*/*',
        ...headers
      }
    };

    const req = https.request(opts, res => {
      const { statusCode, headers: resHeaders } = res;
      // 3xx 轉址
      if ([301, 302, 303, 307, 308].includes(statusCode) && resHeaders.location && maxRedirects > 0) {
        const next = new URL(resHeaders.location, url).toString();
        res.resume(); // 丟棄
        resolve(requestWithRedirect(method, next, headers, maxRedirects - 1));
        return;
      }
      resolve({ statusCode, headers: resHeaders, stream: res, finalUrl: url });
    });

    req.on('error', reject);
    req.end();
  });
}

async function headWithRedirect(url) {
  const res = await requestWithRedirect('HEAD', url);
  return res; // {statusCode, headers, finalUrl}
}

/* -------------------- 下載（支援續傳 / 416 自動修復 / 重試） -------------------- */
async function downloadWithResume(sourceUrl, destFile, label, maxRetries = 6) {
  let attempt = 0;
  let delay = 1500;

  // 下載前確保資料夾存在
  fs.mkdirSync(path.dirname(destFile), { recursive: true });

  while (attempt <= maxRetries) {
    try {
      // 每次嘗試都重新解析 302，避免用到過期的簽名 URL
      const head = await headWithRedirect(sourceUrl);
      if (!(head.statusCode >= 200 && head.statusCode < 400)) {
        throw new Error(`HEAD ${head.statusCode}`);
      }

      const total = parseInt(head.headers['content-length'] || '0', 10);
      const acceptRanges = (head.headers['accept-ranges'] || '').toLowerCase().includes('bytes');

      const part = destFile + '.part';
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;

      let start = 0;
      if (acceptRanges && total > 0 && have > 0 && have < total) start = have;
      if (have > total && total > 0) {
        // 本地比遠端還大 → 砍掉重來
        fs.unlinkSync(part);
      }

      sendLog(`開始下載：${label}  （${(start/1024/1024).toFixed(1)}MB / ${(total/1024/1024).toFixed(1)}MB）`);

      const headers = {};
      if (start > 0) headers['Range'] = `bytes=${start}-`;

      // 取最終直鏈再發 GET
      const head2 = await requestWithRedirect('GET', head.finalUrl, headers);
      const code = head2.statusCode;

      if (code === 416) {
        // 續傳點不合法 → 刪除 .part 從 0 來
        if (fs.existsSync(part)) fs.unlinkSync(part);
        attempt++;
        sendLog('HTTP 416：續傳點無效，重置暫存檔後重試…');
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 12000);
        continue;
      }

      if (!([200, 206].includes(code))) {
        throw new Error(`GET ${code}`);
      }

      // 寫入（200: 重新寫檔；206: 續寫）
      const ws = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
      let received = start;

      await new Promise((resolve, reject) => {
        head2.stream.on('data', chunk => {
          received += chunk.length;
          sendProgress(received, total || received, label);
        });
        head2.stream.on('error', reject);
        ws.on('error', reject);
        head2.stream.pipe(ws);
        ws.on('finish', resolve);
      });

      // 完成後驗長度
      const finalSize = fs.statSync(part).size;
      if (total > 0 && finalSize !== total) {
        throw new Error(`size-mismatch: ${finalSize} != ${total}`);
      }

      // 轉正名
      if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
      fs.renameSync(part, destFile);
      sendProgress(total || finalSize, total || finalSize, label);
      sendLog(`完成：${label}`);
      return; // OK
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw err;
      }
      sendLog(`下載失敗（第 ${attempt} 次重試）：${err.message}`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 12000);
    }
  }
}

/* -------------------- 高階：下載一組分卷 -------------------- */
/**
 * owner/repo/tag 例如：brushbest-collab / Brush / v73
 * baseName 例如：'model-pack.7z'
 * parts    例如：19 (會下載 .001 ~ .019)
 * outDir   例如：path.join(appRoot(),'python','models','sd-turbo')
 */
ipcMain.handle('models:start', async (_evt, { owner, repo, tag, baseName, parts, outDir }) => {
  const out = outDir || path.join(appRoot(), 'python', 'models', 'sd-turbo');
  const urls = [];
  for (let i = 1; i <= parts; i++) {
    const idx = String(i).padStart(3, '0');
    const file = `${baseName}.${idx}`;
    // GitHub 會對這種 URL 302 到簽名直鏈；我們每次都會重新解析
    const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${file}`;
    urls.push({ url, file });
  }

  // 逐一下載
  for (let i = 0; i < urls.length; i++) {
    const { url, file } = urls[i];
    const dest = path.join(out, file);
    const label = `下載 ${i + 1}/${urls.length}：${file}`;
    await downloadWithResume(url, dest, label);
  }

  sendLog('全部分卷下載完成。');
  return 'ok';
});
