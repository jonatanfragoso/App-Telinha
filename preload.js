const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('telinha', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (p) => ipcRenderer.invoke('settings:set', p),
  platform: () => ipcRenderer.invoke('platform'),
  sources: () => ipcRenderer.invoke('sources'),

  audioSessions: () => ipcRenderer.invoke('audio:sessions'),
  pidForSource: (id) => ipcRenderer.invoke('audio:pidForSource', id),
  audioStart: (o) => ipcRenderer.invoke('audio:start', o),
  audioStop: () => ipcRenderer.invoke('audio:stop'),
  onPcm: on('audio:pcm'),
  onAudioStatus: on('audio:status'),

  send: (to, payload) => ipcRenderer.send('mesh:send', { to, payload }),
  setSelf: (s) => ipcRenderer.send('mesh:self', s),
  promote: (id) => ipcRenderer.send('mesh:promote', id),
  refresh: () => ipcRenderer.send('mesh:refresh'),
  onState: on('mesh:state'),
  onSignal: on('mesh:signal'),
  onLog: on('log'),

  currentGame: () => ipcRenderer.invoke('games:current'),
  onGame: on('games:current'),
  attention: () => ipcRenderer.send('win:attention'),
  focusWindow: () => ipcRenderer.send('win:focus'),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateInstall: () => ipcRenderer.send('update:install'),
  updateBusy: (b) => ipcRenderer.send('update:busy', b),
  onUpdate: on('update:status'),
});
