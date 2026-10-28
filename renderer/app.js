/* Telinha — interface e WebRTC */
const T = window.telinha;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let settings = {};
let state = { members: [], connected: false };
let logs = [];

// transmissão própria
let my = null; // { stream, title, cfg, audioInfo }
const outPcs = new Map(); // viewerId -> { pc, stats }
// assistindo
const inPcs = new Map(); // streamerId -> { pc, tile, video, pendingIce, statsTimer }

// ---------------------------------------------------------------- utilidades
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), ms);
}
function log(l) {
  logs.push(`${new Date().toLocaleTimeString()}  ${l}`);
  if (logs.length > 200) logs.shift();
  const b = $('#logBox'); if (b) b.textContent = logs.join('\n');
}
function colorFor(id) {
  let h = 0; for (const c of id || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
const memberName = (id) => (state.members.find((m) => m.id === id) || {}).name || 'alguém';

// ---------------------------------------------------------------- SDP
function mungeSdp(sdp, mbps) {
  const lines = sdp.split('\r\n');
  const ptsByCodec = {};
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(l);
    if (m) (ptsByCodec[m[2].toUpperCase()] ||= []).push(m[1]);
  }
  const kbps = Math.round(mbps * 1000);
  const videoExtra = `x-google-start-bitrate=${Math.round(kbps * 0.75)};x-google-min-bitrate=${Math.min(1500, kbps)};x-google-max-bitrate=${kbps}`;
  const opusExtra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=192000;usedtx=0;cbr=0';
  const want = {};
  for (const pt of ptsByCodec.OPUS || []) want[pt] = opusExtra;
  for (const c of ['H264', 'VP8', 'VP9', 'AV1']) for (const pt of ptsByCodec[c] || []) want[pt] = videoExtra;

  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && want[f[1]]) {
      seen.add(f[1]);
      const params = f[2].split(';').filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx|cbr|x-google-[\w-]+)=/.test(p.trim()));
      out.push(`a=fmtp:${f[1]} ${[...params, want[f[1]]].join(';')}`);
      continue;
    }
    out.push(l);
    const r = /^a=rtpmap:(\d+) /.exec(l);
    if (r && want[r[1]] && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) out.push(`a=fmtp:${r[1]} ${want[r[1]]}`);
  }
  return out.join('\r\n');
}

function preferCodec(transceiver, codec) {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const mime = `video/${codec}`.toLowerCase();
  const chosen = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime);
  if (!chosen.length) { toast(`Codec ${codec} não suportado aqui, usando o padrão`); return; }
  if (codec === 'H264') {
    // perfil High e packetization-mode=1 primeiro (melhor qualidade, encode por hardware)
    const score = (c) => (/packetization-mode=1/.test(c.sdpFmtpLine) ? 2 : 0) + (/profile-level-id=64/.test(c.sdpFmtpLine) ? 1 : 0);
    chosen.sort((a, b) => score(b) - score(a));
  }
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== mime);
  try { transceiver.setCodecPreferences([...chosen, ...rest]); } catch (e) { log(`setCodecPreferences: ${e.message}`); }
}

async function applyEncoding(pc, cfg) {
  for (const s of pc.getSenders()) {
    if (!s.track) continue;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (s.track.kind === 'video') {
      p.encodings[0].maxBitrate = cfg.bitrate * 1_000_000;
      p.encodings[0].maxFramerate = cfg.fps;
      p.encodings[0].scaleResolutionDownBy = 1;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      p.degradationPreference = cfg.pref;
    } else {
      p.encodings[0].maxBitrate = 192_000;
      p.encodings[0].priority = 'high';
    }
    try { await s.setParameters(p); } catch (e) { log(`setParameters(${s.track.kind}): ${e.message}`); }
  }
}

// ---------------------------------------------------------------- sinalização
T.onSignal(async (m) => {
  try {
    switch (m.type) {
      case 'watch': return onWatchRequest(m.from);
      case 'unwatch': return closeOut(m.from);
      case 'offer': return onOffer(m);
      case 'answer': return onAnswer(m);
      case 'ice': return onIce(m);
      case 'ended': return onEnded(m.from);
      case 'nostream': return setTileOverlay(m.from, 'Essa pessoa não está mais transmitindo.');
    }
  } catch (e) { log(`sinal ${m.type}: ${e.message}`); }
});

