// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// 取得 7z 可執行檔路徑（7zip-bin 會依平台給正確檔案）
const { path7za } = require('7zip-bin');

// 如果被打包成 asar，需把路徑換到 app.asar.unpacked
function get7zPath() {
  return path7za.replace('app.asar', 'app.asar.unpacked');
}

async function extract7z(archive7zFirstPart, outputDir, log) {
  await fs.promises.mkdir(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const sevenZip = get7zPath();
    const args = ['x', archive7zFirstPart, `-o${outputDir}`, '-y'];

    log(`[core] 使用 7z 解壓：${sevenZip} ${args.join(' ')}`);

    const p = spawn(sevenZip, args, { windowsHide: true });

    p.stdout.on('data', d => log(d.toString().trim()));
    p.stderr.on('data', d => log(d.toString().trim()));
    p.on('error', err => reject(err));
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`7z exit ${code}`));
    });
  });
}

// 你原本下載完成後呼叫解壓處理的地方，改用上面的 extract7z：
// 假設第一個分卷是 tmp/model-pack.7z.001
ipcMain.handle('model:extract', async (_e, firstPartPath, targetDir) => {
  const log = (m) => _e.sender.send('ui:log', m);
  try {
    await extract7z(firstPartPath, targetDir, log);
    log('[core] 解壓完成。');
    return { ok: true };
  } catch (err) {
    log(`[core] 解壓失敗：${err.message}`);
    return { ok: false, error: err.message };
  }
});

// 其餘你的 createWindow / 其他 IPC handler 保持不變…
