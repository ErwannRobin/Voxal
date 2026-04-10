/* push2talk – main.js
 *
 * Topology:
 *   Signaling : star (host ↔ each peer via DataConnection)
 *   Audio     : full mesh (every peer ↔ every peer via MediaConnection / Opus)
 *
 * Data protocol:
 *   hello        { pseudo }                       joiner -> host on connect
 *   peer-list    { peers:[{id,pseudo}],            host -> joiner (reply to hello)
 *                  hostId, hostPseudo }
 *   peer-joined  { peerId, pseudo }               host -> all existing peers
 *   peer-left    { peerId }                       host -> all
 *   talking      { peerId, active }               non-host -> host (relayed to all)
 *
 * Host migration:
 *   When the host disconnects, all remaining peers independently elect a new host
 *   by sorting all known peer IDs and picking the smallest. The elected peer calls
 *   becomeHost(); others call connectToNewHost(). Audio mesh is unaffected since
 *   MediaConnections are fully peer-to-peer.
 */

// --- State -------------------------------------------------------------------

const DEFAULT_SHORTCUT = 'Ctrl+Backquote';

// --- Audio feedback ----------------------------------------------------------

const _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playBlip(up) {
  const ctx = _audioCtx;
  if (ctx.state === 'suspended') ctx.resume();

  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  const dur = 0.08;

  if (up) {
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.linearRampToValueAtTime(1200, now + dur);
  } else {
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.linearRampToValueAtTime(500, now + dur);
  }

  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.start(now);
  osc.stop(now + dur);
}

// Carillon: ascending triad (C5 – E5 – G5)
function playCarillon() {
  const ctx   = _audioCtx;
  if (ctx.state === 'suspended') ctx.resume();
  const notes = [523.25, 659.25, 783.99];
  notes.forEach(function(freq, i) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t   = ctx.currentTime + i * 0.12;
    const dur = 0.6;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  });
}

// Goodbye: descending fifth (G5 – C5)
function playGoodbye() {
  const ctx   = _audioCtx;
  if (ctx.state === 'suspended') ctx.resume();
  const notes = [783.99, 523.25];
  notes.forEach(function(freq, i) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t   = ctx.currentTime + i * 0.15;
    const dur = 0.45;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  });
}

let peer              = null;
let stream            = null;
let audioTrack        = null;
let isHost            = false;
let roomCode          = '';
let inRoom            = false;
let isTalking         = false;
let freeHandMode      = false;
let recordingShortcut = false;
let myPseudo          = localStorage.getItem('pseudo') || '';

let shortcutStr = localStorage.getItem('ptt-shortcut') || DEFAULT_SHORTCUT;

// peerId -> { data, media, pseudo, talking }
const connections = new Map();

// Haptic feedback (Capacitor native, no-op in browser/Tauri)
function hapticLight() {
  try {
    const Haptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (Haptics) Haptics.impact({ style: 'LIGHT' });
  } catch (_) {}
}

// --- DOM helpers -------------------------------------------------------------

const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

function showError(msg) {
  $('error-message').textContent = msg;
  showScreen('error');
}

// --- Shortcut helpers --------------------------------------------------------

const MODIFIER_CODES = [
  'ControlLeft','ControlRight','AltLeft','AltRight',
  'ShiftLeft','ShiftRight','MetaLeft','MetaRight',
];

function shortcutFromEvent(e) {
  if (MODIFIER_CODES.includes(e.code)) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey)               mods.push('Alt');
  if (e.shiftKey)             mods.push('Shift');
  return [...mods, e.code].join('+');
}

// Returns the bare key code part of a shortcut string e.g. "Ctrl+Backquote" -> "Backquote"
function keyCodeOf(sc) { const parts = sc.split('+'); return parts[parts.length - 1]; }