// ----- lado de quem transmite
async function onWatchRequest(viewerId) {
  if (!my) return T.send(viewerId, { type: 'nostream' });
  closeOut(viewerId);
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const entry = { pc, stats: {}, last: null };
  outPcs.set(viewerId, entry);
  pc.onicecandidate = (e) => { if (e.candidate) T.send(viewerId, { type: 'ice', dir: 'toViewer', c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closeOut(viewerId);
    renderMyViewers();
  };
  const vt = my.stream.getVideoTracks()[0];
  const tv = pc.addTransceiver(vt, { direction: 'sendonly', streams: [my.stream] });
  preferCodec(tv, my.cfg.codec);
  const at = my.stream.getAudioTracks()[0];
  if (at) pc.addTransceiver(at, { direction: 'sendonly', streams: [my.stream] });

  const offer = await pc.createOffer();
  offer.sdp = mungeSdp(offer.sdp, my.cfg.bitrate);
  await pc.setLocalDescription(offer);
  await applyEncoding(pc, my.cfg);
  T.send(viewerId, { type: 'offer', sdp: offer.sdp, bitrate: my.cfg.bitrate, title: my.title, w: my.size.w, h: my.size.h });
  renderMyViewers();
}

async function onAnswer(m) {
  const o = outPcs.get(m.from); if (!o) return;
  await o.pc.setRemoteDescription({ type: 'answer', sdp: mungeSdp(m.sdp, my ? my.cfg.bitrate : 8) });
  if (my) await applyEncoding(o.pc, my.cfg);
}

function closeOut(viewerId) {
  const o = outPcs.get(viewerId); if (!o) return;
  outPcs.delete(viewerId);
  try { o.pc.close(); } catch {}
  renderMyViewers();
}

// ----- lado de quem assiste
async function onOffer(m) {
  const w = inPcs.get(m.from) || openTile(m.from);
  if (w.pc) try { w.pc.close(); } catch {}
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  w.pc = pc; w.pendingIce = []; w.title = m.title;
  w.tile.querySelector('.t').textContent = `${memberName(m.from)} — ${m.title || ''}`;
  pc.onicecandidate = (e) => { if (e.candidate) T.send(m.from, { type: 'ice', dir: 'toStreamer', c: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    try { e.receiver.jitterBufferTarget = 0; } catch {}
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (w.video.srcObject !== stream) w.video.srcObject = stream;
    w.video.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') setTileOverlay(m.from, null);
    else if (st === 'connecting') setTileOverlay(m.from, 'Conectando…', true);
    else if (st === 'failed') setTileOverlay(m.from, 'Não deu pra conectar direto.<br>Confira se os dois estão no Tailscale.', false, true);
    else if (st === 'disconnected') setTileOverlay(m.from, 'Conexão instável…', true);
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
  for (const c of w.pendingIce) await pc.addIceCandidate(c).catch(() => {});
  w.pendingIce = [];
  const ans = await pc.createAnswer();
  ans.sdp = mungeSdp(ans.sdp, m.bitrate || 8);
  await pc.setLocalDescription(ans);
  T.send(m.from, { type: 'answer', sdp: ans.sdp });
  startInStats(m.from);
}

async function onIce(m) {
  if (m.dir === 'toViewer') {
    const w = inPcs.get(m.from); if (!w || !w.pc) return;
    if (!w.pc.remoteDescription) w.pendingIce.push(m.c);
    else await w.pc.addIceCandidate(m.c).catch(() => {});
  } else {
    const o = outPcs.get(m.from); if (!o) return;
    await o.pc.addIceCandidate(m.c).catch(() => {});
  }
}

function onEnded(streamerId) {
  const w = inPcs.get(streamerId); if (!w) return;
  if (w.pc) try { w.pc.close(); } catch {}
  w.pc = null;
  w.video.srcObject = null;
  setTileOverlay(streamerId, 'A transmissão terminou.', false, false, true);
}

function watch(streamerId) {
  const w = inPcs.get(streamerId) || openTile(streamerId);
  setTileOverlay(streamerId, 'Pedindo a transmissão…', true);
  T.send(streamerId, { type: 'watch' });
  w.tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function stopWatching(streamerId) {
  const w = inPcs.get(streamerId); if (!w) return;
  T.send(streamerId, { type: 'unwatch' });
  if (w.pc) try { w.pc.close(); } catch {}
  clearInterval(w.statsTimer);
  w.tile.remove();
  inPcs.delete(streamerId);
  renderLive();
}

// ---------------------------------------------------------------- tiles
function openTile(streamerId) {
  const tile = el('div', 'tile');
  tile.innerHTML = `
    <div class="tile-head">
      <span class="avatar" style="width:22px;height:22px;font-size:11px;background:${colorFor(streamerId)}">${esc(memberName(streamerId)[0] || '?').toUpperCase()}</span>
      <span class="t">${esc(memberName(streamerId))}</span>
      <span title="Volume">🔊</span><input type="range" min="0" max="100" value="100" class="vol" />
      <button class="btn ghost small" data-a="stats" title="Estatísticas">ⓘ</button>
      <button class="btn ghost small" data-a="full" title="Tela cheia (ou clique duplo)">⛶</button>
      <button class="btn ghost small" data-a="close" title="Parar de assistir">✕</button>
    </div>
    <div class="tile-body">
      <video autoplay playsinline></video>
      <div class="stats hidden"></div>
      <div class="overlay"></div>
    </div>`;
  const video = tile.querySelector('video');
  const body = tile.querySelector('.tile-body');
  tile.querySelector('.vol').oninput = (e) => { video.volume = e.target.value / 100; };
  tile.querySelector('[data-a=close]').onclick = () => stopWatching(streamerId);
  tile.querySelector('[data-a=full]').onclick = () => body.requestFullscreen();
  tile.querySelector('[data-a=stats]').onclick = () => tile.querySelector('.stats').classList.toggle('hidden');
  body.ondblclick = () => (document.fullscreenElement ? document.exitFullscreen() : body.requestFullscreen());
  $('#watchArea').append(tile);
  const w = { pc: null, tile, video, pendingIce: [], statsTimer: null };
  inPcs.set(streamerId, w);
  renderLive();
  return w;
}

function setTileOverlay(streamerId, html, spin = false, retry = false, ended = false) {
  const w = inPcs.get(streamerId); if (!w) return;
  const ov = w.tile.querySelector('.overlay');
  if (!html) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  ov.innerHTML = `<div>${spin ? '<div class="spinner"></div>' : ''}${html}${retry || ended ? '<div style="margin-top:12px"></div>' : ''}</div>`;
  if (retry || ended) {
    const box = ov.querySelector('div > div:last-child');
    const b = el('button', 'btn small', retry ? 'Tentar de novo' : 'Fechar');
    b.onclick = () => (retry ? watch(streamerId) : stopWatching(streamerId));
    box.append(b);
  }
}

function startInStats(streamerId) {
  const w = inPcs.get(streamerId); if (!w) return;
  clearInterval(w.statsTimer);
  let prev = null;
  w.statsTimer = setInterval(async () => {
    if (!w.pc) return;
    const r = await w.pc.getStats().catch(() => null); if (!r) return;
    let v = null, a = null, pair = null; const codecs = {};
    r.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') v = s;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') a = s;
      if (s.type === 'codec') codecs[s.id] = s;
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
    });
    if (!v) return;
    const now = performance.now();
    const kbps = prev ? ((v.bytesReceived - prev.bytes) * 8) / (now - prev.t) : 0;
    const lost = prev ? v.packetsLost - prev.lost : 0;
    prev = { bytes: v.bytesReceived, t: now, lost: v.packetsLost };
    const codec = codecs[v.codecId] ? codecs[v.codecId].mimeType.replace('video/', '') : '?';
    const rtt = pair && pair.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : '—';
    w.tile.querySelector('.stats').textContent =
      `${v.frameWidth || 0}×${v.frameHeight || 0} @ ${Math.round(v.framesPerSecond || 0)} fps\n` +
      `${(kbps / 1000).toFixed(1)} Mbps  ${codec}${v.decoderImplementation ? ' · ' + v.decoderImplementation : ''}\n` +
      `ping ${rtt}  perdas ${lost}/s  quadros perdidos ${v.framesDropped || 0}\n` +
      `áudio ${a ? (a.bytesReceived > 0 ? 'ok' : 'sem dados') : 'nenhum'}`;
  }, 1000);
}

// ---------------------------------------------------------------- opções de qualidade
const RES_OPTS = [
  ['640x360', '360p'], ['854x480', '480p'], ['1280x720', '720p'], ['1600x900', '900p'],
  ['1920x1080', '1080p (Full HD)'], ['2560x1440', '1440p (2K)'], ['3440x1440', '3440×1440 (ultrawide)'],
  ['3840x2160', '2160p (4K)'], ['7680x4320', 'Original (sem limite)'],
];
const FPS_OPTS = [15, 24, 30, 45, 60, 90, 120, 144];
const BITRATE_OPTS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 50];
function fillQualitySelects() {
  document.querySelectorAll('.q-res').forEach((s) => { s.innerHTML = RES_OPTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); });
  document.querySelectorAll('.q-fps').forEach((s) => { s.innerHTML = FPS_OPTS.map((f) => `<option value="${f}">${f} fps</option>`).join(''); });
  document.querySelectorAll('.q-bitrate').forEach((s) => { s.innerHTML = BITRATE_OPTS.map((b) => `<option value="${b}">${String(b).replace('.', ',')} Mbps</option>`).join(''); });
}
const QKEY = 'telinha.quality';
function loadQuality() {
  let q = null;
  try { q = JSON.parse(localStorage.getItem(QKEY)); } catch {}
  q = q || { preset: '1920x1080|60|10', res: '1920x1080', fps: 60, bitrate: 10, codec: 'H264', pref: 'maintain-framerate' };
  $('#qPreset').value = q.preset || '';
  $('#qRes').value = q.res; $('#qFps').value = String(q.fps); $('#qBitrate').value = String(q.bitrate);
  $('#qCodec').value = q.codec; $('#qPref').value = q.pref;
}
function saveQuality() {
  try {
    localStorage.setItem(QKEY, JSON.stringify({
      preset: $('#qPreset').value, res: $('#qRes').value, fps: Number($('#qFps').value),
      bitrate: Number($('#qBitrate').value), codec: $('#qCodec').value, pref: $('#qPref').value,
    }));
  } catch {}
}
function applyPreset() {
  const v = $('#qPreset').value; if (!v) return;
  const [res, fps, br] = v.split('|');
  $('#qRes').value = res; $('#qFps').value = fps; $('#qBitrate').value = br;
  updateUploadHint(); saveQuality();
}
function onManualQuality() {
  $('#qPreset').value = '';
  updateUploadHint(); saveQuality();
}
// sugestão de bitrate para H.264 (VP9/AV1 rendem melhor com menos)
function suggestBitrate(res, fps) {
  const [w, h] = res.split('x').map(Number);
  const mpx = Math.min(w * h, 3840 * 2160) / 1e6;
  return Math.max(1, +(mpx * fps * 0.08).toFixed(1));
}

// ---------------------------------------------------------------- minha transmissão
let pickSel = null;
let pickTab = 'screen';
let pickSources = [];

async function openPicker() {
  $('#pickModal').classList.remove('hidden');
  pickSel = null; $('#btnGoLive').disabled = true;
  updateUploadHint();
  await loadSources();
}
async function loadSources() {
  $('#sourceGrid').innerHTML = '<div class="muted small">Carregando…</div>';
  pickSources = await T.sources();
  renderSources();
}
function renderSources() {
  const g = $('#sourceGrid'); g.innerHTML = '';
  const list = pickSources.filter((s) => s.kind === pickTab);
  if (!list.length) g.innerHTML = '<div class="muted small">Nada encontrado.</div>';
  for (const s of list) {
    const c = el('div', 'src' + (pickSel && pickSel.id === s.id ? ' sel' : ''));
    c.innerHTML = `<div class="thumb" style="background-image:url('${s.thumb || ''}')"></div>
      <div class="lbl">${s.icon ? `<img src="${s.icon}">` : ''}<span title="${esc(s.name)}">${esc(s.name)}</span></div>`;
    c.onclick = () => selectSource(s);
    g.append(c);
  }
}
async function selectSource(s) {
  pickSel = s; renderSources();
  $('#btnGoLive').disabled = false;
  await buildAudioOptions();
}

async function buildAudioOptions() {
  const sel = $('#audioMode'); sel.innerHTML = '';
  const add = (v, t) => { const o = el('option', null, esc(t)); o.value = v; sel.append(o); };
  let winApp = null;
  if (pickSel && pickSel.kind === 'window') {
    winApp = await T.pidForSource(pickSel.id);
    if (winApp && winApp.pid) add('window', `Só o som desta janela (${winApp.name})`);
  }
  add('nodiscord', 'Som do sistema, sem o Discord');
  add('pick', 'Escolher um app específico…');
  add('none', 'Sem áudio');
  sel.dataset.winPid = winApp && winApp.pid ? winApp.pid : '';
  sel.dataset.winName = winApp && winApp.name ? winApp.name : '';
  sel.onchange = onAudioModeChange;
  onAudioModeChange();
}

async function onAudioModeChange() {
  const mode = $('#audioMode').value;
  const appSel = $('#audioApp');
  const hint = $('#audioHint');
  appSel.classList.toggle('hidden', mode !== 'pick');
  hint.textContent = {
    window: /chrome|msedge|firefox|opera|brave/i.test($('#audioMode').dataset.winName)
      ? 'É um navegador: vai o som de todas as abas dele. Use outro navegador para o resto, se precisar.'
      : 'As vozes do Discord não vão junto.',
    nodiscord: 'Tudo que toca no seu PC, menos o Discord.',
    pick: 'Só o som do app escolhido (precisa estar tocando ou ter tocado algo).',
    none: '',
  }[mode] || '';
  if (mode === 'pick') {
    appSel.innerHTML = '<option>Carregando…</option>';
    const list = (await T.audioSessions()).filter((s) => !/^discord/i.test(s.name) && !/^telinha/i.test(s.name));
    appSel.innerHTML = '';
    if (!list.length) appSel.innerHTML = '<option value="">Nenhum app com áudio agora</option>';
    for (const s of list) {
      const o = el('option', null, esc(`${s.name}${s.active ? '  ● tocando' : ''}`));
      o.value = s.pid; appSel.append(o);
    }
  }
}

function updateUploadHint() {
  const mbps = Number($('#qBitrate').value) + 0.2;
  const viewers = Math.max(1, state.members.length - 1);
  const sug = suggestBitrate($('#qRes').value, Number($('#qFps').value));
  const low = Number($('#qBitrate').value) < sug * 0.6;
  $('#uploadHint').innerHTML = `Upload aproximado: ${mbps.toFixed(1)} Mbps por pessoa assistindo · ${viewers} na sala agora ≈ ${(mbps * viewers).toFixed(0)} Mbps se todos assistirem.` +
    (low ? `<br><span style="color:var(--warn)">Bitrate baixo para essa resolução/fps (sugestão: ~${String(sug).replace('.', ',')} Mbps). Vai ficar borrado em cenas com movimento.</span>` : '');
}

// áudio: PCM do audiocap -> AudioWorklet -> MediaStreamTrack
let actx = null, worklet = null, adest = null, pcmLeft = null, pcmOff = null, audioStatusOff = null;
async function startAudioPipe(opts) {
  if (!actx) {
    actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await actx.audioWorklet.addModule('pcm-worklet.js');
  }
  await actx.resume();
  worklet = new AudioWorkletNode(actx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  adest = actx.createMediaStreamDestination();
  adest.channelCount = 2;
  worklet.connect(adest);
  pcmLeft = null;
  pcmOff = T.onPcm((u8) => {
    let bytes = u8;
    if (pcmLeft) { const m = new Uint8Array(pcmLeft.length + u8.length); m.set(pcmLeft); m.set(u8, pcmLeft.length); bytes = m; pcmLeft = null; }
    const usable = bytes.length - (bytes.length % 4);
    if (usable < bytes.length) pcmLeft = bytes.slice(usable);
    if (!usable) return;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable);
    worklet.port.postMessage(buf, [buf]);
  });
  audioStatusOff = T.onAudioStatus((st) => {
    if (!st.ok) { toast(`Áudio: ${st.error}`, 7000); log(`áudio: ${st.error}`); if (my) { my.audioInfo = 'Áudio falhou: ' + st.error; renderMyLive(); } }
    else if (st.info) { log(st.info); if (my) { my.audioInfo = st.info; renderMyLive(); } }
  });
  await T.audioStart(opts);
  return adest.stream.getAudioTracks()[0];
}
function stopAudioPipe() {
  T.audioStop();
  if (pcmOff) pcmOff(); pcmOff = null;
  if (audioStatusOff) audioStatusOff(); audioStatusOff = null;
  if (worklet) { worklet.disconnect(); worklet = null; }
  adest = null;
}

async function goLive() {
  if (!pickSel) return;
  const [w, h] = $('#qRes').value.split('x').map(Number);
  const cfg = {
    fps: Number($('#qFps').value), bitrate: Number($('#qBitrate').value),
    codec: $('#qCodec').value, pref: $('#qPref').value, w, h,
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: pickSel.id, maxWidth: w, maxHeight: h, maxFrameRate: cfg.fps, minFrameRate: Math.min(30, cfg.fps) } },
    });
  } catch (e) {
    return toast(`Não consegui capturar: ${e.message}`, 6000);
  }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = cfg.pref === 'maintain-resolution' ? 'detail' : 'motion';
  vt.onended = () => stopLive();

  const mode = $('#audioMode').value;
  let audioInfo = 'Sem áudio';
  if (mode !== 'none') {
    let opts = null;
    if (mode === 'window') { opts = { mode: 'app', pid: Number($('#audioMode').dataset.winPid) }; audioInfo = `Áudio: só ${$('#audioMode').dataset.winName}`; }
    else if (mode === 'pick' && $('#audioApp').value) { opts = { mode: 'app', pid: Number($('#audioApp').value) }; audioInfo = `Áudio: só ${$('#audioApp').selectedOptions[0].textContent.replace(/\s+●.*/, '')}`; }
    else if (mode === 'nodiscord') { opts = { mode: 'nodiscord' }; audioInfo = 'Áudio: sistema sem o Discord'; }
    if (opts) stream.addTrack(await startAudioPipe(opts));
  }

  const s = vt.getSettings();
  my = { stream, title: pickSel.name, cfg, audioInfo, size: { w: s.width || w, h: s.height || h } };
  $('#pickModal').classList.add('hidden');
  saveQuality();
  $('#liveRes').value = $('#qRes').value;
  $('#liveFps').value = String(cfg.fps);
  $('#liveBitrate').value = String(cfg.bitrate);
  $('#livePref').value = cfg.pref;
  T.setSelf({ streaming: { title: my.title, w: my.size.w, h: my.size.h, fps: cfg.fps } });
  renderMyLive();
  renderLive();
}

