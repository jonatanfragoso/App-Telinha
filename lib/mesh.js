// Sinalização + eleição de host.
// Todo app roda um pequeno servidor (HTTP /info + WebSocket /ws). Um deles é eleito host
// e repassa as mensagens de sinalização. O vídeo/áudio NÃO passa pelo host: vai direto entre os PCs.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const tailscale = require('./tailscale');

const PORT = 47800;
const TICK_MS = 4000;
const PROBE_TIMEOUT = 1500;
const APP_ID = 'telinha';
const PROTO = 1;

class Mesh extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.id = crypto.randomUUID();
    this.startedAt = Date.now();
    this.isHost = false;
    this.boost = 0; // aumentado quando alguém pede "tornar host"
    this.self = { streaming: null };
    this.server = null;
    this.boundAddr = null;
    this.wss = null;
    this.clients = new Map(); // (host) id -> { ws, info }
    this.hostConn = null; // (cliente) { ws, hostId, ip }
    this.hostInfo = null;
    this.instances = []; // instâncias do app vistas na última varredura
    this.ts = { ok: false, peers: [] };
    this.members = [];
    this.timer = null;
    this.ticking = false;
  }

  settings() { return this.getSettings(); }

  info() {
    const s = this.settings();
    return {
      app: APP_ID, proto: PROTO, id: this.id, name: s.name, room: s.room,
      priority: s.priority + this.boost, startedAt: this.startedAt,
      isHost: this.isHost, hostId: this.isHost ? this.id : this.hostInfo ? this.hostInfo.id : null,
      ip: this.myIp(),
    };
  }

  myIp() { return this.ts.ok && this.ts.self ? this.ts.self.ip : null; }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    if (this.hostConn) this.hostConn.ws.close();
    if (this.server) this.server.close();
  }

  // ---------- servidor local ----------
  ensureServer() {
    const s = this.settings();
    const want = process.env.TELINHA_BIND || (this.myIp() && !(s.extraPeers || []).length ? this.myIp() : '0.0.0.0');
    if (this.server && this.boundAddr === want) return;
    if (this.server) { try { this.server.close(); } catch {} this.wss && this.wss.close(); }

    const server = http.createServer((req, res) => {
      if (req.url === '/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.info()));
      } else { res.writeHead(404); res.end(); }
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    server.on('upgrade', (req, sock, head) => {
      if (req.url !== '/ws') return sock.destroy();
      wss.handleUpgrade(req, sock, head, (ws) => this.onClient(ws));
    });
    server.on('error', (e) => this.emit('log', `Servidor local: ${e.message}`));
    server.listen(PORT, want, () => this.emit('log', `Escutando em ${want}:${PORT}`));
    this.server = server; this.wss = wss; this.boundAddr = want;
  }

  // ---------- varredura + eleição ----------
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const s = this.settings();
      this.ts = await tailscale.status(s.tailscalePath || null);
      this.ensureServer();

      const ips = new Set();
      for (const p of this.ts.peers) if (p.online && p.ip) ips.add(p.ip);
      for (const ip of s.extraPeers || []) if (ip) ips.add(ip.trim());
      ips.delete(this.myIp());

      const probes = await Promise.all([...ips].map((ip) => probe(ip)));
      const me = this.info();
      const others = probes.filter((x) => x && x.app === APP_ID && x.proto === PROTO && x.room === me.room && x.id !== this.id);
      this.instances = [me, ...others];
      this.elect(me, others);
      this.publishState();
    } catch (e) {
      this.emit('log', `Erro na varredura: ${e.message}`);
    } finally {
      this.ticking = false;
    }
  }

  elect(me, others) {
    const all = [me, ...others];
    const hosts = all.filter((x) => x.isHost);
    const bestHost = hosts.sort(rankCmp)[0];
    const best = [...all].sort(rankCmp)[0];

    if (this.isHost) {
      // outro host melhor apareceu -> eu saio
      if (bestHost && bestHost.id !== this.id) return this.stepDown(bestHost);
      return;
    }
    if (!bestHost) {
      if (best.id === this.id) return this.becomeHost();
      return; // espero o melhor candidato se promover
    }
    // existe host. Eu tenho prioridade maior que ele? então assumo (ele sai sozinho)
    if (me.priority > bestHost.priority) return this.becomeHost();
    this.connectTo(bestHost);
  }

  becomeHost() {
    if (this.isHost) return;
    this.emit('log', 'Assumi como host');
    this.dropHostConn();
    this.isHost = true;
    this.hostInfo = this.info();
    this.clients.clear();
    this.broadcastMembers();
    this.publishState();
  }

  stepDown(newHost) {
    this.emit('log', `Passando host para ${newHost.name}`);
    this.isHost = false;
    this.boost = 0;
    for (const [, c] of this.clients) { try { c.ws.close(4002, 'novo host'); } catch {} }
    this.clients.clear();
    this.connectTo(newHost);
  }

  // ---------- lado host ----------
  onClient(ws) {
    if (!this.isHost) return ws.close(4001, 'nao sou host');
    let id = null;
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        if (this.settings().room !== m.info.room) return ws.close(4003, 'sala diferente');
        id = m.info.id;
        const old = this.clients.get(id);
        if (old && old.ws !== ws) try { old.ws.close(); } catch {}
        this.clients.set(id, { ws, info: m.info, self: m.self || { streaming: null } });
        this.broadcastMembers();
        return;
      }
      if (!id) return;
      if (m.type === 'self') { const c = this.clients.get(id); if (c) c.self = m.self; this.broadcastMembers(); return; }
      if (m.type === 'relay') this.route(id, m.to, m.payload);
    });
    ws.on('close', () => {
      if (id && this.clients.get(id) && this.clients.get(id).ws === ws) {
        this.clients.delete(id);
        this.broadcastMembers();
      }
    });
    ws.on('error', () => {});
  }

  route(from, to, payload) {
    const msg = { type: 'relay', from, payload };
    if (to === this.id) return this.deliver(msg);
    const c = this.clients.get(to);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  memberList() {
    const me = this.info();
    const list = [{ ...me, ...this.self, isHost: true }];
    for (const [, c] of this.clients) list.push({ ...c.info, ...c.self, isHost: false });
    return list;
  }

  broadcastMembers() {
    if (!this.isHost) return;
    const members = this.memberList();
    const s = JSON.stringify({ type: 'members', members, hostId: this.id });
    for (const [, c] of this.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
    this.members = members;
    this.publishState();
  }

  // ---------- lado cliente ----------
  connectTo(host) {
    if (this.hostConn && this.hostConn.hostId === host.id) return;
    this.dropHostConn();
    this.emit('log', `Conectando ao host ${host.name} (${host.ip})`);
    const ws = new WebSocket(`ws://${host.ip}:${PORT}/ws`, { handshakeTimeout: 3000 });
    const conn = { ws, hostId: host.id, ip: host.ip, open: false };
    this.hostConn = conn;
    this.hostInfo = host;
    ws.on('open', () => {
      conn.open = true;
      ws.send(JSON.stringify({ type: 'hello', info: this.info(), self: this.self }));
      this.publishState();
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'members') { this.members = m.members; this.publishState(); }
      else if (m.type === 'relay') this.deliver(m);
    });
    ws.on('close', () => {
      if (this.hostConn === conn) {
        this.hostConn = null; this.hostInfo = null; this.members = [];
        this.publishState();
        setTimeout(() => this.tick(), 300); // reeleição rápida
      }
    });
    ws.on('error', () => {});
  }

  dropHostConn() {
    if (!this.hostConn) return;
    const c = this.hostConn; this.hostConn = null;
    try { c.ws.close(); } catch {}
  }

  // ---------- API para a interface ----------
  deliver(m) {
    if (m.payload && m.payload.type === 'promote') {
      this.boost = 1000;
      this.emit('log', 'Pediram para eu ser o host');
      this.tick();
      return;
    }
    this.emit('signal', { from: m.from, ...m.payload });
  }

  send(to, payload) {
    if (this.isHost) return this.route(this.id, to, payload);
    if (this.hostConn && this.hostConn.open) this.hostConn.ws.send(JSON.stringify({ type: 'relay', to, payload }));
  }

  setSelf(self) {
    this.self = { ...this.self, ...self };
    if (this.isHost) this.broadcastMembers();
    else if (this.hostConn && this.hostConn.open) this.hostConn.ws.send(JSON.stringify({ type: 'self', self: this.self }));
  }

  promote(targetId) {
    if (targetId === this.id) { this.boost = 1000; this.tick(); return; }
    this.send(targetId, { type: 'promote' });
  }

  publishState() {
    const connected = this.isHost || !!(this.hostConn && this.hostConn.open);
    const tsPeers = new Map(this.ts.peers.map((p) => [p.ip, p]));
    const members = (connected ? this.members : []).map((m) => {
      const p = tsPeers.get(m.ip);
      return { ...m, direct: m.id === this.id ? true : p ? p.direct : null };
    });
    this.emit('state', {
      selfId: this.id,
      isHost: this.isHost,
      connected,
      host: this.hostInfo ? { id: this.hostInfo.id, name: this.hostInfo.name } : null,
      members,
      tailscale: { ok: this.ts.ok, error: this.ts.error || null, backend: this.ts.backend || null, ip: this.myIp() },
      seen: this.instances.length,
    });
  }
}

function rankCmp(a, b) {
  return b.priority - a.priority || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1);
}

function probe(ip) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port: PORT, path: '/info', timeout: PROBE_TIMEOUT }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 8192) req.destroy(); });
      res.on('end', () => { try { const j = JSON.parse(body); j.ip = ip; resolve(j); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

module.exports = { Mesh, PORT };