// Returns true if a keydown event matches the current shortcut
function matchesShortcut(e) {
  const parts = shortcutStr.split('+');
  const keyCode = parts[parts.length - 1];
  const needCtrl  = parts.includes('Ctrl');
  const needAlt   = parts.includes('Alt');
  const needShift = parts.includes('Shift');
  return e.code === keyCode
    && (e.ctrlKey || e.metaKey) === needCtrl
    && e.altKey   === needAlt
    && e.shiftKey === needShift;
}

function displayShortcut(raw) {
  return raw
    .replace('Backquote', '`').replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1')
    .replace('Semicolon', ';').replace('Comma', ',').replace('Period', '.')
    .replace('Slash', '/').replace('BracketLeft', '[').replace('BracketRight', ']')
    .replace('Backslash', '\\\\').replace("Quote", "'").replace('Minus', '-').replace('Equal', '=');
}

function updateShortcutDisplay() {
  const label = displayShortcut(shortcutStr);
  $('shortcut-kbd').textContent = label;
  const hintKbd = $('shortcut-hint-kbd');
  if (hintKbd) hintKbd.textContent = label;
}

function startRecordingShortcut() {
  recordingShortcut = true;
  $('shortcut-normal').classList.add('hidden');
  $('shortcut-recording').classList.remove('hidden');
}

function stopRecordingShortcut() {
  recordingShortcut = false;
  $('shortcut-normal').classList.remove('hidden');
  $('shortcut-recording').classList.add('hidden');
}

function applyNewShortcut(newShortcut) {
  stopRecordingShortcut();
  const old = shortcutStr;
  shortcutStr = newShortcut;
  localStorage.setItem('ptt-shortcut', newShortcut);
  updateShortcutDisplay();
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('update_ptt_shortcut', { shortcut: newShortcut })
      .catch(function(err) { console.warn('Failed to update global shortcut:', err); shortcutStr = old; updateShortcutDisplay(); });
  }
}

// --- Peer list UI ------------------------------------------------------------

function shortId(id) {
  return id.length > 14 ? id.slice(0, 6) + '\u2026' + id.slice(-4) : id;
}

function updatePeerList() {
  const list = $('peers-list');
  list.innerHTML = '';

  const addItem = (id, label, self, talking) => {
    const div = document.createElement('div');
    div.id = 'peer-item-' + id;
    div.className = 'peer-item' + (self ? ' peer-self' : '') + (talking ? ' talking' : '');
    div.innerHTML = '<span class="peer-dot"></span><span>' + label + '</span>';
    list.appendChild(div);
  };

  const selfLabel = (myPseudo || 'You') + (isHost ? ' \u00b7 host' : '');
  addItem('self', selfLabel, true, isTalking || freeHandMode);
  connections.forEach((conn, id) => addItem(id, conn.pseudo || shortId(id), false, conn.talking || false));
}

function updatePeerTalking(peerId, active) {
  const conn = connections.get(peerId);
  if (conn) conn.talking = active;
  const el = document.getElementById('peer-item-' + peerId);
  if (el) el.classList.toggle('talking', active);
}

function updateSelfTalking(active) {
  const el = document.getElementById('peer-item-self');
  if (el) el.classList.toggle('talking', active);
}

// --- Audio helpers -----------------------------------------------------------

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 16000,
             echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

function attachAudio(peerId, remoteStream) {
  let el = document.getElementById('audio-' + peerId);
  if (!el) { el = new Audio(); el.id = 'audio-' + peerId; el.autoplay = true; document.body.appendChild(el); }
  el.srcObject = remoteStream;
}

function detachAudio(peerId) { const el = document.getElementById('audio-' + peerId); if (el) el.remove(); }

// --- PTT & free-hand ---------------------------------------------------------

function broadcastTalkingState(active) {
  if (!inRoom || !peer) return;
  const msg = { type: 'talking', peerId: peer.id, active };
  if (isHost) {
    connections.forEach(function(c) { if (c.data) c.data.send(msg); });
  } else {
    const hc = connections.get(roomCode);
    if (hc && hc.data) hc.data.send(msg);
  }
}