function stopLive() {
  if (!my) return;
  for (const id of [...outPcs.keys()]) { T.send(id, { type: 'ended' }); closeOut(id); }
  my.stream.getTracks().forEach((t) => t.stop());
  stopAudioPipe();
  my = null;
  T.setSelf({ streaming: null });
  renderMyLive();
  renderLive();
}

function renderMyLive() {
  const box = $('#myLive');
  box.classList.toggle('hidden', !my);
  $('#btnStream').classList.toggle('hidden', !!my);
  if (!my) { $('#myPreview').srcObject = null; return; }
  const pv = $('#myPreview');
  if (pv.srcObject !== my.stream) pv.srcObject = my.stream;
  $('#myTitle').textContent = my.title;
  $('#myAudioInfo').textContent = `${my.size.w}×${my.size.h} · ${my.cfg.fps} fps · ${my.cfg.codec} · ${my.audioInfo}`;
  renderMyViewers();
}

function renderMyViewers() {
  const box = $('#myViewers'); if (!box) return;
  if (!my) { box.innerHTML = ''; return; }
  if (!outPcs.size) { box.innerHTML = '<span class="muted small">Ninguém assistindo ainda.</span>'; return; }
  box.innerHTML = '';
  for (const [id, o] of outPcs) {
    const d = el('div', 'vstat');
    const s = o.stats;
    d.innerHTML = `<b>${esc(memberName(id))}</b> ${o.pc.connectionState === 'connected'
      ? `${s.fps ?? '–'} fps · ${s.mbps ?? '–'} Mbps · ${s.res ?? ''}${s.enc ? ' · ' + esc(s.enc) : ''}${s.lim && s.lim !== 'none' ? ` <span class="lim">limitado: ${s.lim === 'cpu' ? 'CPU' : s.lim === 'bandwidth' ? 'banda' : s.lim}</span>` : ''}`
      : `<span class="muted">${o.pc.connectionState}</span>`}`;
    box.append(d);
  }
}

