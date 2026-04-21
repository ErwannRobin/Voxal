/* voxal – main.js
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

// --- TURN / ICE servers (metered.ca) ----------------------------------------

const METERED_APP_STORE_KEY    = 'metered-app-name';
const METERED_API_STORE_KEY    = 'metered-api-key';
const METERED_STATUS_STORE_KEY  = 'metered-status';  // 'ok' | 'error' | null
const METERED_COUNT_STORE_KEY   = 'metered-count';   // number of servers when ok
const METERED_SERVERS_STORE_KEY = 'metered-servers'; // JSON array of ICE server objects

// --- Audio focus (Android) ---------------------------------------------------

async function requestAudioFocus() {
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { AudioForeground } = window.Capacitor.Plugins;
      await AudioForeground?.start?.();
    } catch (e) {
      console.warn('[AudioFocus] Failed to request:', e.message);
    }
  }
}

async function releaseAudioFocus() {
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { AudioForeground } = window.Capacitor.Plugins;
      await AudioForeground?.stop?.();
    } catch (e) {
      console.warn('[AudioFocus] Failed to release:', e.message);
    }
  }
}

// --- Presence API -----------------------------------------------------------

const DEFAULT_PRESENCE_BASE     = 'https://vybzjzwsqrggatcrnqxe.supabase.co/functions/v1/session';
const DEFAULT_VOXAL_CONNECT_URL = 'https://voxal.lovable.app';
const PRESENCE_TOKEN_KEY        = 'presence-api-token';
const PRESENCE_ORG_KEY          = 'presence-org-id';
const SERVICE_URL_KEY           = 'service-url';

function presenceBase()       { return (localStorage.getItem(SERVICE_URL_KEY) || DEFAULT_PRESENCE_BASE).replace(/\/$/, ''); }
function voxalConnectUrl()    { return localStorage.getItem('voxal-connect-url') || DEFAULT_VOXAL_CONNECT_URL; }
function presenceToken()      { return localStorage.getItem(PRESENCE_TOKEN_KEY) || ''; }
function presenceOrgId()      { return localStorage.getItem(PRESENCE_ORG_KEY)   || ''; }
function presenceConfigured() { return !!(presenceToken() && presenceOrgId()); }

// --- iframe postMessage bridge -----------------------------------------------
// When Voxal runs embedded inside a parent page's <iframe>, this bridge lets the
// parent control the room (join/create/leave) and observe state changes (talking,
// joined, left, peers).  All messages are scoped to { source: 'voxal' }.
//
// Parent → Voxal  (commands):
//   { type: 'join',   roomCode: '<peerId>' }
//   { type: 'create' }
//   { type: 'leave' }
//
// Voxal → Parent  (events):
//   { source: 'voxal', type: 'joined',  roomCode: '<peerId>', peerId: '<self>' }
//   { source: 'voxal', type: 'left' }
//   { source: 'voxal', type: 'talking', active: true|false }
//   { source: 'voxal', type: 'peers',   peers: [{ id, pseudo, talking }] }

var _isIframe = (function() { try { return window.self !== window.top; } catch(e) { return true; } })();

function iframeEmit(msg) {
  if (!_isIframe) return;
  window.parent.postMessage(Object.assign({ source: 'voxal' }, msg), '*');
}

// --- OAuth-style deep link auth ---------------------------------------------

function generateState() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function handleDeepLink(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'voxal:') return;

    if (url.hostname === 'join') {
      // voxal://join?room=<peerId>
      const roomId = url.searchParams.get('room');
      if (!roomId) return;
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      var doJoin = function() {
        joinRoom(roomId).catch(function(err) { showError(err.message); });
      };
      if (inRoom) {
        leaveRoom();
        setTimeout(doJoin, 150); // give PeerJS a tick to close connections
      } else {
        doJoin();
      }
      return;
    }

    if (url.hostname === 'auth') {
      const token    = url.searchParams.get('token');
      const state    = url.searchParams.get('state');
      const expected = sessionStorage.getItem('voxal-auth-state');
      if (!token) return;
      if (expected && state !== expected) { console.warn('[Auth] State mismatch — ignoring'); return; }
      sessionStorage.removeItem('voxal-auth-state');
      localStorage.setItem(PRESENCE_TOKEN_KEY, token);
      const inp = document.getElementById('input-presence-token');
      if (inp) inp.value = token;
      if (typeof updateDisconnectVisibility === 'function') updateDisconnectVisibility();
      if (typeof updateConnectVisibility === 'function') updateConnectVisibility();
      selectOrgAndStartPolling();
    }
  } catch (e) {
    console.error('[Auth] Deep link parse error', e);
  }
}

async function connectWithVoxalAccount() {
  const state = generateState();
  sessionStorage.setItem('voxal-auth-state', state);
  const connectUrl = voxalConnectUrl() + '/connect?state=' + state;

  if (window.__TAURI__) {
    // Desktop: open in system browser; deep link fires 'deep-link://new-url'
    try { await window.__TAURI__.shell.open(connectUrl); } catch(e) {
      // fallback: shell plugin may not be available yet
      window.open(connectUrl, '_blank');
    }
    window.__TAURI__.event.once('deep-link://new-url', function(e) {
      var urls = Array.isArray(e.payload) ? e.payload : [e.payload];
      if (urls[0]) handleDeepLink(urls[0]);
    });
  } else if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    // iOS: open in system browser; appUrlOpen fires when OS routes voxal:// back
    window.open(connectUrl, '_system');
  } else {
    // Web: popup + postMessage
    var popup = window.open(connectUrl, 'voxal-auth', 'width=520,height=720,left=200,top=100');
    function onMessage(e) {
      if (e.origin !== voxalConnectUrl()) return;
      if (!e.data || !e.data.token) return;
      window.removeEventListener('message', onMessage);
      if (popup && !popup.closed) popup.close();
      handleDeepLink('voxal://auth?token=' + encodeURIComponent(e.data.token) + '&state=' + encodeURIComponent(e.data.state || state));
    }
    window.addEventListener('message', onMessage);
  }
}

// Route presence API calls through Rust to bypass CORS.
// (Tauri's WebView origin tauri://localhost is not whitelisted by external APIs.)
// Falls back to native fetch on web / Capacitor.
function tauriFetch(url, options) {
  if (window.__TAURI__) {
    var method = (options && options.method) || 'GET';
    var token  = options && options.headers && options.headers['x-api-token'];
    var body   = options && options.body || null;
    return window.__TAURI__.core.invoke('presence_fetch', {
      url: url, method: method,
      token: token || null,
      body: body || null,
    }).then(function(data) {
      return { ok: true, status: 200, json: function() { return Promise.resolve(data); } };
    }).catch(function(e) {
      var msg = String(e);
      var m = msg.match(/HTTP (\d+)/);
      var status = m ? parseInt(m[1]) : 500;
      console.error('[tauriFetch]', msg);
      return { ok: false, status: status, json: function() { return Promise.resolve(null); } };
    });
  }
  return fetch(url, options);
}

async function fetchPresence() {
  const res = await tauriFetch(
    presenceBase() + '/org/' + presenceOrgId() + '/presence',
    { headers: { 'x-api-token': presenceToken() } }
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).presence; // [{channel:{id,name}, connected:[{user_id,peer_id,display_name}]}]
}

async function fetchOrgs() {
  const res = await tauriFetch(presenceBase() + '/orgs', {
    headers: { 'x-api-token': presenceToken() },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).organisations; // [{id,name,avatar_url,role}]
}

async function postSession(channelName, peerId) {
  const res = await tauriFetch(presenceBase(), {
    method: 'POST',
    headers: { 'x-api-token': presenceToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: presenceOrgId(), channel_name: channelName, peer_id: peerId }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

function deleteSession() {
  if (!presenceConfigured()) return;
  tauriFetch(presenceBase(), {
    method: 'DELETE',
    headers: { 'x-api-token': presenceToken() },
  }).catch(function(e) { console.warn('[Presence] deleteSession:', e.message); });
}

const FALLBACK_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// 1. Try org TURN (backend-managed, short-lived credentials — preferred)
// 2. Try locally configured metered.ca credentials (manual fallback)
// 3. Fall back to public STUN
async function fetchIceServers() {
  // --- 1. Org ICE servers from Voxal backend ---
  if (presenceConfigured()) {
    try {
      const res = await tauriFetch(
        presenceBase() + '/org/' + presenceOrgId() + '/ice-servers',
        { headers: { 'x-api-token': presenceToken() } }
      );
      if (res.ok) {
        const data = await res.json();
        const ice_servers = data && data.ice_servers;
        if (Array.isArray(ice_servers) && ice_servers.length > 0) {
          console.log('[TURN] Using', ice_servers.length, 'org ICE servers');
          localStorage.setItem(METERED_STATUS_STORE_KEY, 'ok');
          localStorage.setItem(METERED_COUNT_STORE_KEY, String(ice_servers.length));
          localStorage.setItem(METERED_SERVERS_STORE_KEY, JSON.stringify(ice_servers));
          if (typeof updateTurnBadge === 'function') updateTurnBadge();
          return ice_servers;
        }
        console.log('[TURN] No org ICE servers, falling through');
        // ice_servers === null means TURN not configured for this org → fall through
      } else {
        console.warn('[TURN] Org ICE fetch returned', res.status);
      }
    } catch (e) {
      console.warn('[TURN] Org ICE fetch failed, trying local config:', e.message);
    }
  } else {
    console.log('[TURN] presenceConfigured=false, skipping org ICE fetch');
  }

  // --- 2. Locally configured metered.ca credentials ---
  const appName = localStorage.getItem(METERED_APP_STORE_KEY);
  const apiKey  = localStorage.getItem(METERED_API_STORE_KEY);
  if (appName && apiKey) {
    try {
      const url = 'https://' + appName + '.metered.live/api/v1/turn/credentials?apiKey=' + apiKey;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const servers = await res.json();
      if (Array.isArray(servers) && servers.length > 0) {
        console.log('[TURN] Using', servers.length, 'ICE servers from local metered.ca config');
        return servers;
      }
    } catch (e) {
      console.warn('[TURN] Local metered.ca fetch failed, falling back to STUN:', e.message);
    }
  }

  // --- 3. STUN-only fallback ---
  return FALLBACK_ICE;
}

// --- State -------------------------------------------------------------------

const DEFAULT_SHORTCUT = 'Shift+Space';

// --- Audio feedback ----------------------------------------------------------

const _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Keep-alive: a near-silent looping audio source that prevents iOS from
// suspending the WKWebView's JS engine when the app goes to background.
// iOS only keeps a WebView alive if it has active audio output.
let _keepAliveSource = null;

function startKeepAlive() {
  if (_keepAliveSource) return;
  const ctx = _audioCtx;
  if (ctx.state === 'suspended') ctx.resume();
  // OscillatorNode produces real non-zero sine samples — iOS won't treat it as
  // silence and will keep the WKWebView JS engine running in background.
  const osc  = ctx.createOscillator();
  osc.type            = 'sine';
  osc.frequency.value = 20; // 20 Hz: subsonic, inaudible
  const gain = ctx.createGain();
  gain.gain.value = 0.001; // −60 dB, effectively silent
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  _keepAliveSource = osc;
}

function stopKeepAlive() {
  if (_keepAliveSource) {
    try { _keepAliveSource.stop(); } catch (_) {}
    _keepAliveSource = null;
  }
}

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

// Presence state
let presenceData     = []; // last fetched [{channel,connected}]
let activeChannel    = null; // channel name for the current presence session
let presenceInterval = null;

function updateRoomHeader() {
  $('room-code-display').textContent = activeChannel || roomCode;
}

// peerId -> { data, media, pseudo, talking }
const connections = new Map();

// Silently disable / re-enable all home-screen CTAs during a join/create action
function lockHomeCTAs() {
  ['btn-create','btn-join','input-code'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.style.pointerEvents = 'none';
  });
  var list = document.getElementById('channels-list');
  if (list) list.style.pointerEvents = 'none';
}
function unlockHomeCTAs() {
  ['btn-create','btn-join','input-code'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.style.pointerEvents = '';
  });
  var list = document.getElementById('channels-list');
  if (list) list.style.pointerEvents = '';
}

// Haptic feedback (Capacitor native, no-op in browser/Tauri)
function hapticLight() {
  try {
    const Haptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (Haptics) Haptics.impact({ style: 'LIGHT' });
  } catch (_) {}
}

// Loading state helper — disables el and shows a spinner label
function setLoading(el, on, originalLabel) {
  if (on) {
    el.disabled = true;
    el._origLabel = el.textContent;
    el.innerHTML = '<span class="btn-spinner"></span>' + (originalLabel || el._origLabel);
  } else {
    el.disabled = false;
    el.textContent = el._origLabel || el.textContent;
  }
}

// Clipboard fallback for iOS WKWebView where navigator.clipboard may be unavailable
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
}

// iOS PushToTalk framework bridge (iOS 16+, no-op elsewhere)
const PTT = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PTTPlugin;

function nativePTTJoin(roomName) {
  if (PTT) PTT.join({ roomName }).catch(function(e) { console.warn('[PTT join]', e); });
}
function nativePTTLeave() {
  if (PTT) PTT.leave().catch(function(e) { console.warn('[PTT leave]', e); });
}
function nativePTTStart() {
  if (PTT) PTT.startTransmitting().catch(function(e) { console.warn('[PTT start]', e); });
}
function nativePTTStop() {
  if (PTT) PTT.stopTransmitting().catch(function(e) { console.warn('[PTT stop]', e); });
}

// --- DOM helpers -------------------------------------------------------------

const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  if (name === 'home') startPresencePolling();
  else                 stopPresencePolling();
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

  // Notify the parent iframe of the current peer list
  if (_isIframe && inRoom) {
    var peers = [{ id: peer ? peer.id : 'self', pseudo: myPseudo || 'You', self: true, talking: isTalking || freeHandMode }];
    connections.forEach(function(conn, id) {
      peers.push({ id: id, pseudo: conn.pseudo || shortId(id), self: false, talking: conn.talking || false });
    });
    iframeEmit({ type: 'peers', peers: peers });
  }
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
  // Normalise legacy webkit prefix (some older iOS/Android WebViews)
  const getUserMedia = (
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : (navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)
          ? function(c) {
              return new Promise(function(res, rej) {
                (navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)
                  .call(navigator, c, res, rej);
              });
            }
          : null
  );
  if (!getUserMedia) throw new Error('Microphone access is not available in this environment.');
  return getUserMedia({
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
  // Notify the iOS PTT framework → updates Dynamic Island transmit indicator
  if (active) nativePTTStart(); else nativePTTStop();
  audioTrack.enabled = active;
  $('ptt-btn').classList.toggle('active', active);
  $('ptt-status').textContent = active ? '\u25cf Transmitting\u2026' : '';
  updateSelfTalking(active);
  broadcastTalkingState(active);
  iframeEmit({ type: 'talking', active: active });
  // Request/release audio focus on Android
  if (active) requestAudioFocus(); else releaseAudioFocus();
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
  if (!active) $('ptt-btn').classList.remove('active');

  if (active) {
    var isMobile = window.Capacitor && window.Capacitor.isNativePlatform();
    if (isMobile) {
      $('ptt-hint').textContent = 'Free hand · tap to stop';
    } else {
      $('ptt-hint').innerHTML = 'Free hand · press <kbd id="shortcut-hint-kbd">' + displayShortcut(shortcutStr) + '</kbd> to stop';
    }
    $('ptt-status').textContent = '\u25cf Live';
  } else {
    var isMobile = window.Capacitor && window.Capacitor.isNativePlatform();
    if (isMobile) {
      $('ptt-hint').textContent = 'Hold to talk · double-tap for free hand';
    } else {
      $('ptt-hint').innerHTML = 'Hold <kbd id="shortcut-hint-kbd">' + displayShortcut(shortcutStr) + '</kbd> anywhere to talk · x2 for free hand';
    }
    $('ptt-status').textContent = '';
  }

  updateSelfTalking(active);
  broadcastTalkingState(active);
  // Request/release audio focus on Android
  if (active) requestAudioFocus(); else releaseAudioFocus();
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
  releaseAudioFocus();
  nativePTTLeave();
  stopKeepAlive();
  if (activeChannel) { deleteSession(); activeChannel = null; }
  Array.from(connections.keys()).forEach(removePeer);
  if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
  if (peer) peer.destroy();
  peer = null; stream = null; audioTrack = null;
  isHost = false; roomCode = '';
  document.querySelectorAll('audio[id^="audio-"]').forEach(function(el) { el.remove(); });
  iframeEmit({ type: 'left' });
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
  updateRoomHeader();
  updatePeerList();
  // peer.on('connection') is already wired in joinRoom() and will route here
  // since isHost is now true
}

function connectToNewHost(newHostId) {
  roomCode = newHostId;
  updateRoomHeader();

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

async function createRoom(onJoined) {
  stream = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;
  const iceServers = await fetchIceServers();
  peer = new Peer({ config: { iceServers } });
  peer.on('open', function(id) {
    isHost = true; roomCode = id; inRoom = true;
    updateRoomHeader();
    nativePTTJoin(id);
    startKeepAlive();
    showScreen('room');
    updatePeerList();
    updateShortcutDisplay();
    iframeEmit({ type: 'joined', roomCode: id, peerId: id });
    if (onJoined) onJoined(id);
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

async function joinRoom(code, onJoined) {
  if (!code) return;
  stream = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;
  const iceServers = await fetchIceServers();
  peer = new Peer({ config: { iceServers } });
  peer.on('open', function() {
    roomCode = code;
    if (onJoined) onJoined(peer.id); // register presence as soon as we have our peer_id
    const hostData = peer.connect(code, { reliable: true });

    hostData.on('open', function() {
      hostData.send({ type: 'hello', pseudo: myPseudo || 'Anonymous' });
      isHost = false; inRoom = true;
      connections.set(code, { data: hostData, media: null, pseudo: shortId(code), talking: false });
      updateRoomHeader();
      nativePTTJoin(code);
      startKeepAlive();
      showScreen('room');
      updatePeerList();
      updateShortcutDisplay();
      iframeEmit({ type: 'joined', roomCode: code, peerId: peer.id });
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

// --- Presence UI ------------------------------------------------------------

function renderPresenceChannels() {
  const list = $('channels-list');
  if (!presenceData.length) {
    list.innerHTML = '<p class="presence-empty">No channels found.</p>';
    return;
  }
  list.innerHTML = '';
  presenceData.forEach(function(item, idx) {
    const ch        = item.channel;
    const connected = item.connected || [];
    const names     = connected.map(function(c) { return c.display_name || 'Anonymous'; }).join(', ');
    const div       = document.createElement('div');
    div.className   = 'channel-item';
    div.setAttribute('role', 'button');
    div.tabIndex    = 0;
    div.innerHTML =
      '<div class="channel-info">' +
        '<span class="channel-name">' + ch.name + '</span>' +
        (names ? '<span class="channel-members">' + names + '</span>' : '') +
      '</div>' +
      (connected.length ? '<span class="channel-count">' + connected.length + '</span>' : '') +
      '<span class="channel-join-icon">›</span>';
    function handleJoin() {
      if (div.classList.contains('loading')) return;
      div.classList.add('loading');
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      lockHomeCTAs();
      joinChannel(presenceData[idx]).catch(function(err) { showError(err.message); }).finally(function() { div.classList.remove('loading'); unlockHomeCTAs(); });
    }
    div.addEventListener('click', handleJoin);
    div.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleJoin(); } });
    list.appendChild(div);
  });
}

async function refreshPresence() {
  if (!presenceConfigured()) return;
  const list = $('channels-list');
  try {
    presenceData = await fetchPresence();
    renderPresenceChannels();
  } catch (e) {
    list.innerHTML = '<p class="presence-error">' + e.message + '</p>';
  }
}

function startPresencePolling() {
  stopPresencePolling();
  if (!presenceConfigured()) { $('presence-panel').classList.add('hidden'); return; }
  $('presence-panel').classList.remove('hidden');
  $('channels-list').innerHTML = '<p class="presence-loading">Loading…</p>';
  refreshPresence();
  presenceInterval = setInterval(refreshPresence, 15000);
}

function stopPresencePolling() {
  if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
}

// Called after auth completes (deep link or postMessage). Picks the best org
// and starts presence polling — works whether or not the settings modal is open.
async function selectOrgAndStartPolling() {
  try {
    const orgs      = await fetchOrgs();
    var savedOrgId  = presenceOrgId();
    var validSaved  = orgs.find(function(o) { return o.id === savedOrgId; });
    var bestOrgId   = validSaved ? savedOrgId : (orgs.length > 0 ? orgs[0].id : '');
    if (bestOrgId) localStorage.setItem(PRESENCE_ORG_KEY, bestOrgId);
    // If modal is open, sync its select element
    var select = document.getElementById('select-presence-org');
    if (select && !document.getElementById('modal-settings').classList.contains('hidden')) {
      select.innerHTML = '<option value="">— select organisation —</option>' +
        orgs.map(function(o) {
          var label = o.name + (o.role === 'admin' ? ' ★' : '');
          return '<option value="' + o.id + '"' + (o.id === bestOrgId ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
    }
    if (presenceConfigured()) {
      stopPresencePolling();
      startPresencePolling();
      fetchIceServers().catch(function(e) { console.warn('[ICE] prefetch failed:', e.message); });
    }
  } catch (e) {
    console.error('[Auth] selectOrgAndStartPolling failed:', e.message);
  }
}

async function joinChannel(item) {
  const connected    = item.connected || [];
  activeChannel      = item.channel.name;
  const postPresence = function(peerId) {
    postSession(activeChannel, peerId).catch(function(e) {
      console.warn('[Presence] session registration failed:', e.message);
    });
  };
  if (connected.length === 0) {
    await createRoom(postPresence);
  } else {
    const hostId = connected.map(function(c) { return c.peer_id; }).sort()[0];
    await joinRoom(hostId, postPresence);
  }
}

// --- Bootstrap ---------------------------------------------------------------

window.addEventListener('DOMContentLoaded', function() {

  // Pseudo: hide the home-screen name field once the user has set a name
  // Hide the home pseudo field only if a name was already set at load time.
  // Once visible in a session, it stays visible regardless of edits.
  if (myPseudo) $('pseudo-field-home').style.display = 'none';
  $('input-pseudo').value = myPseudo;
  $('input-pseudo').addEventListener('input', function(e) {
    myPseudo = e.target.value.trim();
    localStorage.setItem('pseudo', myPseudo);
    if (inRoom) updatePeerList();
  });

  // Connect button: visible only when NOT logged in
  window.updateConnectVisibility = function updateConnectVisibility() {
    var connected = !!presenceToken();
    var btnMain = document.getElementById('btn-connect-voxal-home');
    var btnSettings = document.getElementById('btn-connect-voxal');
    if (btnMain)     btnMain.style.display     = connected ? 'none' : '';
    if (btnSettings) btnSettings.style.display = connected ? 'none' : '';
  }

  // Disconnect row: visible only when token is set
  window.updateDisconnectVisibility = function updateDisconnectVisibility() {
    var row = $('disconnect-row');
    if (row) row.style.display = presenceToken() ? '' : 'none';
  }
  updateDisconnectVisibility(); updateConnectVisibility();

  // --- Theme toggle ---
  const THEME_KEY = 'theme';
  function applyTheme(val) {
    document.documentElement.setAttribute('data-theme', val || 'system');
    var toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('button[data-theme]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.theme === (val || 'system'));
    });
  }
  applyTheme(localStorage.getItem(THEME_KEY) || 'system');
  var themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', function(e) {
      var btn = e.target.closest('button[data-theme]');
      if (!btn) return;
      var val = btn.dataset.theme;
      localStorage.setItem(THEME_KEY, val);
      applyTheme(val);
    });
  }

  // Clear (×) buttons inside .input-clearable wrappers
  document.querySelectorAll('.input-clear').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = document.getElementById(btn.dataset.target);
      if (!target) return;
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.focus();
    });
  });

  if (window.__TAURI__ && shortcutStr !== DEFAULT_SHORTCUT) {
    window.__TAURI__.core.invoke('update_ptt_shortcut', { shortcut: shortcutStr })
      .catch(function() { shortcutStr = DEFAULT_SHORTCUT; localStorage.removeItem('ptt-shortcut'); });
  }
  updateShortcutDisplay();

  // Capacitor: extend WebView behind Dynamic Island with light status-bar icons
  const CapStatusBar = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
  if (CapStatusBar) {
    CapStatusBar.setOverlaysWebView({ overlay: true });
    CapStatusBar.setStyle({ style: 'DARK' }); // light icons on dark background
  }

  // Hide shortcut UI on native mobile — no keyboard shortcuts on touch devices
  const isNativeMobile = window.Capacitor && window.Capacitor.isNativePlatform();
  if (isNativeMobile) {
    document.body.classList.add('platform-mobile');
    $('shortcut-normal').style.display   = 'none';
    $('shortcut-recording').style.display = 'none';
    $('shortcut-spacer').style.display   = 'none';
    $('ptt-hint').textContent = 'Hold to talk · double-tap for free hand';
    $('btn-copy').title = 'Share room code';
  }

  $('btn-create').addEventListener('click', function() {
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    var btn = $('btn-create');
    setLoading(btn, true, 'Create Room');
    lockHomeCTAs();
    createRoom().catch(function(err) { showError(err.message); }).finally(function() { setLoading(btn, false); unlockHomeCTAs(); });
  });
  $('btn-join').addEventListener('click', function() {
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    var btn = $('btn-join');
    setLoading(btn, true, 'Join');
    lockHomeCTAs();
    joinRoom($('input-code').value.trim()).catch(function(err) { showError(err.message); }).finally(function() { setLoading(btn, false); unlockHomeCTAs(); });
  });
  $('input-code').addEventListener('keydown', function(e) { if (e.key === 'Enter') $('btn-join').click(); });

  // TURN settings modal
  function connStatusHTML() {
    const turnStatus = localStorage.getItem(METERED_STATUS_STORE_KEY);
    const turnCount  = localStorage.getItem(METERED_COUNT_STORE_KEY);
    const turnLine = turnStatus === 'ok'
      ? '<span class="cs-ok">✓</span> TURN — ' + (turnCount ? turnCount + ' servers' : 'configured')
      : turnStatus === 'error'
      ? '<span class="cs-err">✕</span> TURN error'
      : '<span class="cs-muted">—</span> TURN not configured';

    const voxalLine = presenceToken()
      ? '<span class="cs-ok">✓</span> Voxal Connect — ' + (function() {
          var total = 0;
          presenceData.forEach(function(item) { total += (item.connected || []).length; });
          return total + ' user' + (total !== 1 ? 's' : '') + ' online';
        })()
      : '<span class="cs-muted">—</span> Not connected to Voxal';

    return '<div class="cs-row">' + voxalLine + '</div>' +
           '<div class="cs-row"><span class="cs-ok">✓</span> STUN available</div>' +
           '<div class="cs-row">' + turnLine + '</div>';
  }

  window.updateTurnBadge = function updateTurnBadge() {
    const online     = navigator.onLine;
    const turnStatus = localStorage.getItem(METERED_STATUS_STORE_KEY);
    const badge      = $('turn-badge');
    badge.classList.remove('ok', 'partial');
    if (!online) {
      // red (default) — no connection possible
    } else if (turnStatus === 'ok') {
      badge.classList.add('ok');      // green — STUN + TURN
    } else {
      badge.classList.add('partial'); // orange — STUN only
    }
    var content = document.getElementById('conn-status-content');
    if (content) content.innerHTML = connStatusHTML();
  }

  // Show/hide the connection status popover
  var popoverOpen = false;
  function showConnPopover() {
    var content = document.getElementById('conn-status-content');
    if (content) content.innerHTML = connStatusHTML();
    document.getElementById('conn-status-popover').classList.remove('hidden');
    popoverOpen = true;
  }
  function hideConnPopover() {
    document.getElementById('conn-status-popover').classList.add('hidden');
    popoverOpen = false;
  }
  var settingsBtn = $('btn-open-settings');
  settingsBtn.addEventListener('mouseenter', showConnPopover);
  settingsBtn.addEventListener('mouseleave', hideConnPopover);
  settingsBtn.addEventListener('click', function() {
    if (popoverOpen) hideConnPopover(); else showConnPopover();
  });
  var turnBadge = $('turn-badge');
  turnBadge.addEventListener('click', function() {
    if (popoverOpen) hideConnPopover(); else showConnPopover();
  });
  turnBadge.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (popoverOpen) hideConnPopover(); else showConnPopover(); } });

  async function testTurnCredentials() {
    const appName = $('input-metered-app').value.trim();
    const apiKey  = $('input-metered-key').value.trim();
    const statusEl = $('turn-test-status');
    const btn      = $('btn-test-turn');

    if (!appName || !apiKey) {
      statusEl.style.color = '';
      statusEl.textContent = 'Enter app name and API key first.';
      return;
    }

    btn.disabled = true;
    statusEl.style.color = '';
    statusEl.textContent = 'Testing…';

    try {
      const url = 'https://' + appName + '.metered.live/api/v1/turn/credentials?apiKey=' + apiKey;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const servers = await res.json();
      if (!Array.isArray(servers) || servers.length === 0) throw new Error('No servers returned');
      localStorage.setItem(METERED_STATUS_STORE_KEY, 'ok');
      localStorage.setItem(METERED_COUNT_STORE_KEY, String(servers.length));
      localStorage.setItem(METERED_SERVERS_STORE_KEY, JSON.stringify(servers));
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = '✓ ' + servers.length + ' servers ready';
    } catch (e) {
      localStorage.setItem(METERED_STATUS_STORE_KEY, 'error');
      localStorage.removeItem(METERED_COUNT_STORE_KEY);
      localStorage.removeItem(METERED_SERVERS_STORE_KEY);
      statusEl.style.color = '#fb923c';
      statusEl.textContent = '✕ ' + e.message;
    }

    btn.disabled = false;
    updateTurnBadge();
    if (localStorage.getItem(METERED_STATUS_STORE_KEY) === 'ok') wireStatusHover(statusEl);
  }

  function wireStatusHover(el) {
    el.style.cursor = 'help';
    el.onmouseenter = function() {
      var raw = localStorage.getItem(METERED_SERVERS_STORE_KEY);
      if (!raw) return;
      try { showTurnServersPopover(el, JSON.parse(raw)); } catch(e) {}
    };
    el.onmouseleave = hideTurnServersPopover;
  }

  function showTurnServersPopover(anchor, servers) {
    var pop = document.getElementById('turn-servers-popover');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'turn-servers-popover';
      pop.className = 'turn-servers-popover';
      document.body.appendChild(pop);
    }
    pop.innerHTML = servers.map(function(s) {
      var urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.map(function(u) { return '<div class="tsrv-row">' + u + '</div>'; }).join('');
    }).join('');
    var rect = anchor.getBoundingClientRect();
    pop.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = (rect.left  + window.scrollX) + 'px';
    pop.classList.remove('hidden');
  }

  function hideTurnServersPopover() {
    var pop = document.getElementById('turn-servers-popover');
    if (pop) pop.classList.add('hidden');
  }

  let _prefsWin = null; // track the Tauri preferences window

  function openSettings() {
    // On Tauri desktop: try to open / focus a dedicated preferences window
    if (window.__TAURI__) {
      try {
        const { WebviewWindow } = window.__TAURI__.webviewWindow;
        if (_prefsWin) {
          _prefsWin.setFocus().catch(function() {
            _prefsWin = null;
            openSettings(); // retry — window was closed
          });
          return;
        }
        const win = new WebviewWindow('preferences', {
          url: 'settings.html',
          title: 'Voxal — Preferences',
          width: 420,
          height: 720,
          resizable: true,
          center: true,
        });
        _prefsWin = win;
        win.once('tauri://destroyed', function() { _prefsWin = null; });
        return;
      } catch (e) {
        console.warn('[Settings] Could not open preferences window, using modal:', e.message);
      }
    }
    // Web / mobile (or Tauri fallback): use the in-app modal
    $('input-pseudo').value         = myPseudo;
    $('input-service-url').value    = localStorage.getItem(SERVICE_URL_KEY) || 'https://vybzjzwsqrggatcrnqxe.supabase.co/functions/v1/session';
    $('input-metered-app').value    = localStorage.getItem(METERED_APP_STORE_KEY) || '';
    $('input-metered-key').value    = localStorage.getItem(METERED_API_STORE_KEY) || '';
    $('input-presence-token').value = presenceToken();
    // Restore saved TURN test result
    var savedTurnStatus = localStorage.getItem(METERED_STATUS_STORE_KEY);
    var savedTurnCount  = localStorage.getItem(METERED_COUNT_STORE_KEY);
    var statusEl = $('turn-test-status');
    if (savedTurnStatus === 'ok' && savedTurnCount) {
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = '✓ ' + savedTurnCount + ' servers ready';
      wireStatusHover(statusEl);
    } else if (savedTurnStatus === 'error') {
      statusEl.style.color = '#fb923c';
      statusEl.textContent = '✕ Test failed';
      statusEl.onmouseenter = null;
    } else {
      statusEl.textContent = '';
      statusEl.onmouseenter = null;
    }
    updateDisconnectVisibility(); updateConnectVisibility();
    $('modal-settings').classList.remove('hidden');
    if (presenceToken()) loadOrgs();
  }
  function closeSettings() {
    $('modal-settings').classList.add('hidden');
    startPresencePolling(); // refresh in case org changed
  }

  function disconnectAccount() {
    const token = presenceToken();
    if (token) deleteSession();
    localStorage.removeItem(PRESENCE_TOKEN_KEY);
    localStorage.removeItem(PRESENCE_ORG_KEY);
    $('input-presence-token').value = '';
    $('select-presence-org').innerHTML = '<option value="">— enter API token first —</option>';
    $('select-presence-org').disabled = true;
    $('org-load-status').textContent  = '';
    stopPresencePolling();
    renderPresenceChannels([]);
    updateDisconnectVisibility(); updateConnectVisibility();
    // Stay in settings — navigate home in background
    if (inRoom) leaveRoom();
    showScreen('home');
  }

  async function loadOrgs() {
    const select    = $('select-presence-org');
    const statusEl  = $('org-load-status');
    select.disabled = true;
    statusEl.textContent = 'Loading…';
    statusEl.style.color = '';
    try {
      const orgs       = await fetchOrgs();
      var savedOrgId   = presenceOrgId();
      var validSaved   = orgs.find(function(o) { return o.id === savedOrgId; });
      var currentOrgId = validSaved ? savedOrgId : (orgs.length > 0 ? orgs[0].id : '');
      if (currentOrgId) localStorage.setItem(PRESENCE_ORG_KEY, currentOrgId);
      select.innerHTML = '<option value="">— select organisation —</option>' +
        orgs.map(function(o) {
          var label = o.name + (o.role === 'admin' ? ' ★' : '');
          return '<option value="' + o.id + '"' + (o.id === currentOrgId ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
      statusEl.textContent = '';
      if (presenceConfigured()) {
        stopPresencePolling();
        startPresencePolling();
        fetchIceServers().catch(function(e) { console.warn('[ICE] prefetch failed:', e.message); });
      }
    } catch (e) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = e.message;
    }
    select.disabled = false;
  }

  updateTurnBadge();
  $('input-service-url').addEventListener('input', function(e) {
    var val = e.target.value.trim();
    if (val) localStorage.setItem(SERVICE_URL_KEY, val);
    else localStorage.removeItem(SERVICE_URL_KEY);
  });
  $('input-metered-app').addEventListener('input', function(e) {
    localStorage.setItem(METERED_APP_STORE_KEY, e.target.value.trim());
    localStorage.removeItem(METERED_STATUS_STORE_KEY);
    $('turn-test-status').textContent = '';
    updateTurnBadge();
  });
  $('input-metered-key').addEventListener('input', function(e) {
    localStorage.setItem(METERED_API_STORE_KEY, e.target.value.trim());
    localStorage.removeItem(METERED_STATUS_STORE_KEY);
    $('turn-test-status').textContent = '';
    updateTurnBadge();
  });
  $('btn-open-settings').addEventListener('click', function() {
    // On desktop (gear hidden) the button only drives the popover — handled above.
    // On web/mobile, open settings (popover is shown via mouseenter/tap separately).
    if (!window.__TAURI__) openSettings();
  });
  // On desktop the native menu handles settings — hide the gear icon,
  // but keep the button visible so the TURN status LED remains.
  if (window.__TAURI__) {
    var gearIcon = document.querySelector('#btn-open-settings .gear-icon');
    if (gearIcon) gearIcon.style.display = 'none';
    $('btn-open-settings').style.cursor = 'default';
    $('btn-open-settings').title = '';
  }
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-close-settings-footer').addEventListener('click', closeSettings);
  $('modal-backdrop').addEventListener('click', closeSettings);
  $('btn-test-turn').addEventListener('click', testTurnCredentials);
  $('btn-disconnect').addEventListener('click', disconnectAccount);
  $('btn-connect-voxal').addEventListener('click', connectWithVoxalAccount);

  // iOS: deep link comes back via @capacitor/app appUrlOpen
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    var CapApp = window.Capacitor.Plugins.App;
    CapApp.addListener('appUrlOpen', function(data) {
      if (data && data.url) handleDeepLink(data.url);
    });
    // Handle cold-launch via deep link
    CapApp.getLaunchUrl().then(function(data) {
      if (data && data.url) handleDeepLink(data.url);
    }).catch(function() {});
  }

  // Tauri: "Voxal → Preferences…" menu item
  if (window.__TAURI__) {
    window.__TAURI__.event.listen('open-preferences', openSettings);
  }

  // Cross-window sync: when settings.html (Tauri preferences window) writes to
  // localStorage, the main window receives a storage event and refreshes.
  window.addEventListener('storage', function(e) {
    if (e.key === THEME_KEY) {
      applyTheme(e.newValue || 'system');
      return;
    }
    if (e.key === 'pseudo') {
      myPseudo = e.newValue || '';
      $('input-pseudo').value = myPseudo;
      if (inRoom) updatePeerList();
      return;
    }
    var relevantKeys = [PRESENCE_TOKEN_KEY, PRESENCE_ORG_KEY, METERED_APP_STORE_KEY,
                        METERED_API_STORE_KEY, METERED_STATUS_STORE_KEY];
    if (relevantKeys.indexOf(e.key) === -1) return;
    updateTurnBadge();
    if (e.key === PRESENCE_TOKEN_KEY || e.key === PRESENCE_ORG_KEY) {
      updateDisconnectVisibility(); updateConnectVisibility();
      stopPresencePolling();
      if (presenceConfigured()) {
        startPresencePolling();
      } else {
        renderPresenceChannels([]);
        if (inRoom) leaveRoom();
        showScreen('home');
      }
    }
  });

  window.addEventListener('online',  updateTurnBadge);
  window.addEventListener('offline', updateTurnBadge);

  // iframe postMessage: receive commands from the parent page
  if (_isIframe) {
    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'auth' && msg.token) {
        // Portal passes its session token (and optionally orgId) so the user
        // doesn't have to go through the OAuth popup while already logged in.
        localStorage.setItem(PRESENCE_TOKEN_KEY, msg.token);
        if (msg.orgId) localStorage.setItem(PRESENCE_ORG_KEY, msg.orgId);
        updateDisconnectVisibility(); updateConnectVisibility();
        selectOrgAndStartPolling();
      } else if (msg.type === 'join' && msg.roomCode) {
        if (_audioCtx.state === 'suspended') _audioCtx.resume();
        if (inRoom) leaveRoom();
        joinRoom(String(msg.roomCode)).catch(function(err) { iframeEmit({ type: 'error', message: err.message }); });
      } else if (msg.type === 'create') {
        if (_audioCtx.state === 'suspended') _audioCtx.resume();
        if (inRoom) leaveRoom();
        createRoom().catch(function(err) { iframeEmit({ type: 'error', message: err.message }); });
      } else if (msg.type === 'leave') {
        if (inRoom) leaveRoom();
      }
    });
    // Signal readiness so the parent knows it's safe to send the auth command
    iframeEmit({ type: 'ready' });
  }

  // Presence credentials
  $('input-presence-token').addEventListener('input', function(e) {
    localStorage.setItem(PRESENCE_TOKEN_KEY, e.target.value.trim());
    localStorage.removeItem(PRESENCE_ORG_KEY);
    $('select-presence-org').innerHTML = '<option value="">— select organisation —</option>';
    $('select-presence-org').disabled = true;
    $('org-load-status').textContent = '';
    updateDisconnectVisibility(); updateConnectVisibility();
  });
  $('input-presence-token').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && presenceToken()) loadOrgs();
  });
  $('input-presence-token').addEventListener('blur', function() {
    if (presenceToken()) loadOrgs();
  });
  $('select-presence-org').addEventListener('change', function(e) {
    localStorage.setItem(PRESENCE_ORG_KEY, e.target.value);
  });
  $('btn-refresh-presence').addEventListener('click', refreshPresence);

  // Start presence polling on load (if configured)
  startPresencePolling();
  $('btn-copy').addEventListener('click', function() {
    var text = roomCode;
    var toast = $('copy-toast');
    function showToast() {
      toast.classList.add('visible');
      clearTimeout($('btn-copy')._toastTimer);
      $('btn-copy')._toastTimer = setTimeout(function() { toast.classList.remove('visible'); }, 1500);
    }
    // On native mobile, open the system share sheet with a deep link
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
      var shareUrl = 'voxal://join?room=' + encodeURIComponent(text);
      if (navigator.share) {
        navigator.share({ title: 'Join my Voxal room', text: shareUrl }).catch(function(e) { console.warn('[Share]', e); });
      } else {
        fallbackCopy(shareUrl); showToast();
      }
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showToast).catch(function() { fallbackCopy(text); showToast(); });
    } else {
      fallbackCopy(text); showToast();
    }
  });
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-back').addEventListener('click', function() { showScreen('home'); });

  const pttBtn = $('ptt-btn');
  var lastPttTapTime = 0;
  var DOUBLE_TAP_MS  = 300;
  var ignorePttUp    = false;

  pttBtn.addEventListener('pointerdown', function(e) {
    e.preventDefault();
    pttBtn.setPointerCapture(e.pointerId);
    var now = Date.now();
    if (now - lastPttTapTime < DOUBLE_TAP_MS) {
      lastPttTapTime = 0;
      ignorePttUp = true;
      setFreeHand(true);
      return;
    }
    if (freeHandMode) {
      pttBtn.classList.add('active'); // visual press feedback while free hand is on
    } else {
      setTalking(true);
    }
  });
  pttBtn.addEventListener('pointerup', function(e) {
    if (ignorePttUp) { ignorePttUp = false; return; }
    lastPttTapTime = Date.now();
    if (freeHandMode) setFreeHand(false);
    else setTalking(false);
  });
  pttBtn.addEventListener('pointercancel', function(e) {
    ignorePttUp = false;
    lastPttTapTime = 0;
    if (freeHandMode) setFreeHand(false);
    else setTalking(false);
  });

  $('btn-freehand').addEventListener('click', function() { setFreeHand(!freeHandMode); });
  $('btn-edit-shortcut').addEventListener('click', startRecordingShortcut);
  $('btn-cancel-shortcut').addEventListener('click', stopRecordingShortcut);

  var lastSpaceRelease = 0;
  var ignoreSpaceUp = false;
  document.addEventListener('keydown', function(e) {
    // Close settings modal on Enter or Escape (takes priority over everything)
    if (!$('modal-settings').classList.contains('hidden')) {
      if (e.key === 'Escape') { closeSettings(); e.preventDefault(); }
      if (e.key === 'Enter') {
        const fields = [$('input-metered-app'), $('input-metered-key'), $('input-presence-token'), $('select-presence-org')];
        const idx = fields.indexOf(document.activeElement);
        if (idx >= 0 && idx < fields.length - 1) { fields[idx + 1].focus(); }
        else { closeSettings(); }
        e.preventDefault();
      }
      if (e.key === 'Tab') {
        const fields = [$('input-metered-app'), $('input-metered-key'), $('input-presence-token'), $('select-presence-org')];
        const idx  = fields.indexOf(document.activeElement);
        const next = e.shiftKey ? (idx - 1 + fields.length) : (idx + 1);
        fields[next % fields.length].focus();
        e.preventDefault();
      }
      return; // don't process PTT or shortcuts while modal is open
    }
    if (recordingShortcut) { e.preventDefault(); const s = shortcutFromEvent(e); if (s) applyNewShortcut(s); return; }
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      var now = Date.now();
      if (now - lastSpaceRelease < DOUBLE_TAP_MS) {
        lastSpaceRelease = 0;
        ignoreSpaceUp = true;
        setFreeHand(!freeHandMode);
      } else if (freeHandMode) {
        $('ptt-btn').classList.add('active');
      } else {
        setTalking(true);
      }
      return;
    }
    if (e.code === 'Enter' && !e.repeat && inRoom) { setFreeHand(!freeHandMode); e.preventDefault(); return; }
    if (matchesShortcut(e) && !e.repeat) { setTalking(true);                                          e.preventDefault(); }
  });
  document.addEventListener('keyup', function(e) {
    if (e.code === 'Space') {
      if (ignoreSpaceUp) { ignoreSpaceUp = false; return; }
      lastSpaceRelease = Date.now();
      if (freeHandMode) {
        $('ptt-btn').classList.remove('active');
        setFreeHand(false);
      } else {
        setTalking(false);
      }
      return;
    }
    if (keyCodeOf(shortcutStr) === e.code) setTalking(false);
  });

  // Tauri-only: global shortcut works even when app is in background
  if (window.__TAURI__) {
    const listen = window.__TAURI__.event.listen;
    var lastTauriRelease = 0;
    var ignoreTauriRelease = false;
    listen('ptt-press', function() {
      if (recordingShortcut) return;
      var now = Date.now();
      if (now - lastTauriRelease < DOUBLE_TAP_MS) {
        // Double-press: toggle free hand mode (same as double-tap on mobile)
        lastTauriRelease = 0;
        ignoreTauriRelease = true;
        setFreeHand(!freeHandMode);
        return;
      }
      if (freeHandMode) {
        // In free hand mode: shortcut acts as PTT override (mic already on — just show visual feedback)
        $('ptt-btn').classList.add('active');
      } else {
        setTalking(true);
      }
    });
    listen('ptt-release', function() {
      if (recordingShortcut) return;
      if (ignoreTauriRelease) { ignoreTauriRelease = false; return; }
      lastTauriRelease = Date.now();
      if (freeHandMode) {
        // Release while in free hand mode: turn off free hand (mic goes silent)
        $('ptt-btn').classList.remove('active');
        setFreeHand(false);
      } else {
        setTalking(false);
      }
    });
  }

  // iOS PushToTalk framework: Dynamic Island / Lock Screen button events
  if (PTT) {
    PTT.addListener('ptt-press',   function() { setTalking(true);  });
    PTT.addListener('ptt-release', function() { setTalking(false); });
    PTT.addListener('ptt-error',   function(e) { console.warn('[PTT]', e.message); });
  }

  // Resume audio context and keep-alive when app returns to foreground
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      if (inRoom) startKeepAlive();
    }
  });
});
