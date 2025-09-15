const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const Store = require('electron-store');
const got = require('got');
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');

const store = new Store({ name: 'settings' });

/** 下載來源設定：請改成你的 OWNER / REPO / TAG / 檔名 **/
const GH = {
  OWNER: 'brushbest-collab',
  REPO:  'Brush',                 // 你的 repo
  TAG:   'v73',                   // 你的 Release Tag
  BASE:  'model-pack.7z',         // 分卷基底檔名：model-pack.7z.001, .002 ...
  TOTAL_PARTS: 302                // 分卷數（可依實際調整）
};

// --------------------------- 內部輔助 ---------------------------

function get7zPath() {
  // 把 app.asar 換成 app.asar.unpacked，確保能讀到真正的 7za.exe
  return path7za.replace('app.asar', 'app.asar.unpacked');
}

function logTo(win, ...args) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', args.map(String).join(' '));
  }
}

async function streamDownloadWithResume(url, destPath, win) {
  // 斷點續傳：如果已有部分，帶 Range
  let start = 0;
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    start = stat.size || 0;
  }

  const headers = start > 0 ? { Range: `bytes=${start}-` } : undefined;

  logTo(win, `開始下載：${url} -> ${destPath}（續傳位移=${start}）`);

  await fse.ensureDir(path.dirname(destPath));

  const writeStream = fs.createWriteStream(destPath, { flags: start > 0 ? 'a' : 'w' });

  return new Promise((resolve, reject) => {
    const req = got.stream(url, {
      followRedirect: true,
      headers
    });

    req.on('downloadProgress', p => {
      const percent = Math.floor((p.percent || 0) * 100);
      win.webContents.send('progress', percent);
    });

    req.on('error', err => {
      writeStream.close();
      reject(err);
    });

    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    req.pipe(writeStream);
  });
}

async function extractWith7z(firstPartPath, outDir, win) {
  const sevenZip = get7zPath();
  if (!fs.existsSync(sevenZip)) {
    throw new Error(`7z 不存在：${sevenZip}`);
  }

  await fse.ensureDir(outDir);

  return new Promise((resolve, reject) => {
    logTo(win, `[core] 使用 7z 解壓：7z x -y -o${outDir} ${firstPartPath}`);
    const ps = spawn(sevenZip, ['x', firstPartPath, `-o${outDir}`, '-y']);

    ps.stdout.on('data', (d) => logTo(win, d.toString()));
    ps.stderr.on('data', (d) => logTo(win, d.toString()));

    ps.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`7z exit ${code}`));
    });
  });
}

// --------------------------- IPC ---------------------------

ipcMain.handle('app:get-state', async () => {
  // 這裡僅回報是否有 model root；Python bootstrap 你可自行加偵測
  const modelRoot = store.get('modelRoot', '');
  const bootstrap = fs.existsSync(modelRoot); // 粗略判斷
  return { bootstrap, modelRoot };
});

ipcMain.handle('model:pick-root', async () => {
  const ret = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.get('modelRoot') || undefined,
    title: '選擇模型資料夾'
  });
  if (!ret.canceled && ret.filePaths && ret.filePaths[0]) {
    store.set('modelRoot', ret.filePaths[0]);
    return ret.filePaths[0];
  }
  throw new Error('取消選擇');
});

ipcMain.handle('model:download', async (e) => {
  const win = BrowserWindow.getFocusedWindow();
  const modelRoot = store.get('modelRoot', '');
  if (!modelRoot) throw new Error('尚未指定模型資料夾');

  const tmpDir = path.join(modelRoot, '.tmp');
  const firstPart = path.join(tmpDir, `${GH.BASE}.001`);

  try {
    logTo(win, '[ui] 開始下載模型（正式）…');
    for (let i = 1; i <= GH.TOTAL_PARTS; i++) {
      const num = String(i).padStart(3, '0');
      const url = `https://github.com/${GH.OWNER}/${GH.REPO}/releases/download/${GH.TAG}/${GH.BASE}.${num}`;
      const dst = path.join(tmpDir, `${GH.BASE}.${num}`);

      try {
        await streamDownloadWithResume(url, dst, win);
        logTo(win, `[ui] 完成 ${path.basename(dst)}.`);
      } catch (err) {
        logTo(win, `[ui] 下載失敗 ${path.basename(dst)}：${err.message}`);
        throw err;
      }
    }

    logTo(win, '[ui] 下載全部分卷完成，開始解壓…');
    await extractWith7z(firstPart, modelRoot, win);

    logTo(win, '[ui] 解壓完成。可以開始使用囉！');
    return true;
  } finally {
    // 可選：保留 tmp 以利續傳；若要清除把下行取消註解
    // fse.remove(tmpDir).catch(()=>{});
  }
});

ipcMain.handle('ui:open-designer', async () => {
  // 這裡先給個提醒視窗，避免你說「點了沒反應」
  const win = BrowserWindow.getFocusedWindow();
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'EVI Brush Desktop',
    message: '這裡接入你的鞋款設計 / Prompt 生成 UI。'
  });
  return true;
});

// --------------------------- 視窗 ---------------------------

let mainWin;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  mainWin.loadFile(path.join(__dirname, 'index.html'));
  // mainWin.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