setInterval(async () => {
  if (!my) return;
  for (const [, o] of outPcs) {
    const r = await o.pc.getStats().catch(() => null); if (!r) continue;
    let v = null;
    r.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') v = s; });
    if (!v) continue;
    const now = performance.now();
    const mbps = o.last ? ((v.bytesSent - o.last.b) * 8) / ((now - o.last.t) * 1000) : 0;
    o.last = { b: v.bytesSent, t: now };
    o.stats = {
      fps: Math.round(v.framesPerSecond || 0), mbps: mbps.toFixed(1),
      res: v.frameWidth ? `${v.frameWidth}×${v.frameHeight}` : '',
      enc: v.encoderImplementation ? (v.powerEfficientEncoder ? 'GPU' : 'CPU') : '',
      lim: v.qualityLimitationReason,
    };
  }
  renderMyViewers();
}, 1000);

async function liveTune() {
  if (!my) return;
  const vt = my.stream.getVideoTracks()[0];
  const [w, h] = $('#liveRes').value.split('x').map(Number);
  const fps = Number($('#liveFps').value);
  if (w !== my.cfg.w || h !== my.cfg.h || fps !== my.cfg.fps) {
    try {
      // trocar resolução/fps sem reiniciar a captura
      await vt.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: fps } });
      my.cfg.w = w; my.cfg.h = h; my.cfg.fps = fps;
      const s = vt.getSettings();
      my.size = { w: s.width || w, h: s.height || h };
    } catch (e) {
      toast(`Não deu pra mudar resolução/fps ao vivo: ${e.message}. Pare e comece de novo.`, 6000);
      $('#liveRes').value = `${my.cfg.w}x${my.cfg.h}`; $('#liveFps').value = String(my.cfg.fps);
    }
  }
  my.cfg.bitrate = Number($('#liveBitrate').value);
  my.cfg.pref = $('#livePref').value;
  vt.contentHint = my.cfg.pref === 'maintain-resolution' ? 'detail' : 'motion';
  for (const [, o] of outPcs) await applyEncoding(o.pc, my.cfg);
  T.setSelf({ streaming: { title: my.title, w: my.size.w, h: my.size.h, fps: my.cfg.fps } });
  renderMyLive();
  toast('Qualidade atualizada');
}

