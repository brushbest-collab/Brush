(() => {
  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const modelRootEl = $("#modelRoot");
  const btnPick = $("#btnPickModelRoot");
  const btnDownload = $("#btnDownload");
  const btnStart = $("#btnStart");
  const barFill = $("#barFill");
  const logEl = $("#log");

  const log = (msg) => {
    const t = new Date().toLocaleTimeString();
    logEl.textContent += `[ui] ${t} ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const setProgress = (p /* 0~100 */) => {
    barFill.style.width = `${Math.max(0, Math.min(100, p))}%`;
  };

  async function refresh() {
    try {
      const s = await window.api.getState(); // 由 preload 暴露
      modelRootEl.textContent = s.modelRoot || "--";
      statusEl.textContent = s.bootstrap
        ? `Python bootstrap found. ${s.installed ? "模型已安裝。" : "模型未安裝。"}`
        : "Python bootstrap not found（請確認安裝包是否完整）";

      btnPick.disabled = !s.bootstrap;
      btnDownload.disabled = !s.bootstrap;
      btnStart.disabled = !s.bootstrap || !s.installed;
    } catch (e) {
      statusEl.textContent = "初始化失敗：" + e.message;
      console.error(e);
    }
  }

  // 選擇模型根目錄
  btnPick.addEventListener("click", async () => {
    const p = await window.api.pickModelRoot();
    if (p) {
      log(`選擇模型資料夾：${p}`);
      await refresh();
    }
  });

  // 下載模型（支援 302 與斷點續傳；每卷 900MB）
  btnDownload.addEventListener("click", async () => {
    setProgress(0);
    log("開始下載模型…");
    await window.api.downloadModel(
      {
        partSizeMB: 900,
        tag: "latest", // 或指定 vXX
      },
      (evt) => {
        if (evt.type === "log") log(evt.text);
        if (evt.type === "progress") setProgress(evt.percent);
      }
    );
    log("下載流程結束。");
    await refresh();
  });

  // 開啟設計 / 生成
  btnStart.addEventListener("click", async () => {
    const ok = await window.api.startDesigner();
    if (!ok) {
      alert("尚未安裝模型，請先下載或指定模型資料夾。");
    }
  });

  document.addEventListener("DOMContentLoaded", refresh);
})();
