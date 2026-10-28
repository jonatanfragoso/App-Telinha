// Ponte com o audiocap.exe (captura de áudio por processo do Windows).
const { execFile, spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'audiocap.exe')
    : path.join(__dirname, '..', 'native', 'audiocap.exe');
}

function runJson(args) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile(helperPath(), args, { timeout: 5000, windowsHide: true }, (err, out) => {
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

const sessions = async () => (await runJson(['sessions'])) || [];
const pidForHwnd = (hwnd) => runJson(['hwnd', String(hwnd)]);
const findRoots = async (exe) => (await runJson(['find', exe])) || [];

let proc = null;

// mode: 'app' (incluir pid) | 'nodiscord' (sistema exceto Discord) | 'system' (sistema exceto este app)
async function start({ mode, pid }, onData, onStatus) {
  stop();
  if (process.platform !== 'win32') { onStatus({ ok: false, error: 'Captura de áudio só funciona no Windows' }); return; }
  let args;
  if (mode === 'app') args = ['capture', 'include', String(pid)];
  else if (mode === 'nodiscord') {
    const roots = await findRoots('Discord.exe');
    const canary = roots.length ? roots : await findRoots('DiscordCanary.exe');
    const target = canary[0] || process.pid;
    args = ['capture', 'exclude', String(target)];
    onStatus({ ok: true, info: canary[0] ? 'Excluindo o Discord do áudio' : 'Discord não está aberto: capturando o sistema' });
  } else args = ['capture', 'exclude', String(process.pid)];

  const p = spawn(helperPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  proc = p;
  p.stdout.on('data', (chunk) => { if (proc === p) onData(chunk); });
  let errText = '';
  p.stderr.on('data', (d) => {
    errText += d.toString();
    if (/^OK/m.test(errText)) onStatus({ ok: true, capturing: true });
  });
  p.on('exit', (code) => {
    if (proc !== p) return;
    proc = null;
    if (code) onStatus({ ok: false, error: errText.trim() || `audiocap saiu com código ${code}` });
  });
  p.on('error', (e) => onStatus({ ok: false, error: e.message }));
}

function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  try { p.stdin.end(); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 500);
}

module.exports = { sessions, pidForHwnd, start, stop };