// ---------------------------------------------------------------- estado da rede
T.onState((s) => {
  const prevIds = new Set(state.members.map((m) => m.id));
  state = s;
  renderNet(); renderMembers(); renderLive();
  if (!$('#pickModal').classList.contains('hidden')) updateUploadHint();
  // nomes nas tiles podem ter chegado depois
  for (const [id, w] of inPcs) {
    const t = w.tile.querySelector('.t');
    if (t && !prevIds.has(id)) t.textContent = `${memberName(id)}${w.title ? ' — ' + w.title : ''}`;
  }
});
T.onLog(log);

function renderNet() {
  const n = $('#netStatus'), dot = n.querySelector('.dot'), txt = n.querySelector('.txt');
  dot.className = 'dot';
  if (!state.tailscale || !state.tailscale.ok) {
    if ((settings.extraPeers || []).length && state.connected) {
      dot.classList.add('ok'); txt.textContent = state.isHost ? 'Você é o host (rede local)' : `Host: ${state.host ? state.host.name : '?'}`;
    } else {
      dot.classList.add('bad');
      txt.textContent = state.tailscale && state.tailscale.backend && state.tailscale.backend !== 'Running'
        ? `Tailscale: ${state.tailscale.backend}` : 'Tailscale não encontrado ou desligado';
    }
  } else if (!state.connected) {
    txt.textContent = 'Procurando a galera…';
  } else {
    dot.classList.add('ok');
    txt.textContent = state.isHost ? 'Você é o host' : `Host: ${state.host ? state.host.name : '?'}`;
  }
  $('#roomName').textContent = settings.room || '';
}

