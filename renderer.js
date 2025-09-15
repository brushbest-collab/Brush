const $status = document.querySelector('#status');
const $pickBtn = document.querySelector('#pickRootBtn');
const $rootLabel = document.querySelector('#rootLabel');
const $downloadBtn = document.querySelector('#downloadBtn');
const $designBtn = document.querySelector('#designBtn');
const $log = document.querySelector('#log');

let appState = { bootstrap: false, modelRoot: '' };

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
  // 按鈕狀態
  $downloadBtn.disabled = false; // 下載模型（示範用，這裡不實作）
  $designBtn.disabled = !(appState.bootstrap && appState.modelRoot);
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
  // 這裡保留你的下載流程（目前示範不實作）
  log('開始下載模型（示範 / 不實作）');
  log('示範下載完成。');
});

$designBtn.addEventListener('click', async () => {
  if ($designBtn.disabled) return;
  await window.api.startDesign(appState);
});

document.addEventListener('DOMContentLoaded', refresh);
