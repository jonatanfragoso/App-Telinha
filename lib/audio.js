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

// apps de voz conhecidos, em ordem de preferência para tirar do "som do sistema"
const VOICE_APPS = [
  ['Discord.exe', 'Discord'], ['DiscordPTB.exe', 'Discord PTB'], ['DiscordCanary.exe', 'Discord Canary'],
  ['TeamSpeak.exe', 'TeamSpeak'], ['ts3client_win64.exe', 'TeamSpeak 3'], ['ts3client_win32.exe', 'TeamSpeak 3'],
  ['ms-teams.exe', 'Teams'], ['Teams.exe', 'Teams'], ['Zoom.exe', 'Zoom'], ['WhatsApp.exe', 'WhatsApp'],
  ['WhatsApp.Root.exe', 'WhatsApp'], ['Skype.exe', 'Skype'], ['mumble.exe', 'Mumble'], ['Guilded.exe', 'Guilded'],
  ['slack.exe', 'Slack'], ['Telegram.exe', 'Telegram'], ['Signal.exe', 'Signal'],
];
// apps de voz abertos agora: [{ exe, name, pid (raiz da árvore) }]
async function voiceApps() {
  if (process.platform !== 'win32') return [];
  const out = await new Promise((resolve) => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_e, o) => resolve(String(o || '')));
  });
  const running = new Set(out.split(/\r?\n/).map((l) => (/^"([^"]+)"/.exec(l) || [])[1]).filter(Boolean).map((x) => x.toLowerCase()));
  const list = [];
  for (const [exe, name] of VOICE_APPS) {
    if (!running.has(exe.toLowerCase()) || list.some((x) => x.name === name)) continue;
    const roots = await findRoots(exe);
    if (roots[0]) list.push({ exe, name, pid: roots[0] });
  }
  return list;
}

let proc = null;

// mode: 'app' (incluir a árvore do pid) | 'exclude' (sistema exceto a árvore do pid, um app de voz)
//       | 'system' (sistema exceto este app). O Windows só permite excluir uma árvore por captura.
async function start({ mode, pid, name }, onData, onStatus) {
  stop();
  if (process.platform !== 'win32') { onStatus({ ok: false, error: 'Captura de áudio só funciona no Windows' }); return; }
  let args;
  if (mode === 'app') args = ['capture', 'include', String(pid)];
  else if (mode === 'exclude' && pid) {
    args = ['capture', 'exclude', String(pid)];
    onStatus({ ok: true, info: `Excluindo o ${name || 'app de voz'} do áudio` });
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

module.exports = { sessions, pidForHwnd, voiceApps, start, stop };