function renderMembers() {
  const ul = $('#members'); ul.innerHTML = '';
  const list = [...state.members].sort((a, b) => (b.isHost - a.isHost) || a.name.localeCompare(b.name));
  for (const m of list) {
    const li = el('li', 'member');
    const me = m.id === state.selfId;
    const conn = me ? 'você' : m.direct === false ? '<span style="color:var(--warn)">via relay (lento)</span>' : m.direct ? 'conexão direta' : '';
    li.innerHTML = `
      <span class="avatar" style="background:${colorFor(m.id)}">${esc((m.name || '?')[0].toUpperCase())}</span>
      <div class="meta">
        <div class="nm">${esc(m.name)}${m.isHost ? '<span class="crown" title="Host">♛</span>' : ''}${m.streaming ? '<span class="tag-live">AO VIVO</span>' : ''}</div>
        <div class="sub">${conn}</div>
      </div>`;
    if (!m.isHost) {
      const b = el('button', 'btn ghost small act', 'Tornar host');
      b.title = 'Passar o papel de host para esta pessoa';
      b.onclick = () => { T.promote(m.id); toast(`Pedindo para ${m.name} virar host…`); };
      li.append(b);
    }
    ul.append(li);
  }
  const hint = $('#sideHint');
  if (!state.tailscale || !state.tailscale.ok) {
    hint.innerHTML = 'Instale e entre no <b>Tailscale</b> com a mesma rede dos seus amigos. Depois é só deixar o Telinha aberto.';
  } else if (state.members.length <= 1) {
    hint.innerHTML = `Ninguém mais por aqui. Seus amigos precisam estar na mesma tailnet, com o Telinha aberto e na sala <code>${esc(settings.room)}</code>.`;
  } else hint.innerHTML = '';
}

