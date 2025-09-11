// main.js
// Electron 主程序：內建最穩下載（BITS -> HTTPS 302 跟隨 + 續傳），支援 GitHub Releases 模型分割檔

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');

const isDev = !app.isPackaged;

// === 依專案情況調整（預設指向本 repo 的 Releases） ===
const GH_OWNER = 'brushbest-collab';
const GH_REPO  = 'Brush';

// ====================== 視窗 ======================
function createWindow() {
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
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ====================== 工具 ======================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function pad3(n) { return n.toString().padStart(3, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 組 GitHub Releases 下載 URL
function releaseUrl(tag, filename) {
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${tag}/${filename}`;
}

// ====================== 優先方案：BITS ======================
// 以 Windows 內建 BITS 背景下載（可續傳、會自動重試）
function downloadViaBITS(url, outFile) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      // 1h timeout、30s 重試間隔；BITS 會自動處理暫斷
      `Start-BitsTransfer -Source '${url}' -Destination '${outFile}' -RetryInterval 30 -RetryTimeout 3600`
    ], { windowsHide: true });

    let stderr = '';
    ps.stderr.on('data', d => stderr += d.toString());
    ps.on('close', code => {
      if (code === 0 && fs.existsSync(outFile)) return resolve(outFile);
      reject(new Error(stderr || `BITS failed (${code})`));
    });
  });
}

// ====================== 後備方案：HTTPS 302 + 續傳 ======================
// 會自動跟隨 301/302/307/308，且支援 Range 續傳與重試
function downloadWithRedirectsResume(url, outFile, opt = {}) {
  const {
    maxRedirects = 10,
    tries = 10,
    backoffFirst = 1500 // ms
  } = opt;

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const doOnce = (currentUrl, redirectsLeft) => {
      attempt++;

      // 續傳：若已存在，從 size 接續
      const exists = fs.existsSync(outFile);
      const startAt = exists ? fs.statSync(outFile).size : 0;
      const headers = {
        'User-Agent': 'EVI-Brush-Desktop',
      };
      if (startAt > 0) headers['Range'] = `bytes=${startAt}-`;

      const req = https.request(currentUrl, { method: 'GET', headers }, res => {
        const code = res.statusCode || 0;

        // 重定向
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, currentUrl).toString();
          req.destroy();
          return doOnce(next, redirectsLeft - 1);
        }

        // 成功（200 或 206）
        if ([200, 206].includes(code)) {
          ensureDir(path.dirname(outFile));
          const ws = fs.createWriteStream(outFile, { flags: startAt > 0 ? 'a' : 'w' });

          let downloaded = startAt;
          const total = (() => {
            const len = +res.headers['content-length'] || 0;
            // 206 時總長度在 content-range，例如 "bytes 123-999/1000"
            const cr = res.headers['content-range'];
            if (cr && /\/(\d+)$/.test(cr)) return parseInt(RegExp.$1, 10);
            return startAt + len;
          })();

          res.on('data', chunk => {
            downloaded += chunk.length;
            ws.write(chunk);
            // 進度事件（可在 renderer 顯示）
            app?.emit?.('model-progress', { url: currentUrl, downloaded, total });
          });

          res.on('end', () => {
            ws.end();
            resolve(outFile);
          });

          res.on('error', err => {
            ws.close();
            reject(err);
          });

          return;
        }

        // 其他錯誤碼
        reject(new Error(`HTTP ${code}`));
      });

      req.on('error', async (err) => {
        if (attempt >= tries) return reject(err);
        const wait = backoffFirst * Math.pow(1.6, attempt - 1);
        await sleep(wait);
        doOnce(currentUrl, redirectsLeft);
      });

      req.end();
    };

    doOnce(url, maxRedirects);
  });
}

// 統一的下載器（先 BITS -> 後備 HTTPS）
async function smartDownload(url, outFile) {
  try {
    return await downloadViaBITS(url, outFile);
  } catch (e) {
    // BITS 失敗再退回自帶下載器（可處理 302 與續傳）
    return await downloadWithRedirectsResume(url, outFile, { tries: 12 });
  }
}

// ====================== 解壓 7z 分割檔 ======================
function extract7zSplit(firstPartPath, outDir) {
  return new Promise((resolve, reject) => {
    ensureDir(outDir);
    const seven = sevenBin.path7za; // 內建跨平台 7z 可執行檔
    const child = spawn(seven, ['x', '-y', firstPartPath, `-o${outDir}`], { windowsHide: true });

    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `7z exit ${code}`));
    });
  });
}

// ====================== IPC：檢查 pbs、下載模型 ======================
ipcMain.handle('check-pbs', async () => {
  try {
    const p = path.join(process.resourcesPath, 'python', 'pbs');
    return fs.existsSync(p) ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
});

/**
 * 下載模型（GitHub Releases 分割檔）
 * @param {{tag:string, parts:number, base?:string}} payload
 *   tag   : 例如 'v73'
 *   parts : 分割片數（例如 5）
 *   base  : 基底檔名（預設 'model-pack.7z'，會自動組 .001 ~ .NNN）
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
ipcMain.handle('model.download', async (_evt, payload) => {
  const tag   = payload?.tag || 'latest';
  const parts = Math.max(1, +payload?.parts || 1);
  const base  = payload?.base || 'model-pack.7z';

  const userTmp = ensureDir(path.join(app.getPath('userData'), 'model-tmp'));
  const outModels = ensureDir(path.join(process.resourcesPath, 'python', 'models'));

  try {
    // 產生分割檔 URL 與本機路徑
    const tasks = [];
    for (let i = 1; i <= parts; i++) {
      const p3 = pad3(i);
      const filename = `${base}.${p3}`;
      const url = releaseUrl(tag, filename);
      const out = path.join(userTmp, filename);
      tasks.push({ url, out });
    }

    // 下載（逐一，穩定度高；如需併發可自行改 PromisePool）
    for (const t of tasks) {
      app.emit('model-progress', { url: t.url, downloaded: 0, total: 0 });
      await smartDownload(t.url, t.out);
      app.emit('model-progress', { url: t.url, downloaded: 1, total: 1 }); // 單檔完成訊號
    }

    // 解壓：使用第一片 .001
    const first = path.join(userTmp, `${base}.001`);
    await extract7zSplit(first, outModels);

    // 清理暫存
    try { fs.rmSync(userTmp, { recursive: true, force: true }); } catch {}

    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
});

// ====================== 將進度轉發給前端（可選） ======================
app.on('model-progress', (info) => {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    w.webContents.send('download-progress', info);
  }
});
