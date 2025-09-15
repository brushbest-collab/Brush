// renderer/renderer.js
(() => {
  const $ = (id) => document.getElementById(id);
  const logBox = $("logs");
  const bar = $("bar");
  const rootLabel = $("rootLabel");
  const checking = $("checking");

  function log(line) {
    if (!logBox) return;
    const time = new Date().toLocaleTimeString();
    logBox.textContent += `[ui ${time}] ${line}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  // 綁定按鈕
  $("btnPick").addEventListener("click", async () => {
    try {
      const dir = await window.evi?.pickModelRoot?.();
      if (dir) {
        rootLabel.textContent = dir;
        log(`選擇模型資料夾: ${dir}`);
      }
    } catch (e) {
      log(`選擇資料夾失敗: ${e.message || e}`);
    }
  });

  $("btnDownload").addEventListener("click", async () => {
    try {
      log("開始下載模型（可續傳 / 302 兼容）");
      await window.evi?.downloadAll?.();
    } catch (e) {
      log(`下載失敗: ${e.message || e}`);
    }
  });

  $("btnGo").addEventListener("click", async () => {
    try {
      const ok = await window.evi?.goDesign?.();
      if (!ok) {
        await window.evi?.alert?.("尚未安裝模型，請先下載 / 指定模型資料夾。");
      }
    } catch (e) {
      log(`開啟設計頁面失敗: ${e.message || e}`);
    }
  });

  // 訂閱主程序事件
  // 日誌
  window.evi?.onLog?.((_evt, line) => log(line));
  // 進度
  window.evi?.onProgress?.((_evt, p) => {
    if (typeof p === "number") bar.value = p;
  });
  // 狀態（bootstrap / modelRoot）
  window.evi?.onState?.((_evt, state) => {
    checking.textContent = state.bootstrap
      ? "Python bootstrap found. 模型未安裝。"
      : "Python bootstrap not found（請確認安裝包是否完整）";
    if (state.modelRoot) rootLabel.textContent = state.modelRoot;
    log(`state received: bootstrap=${!!state.bootstrap}, modelRoot=${state.modelRoot || "--"}`);
  });

  // 啟動時向主程序詢問狀態
  (async () => {
    try {
      const s = await window.evi?.getState?.();
      if (s) {
        checking.textContent = s.bootstrap
          ? "Python bootstrap found. 模型未安裝。"
          : "Python bootstrap not found（請確認安裝包是否完整）";
        if (s.modelRoot) rootLabel.textContent = s.modelRoot;
        log(`state received: bootstrap=${!!s.bootstrap}, modelRoot=${s.modelRoot || "--"}`);
      } else {
        log("未取得狀態（確認 preload 與 IPC 設定）");
      }
    } catch (e) {
      log(`取得狀態失敗: ${e.message || e}`);
    }
  })();
})();