function renderLive() {
  const box = $('#liveList'); box.innerHTML = '';
  const live = state.members.filter((m) => m.streaming && m.id !== state.selfId);
  if (!live.length) { box.innerHTML = '<div class="empty">Ninguém transmitindo agora. Clique em <b>Transmitir</b> pra começar.</div>'; return; }
  for (const m of live) {
    const c = el('div', 'live-card');
    const watching = inPcs.has(m.id);
    c.innerHTML = `
      <span class="avatar" style="background:${colorFor(m.id)}">${esc(m.name[0].toUpperCase())}</span>
      <div class="meta"><div class="t">${esc(m.name)}</div>
      <div class="s" title="${esc(m.streaming.title)}">${esc(m.streaming.title)} · ${m.streaming.h || ''}p${m.streaming.fps || ''}</div></div>`;
    const b = el('button', 'btn ' + (watching ? 'ghost' : 'primary') + ' small', watching ? 'Assistindo' : 'Assistir');
    b.disabled = watching;
    b.onclick = () => watch(m.id);
    c.append(b);
    box.append(c);
  }
}

// ---------------------------------------------------------------- configurações
async function openSettings() {
  $('#sName').value = settings.name || '';
  $('#sRoom').value = settings.room || '';
  const pr = Number(settings.priority) || 0;
  $('#sPriority').value = pr >= 10 ? '10' : pr <= -10 ? '-10' : '0';
  $('#sExtra').value = (settings.extraPeers || []).join('\n');
  $('#sTsPath').value = settings.tailscalePath || '';
  $('#logBox').textContent = logs.join('\n');
  $('#setModal').classList.remove('hidden');
}
async function saveSettings() {
  const patch = {
    name: $('#sName').value.trim() || settings.name,
    room: $('#sRoom').value.trim().toLowerCase() || 'geral',
    priority: Number($('#sPriority').value),
    extraPeers: $('#sExtra').value.split(/\s+/).map((x) => x.trim()).filter(Boolean),
    tailscalePath: $('#sTsPath').value.trim(),
  };
  settings = await T.setSettings(patch);
  $('#setModal').classList.add('hidden');
  renderNet();
  toast('Salvo');
}