function setTalking(active) {
  if (!inRoom || !audioTrack || freeHandMode) return;
  if (active === isTalking) return;
  isTalking = active;
  playBlip(active);
  if (active) hapticLight();
  audioTrack.enabled = active;
  $('ptt-btn').classList.toggle('active', active);
  $('ptt-status').textContent = active ? '\u25cf Transmitting\u2026' : '';
  updateSelfTalking(active);
  broadcastTalkingState(active);
}

function setFreeHand(active) {
  freeHandMode = active;
  playBlip(active);
  if (audioTrack) audioTrack.enabled = active;

  const btn = $('btn-freehand');
  btn.textContent = active ? 'ON' : 'OFF';
  btn.setAttribute('aria-pressed', String(active));
  btn.classList.toggle('active', active);
  $('ptt-btn').classList.toggle('freehand', active);

  if (active) {
    $('ptt-hint').textContent = 'Free hand \u2014 mic always on';
    $('ptt-status').textContent = '\u25cf Live';
  } else {
    $('ptt-hint').innerHTML = 'Hold <kbd id="shortcut-hint-kbd">' + displayShortcut(shortcutStr) + '</kbd> or click &amp; hold';
    $('ptt-status').textContent = '';
  }

  updateSelfTalking(active);
  broadcastTalkingState(active);
}

// --- Connection helpers ------------------------------------------------------

function removePeer(peerId) {
  const conn = connections.get(peerId);
  if (!conn) return;
  if (conn.data) conn.data.close();
  if (conn.media) conn.media.close();
  connections.delete(peerId);
  detachAudio(peerId);
  updatePeerList();
}

function leaveRoom() {
  inRoom = false; freeHandMode = false; isTalking = false;
  Array.from(connections.keys()).forEach(removePeer);
  if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
  if (peer) peer.destroy();
  peer = null; stream = null; audioTrack = null;
  isHost = false; roomCode = '';
  document.querySelectorAll('audio[id^="audio-"]').forEach(function(el) { el.remove(); });
  showScreen('home');
}

// --- Host migration ----------------------------------------------------------

function initiateHostMigration() {
  if (!inRoom) return;

  const oldHostId = roomCode;

  // Remove old host from the map (data conn is already dead; media closes on its own)
  const oldConn = connections.get(oldHostId);
  if (oldConn) {
    if (oldConn.media) oldConn.media.close();
    connections.delete(oldHostId);
    detachAudio(oldHostId);
  }

  playGoodbye();

  // Elect new host: smallest peer ID among all remaining peers + self
  const allIds = [...connections.keys(), peer.id].sort();
  if (allIds.length === 0) { leaveRoom(); return; }

  const newHostId = allIds[0];
  updatePeerList();

  if (newHostId === peer.id) {
    becomeHost();
  } else {
    connectToNewHost(newHostId);
  }
}

function becomeHost() {
  isHost = true;
  roomCode = peer.id;
  $('room-code-display').textContent = peer.id;
  updatePeerList();
  // peer.on('connection') is already wired in joinRoom() and will route here
  // since isHost is now true
}

function connectToNewHost(newHostId) {
  roomCode = newHostId;
  $('room-code-display').textContent = newHostId;

  const hostData = peer.connect(newHostId, { reliable: true });

  hostData.on('open', function() {
    hostData.send({ type: 'hello', pseudo: myPseudo || 'Anonymous' });
    const prev = connections.get(newHostId) || { media: null, talking: false };
    connections.set(newHostId, Object.assign({}, prev, { data: hostData, pseudo: prev.pseudo || shortId(newHostId) }));
    updatePeerList();
  });

  hostData.on('data',  function(msg) { handleHostMessage(msg); });
  hostData.on('close', function()    { if (inRoom) initiateHostMigration(); });
  hostData.on('error', function(err) { console.warn('[host-data]', err); });
}

