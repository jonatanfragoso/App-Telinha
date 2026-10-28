// Atualização automática via GitHub Releases (electron-updater).
// Funciona na versão instalada (Telinha Setup x.y.z.exe). A versão portátil não se atualiza sozinha.
const { app } = require('electron');

let autoUpdater = null;
let status = { state: 'idle' };
let notify = () => {};

function set(s) { status = s; notify(status); }

function init(onStatus) {
  notify = onStatus;
  if (!app.isPackaged) return set({ state: 'dev', message: 'Rodando pelo código (npm start): atualização desativada' });
  if (process.env.PORTABLE_EXECUTABLE_DIR) return set({ state: 'portable', message: 'Versão portátil: baixe a nova versão manualmente' });
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return set({ state: 'error', message: e.message }); }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // se não reiniciar agora, instala ao fechar
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest', version: app.getVersion() }));
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ ...status, state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => set({ state: 'error', message: String(e && e.message ? e.message : e).split('\n')[0] }));

  check();
  setInterval(check, 2 * 60 * 60 * 1000); // a cada 2 h
}

function check() {
  if (!autoUpdater) return status;
  autoUpdater.checkForUpdates().catch(() => {});
  return status;
}

function install() {
  if (autoUpdater && status.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

module.exports = { init, check, install, get status() { return status; } };
