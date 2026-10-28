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
      case 'chat': return onChat(m);
      case 'askstream': return onAskStream(m.from);
      case 'askreply': return onAskReply(m);
    }
  } catch (e) { log(`sinal ${m.type}: ${e.message}`); }
});

// ----- lado de quem transmite
async function onWatchRequest(viewerId) {
  if (!my) return T.send(viewerId, { type: 'nostream' });
  closeOut(viewerId);
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const entry = { pc, stats: {}, last: null, announced: false };
  outPcs.set(viewerId, entry);
  pc.onicecandidate = (e) => { if (e.candidate) T.send(viewerId, { type: 'ice', dir: 'toViewer', c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closeOut(viewerId);
    if (pc.connectionState === 'connected' && !entry.announced) {
      entry.announced = true;
      toast(`${memberName(viewerId)} começou a assistir sua transmissão.`);
      log(`${memberName(viewerId)} começou a assistir`);
    }
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
  w.pc = pc; w.pendingIce = []; w.title = str(m.title, 200);
  w.tile.querySelector('.t').textContent = `${memberName(m.from)} — ${w.title}`;
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
  ans.sdp = mungeSdp(ans.sdp, Math.min(50, Math.max(1, Number(m.bitrate) || 8)));
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
// Os dados dos membros vêm de outros PCs: só aceita os campos e tipos esperados.
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
function cleanMember(m) {
  return {
    id: str(m.id, 64), name: str(m.name, 32) || '?', ip: str(m.ip, 64),
    isHost: !!m.isHost, direct: typeof m.direct === 'boolean' ? m.direct : null,
    streaming: m.streaming && typeof m.streaming === 'object'
      ? { title: str(m.streaming.title, 200), w: num(m.streaming.w), h: num(m.streaming.h), fps: num(m.streaming.fps) } : null,
    playing: m.playing && typeof m.playing === 'object' && str(m.playing.name, 60)
      ? { name: str(m.playing.name, 60), requests: !!m.playing.requests } : null,
  };
}

T.onState((s) => {
  const prevIds = new Set(state.members.map((m) => m.id));
  s.members = (Array.isArray(s.members) ? s.members : []).filter((m) => m && typeof m.id === 'string').map(cleanMember);
  state = s;
  renderNet(); renderMembers(); renderLive(); renderChat();
  checkAutoWatch();
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
    const dm = chats.get(m.id);
    if (dm && dm.unread) li.classList.add('dm-unread');
    li.innerHTML = `
      <span class="avatar" style="background:${colorFor(m.id)}">${esc((m.name || '?')[0].toUpperCase())}</span>
      <div class="meta">
        <div class="nm">${esc(m.name)}${m.isHost ? '<span class="crown" title="Host">♛</span>' : ''}${m.streaming ? '<span class="tag-live">AO VIVO</span>' : ''}</div>
        ${m.playing ? `<div class="game" title="${esc(m.playing.name)}">🎮 ${esc(m.playing.name)}</div>` : ''}
        <div class="sub">${conn}</div>
      </div>
      <div class="acts"></div>`;
    const acts = li.querySelector('.acts');
    if (!me) {
      const b = el('button', 'btn ghost small', '💬');
      b.title = `Mensagem privada para ${m.name}`;
      b.onclick = () => openChat(m.id);
      acts.append(b);
    }
    if (!m.isHost) {
      const b = el('button', 'btn ghost small', '♛');
      b.title = 'Tornar host (passa o papel de host para esta pessoa)';
      b.onclick = () => { T.promote(m.id); toast(`Pedindo para ${m.name} virar host…`); };
      acts.append(b);
    }
    if (!me && m.playing && m.playing.requests && !m.streaming) {
      const wait = askCooldown.get(m.id) > Date.now();
      const b = el('button', 'btn small ask', wait ? 'Pedido enviado' : 'Pedir transmissão');
      b.disabled = wait;
      b.title = wait ? 'Dá pra pedir de novo daqui a alguns minutos' : `Pedir para ${m.name} transmitir o jogo`;
      b.onclick = () => askStream(m.id);
      li.querySelector('.meta').append(b);
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
      <div class="s" title="${esc(m.streaming.title)}">${esc(m.streaming.title)} · ${esc(m.streaming.h || '')}p${esc(m.streaming.fps || '')}</div></div>`;
    const b = el('button', 'btn ' + (watching ? 'ghost' : 'primary') + ' small', watching ? 'Assistindo' : 'Assistir');
    b.disabled = watching;
    b.onclick = () => watch(m.id);
    c.append(b);
    box.append(c);
  }
}

// ---------------------------------------------------------------- chat
// Mensagens só na memória: fechou o app, sumiram. Vão pelo host (como a sinalização), dentro do Tailscale.
const chats = new Map(); // 'room' | memberId -> { name, msgs: [{ from, name, text, ts, sys }], unread }
chats.set('room', { name: 'Sala', msgs: [], unread: 0 });
let activeChat = 'room';
let chatOpen = true;
try { chatOpen = localStorage.getItem('telinha.chatOpen') !== '0'; } catch {}

function chatFor(key, name) {
  if (!chats.has(key)) chats.set(key, { name: name || memberName(key), msgs: [], unread: 0 });
  return chats.get(key);
}
function pushMsg(key, msg) {
  const c = chatFor(key, msg.dmName);
  c.msgs.push(msg);
  if (c.msgs.length > 300) c.msgs.shift();
  const seen = chatOpen && activeChat === key && document.hasFocus();
  if (!seen && !msg.mine && !msg.sys) c.unread++;
}

function onChat(m) {
  const text = String(m.text || '').slice(0, 1000).trim();
  if (!text) return;
  const name = state.members.some((x) => x.id === m.from) ? memberName(m.from) : String(m.name || 'alguém').slice(0, 32);
  const key = m.scope === 'dm' ? m.from : 'room';
  pushMsg(key, { from: m.from, name, text, ts: Date.now(), dmName: name });
  if (key !== 'room') T.attention();
  renderChat(); renderMembers();
}

function sendChat(text) {
  text = text.trim().slice(0, 1000);
  if (!text) return;
  const others = state.members.filter((x) => x.id !== state.selfId);
  if (activeChat === 'room') {
    if (!others.length) return toast('Não tem mais ninguém na sala agora.');
    for (const o of others) T.send(o.id, { type: 'chat', scope: 'room', text, name: settings.name });
  } else {
    if (!others.some((o) => o.id === activeChat)) return toast('Essa pessoa não está mais na sala.');
    T.send(activeChat, { type: 'chat', scope: 'dm', text, name: settings.name });
  }
  pushMsg(activeChat, { from: state.selfId, name: settings.name, text, ts: Date.now(), mine: true });
  renderChat();
}

function openChat(key) {
  chatFor(key);
  activeChat = key;
  setChatOpen(true);
  $('#chatInput').focus();
}
function setChatOpen(v) {
  chatOpen = v;
  try { localStorage.setItem('telinha.chatOpen', v ? '1' : '0'); } catch {}
  renderChat();
}

const linkify = (t) => esc(t).replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank">${u}</a>`);

function renderChat() {
  $('#chat').classList.toggle('hidden', !chatOpen);
  if (chatOpen && document.hasFocus()) chatFor(activeChat).unread = 0;
  const total = [...chats.values()].reduce((n, c) => n + c.unread, 0);
  $('#chatBadge').textContent = total;
  $('#chatBadge').classList.toggle('hidden', !total);
  if (!chatOpen) return;

  const tabs = $('#chatTabs'); tabs.innerHTML = '';
  for (const [key, c] of chats) {
    const present = key === 'room' || state.members.some((x) => x.id === key);
    if (key !== 'room' && present) c.name = memberName(key);
    const t = el('button', 'chat-tab' + (key === activeChat ? ' active' : ''));
    t.innerHTML = `<span class="n">${key === 'room' ? '# Sala' : '@ ' + esc(c.name)}${present ? '' : ' (saiu)'}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}${key !== 'room' ? '<span class="x" title="Fechar conversa">✕</span>' : ''}`;
    t.onclick = (e) => {
      if (e.target.classList.contains('x')) {
        chats.delete(key);
        if (activeChat === key) activeChat = 'room';
      } else activeChat = key;
      renderChat(); renderMembers();
    };
    tabs.append(t);
  }

  const c = chatFor(activeChat);
  const present = activeChat === 'room' || state.members.some((x) => x.id === activeChat);
  $('#chatInput').disabled = !present;
  $('#chatInput').placeholder = activeChat === 'room' ? 'Mensagem para a sala' : present ? `Mensagem para ${c.name}` : 'Essa pessoa saiu da sala';
  // só redesenha o histórico se mudou (o estado da sala chega a cada poucos segundos)
  const sig = `${activeChat}|${c.msgs.length}|${c.msgs.length && c.msgs[c.msgs.length - 1].ts}`;
  if (sig === renderChat.sig) return;
  renderChat.sig = sig;
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = '';
  if (!c.msgs.length) log.innerHTML = `<div class="chat-empty">${activeChat === 'room' ? 'Ninguém falou nada ainda.<br>As mensagens não ficam salvas.' : `Conversa privada com ${esc(c.name)}.<br>Só vocês dois veem.`}</div>`;
  for (const m of c.msgs) {
    const d = el('div', 'msg' + (m.sys ? ' sys' : ''));
    d.innerHTML = m.sys ? esc(m.text)
      : `<span class="who" style="color:${m.mine ? 'var(--accent-2)' : colorFor(m.from)}">${esc(m.name)}</span><span class="when">${new Date(m.ts).toLocaleTimeString().slice(0, 5)}</span><div class="body">${linkify(m.text)}</div>`;
    log.append(d);
  }
  if (atBottom || (c.msgs.length && c.msgs[c.msgs.length - 1].mine)) log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- pedidos de transmissão
// Só dá pra pedir para quem marcou "jogando" e aceita pedidos. Aceitar só abre o seletor de tela.
const ASK_COOLDOWN = 10 * 60 * 1000;
const REFUSE_BLOCK = 30 * 60 * 1000;
const ASK_EXPIRE = 2 * 60 * 1000;
const askCooldown = new Map(); // (quem pede) memberId -> pode pedir de novo a partir de
const autoWatch = new Map(); // (quem pede) memberId -> assistir sozinho se começar até
const askBlock = new Map(); // (quem recebe) nome|id -> bloqueado até
const pendingAsks = new Map(); // (quem recebe) memberId -> { card, timer }
let myGame = null;

function askStream(id) {
  T.send(id, { type: 'askstream' });
  askCooldown.set(id, Date.now() + ASK_COOLDOWN);
  setTimeout(renderMembers, ASK_COOLDOWN + 500);
  toast(`Pedido enviado para ${memberName(id)}.`);
  renderMembers();
}

function onAskReply(m) {
  if (m.ok) {
    autoWatch.set(m.from, Date.now() + 5 * 60 * 1000);
    toast(`${memberName(m.from)} aceitou e vai escolher o que transmitir. Você entra sozinho quando começar.`, 6000);
  } else toast(`${memberName(m.from)}: ${String(m.reason || 'pedido recusado').slice(0, 120)}`, 5000);
}

function checkAutoWatch() {
  for (const [id, until] of autoWatch) {
    if (until < Date.now()) { autoWatch.delete(id); continue; }
    const m = state.members.find((x) => x.id === id);
    if (m && m.streaming && !inPcs.has(id)) { autoWatch.delete(id); watch(id); }
  }
}

function onAskStream(from) {
  const reply = (ok, reason) => T.send(from, { type: 'askreply', ok, reason });
  const name = memberName(from);
  if (!settings.gameDetect || !settings.gameRequests || !myGame) return reply(false, 'não está aceitando pedidos agora.');
  if (my) return reply(false, 'já está transmitindo. É só clicar em Assistir.');
  if (pendingAsks.has(from)) return;
  const keys = [from, `n:${name}`];
  if (keys.some((k) => askBlock.get(k) > Date.now())) return reply(false, 'espere um pouco antes de pedir de novo.');
  keys.forEach((k) => askBlock.set(k, Date.now() + ASK_COOLDOWN));

  const card = el('div', 'req-card');
  card.innerHTML = `<span class="avatar" style="background:${colorFor(from)}">${esc((name[0] || '?').toUpperCase())}</span>
    <div class="txt"><b>${esc(name)}</b> pediu pra você transmitir <b>${esc(myGame.name)}</b>.
    <div class="muted small">Nada é transmitido até você escolher a tela e confirmar. <button class="link" data-a="off">Não aceitar mais pedidos</button></div></div>`;
  const ok = el('button', 'btn primary small', 'Escolher o que transmitir');
  const no = el('button', 'btn ghost small', 'Recusar');
  card.append(ok, no);
  const done = () => { clearTimeout(p.timer); card.remove(); pendingAsks.delete(from); };
  const refuse = (reason) => { keys.forEach((k) => askBlock.set(k, Date.now() + REFUSE_BLOCK)); reply(false, reason); done(); };
  const p = { card, timer: setTimeout(() => refuse('não respondeu ao pedido.'), ASK_EXPIRE) };
  ok.onclick = () => { reply(true); done(); openPicker(); };
  no.onclick = () => refuse('recusou o pedido.');
  card.querySelector('[data-a=off]').onclick = async () => {
    settings = await T.setSettings({ gameRequests: false });
    for (const [id, x] of [...pendingAsks]) { clearTimeout(x.timer); x.card.remove(); pendingAsks.delete(id); T.send(id, { type: 'askreply', ok: false, reason: 'não está aceitando pedidos agora.' }); }
    toast('Pedidos desligados. Dá pra ligar de novo em ⚙.');
  };
  pendingAsks.set(from, p);
  $('#requests').append(card);
  T.attention();
  if (!document.hasFocus()) {
    try {
      const n = new Notification('Telinha', { body: `${name} pediu pra você transmitir ${myGame.name}.`, silent: false });
      n.onclick = () => T.focusWindow();
    } catch {}
  }
}

function renderGameNow() {
  const box = $('#gameNow'); if (!box) return;
  if (!settings.gameDetect) { box.textContent = ''; return; }
  box.textContent = myGame ? `Detectado agora: ${myGame.name} (${myGame.exe}, pela ${myGame.source})` : 'Nenhum jogo detectado agora.';
}

// ---------------------------------------------------------------- configurações
async function openSettings() {
  $('#sName').value = settings.name || '';
  $('#sRoom').value = settings.room || '';
  const pr = Number(settings.priority) || 0;
  $('#sPriority').value = pr >= 10 ? '10' : pr <= -10 ? '-10' : '0';
  $('#sExtra').value = (settings.extraPeers || []).join('\n');
  $('#sTsPath').value = settings.tailscalePath || '';
  $('#sGameDetect').checked = !!settings.gameDetect;
  $('#sGameRequests').checked = settings.gameRequests !== false;
  $('#sGameList').value = (settings.gameList || []).join('\n');
  $('#sGameIgnore').value = (settings.gameIgnore || []).join('\n');
  renderGameNow();
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
    gameDetect: $('#sGameDetect').checked,
    gameRequests: $('#sGameRequests').checked,
    gameList: $('#sGameList').value.split('\n').map((x) => x.trim()).filter(Boolean),
    gameIgnore: $('#sGameIgnore').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
  };
  settings = await T.setSettings(patch);
  $('#setModal').classList.add('hidden');
  renderNet();
  toast(patch.tailscalePath && settings.tailscalePath !== patch.tailscalePath
    ? 'Salvo, mas o caminho do Tailscale foi ignorado: precisa ser um arquivo tailscale.exe que exista.' : 'Salvo', 6000);
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
$('#btnChat').onclick = () => setChatOpen(!chatOpen);
$('#chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('#chatInput').value); $('#chatInput').value = ''; };
window.addEventListener('focus', () => { renderChat(); renderMembers(); });
T.onGame((g) => { myGame = g; renderGameNow(); });
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
  myGame = await T.currentGame();
  const p = await T.platform();
  $('#appVersion').textContent = `Telinha ${p.version}`;
  renderNet(); renderMembers(); renderLive(); renderChat();
})();
