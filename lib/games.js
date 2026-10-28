// Detecção de "jogando agora". Só roda se o usuário ligar nas configurações.
// Fontes, em ordem: lista do usuário > lista pública de jogos do Discord > pastas de lojas (Steam, Epic, GOG...).
// Nada sai do PC além do nome do jogo (o caminho e os outros processos ficam aqui).
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { net } = require('electron');

const POLL_MS = 15000;
const DB_URL = 'https://discord.com/api/v9/applications/detectable';
const DB_MAX_AGE = 7 * 24 * 3600 * 1000;

// pastas onde as lojas instalam jogos: o nome da pasta vira o nome do jogo
const STORE_DIRS = [
  /\\steamapps\\common\\([^\\]+)\\/i,
  /\\Epic Games\\([^\\]+)\\/i,
  /\\GOG Galaxy\\Games\\([^\\]+)\\/i,
  /\\XboxGames\\([^\\]+)\\/i,
  /\\Riot Games\\([^\\]+)\\/i,
  /\\EA Games\\([^\\]+)\\/i,
  /\\Ubisoft Game Launcher\\games\\([^\\]+)\\/i,
];
const NOT_GAME_DIR = /^(steamworks shared|steamvr|riot client|launcher|directx|epic online services|wallpaper_engine)$/i;
const NOT_GAME_EXE = /crash|report|helper|launcher|setup|redist|unins|update|easyanticheat|battleye|beservice|overlay|cefprocess|webhelper|vcredist|dxsetup/i;

let opts = null; // { dataDir, getSettings, onChange }
let db = null; // { basename: [[sufixo, nome], ...] }
let timer = null;
let current = null;
let lastKey = '';

function init(o) {
  opts = o;
  refresh();
}

// chamado ao abrir e sempre que as configurações mudam
function refresh() {
  const s = opts.getSettings();
  clearInterval(timer); timer = null;
  if (!s.gameDetect) return set(null, true);
  loadDb();
  poll(true);
  timer = setInterval(() => poll(false), POLL_MS);
}

function set(g, force) {
  const key = g ? `${g.name}|${g.exe}` : '';
  if (!force && key === lastKey) return;
  lastKey = key; current = g;
  opts.onChange(g);
}

async function poll(force) {
  if (process.env.TELINHA_FAKE_GAME) return set({ name: process.env.TELINHA_FAKE_GAME, exe: 'teste.exe', source: 'teste' }, force);
  const procs = await listProcs();
  if (!opts.getSettings().gameDetect) return;
  set(detect(procs), force);
}

function listProcs() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | ForEach-Object { if ($_.Path) { "$([int]($_.MainWindowHandle -ne 0))|$($_.Path)" } }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return resolve([]);
      resolve(String(out).split(/\r?\n/).filter(Boolean).map((l) => {
        const i = l.indexOf('|');
        return { win: l.slice(0, i) === '1', path: l.slice(i + 1) };
      }));
    });
  });
}

function parseList(lines) {
  // "eldenring.exe = Elden Ring" ou só "eldenring.exe"
  const m = new Map();
  for (const l of lines || []) {
    const [exe, ...rest] = l.split('=');
    const k = exe.trim().toLowerCase();
    if (k) m.set(k, rest.join('=').trim() || k.replace(/\.exe$/, ''));
  }
  return m;
}

function detect(procs) {
  const s = opts.getSettings();
  const mine = parseList(s.gameList);
  const ignore = new Set((s.gameIgnore || []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  let best = null; // { rank, name, exe }
  const take = (rank, name, exe) => { if (!best || rank < best.rank) best = { rank, name, exe }; };

  for (const p of procs) {
    const norm = p.path.replace(/\\/g, '/').toLowerCase();
    const exe = norm.slice(norm.lastIndexOf('/') + 1);
    if (ignore.has(exe)) continue;
    if (mine.has(exe)) { take(0, mine.get(exe), exe); continue; }
    const hits = db && db[exe];
    if (hits) {
      const hit = hits.find(([suf]) => norm === suf || norm.endsWith('/' + suf));
      if (hit) { take(p.win ? 1 : 2, hit[1], exe); continue; }
    }
    if (p.win && !NOT_GAME_EXE.test(exe)) {
      for (const re of STORE_DIRS) {
        const m = re.exec(p.path);
        if (m && !NOT_GAME_DIR.test(m[1])) { take(3, m[1], exe); break; }
      }
    }
  }
  return best ? { name: best.name.slice(0, 60), exe: best.exe, source: ['sua lista', 'lista do Discord', 'lista do Discord', 'pasta da loja'][best.rank] } : null;
}

// ---------- lista de jogos do Discord (pública, sem login) ----------
function dbFile() { return path.join(opts.dataDir, 'games-db.json'); }

function loadDb() {
  if (db) return;
  let age = Infinity;
  try {
    const j = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
    db = j.index; age = Date.now() - j.at;
  } catch {}
  if (age > DB_MAX_AGE) downloadDb();
}

async function downloadDb() {
  try {
    const res = await net.fetch(DB_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const apps = await res.json();
    const count = {};
    const all = [];
    for (const a of apps) {
      for (const e of a.executables || []) {
        if (e.os !== 'win32' || e.is_launcher || !e.name || e.name.startsWith('>')) continue;
        const suf = e.name.toLowerCase();
        const base = suf.slice(suf.lastIndexOf('/') + 1);
        count[base] = (count[base] || 0) + 1;
        all.push([base, suf, a.name]);
      }
    }
    const index = {};
    for (const [base, suf, name] of all) {
      // "game.exe" sozinho aparece em centenas de jogos: só vale com a pasta junto
      if (suf === base && count[base] > 1) continue;
      (index[base] ||= []).push([suf, name]);
    }
    db = index;
    fs.mkdirSync(opts.dataDir, { recursive: true });
    fs.writeFileSync(dbFile(), JSON.stringify({ at: Date.now(), index }));
    if (opts.onLog) opts.onLog(`Lista de jogos atualizada (${Object.keys(index).length} executáveis)`);
  } catch (e) {
    if (opts.onLog) opts.onLog(`Não consegui baixar a lista de jogos: ${e.message}`);
  }
}

module.exports = { init, refresh, current: () => current };
