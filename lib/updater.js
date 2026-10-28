// Atualização automática via GitHub Releases (electron-updater).
// Funciona na versão instalada (Telinha Setup x.y.z.exe). A versão portátil não se atualiza sozinha.
// Baixa sozinho (nunca durante transmissão), mas só instala quando o usuário clica em "Atualizar agora".
const { app } = require('electron');

let autoUpdater = null;
let CancellationToken = null;
let status = { state: 'idle' };
let notify = () => {};
let busy = false; // transmitindo ou assistindo
let pending = null; // versão encontrada, esperando para baixar
let cancel = null; // download em andamento

function set(s) { status = s; notify(status); }

function init(onStatus) {
  notify = onStatus;
  if (!app.isPackaged) return set({ state: 'dev', message: 'Rodando pelo código (npm start): atualização desativada' });
  if (process.env.PORTABLE_EXECUTABLE_DIR) return set({ state: 'portable', message: 'Versão portátil: baixe a nova versão manualmente' });
  try { ({ autoUpdater, CancellationToken } = require('electron-updater')); } catch (e) { return set({ state: 'error', message: e.message }); }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false; // nunca instala escondido ao fechar
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest', version: app.getVersion() }));
  autoUpdater.on('update-available', (i) => { pending = i.version; download(); });
  autoUpdater.on('download-progress', (p) => set({ ...status, state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => { cancel = null; pending = null; set({ state: 'ready', version: i.version }); });
  autoUpdater.on('error', (e) => {
    const msg = String(e && e.message ? e.message : e).split('\n')[0];
    if (/cancel/i.test(msg)) return; // download interrompido por causa de uma transmissão
    cancel = null;
    set({ state: 'error', message: msg });
  });

  check();
  setInterval(check, 2 * 60 * 60 * 1000); // a cada 2 h
}

function download() {
  if (!pending || cancel) return;
  if (busy) return set({ state: 'waiting', version: pending });
  cancel = new CancellationToken();
  set({ state: 'downloading', version: pending, percent: 0 });
  autoUpdater.downloadUpdate(cancel).catch(() => { cancel = null; });
}

// a interface avisa quando começa/termina uma transmissão (própria ou assistida)
function setBusy(b) {
  busy = !!b;
  if (busy && cancel) { cancel.cancel(); cancel = null; set({ state: 'waiting', version: pending }); }
  else if (!busy) download();
}

function check() {
  if (!autoUpdater || status.state === 'ready' || cancel) return status;
  autoUpdater.checkForUpdates().catch(() => {});
  return status;
}

function install() {
  if (autoUpdater && status.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

module.exports = { init, check, install, setBusy, get status() { return status; } };
