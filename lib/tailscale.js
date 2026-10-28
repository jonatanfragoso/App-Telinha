// Lê a rede do Tailscale localmente (tailscale status --json). Nenhum servidor nosso envolvido.
const { execFile } = require('child_process');
const fs = require('fs');

const CANDIDATES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  'tailscale',
];

let resolved = null;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function status(customPath) {
  const list = customPath ? [customPath] : resolved ? [resolved] : CANDIDATES;
  let lastErr;
  for (const bin of list) {
    if (bin.includes('\\') && !fs.existsSync(bin)) continue;
    try {
      const out = await run(bin, ['status', '--json']);
      resolved = bin;
      return parse(JSON.parse(out));
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : 'Tailscale não encontrado', self: null, peers: [] };
}

const ipv4 = (ips) => (ips || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null;

function parse(j) {
  const self = j.Self
    ? { host: j.Self.HostName, dns: j.Self.DNSName, ip: ipv4(j.Self.TailscaleIPs), online: true }
    : null;
  const peers = Object.values(j.Peer || {}).map((p) => ({
    host: p.HostName,
    dns: p.DNSName,
    ip: ipv4(p.TailscaleIPs),
    online: !!p.Online,
    os: p.OS,
    direct: !!p.CurAddr, // CurAddr vazio = passando por relay DERP
    relay: p.Relay || '',
  }));
  const running = j.BackendState === 'Running';
  const tailnet = j.CurrentTailnet && j.CurrentTailnet.Name ? String(j.CurrentTailnet.Name) : null;
  return { ok: running && !!(self && self.ip), backend: j.BackendState, self, peers, tailnet };
}

// Redes (tailnets) em que este PC já entrou: `tailscale switch --list`.
//   ID    Tailnet                   Account
//   a0c5  fulano@gmail.com          fulano@gmail.com*     <- * = a rede em uso
async function networks(customPath) {
  const bin = customPath || resolved;
  if (!bin) return [];
  try {
    const out = await run(bin, ['switch', '--list']);
    return out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 3 && /^[0-9a-f]+$/i.test(c[0]))
      .map(([id, tailnet, account]) => ({ id, tailnet, account: account.replace(/\*$/, ''), active: account.endsWith('*') }));
  } catch { return []; }
}

// troca a rede em uso; só aceita um ID que esteja na lista
async function switchTo(id, customPath) {
  const list = await networks(customPath);
  if (!list.some((n) => n.id === id)) throw new Error('Rede não encontrada');
  await run(customPath || resolved, ['switch', id]);
}

module.exports = { status, networks, switchTo };
