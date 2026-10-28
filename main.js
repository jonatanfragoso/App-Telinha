const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Mesh } = require('./lib/mesh');
const audio = require('./lib/audio');
const updater = require('./lib/updater');
const games = require('./lib/games');
const firewall = require('./lib/firewall');
const tailscale = require('./lib/tailscale');

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
  gameDetect: false, gameRequests: true, gameList: [], gameIgnore: [], avatar: null, sounds: true,
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
  settings.avatar = cleanAvatar(settings.avatar);
  if (settings.tailscalePath && !(path.basename(settings.tailscalePath).toLowerCase() === 'tailscale.exe' && fs.existsSync(settings.tailscalePath))) settings.tailscalePath = '';
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
  // links (ex.: do chat) só abrem no navegador se forem http/https; a janela nunca sai do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
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
  mesh.setSelf({ avatar: publicAvatar(settings.avatar) });
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
// avatar: { kind: 'emoji', emoji, color } ou { kind: 'photo', data (data URL 128x128), hash }
const PHOTO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function cleanAvatar(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'emoji' && typeof a.emoji === 'string' && a.emoji.length <= 8) {
    return { kind: 'emoji', emoji: a.emoji, color: Math.max(0, Math.min(7, Number(a.color) | 0)) };
  }
  if (a.kind === 'photo' && typeof a.data === 'string' && a.data.length <= 90000 && PHOTO_RE.test(a.data)) {
    return { kind: 'photo', data: a.data, hash: crypto.createHash('sha256').update(a.data).digest('hex').slice(0, 16) };
  }
  return null;
}
// para a sala vai só a referência; a foto é pedida uma vez por quem não tem (pelo relay)
const publicAvatar = (a) => (!a ? null : a.kind === 'emoji' ? { kind: 'emoji', emoji: a.emoji, color: a.color } : { kind: 'photo', hash: a.hash });

const strList = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, max) : []);
// Só aceita os campos conhecidos, com o tipo certo. O caminho do Tailscale é executado pelo app,
// então só vale um arquivo chamado tailscale.exe que exista.
function cleanSettings(patch) {
  const out = {};
  if (typeof patch.name === 'string') out.name = patch.name.trim().slice(0, 32) || settings.name;
  if (typeof patch.room === 'string') out.room = patch.room.trim().toLowerCase().slice(0, 32) || 'geral';
  if (patch.priority !== undefined) out.priority = Math.max(-10, Math.min(10, Number(patch.priority) || 0));
  if (patch.extraPeers !== undefined) out.extraPeers = strList(patch.extraPeers, 50).filter((ip) => /^[\d.:a-f]+$/i.test(ip));
  if (typeof patch.tailscalePath === 'string') {
    const p = patch.tailscalePath.trim();
    if (!p || (path.basename(p).toLowerCase() === 'tailscale.exe' && fs.existsSync(p))) out.tailscalePath = p;
  }
  for (const k of ['gameDetect', 'gameRequests', 'sounds']) if (patch[k] !== undefined) out[k] = !!patch[k];
  for (const k of ['gameList', 'gameIgnore']) if (patch[k] !== undefined) out[k] = strList(patch[k], 200);
  if (patch.avatar !== undefined) out.avatar = cleanAvatar(patch.avatar);
  return out;
}

ipcMain.handle('settings:set', (_e, raw) => {
  const patch = cleanSettings(raw || {});
  const roomChanged = patch.room !== undefined && patch.room !== settings.room;
  settings = { ...settings, ...patch };
  saveSettings();
  if (roomChanged && mesh) { mesh.isHost = false; mesh.dropHostConn(); }
  if (mesh) { mesh.setSelf({ avatar: publicAvatar(settings.avatar) }); mesh.tick(); }
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
ipcMain.handle('audio:voiceApps', () => audio.voiceApps());
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
ipcMain.on('update:busy', (_e, b) => updater.setBusy(b));
ipcMain.handle('games:current', () => games.current());
ipcMain.handle('firewall:status', () => firewall.status());
ipcMain.handle('firewall:fix', () => firewall.fix());
ipcMain.handle('tailscale:networks', () => tailscale.networks(settings.tailscalePath || null));
ipcMain.handle('tailscale:switch', async (_e, id) => {
  try { await tailscale.switchTo(String(id), settings.tailscalePath || null); }
  catch (e) { return { ok: false, message: String(e.message || e).split('\n')[0] }; }
  setTimeout(() => mesh && mesh.tick(), 1500); // o IP do Tailscale muda: varre de novo logo
  return { ok: true };
});
ipcMain.on('win:attention', () => {
  if (!win || win.isFocused()) return;
  win.flashFrame(true);
  win.once('focus', () => win && win.flashFrame(false));
});
ipcMain.on('win:focus', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
ipcMain.handle('platform', () => ({ platform: process.platform, version: app.getVersion(), osRelease: os.release() }));
