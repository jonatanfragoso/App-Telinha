// Regra do Firewall do Windows: libera o Telinha só para conexões vindas do Tailscale (100.64.0.0/10).
// O instalador cria a mesma regra (build/installer.nsh); aqui é o botão "Liberar no firewall" para quem recusou.
// Apaga antes as regras de entrada do Telinha.exe, porque um "Cancelar" no aviso do Windows cria regras
// de bloqueio, e bloqueio vence permissão.
const { execFile } = require('child_process');
const { app } = require('electron');

const RULE = 'Telinha-Tailscale';
const supported = () => process.platform === 'win32' && app.isPackaged;

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ err, out: String(stdout || stderr || '') }));
  });
}

// true = regra existe, false = não existe, null = não se aplica (dev, Linux)
async function status() {
  if (!supported()) return null;
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE}`], 5000);
  return !r.err;
}

async function fix() {
  if (!supported()) return { ok: false, message: 'Só funciona na versão instalada no Windows' };
  const exe = process.execPath;
  const cmd = `/c netsh advfirewall firewall delete rule name=all dir=in program="${exe}"`
    + ` & netsh advfirewall firewall add rule name=${RULE} dir=in action=allow program="${exe}" remoteip=100.64.0.0/10 profile=any enable=yes`;
  const ps = `Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '${cmd.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 120000);
  if (await status()) return { ok: true };
  return { ok: false, message: r.err && /cancel/i.test(r.out) ? 'Você não autorizou no aviso do Windows' : 'Não deu certo. Tente pelo passo a passo do site.' };
}

module.exports = { status, fix };