function handleIncomingCall(call) {
  call.answer(stream);
  call.on('stream', function(remote) {
    attachAudio(call.peer, remote);
    const prev = connections.get(call.peer) || { data: null, pseudo: shortId(call.peer), talking: false };
    connections.set(call.peer, Object.assign({}, prev, { media: call }));
    updatePeerList();
  });
  call.on('close', function() { removePeer(call.peer); });
  call.on('error', function(err) { console.warn('[call]', err); });
}

// --- Host logic --------------------------------------------------------------

function handleJoinerDataConnection(dataConn) {
  const joinerId = dataConn.peer;

  dataConn.on('open', function() {
    connections.set(joinerId, { data: dataConn, media: null, pseudo: shortId(joinerId), talking: false });
  });

  dataConn.on('data', function(msg) {
    if (msg.type === 'hello') {
      const pseudo = msg.pseudo || shortId(joinerId);
      const existing = connections.get(joinerId) || { data: dataConn, media: null, talking: false };
      connections.set(joinerId, Object.assign({}, existing, { pseudo: pseudo }));

      const peers = Array.from(connections.entries())
        .filter(function(entry) { return entry[0] !== joinerId; })
        .map(function(entry) { return { id: entry[0], pseudo: entry[1].pseudo || shortId(entry[0]) }; });
      dataConn.send({ type: 'peer-list', peers: peers, hostId: peer.id, hostPseudo: myPseudo || 'Host' });

      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'peer-joined', peerId: joinerId, pseudo: pseudo });
      });

      playCarillon();
      updatePeerList();

    } else if (msg.type === 'talking') {
      updatePeerTalking(joinerId, msg.active);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'talking', peerId: joinerId, active: msg.active });
      });
    }
  });

  dataConn.on('close', function() {
    if (!connections.has(joinerId)) return;
    connections.forEach(function(c) { if (c.data) c.data.send({ type: 'peer-left', peerId: joinerId }); });
    playGoodbye();
    removePeer(joinerId);
  });

  dataConn.on('error', function(err) { console.warn('[data]', err); });
}

async function createRoom() {
  stream = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;
  peer = new Peer();
  peer.on('open', function(id) {
    isHost = true; roomCode = id; inRoom = true;
    $('room-code-display').textContent = id;
    showScreen('room');
    updatePeerList();
    updateShortcutDisplay();
  });
  peer.on('connection', function(dataConn) { handleJoinerDataConnection(dataConn); });
  peer.on('call',       function(call)     { handleIncomingCall(call); });
  peer.on('error',      function(err)      { showError(err.message); });
}

// --- Non-host logic ----------------------------------------------------------

function handleHostMessage(msg) {
  if (msg.type === 'peer-list') {
    const hostConn = connections.get(roomCode);
    if (hostConn) hostConn.pseudo = msg.hostPseudo || shortId(roomCode);

    const allPeers = msg.peers.concat([{ id: roomCode, pseudo: msg.hostPseudo || shortId(roomCode) }]);
    allPeers.forEach(function(p) {
      const peerId = p.id;
      const pseudo = p.pseudo;
      const prev = connections.get(peerId) || { data: null, talking: false };
      if (prev.media) return;
      connections.set(peerId, Object.assign({}, prev, { pseudo: pseudo, media: null }));
      updatePeerList();

      const call = peer.call(peerId, stream);
      call.on('stream', function(remote) { attachAudio(peerId, remote); });
      call.on('close',  function()       { removePeer(peerId); });
      connections.set(peerId, Object.assign({}, connections.get(peerId), { media: call }));
    });

  } else if (msg.type === 'peer-joined') {
    if (!connections.has(msg.peerId)) {
      connections.set(msg.peerId, { data: null, media: null, pseudo: msg.pseudo || shortId(msg.peerId), talking: false });
      playCarillon();
      updatePeerList();
    }

  } else if (msg.type === 'peer-left') {
    playGoodbye();
    removePeer(msg.peerId);

  } else if (msg.type === 'talking') {
    updatePeerTalking(msg.peerId, msg.active);
  }
}

