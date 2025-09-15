// renderer.js
const $ = (q) => document.querySelector(q);
const logEl = $('#log');
const bar = $('#bar');
const rootText = $('#root-path');
const pickBtn = $('#btn-pick');
const dlBtn = $('#btn-dl');
const goBtn = $('#btn-go');
const bootstrapEl = $('#bootstrap');

function appendLog(t) {
  const line = document.createElement('div');
  line.textContent = t;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(frac) {
  const v = Math.max(0, Math.min(1, frac || 0));
  bar.style.width = `${v * 100}%`;
}

async function init() {
  const s = await window.api.init();
  bootstrapEl.textContent = s.bootstrap ? 'Python bootstrap found.' : 'Python bootstrap not found（請確認安裝包是否完整）';
  rootText.textContent = s.modelRoot || '--';
}

pickBtn.addEventListener('click', async () => {
  const p = await window.api.pickRoot();
  if (p) rootText.textContent = p;
});

dlBtn.addEventListener('click', async () => {
  const root = rootText.textContent.trim();
  if (!root || root === '--') {
    appendLog('[ui] 尚未選擇模型資料夾。');
    return;
  }
  try {
    appendLog('[ui] 準備下載…');
    setProgress(0);
    await window.api.downloadModel(root);
    setProgress(1);
  } catch (e) {
    appendLog(`[ui] 下載/解壓錯誤：${e.message || e}`);
  }
});

goBtn.addEventListener('click', () => {
  window.api.openGenerator();
});

window.api.onLog((m) => appendLog(m));
window.api.onProgress(({ current, total }) => {
  const frac = total ? current / total : 0;
  setProgress(frac);
});

init();
