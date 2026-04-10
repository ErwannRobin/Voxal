/* push2talk – main.js
 *
 * Topology:
 *   Signaling : star (host ↔ each peer via DataConnection)
 *   Audio     : full mesh (every peer ↔ every peer via MediaConnection / Opus)
 */

// ─── State ────────────────────────────────────────────────────────────────────

const DEFAULT_SHORTCUT = 'Ctrl+Backquote';

let peer           = null;
let stream         = null;
let audioTrack     = null;
let isHost         = false;
let roomCode       = '';
let inRoom         = false;
let isTalking      = false;
let freeHandMode   = false;
let recordingShortcut = false;

let shortcutStr = localStorage.getItem('ptt-shortcut') || DEFAULT_SHORTCUT;

// peerId → { data: DataConnection|null, media: MediaConnection|null }
const connections = new Map();

// ─── Shortcut helpers ─────────────────────────────────────────────────────────

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
  return [...mods, e.code].join('+');   // e.g. "Ctrl+Backquote", "Alt+KeyM"
}

function displayShortcut(raw) {
  return raw
    .replace('Backquote', '`')
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .replace('Semicolon', ';').replace('Comma', ',').replace('Period', '.')
    .replace('Slash', '/').replace('BracketLeft', '[').replace('BracketRight', ']')
    .replace('Backslash', '\\').replace('Quote', "'").replace('Minus', '-')
    .replace('Equal', '=');
}

function updateShortcutDisplay() {
  $('shortcut-kbd').textContent = displayShortcut(shortcutStr);
  $('shortcut-hint-kbd').textContent = displayShortcut(shortcutStr);
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
  window.__TAURI__.core.invoke('update_ptt_shortcut', { shortcut: newShortcut })
    .then(() => {
      localStorage.setItem('ptt-shortcut', newShortcut);
      updateShortcutDisplay();
    })
    .catch(err => {
      console.warn('Failed to update shortcut:', err);
      shortcutStr = old;
    });
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

function showError(msg) {
  $('error-message').textContent = msg;
  showScreen('error');
}

// ─── Peer list UI ─────────────────────────────────────────────────────────────

function shortId(id) {
  return id.length > 14 ? id.slice(0, 6) + '…' + id.slice(-4) : id;
}

function updatePeerList() {
  const list = $('peers-list');
  list.innerHTML = '';

  const addItem = (label, self = false) => {
    const div = document.createElement('div');
    div.className = 'peer-item' + (self ? ' peer-self' : '');
    div.innerHTML = `<span class="peer-dot"></span><span>${label}</span>`;
    list.appendChild(div);
  };

  addItem(`You${isHost ? ' · host' : ''}`, true);
  connections.forEach((_, id) => addItem(shortId(id)));
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount:     1,
      sampleRate:       16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl:  true,
    },
    video: false,
  });
}

function attachAudio(peerId, remoteStream) {
  let el = document.getElementById(`audio-${peerId}`);
  if (!el) {
    el = new Audio();
    el.id = `audio-${peerId}`;
    el.autoplay = true;
    document.body.appendChild(el);
  }
  el.srcObject = remoteStream;
}

function detachAudio(peerId) {
  document.getElementById(`audio-${peerId}`)?.remove();
}

// ─── PTT & free-hand ─────────────────────────────────────────────────────────

function setTalking(active) {
  if (!inRoom || !audioTrack || freeHandMode) return;
  isTalking = active;
  audioTrack.enabled = active;
  $('ptt-btn').classList.toggle('active', active);
  $('ptt-status').textContent = active ? '● Transmitting…' : '';
}

function setFreeHand(active) {
  freeHandMode = active;
  if (audioTrack) audioTrack.enabled = active;

  const btn = $('btn-freehand');
  btn.textContent = active ? 'ON' : 'OFF';
  btn.setAttribute('aria-pressed', active);
  btn.classList.toggle('active', active);
  $('ptt-btn').classList.toggle('freehand', active);

  if (active) {
    $('ptt-hint').innerHTML = 'Free hand — mic always on';
    $('ptt-status').textContent = '● Live';
  } else {
    $('ptt-hint').innerHTML = `Hold <kbd id="shortcut-hint-kbd">${displayShortcut(shortcutStr)}</kbd> or click &amp; hold`;
    $('ptt-status').textContent = '';
  }
}

// ─── Connection helpers ───────────────────────────────────────────────────────

function removePeer(peerId) {
  const conn = connections.get(peerId);
  if (!conn) return;
  conn.data?.close();
  conn.media?.close();
  connections.delete(peerId);
  detachAudio(peerId);
  updatePeerList();
}

function leaveRoom() {
  inRoom = false;
  freeHandMode = false;
  isTalking = false;
  setTalking(false);
  [...connections.keys()].forEach(removePeer);
  stream?.getTracks().forEach(t => t.stop());
  peer?.destroy();
  peer = null; stream = null; audioTrack = null;
  isHost = false; roomCode = '';
  document.querySelectorAll('audio[id^="audio-"]').forEach(el => el.remove());
  showScreen('home');
}

function handleIncomingCall(call) {
  call.answer(stream);
  call.on('stream', remote => {
    attachAudio(call.peer, remote);
    const prev = connections.get(call.peer) ?? { data: null };
    connections.set(call.peer, { ...prev, media: call });
    updatePeerList();
  });
  call.on('close', () => removePeer(call.peer));
  call.on('error', err => console.warn('[call]', err));
}

