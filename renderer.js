const $status = document.querySelector('#status');
const $pickBtn = document.querySelector('#pickRootBtn');
const $rootLabel = document.querySelector('#rootLabel');
const $downloadBtn = document.querySelector('#downloadBtn');
const $designBtn = document.querySelector('#designBtn');
const $log = document.querySelector('#log');

let appState = { bootstrap: false, modelRoot: '' };
let busy = false;

function log(msg) {
  const at = new Date().toLocaleTimeString();
  $log.value += `[ui ${at}] ${msg}\n`;
  $log.scrollTop = $log.scrollHeight;
}

function render() {
  if (appState.bootstrap) {
    $status.textContent = 'Python bootstrap found.';
    $status.className = 'ok';
  } else {
    $status.textContent = 'Python bootstrap not found（請確認安裝包是否完整）';
    $status.className = 'warn';
  }
  $rootLabel.textContent = appState.modelRoot || '--';

  $downloadBtn.disabled = busy;
  $designBtn.disabled = busy || !(appState.bootstrap && appState.modelRoot);
}

async function refresh() {
  $status.textContent = 'Checking...';
  appState = await window.api.getState();
  render();
}

$pickBtn.addEventListener('click', async () => {
  const p = await window.api.pickRoot();
  if (p) {
    appState.modelRoot = p;
    log(`選擇模型資料夾：${p}`);
    render();
  } else {
    log('選擇模型資料夾：已取消');
  }
});

$downloadBtn.addEventListener('click', async () => {
  if (busy) return;
  busy = true; render();
  try {
    log('開始下載模型（正式）…');
    await window.api.downloadModel(appState.modelRoot);
    log('下載流程完成。');
  } catch (e) {
    log('下載失敗：' + (e?.message || e));
  } finally {
    busy = false; render();
  }
});

$designBtn.addEventListener('click', async () => {
  if ($designBtn.disabled) return;
  await window.api.startDesign(appState);
});

window.api.onLog((m) => log(m));
document.addEventListener('DOMContentLoaded', refresh);