// ---------------------------------------------------------------- eventos
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('.modal').classList.add('hidden')));
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  pickTab = t.dataset.tab; renderSources();
}));
$('#btnStream').onclick = openPicker;
$('#btnReloadSources').onclick = loadSources;
$('#btnGoLive').onclick = goLive;
$('#btnStop').onclick = stopLive;
$('#btnSettings').onclick = openSettings;
$('#btnSaveSettings').onclick = saveSettings;
fillQualitySelects();
loadQuality();
$('#qPreset').onchange = applyPreset;
['#qRes', '#qFps', '#qBitrate'].forEach((s) => ($(s).onchange = onManualQuality));
['#qCodec', '#qPref'].forEach((s) => ($(s).onchange = saveQuality));
['#liveRes', '#liveFps', '#liveBitrate', '#livePref'].forEach((s) => ($(s).onchange = liveTune));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden')); });

// ---------------------------------------------------------------- atualização
function renderUpdate(u) {
  if (!u) return;
  const txt = {
    idle: '—', dev: u.message, portable: u.message,
    checking: 'Procurando atualização…',
    latest: `Você está na versão mais recente (${u.version}).`,
    downloading: `Baixando a versão ${u.version}… ${u.percent || 0}%`,
    ready: `Versão ${u.version} pronta. Clique em "Atualizar" no topo.`,
    error: `Não consegui verificar: ${u.message}`,
  }[u.state] || '';
  $('#updText').textContent = txt;
  const b = $('#btnUpdate');
  b.classList.toggle('hidden', u.state !== 'ready');
  if (u.state === 'ready') { b.textContent = `Atualizar para ${u.version}`; if (!renderUpdate.told) { renderUpdate.told = true; toast(`Nova versão ${u.version} baixada. Clique em "Atualizar" quando quiser.`, 6000); } }
}
T.onUpdate(renderUpdate);
$('#btnUpdCheck').onclick = async () => renderUpdate(await T.updateCheck());
$('#btnUpdate').onclick = () => {
  if (my && !confirm('Você está transmitindo. Atualizar agora encerra a transmissão. Continuar?')) return;
  if (my) stopLive();
  T.updateInstall();
};

(async () => {
  renderUpdate(await T.updateStatus());
  settings = await T.getSettings();
  const p = await T.platform();
  $('#appVersion').textContent = `Telinha ${p.version}`;
  renderNet(); renderMembers(); renderLive();
})();
