const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Mesh } = require('./lib/mesh');
const audio = require('./lib/audio');
const updater = require('./lib/updater');
const games = require('./lib/games');

// Sem isso o Chromium esconde os IPs locais atrás de nomes .local (mDNS),
// e quem só assiste não conseguiria conectar pelo IP do Tailscale.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Evita que o Chromium reduza fps quando a janela fica em segundo plano
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) app.quit();
// necessário para as notificações do Windows aparecerem com o nome do app
if (process.platform === 'win32') app.setAppUserModelId('br.jonatan.telinha');

const settingsFile = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  name: os.hostname(), room: 'geral', priority: 0, extraPeers: [], tailscalePath: '',
  gameDetect: false, gameRequests: true, gameList: [], gameIgnore: [],
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

let win = null;
let mesh = null;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Telinha',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  if (process.env.TELINHA_SHOT) {
    // usado só para teste automatizado da interface
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message || ''));
    setTimeout(async () => {
      if (process.env.TELINHA_JS) await win.webContents.executeJavaScript(process.env.TELINHA_JS).catch((e) => console.log('js', e));
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.TELINHA_SHOT, img.toPNG());
        app.quit();
      }, 1200);
    }, 3500);
  }
}

app.whenReady().then(() => {
  loadSettings();
  mesh = new Mesh(() => settings);
  mesh.on('state', (s) => send('mesh:state', s));
  mesh.on('signal', (m) => send('mesh:signal', m));
  mesh.on('log', (l) => send('log', l));
  createWindow();
  mesh.start();
  games.init({
    dataDir: app.getPath('userData'),
    getSettings: () => settings,
    onLog: (l) => send('log', l),
    onChange: publishGame,
  });
  win.webContents.once('did-finish-load', () => updater.init((s) => send('update:status', s)));
});

// só o nome do jogo vai para a sala
function publishGame(g) {
  if (mesh) mesh.setSelf({ playing: g ? { name: g.name, requests: !!settings.gameRequests } : null });
  send('games:current', g);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { audio.stop(); if (mesh) mesh.stop(); app.quit(); });

// ---------- IPC ----------
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  const roomChanged = patch.room !== undefined && patch.room !== settings.room;
  settings = { ...settings, ...patch };
  settings.priority = Number(settings.priority) || 0;
  saveSettings();
  if (roomChanged && mesh) { mesh.isHost = false; mesh.dropHostConn(); }
  if (mesh) mesh.tick();
  games.refresh();
  return settings;
});

ipcMain.handle('sources', async () => {
  const list = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 384, height: 216 },
    fetchWindowIcons: true,
  });
  return list
    .filter((s) => s.name !== 'Telinha')
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('audio:sessions', () => audio.sessions());
ipcMain.handle('audio:pidForSource', async (_e, sourceId) => {
  const m = /^window:(\d+):/.exec(sourceId || '');
  return m ? audio.pidForHwnd(m[1]) : null;
});
ipcMain.handle('audio:start', (_e, opts) => {
  audio.start(
    opts,
    (chunk) => send('audio:pcm', chunk),
    (st) => send('audio:status', st),
  );
  return true;
});
ipcMain.handle('audio:stop', () => { audio.stop(); return true; });

ipcMain.on('mesh:send', (_e, { to, payload }) => mesh && mesh.send(to, payload));
ipcMain.on('mesh:self', (_e, self) => mesh && mesh.setSelf(self));
ipcMain.on('mesh:promote', (_e, id) => mesh && mesh.promote(id));
ipcMain.on('mesh:refresh', () => mesh && mesh.tick());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:status', () => updater.status);
ipcMain.on('update:install', () => { audio.stop(); updater.install(); });
ipcMain.handle('games:current', () => games.current());
ipcMain.on('win:attention', () => {
  if (!win || win.isFocused()) return;
  win.flashFrame(true);
  win.once('focus', () => win && win.flashFrame(false));
});
ipcMain.on('win:focus', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
ipcMain.handle('platform', () => ({ platform: process.platform, version: app.getVersion(), osRelease: os.release() }));
