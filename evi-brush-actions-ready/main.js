// main.js — portable Python + first-run venv bootstrap + wheels(offline) 安裝
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

let pyProc = null;

function logFile() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'py.log');
}
function writeLog(msg) {
  fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${msg}\n`);
}

function waitForServer(url, attempts = 600, delay = 500) { // 5 分鐘
  const http = require('http');
  return new Promise((resolve, reject) => {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      http.get(url, () => { clearInterval(t); resolve(); })
        .on('error', () => { if (tries >= attempts) { clearInterval(t); reject(new Error('timeout')); } });
    }, delay);
  });
}

function bootstrapVenvIfNeeded(pyRoot) {
  const isWin = process.platform === 'win32';
  const venvPy = isWin
    ? path.join(pyRoot, 'venv', 'Scripts', 'python.exe')
    : path.join(pyRoot, 'venv', 'bin', 'python');
  if (fs.existsSync(venvPy)) return venvPy;

  // 1) 找到隨包 PBS 的 python
  const pbsPy = isWin
    ? path.join(pyRoot, 'pbs', 'python.exe')
    : path.join(pyRoot, 'pbs', 'bin', 'python3');

  let bootstrap = null;
  if (fs.existsSync(pbsPy)) bootstrap = pbsPy;
  else if (process.env.PYTHON) bootstrap = process.env.PYTHON; // 後備（不建議）

  if (!bootstrap) throw new Error('portable Python bootstrap not found (python/pbs).');

  writeLog('No venv found → creating venv...');
  const venvDir = path.join(pyRoot, 'venv');
  const create = spawnSync(bootstrap, ['-m', 'venv', venvDir], { cwd: pyRoot });
  if (create.status !== 0) {
    writeLog(`venv create failed: ${create.stderr?.toString()}`);
    throw new Error('venv create failed');
  }

  // 2) 升級 pip
  const up = spawnSync(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], { cwd: pyRoot });
  if (up.status !== 0) writeLog(`pip upgrade warning: ${up.stderr?.toString()}`);

  // 3) 安裝依賴：優先吃離線 wheels，其次線上
  const req = fs.existsSync(path.join(pyRoot, 'requirements.txt'))
    ? path.join(pyRoot, 'requirements.txt')
    : (fs.existsSync(path.join(pyRoot, 'requirements')) ? path.join(pyRoot, 'requirements') : null);

  if (req) {
    const wheelsDir = path.join(pyRoot, 'wheels');
    let args;
    if (fs.existsSync(wheelsDir) && fs.readdirSync(wheelsDir).length > 0) {
      writeLog('Installing deps from offline wheels...');
      args = ['-m', 'pip', 'install', '--no-index', `--find-links=${wheelsDir}`, '-r', req];
    } else {
      writeLog('Installing deps from PyPI (online)...');
      args = ['-m', 'pip', 'install', '-r', req];
    }
    const inst = spawnSync(venvPy, args, { cwd: pyRoot });
    if (inst.status !== 0) {
      writeLog(`pip install failed: ${inst.stderr?.toString()}`);
      throw new Error('pip install failed');
    }
  } else {
    writeLog('requirements not found — skip deps install.');
  }

  return venvPy;
}

function startPython() {
  const pyRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'python')
    : path.join(__dirname, 'python');

  // 讓 HF/Transformers 快取在本地，線上或離線都能重用
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    HUGGINGFACE_HUB_CACHE: path.join(pyRoot, 'models'),
    TRANSFORMERS_CACHE: path.join(pyRoot, 'models'),
    HF_HOME: path.join(pyRoot, 'hf_cache'),
    HF_HUB_ENABLE_HF_TRANSFER: '1', // 加速下載
  };

  let venvPython;
  try {
    venvPython = bootstrapVenvIfNeeded(pyRoot);
  } catch (e) {
    writeLog(`bootstrap failed: ${e.stack || e.message}`);
    throw e;
  }

  const serverScript = path.join(pyRoot, 'server.py');
  writeLog(`Launching server: ${venvPython} ${serverScript}`);
  pyProc = spawn(venvPython, [serverScript], { cwd: pyRoot, env });

  const log = fs.createWriteStream(logFile(), { flags: 'a' });
  pyProc.stdout.on('data', d => log.write(`[stdout] ${d}\n`));
  pyProc.stderr.on('data', d => log.write(`[stderr] ${d}\n`));
  pyProc.on('close', c => log.write(`\n==== Python exited code=${c} ====\n`));
  return pyProc;
}

async function createWindow () {
  const win = new BrowserWindow({ width: 1280, height: 860 });

  try {
    if (!pyProc) startPython();
    await waitForServer('http://127.0.0.1:7860');
    win.loadURL('http://127.0.0.1:7860');
  } catch (e) {
    const html = `
      <h2>Backend did not start.</h2>
      <p>Check log file:</p>
      <pre>${logFile()}</pre>
      <p>${e.message || e}</p>
    `;
    win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => { try { pyProc && pyProc.kill(); } catch(_){} });