// ─── Host logic ───────────────────────────────────────────────────────────────

function handleJoinerDataConnection(dataConn) {
  const joinerId = dataConn.peer;

  dataConn.on('open', () => {
    dataConn.send({ type: 'peer-list', peers: [...connections.keys()] });
    connections.forEach(({ data }) => data?.send({ type: 'peer-joined', peerId: joinerId }));
    connections.set(joinerId, { data: dataConn, media: null });
    updatePeerList();
  });

  dataConn.on('close', () => {
    if (!connections.has(joinerId)) return;
    connections.forEach(({ data }) => data?.send({ type: 'peer-left', peerId: joinerId }));
    removePeer(joinerId);
  });

  dataConn.on('error', err => console.warn('[data]', err));
}

async function createRoom() {
  stream     = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;

  peer = new Peer();

  peer.on('open', id => {
    isHost = true; roomCode = id; inRoom = true;
    $('room-code-display').textContent = id;
    showScreen('room');
    updatePeerList();
    updateShortcutDisplay();
  });

  peer.on('connection', dataConn => handleJoinerDataConnection(dataConn));
  peer.on('call',       call     => handleIncomingCall(call));
  peer.on('error',      err      => showError(err.message));
}

// ─── Non-host logic ───────────────────────────────────────────────────────────

function handleHostMessage(msg) {
  if (msg.type === 'peer-list') {
    [...msg.peers, roomCode].forEach(peerId => {
      if (connections.has(peerId)) return;
      connections.set(peerId, { data: null, media: null });
      updatePeerList();

      const call = peer.call(peerId, stream);
      call.on('stream', remote => {
        attachAudio(peerId, remote);
        const prev = connections.get(peerId) ?? { data: null };
        connections.set(peerId, { ...prev, media: call });
      });
      call.on('close', () => removePeer(peerId));
      const prev = connections.get(peerId) ?? { data: null };
      connections.set(peerId, { ...prev, media: call });
    });

  } else if (msg.type === 'peer-joined') {
    if (!connections.has(msg.peerId)) {
      connections.set(msg.peerId, { data: null, media: null });
      updatePeerList();
    }

  } else if (msg.type === 'peer-left') {
    removePeer(msg.peerId);
  }
}

async function joinRoom(code) {
  if (!code) return;

  stream     = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;

  peer = new Peer();

  peer.on('open', () => {
    roomCode = code;
    const hostData = peer.connect(code, { reliable: true });

    hostData.on('open', () => {
      isHost = false; inRoom = true;
      connections.set(code, { data: hostData, media: null });
      $('room-code-display').textContent = code;
      showScreen('room');
      updatePeerList();
      updateShortcutDisplay();
    });

    hostData.on('data',  msg => handleHostMessage(msg));
    hostData.on('close', ()  => { if (inRoom) showError('Disconnected. Room closed.'); });
    hostData.on('error', err => showError(err.message));
  });

  peer.on('call',  call => handleIncomingCall(call));
  peer.on('error', err  => showError(err.message));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

  // Sync saved shortcut with Rust if it differs from the compiled default
  if (shortcutStr !== DEFAULT_SHORTCUT) {
    window.__TAURI__.core.invoke('update_ptt_shortcut', { shortcut: shortcutStr })
      .catch(() => {
        shortcutStr = DEFAULT_SHORTCUT;
        localStorage.removeItem('ptt-shortcut');
      });
  }
  updateShortcutDisplay();

  // ── Room actions ──
  $('btn-create').addEventListener('click', () =>
    createRoom().catch(err => showError(err.message))
  );
  $('btn-join').addEventListener('click', () =>
    joinRoom($('input-code').value.trim()).catch(err => showError(err.message))
  );
  $('input-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-join').click();
  });
  $('btn-copy').addEventListener('click', () =>
    navigator.clipboard.writeText(roomCode)
  );
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-back').addEventListener('click', () => showScreen('home'));

  // ── PTT button (mouse / touch) ──
  $('ptt-btn').addEventListener('mousedown',  () => setTalking(true));
  $('ptt-btn').addEventListener('mouseup',    () => setTalking(false));
  $('ptt-btn').addEventListener('mouseleave', () => setTalking(false));

  // ── Free hand toggle ──
  $('btn-freehand').addEventListener('click', () => setFreeHand(!freeHandMode));

  // ── Shortcut recorder ──
  $('btn-edit-shortcut').addEventListener('click', startRecordingShortcut);
  $('btn-cancel-shortcut').addEventListener('click', stopRecordingShortcut);

  // ── Keyboard ──
  document.addEventListener('keydown', e => {
    if (recordingShortcut) {
      e.preventDefault();
      const s = shortcutFromEvent(e);
      if (s) applyNewShortcut(s);
      return;
    }
    if (e.code === 'Space' && !e.repeat) { setTalking(true); e.preventDefault(); }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') setTalking(false);
  });

  // ── Tauri global shortcut (Ctrl+` by default, works in background) ──
  const { listen } = window.__TAURI__.event;
  listen('ptt-press',   () => { if (!recordingShortcut) setTalking(true);  });
  listen('ptt-release', () => { if (!recordingShortcut) setTalking(false); });
});