async function joinRoom(code) {
  if (!code) return;
  stream = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;
  peer = new Peer();
  peer.on('open', function() {
    roomCode = code;
    const hostData = peer.connect(code, { reliable: true });

    hostData.on('open', function() {
      hostData.send({ type: 'hello', pseudo: myPseudo || 'Anonymous' });
      isHost = false; inRoom = true;
      connections.set(code, { data: hostData, media: null, pseudo: shortId(code), talking: false });
      $('room-code-display').textContent = code;
      showScreen('room');
      updatePeerList();
      updateShortcutDisplay();
    });

    hostData.on('data',  function(msg) { handleHostMessage(msg); });
    hostData.on('close', function()    { if (inRoom) initiateHostMigration(); });
    hostData.on('error', function(err) { showError(err.message); });
  });
  // Accept incoming connections in case this peer becomes host after migration
  peer.on('connection', function(dataConn) { if (isHost) handleJoinerDataConnection(dataConn); });
  peer.on('call',  function(call) { handleIncomingCall(call); });
  peer.on('error', function(err)  { showError(err.message); });
}

// --- Bootstrap ---------------------------------------------------------------

window.addEventListener('DOMContentLoaded', function() {

  $('input-pseudo').value = myPseudo;
  $('input-pseudo').addEventListener('input', function(e) {
    myPseudo = e.target.value.trim();
    localStorage.setItem('pseudo', myPseudo);
    if (inRoom) updatePeerList();
  });

  if (window.__TAURI__ && shortcutStr !== DEFAULT_SHORTCUT) {
    window.__TAURI__.core.invoke('update_ptt_shortcut', { shortcut: shortcutStr })
      .catch(function() { shortcutStr = DEFAULT_SHORTCUT; localStorage.removeItem('ptt-shortcut'); });
  }
  updateShortcutDisplay();

  $('btn-create').addEventListener('click', function() { createRoom().catch(function(err) { showError(err.message); }); });
  $('btn-join').addEventListener('click', function() {
    joinRoom($('input-code').value.trim()).catch(function(err) { showError(err.message); });
  });
  $('input-code').addEventListener('keydown', function(e) { if (e.key === 'Enter') $('btn-join').click(); });
  $('btn-copy').addEventListener('click', function() { navigator.clipboard.writeText(roomCode); });
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-back').addEventListener('click', function() { showScreen('home'); });

  $('ptt-btn').addEventListener('mousedown',  function() { setTalking(true); });
  $('ptt-btn').addEventListener('mouseup',    function() { setTalking(false); });
  $('ptt-btn').addEventListener('mouseleave', function() { setTalking(false); });

  $('btn-freehand').addEventListener('click', function() { setFreeHand(!freeHandMode); });
  $('btn-edit-shortcut').addEventListener('click', startRecordingShortcut);
  $('btn-cancel-shortcut').addEventListener('click', stopRecordingShortcut);

  document.addEventListener('keydown', function(e) {
    if (recordingShortcut) { e.preventDefault(); const s = shortcutFromEvent(e); if (s) applyNewShortcut(s); return; }
    // Space always triggers PTT; Enter always toggles free-hand
    if (e.code === 'Space' && !e.repeat) { setTalking(true);           e.preventDefault(); return; }
    if (e.code === 'Enter' && !e.repeat) { setFreeHand(!freeHandMode); e.preventDefault(); return; }
    if (matchesShortcut(e) && !e.repeat) { setTalking(true);           e.preventDefault(); }
  });
  document.addEventListener('keyup', function(e) {
    if (e.code === 'Space') { setTalking(false); return; }
    if (keyCodeOf(shortcutStr) === e.code) setTalking(false);
  });

  // Tauri-only: global shortcut works even when app is in background
  if (window.__TAURI__) {
    const listen = window.__TAURI__.event.listen;
    listen('ptt-press',   function() { if (!recordingShortcut) setTalking(true);  });
    listen('ptt-release', function() { if (!recordingShortcut) setTalking(false); });
  }
});
