/* push2talk – main.js
 *
 * Topology:
 *   Signaling : star (host ↔ each peer via DataConnection)
 *   Audio     : full mesh (every peer ↔ every peer via MediaConnection / Opus)
 *
 * Join flow:
 *   1. Joiner opens DataConnection to host (room code = host peer ID)
 *   2. Host sends  { type:'peer-list', peers:[...] }
 *   3. Joiner calls every peer in list + host via MediaConnection
 *   4. Host broadcasts { type:'peer-joined', peerId } to all existing peers
 *   5. Existing peers answer incoming MediaConnection from joiner automatically
 *
 * Leave flow:
 *   Host detects DataConnection close → broadcasts { type:'peer-left', peerId }
 */

// ─── State ────────────────────────────────────────────────────────────────────

let peer       = null;   // PeerJS Peer
let stream     = null;   // local MediaStream
let audioTrack = null;   // audio track – enabled only while PTT pressed
let isHost     = false;
let roomCode   = '';
let inRoom     = false;

// peerId → { data: DataConnection|null, media: MediaConnection|null }
const connections = new Map();

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
      sampleRate:       16000,   // sufficient for voice; Opus will encode efficiently
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

// ─── PTT ──────────────────────────────────────────────────────────────────────

function setTalking(active) {
  if (!inRoom || !audioTrack) return;
  audioTrack.enabled = active;
  $('ptt-btn').classList.toggle('active', active);
  $('ptt-status').textContent = active ? '● Transmitting…' : '';
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
  setTalking(false);
  [...connections.keys()].forEach(removePeer);
  stream?.getTracks().forEach(t => t.stop());
  peer?.destroy();
  peer = null; stream = null; audioTrack = null;
  isHost = false; roomCode = '';
  document.querySelectorAll('audio[id^="audio-"]').forEach(el => el.remove());
  showScreen('home');
}

// Answer an incoming media call from any peer
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
    // Tell the newcomer who's already in the room
    dataConn.send({ type: 'peer-list', peers: [...connections.keys()] });

    // Tell existing peers about the newcomer (they'll receive the incoming call)
    connections.forEach(({ data }) => {
      data?.send({ type: 'peer-joined', peerId: joinerId });
    });

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
  });

  peer.on('connection', dataConn => handleJoinerDataConnection(dataConn));
  peer.on('call',       call     => handleIncomingCall(call));
  peer.on('error',      err      => showError(err.message));
}

// ─── Non-host logic ───────────────────────────────────────────────────────────

function handleHostMessage(msg) {
  if (msg.type === 'peer-list') {
    // Call host + all listed peers for audio
    [...msg.peers, roomCode].forEach(peerId => {
      if (connections.has(peerId)) return;
      connections.set(peerId, { data: null, media: null }); // show in UI immediately
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
    // Newcomer will call us – just reserve a slot in the UI
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
    });

    hostData.on('data',  msg => handleHostMessage(msg));
    hostData.on('close', ()  => { if (inRoom) showError('Disconnected. Room closed.'); });
    hostData.on('error', err => showError(err.message));
  });

  peer.on('call',  call => handleIncomingCall(call));
  peer.on('error', err  => showError(err.message));
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

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

  // PTT – click / hold the on-screen button
  $('ptt-btn').addEventListener('mousedown',  () => setTalking(true));
  $('ptt-btn').addEventListener('mouseup',    () => setTalking(false));
  $('ptt-btn').addEventListener('mouseleave', () => setTalking(false));

  // PTT – Space bar fallback when window is focused
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat) { setTalking(true);  e.preventDefault(); }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') setTalking(false);
  });

  // PTT – Tauri global shortcut (Ctrl+`) works even when app is in background
  const { listen } = window.__TAURI__.event;
  listen('ptt-press',   () => setTalking(true));
  listen('ptt-release', () => setTalking(false));
});
