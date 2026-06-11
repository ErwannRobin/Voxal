/* voxal – main.js
 *
 * Topology:
 *   Signaling : star (host ↔ each peer via DataConnection)
 *   Audio     : full mesh (every peer ↔ every peer via MediaConnection / Opus)
 *
 * Data protocol:
 *   hello        { pseudo }                       joiner -> host on connect
 *   peer-list    { peers:[{id,pseudo}],            host -> joiner (reply to hello)
 *                  hostId, hostPseudo, deputyId, successorIds }
 *   peer-joined  { peerId, pseudo }               host -> all existing peers
 *   peer-left    { peerId }                       host -> all
 *   talking      { peerId, active }               non-host -> host (relayed to all)
 *   pseudo       { pseudo }                        non-host -> host (relayed as peer-renamed)
 *   peer-renamed { peerId, pseudo }               host -> all
 *   heartbeat    { at, deputyId, successorIds }   host <-> peers
 *   redirect     { hostId, hostPseudo }          non-host -> misdirected joiner
 *   room-published { roomId }                   host -> all (lobby ID changed)
 *   video-mode   { enabled }                    host -> peer (toggle video mode, dev only)
 *   video-offer  { peerId }                     peer -> host (relayed) — peer started camera
 *   video-stop   { peerId }                     peer -> host (relayed) — peer stopped camera
 *
 * Host migration:
 *   When the host's DataConnection closes (or heartbeat times out), every peer runs
 *   `initiateHostMigration` which is idempotent and state-aware (`roomState`).
 *   The host publishes a sticky successor chain (`deputyId`, `successorIds`) in
 *   `peer-list` and heartbeat messages. On host loss, peers follow that authoritative
 *   chain instead of electing from local room state. The chosen successor calls
 *   `becomeHost()`; others call `connectToNewHost(newHostId)`.
 *   Migration succeeds only after the new host's authoritative `peer-list` arrives.
 *   Failed candidates are added to `_migrationExcluded` so later successors can take
 *   over. Audio MediaConnections to non-host peers are never touched, so audio
 *   survives the handoff.
 */

// --- TURN / ICE servers (metered.ca) ----------------------------------------

const METERED_APP_STORE_KEY    = 'metered-app-name';
const METERED_API_STORE_KEY    = 'metered-api-key';
const METERED_STATUS_STORE_KEY  = 'metered-status';  // 'ok' | 'error' | null
const METERED_COUNT_STORE_KEY   = 'metered-count';   // number of servers when ok
const METERED_SERVERS_STORE_KEY = 'metered-servers'; // JSON array of ICE server objects

const NOISE_SUPPRESSION_KEY = 'noise-suppression'; // 'rnnoise' | 'browser' | 'off'
const MIC_DEVICE_KEY        = 'mic-device-id';
const CAMERA_DEVICE_KEY     = 'camera-device-id';
const SPEAKER_DEVICE_KEY    = 'speaker-device-id';
const DEVICE_LABELS_KEY     = 'media-device-labels';

// --- Audio focus (Android) ---------------------------------------------------

async function requestAudioFocus() {
  if (!window.Capacitor?.isNativePlatform?.()) return;
  try {
    var plugin = window.Capacitor?.Plugins?.AudioForeground;
    if (!plugin || typeof plugin.start !== 'function') {
      console.warn('[AudioFocus] AudioForeground.start() unavailable');
      return;
    }
    await plugin.start();
  } catch (e) {
    console.warn('[AudioFocus] Failed to request:', e.message);
  }
}

async function releaseAudioFocus() {
  if (!window.Capacitor?.isNativePlatform?.()) return;
  try {
    var plugin = window.Capacitor?.Plugins?.AudioForeground;
    if (!plugin || typeof plugin.stop !== 'function') return;
    await plugin.stop();
  } catch (e) {
    console.warn('[AudioFocus] Failed to release:', e.message);
  }
}

// --- Presence API -----------------------------------------------------------

const DEFAULT_PRESENCE_BASE     = 'https://vybzjzwsqrggatcrnqxe.supabase.co/functions/v1/session';
const ANONYMOUS_ROOMS_BASE      = 'https://vybzjzwsqrggatcrnqxe.supabase.co/functions/v1/anonymous-rooms';
const DEFAULT_VOXAL_CONNECT_URL = 'https://voxal.lovable.app';
// Canonical web URL — used for invite links on native (Tauri/iOS) and for Universal Links
const VOXAL_WEB_URL             = 'https://ptt.voxal.app';
const PRESENCE_TOKEN_KEY        = 'presence-api-token';
const PRESENCE_ORG_KEY          = 'presence-org-id';
const SERVICE_URL_KEY           = 'service-url';
const PSEUDO_KEY                = 'pseudo';
const PSEUDO_SESSION_KEY        = 'pseudo-session';
const DEV_MODE_KEY              = 'dev-mode';
const VIDEO_MODE_KEY            = 'video-mode-enabled';
const REJOIN_SNAPSHOT_KEY       = 'rejoin-snapshot';
const REJOIN_TTL_MS             = 30 * 60 * 1000; // 30 minutes
var   _rejoinDismissed          = false;

function presenceBase()       { return (localStorage.getItem(SERVICE_URL_KEY) || DEFAULT_PRESENCE_BASE).replace(/\/$/, ''); }
function voxalConnectUrl()    { return localStorage.getItem('voxal-connect-url') || DEFAULT_VOXAL_CONNECT_URL; }
function presenceToken()      { return localStorage.getItem(PRESENCE_TOKEN_KEY) || ''; }
function presenceOrgId()      { return localStorage.getItem(PRESENCE_ORG_KEY)   || ''; }
function presenceConfigured() { return !!(presenceToken() && presenceOrgId()); }

function shouldPersistPseudoGlobally() {
  return !!window.__TAURI__ || !!window.Capacitor?.isNativePlatform?.();
}

function loadInitialPseudo() {
  var sessionPseudo = sessionStorage.getItem(PSEUDO_SESSION_KEY);
  if (sessionPseudo !== null) return sessionPseudo;

  var savedPseudo = localStorage.getItem(PSEUDO_KEY) || '';
  sessionStorage.setItem(PSEUDO_SESSION_KEY, savedPseudo);

  if (!shouldPersistPseudoGlobally()) {
    localStorage.removeItem(PSEUDO_KEY);
  }

  return savedPseudo;
}

// --- iframe postMessage bridge -----------------------------------------------
// When Voxal runs embedded inside a parent page's <iframe>, this bridge lets the
// parent control the room (join/create/leave) and observe state changes (talking,
// joined, left, peers, host-changed).  All messages are scoped to
// { source: 'voxal' }.
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
//   { source: 'voxal', type: 'host-changed', roomCode: '<peerId>', isSelf: true|false }

var _isIframe = (function() { try { return window.self !== window.top; } catch(e) { return true; } })();

function getAllowedParentOrigin() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var raw = params.get('parentOrigin');
    if (!raw) return window.location.origin;
    var parsed = new URL(raw, window.location.href);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch (_) {
    return window.location.origin;
  }
}

function iframeEmit(msg) {
  if (!_isIframe) return;
  var targetOrigin = getAllowedParentOrigin();
  if (!targetOrigin) return;
  window.parent.postMessage(Object.assign({ source: 'voxal' }, msg), targetOrigin);
}

// --- OAuth-style deep link auth ---------------------------------------------

function generateState() {
  if (typeof crypto !== 'undefined') {
    if (crypto.randomUUID) return crypto.randomUUID();
    if (crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
  }
  // Last-resort fallback for very old runtimes.
  return String(Date.now()) + '-' + String(performance.now());
}

function handleDeepLink(urlStr) {
  try {
    const url = new URL(urlStr);

    // ── Universal Links: https://ptt.voxal.app/*?room=<id> ───────────
    if (url.protocol === 'https:' && url.hostname === 'ptt.voxal.app') {
      const roomId = url.searchParams.get('room');
      if (roomId) {
        if (_audioCtx.state === 'suspended') _audioCtx.resume();
        var doJoinUL = function() {
          joinRoom(roomId).catch(function(err) { showError(err.message); });
        };
        if (inRoom) { leaveRoom(); setTimeout(doJoinUL, 150); }
        else { doJoinUL(); }
      }
      return;
    }

    if (url.protocol !== 'voxal:') return;

    if (url.hostname === 'join') {
      // voxal://join?room=<peerId or lobbyId>
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
    var secret = options && options.headers && options.headers['x-room-secret'];
    var body   = options && options.body || null;
    return window.__TAURI__.core.invoke('presence_fetch', {
      url: url, method: method,
      token: token || null,
      secret: secret || null,
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
    devLog('[ICE] Trying org servers…');
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
          devLog('[ICE] Org: ' + ice_servers.length + ' server(s) ✓');
          localStorage.setItem(METERED_STATUS_STORE_KEY, 'ok');
          localStorage.setItem(METERED_COUNT_STORE_KEY, String(ice_servers.length));
          localStorage.setItem(METERED_SERVERS_STORE_KEY, JSON.stringify(ice_servers));
          if (typeof updateTurnBadge === 'function') updateTurnBadge();
          return ice_servers;
        }
        console.log('[TURN] No org ICE servers, falling through');
        devLog('[ICE] Org: no servers configured, trying next…', 'warn');
        // ice_servers === null means TURN not configured for this org → fall through
      } else {
        console.warn('[TURN] Org ICE fetch returned', res.status);
        devLog('[ICE] Org fetch HTTP ' + res.status, 'warn');
      }
    } catch (e) {
      console.warn('[TURN] Org ICE fetch failed, trying local config:', e.message);
      devLog('[ICE] Org fetch failed: ' + e.message, 'warn');
    }
  } else {
    console.log('[TURN] presenceConfigured=false, skipping org ICE fetch');
  }

  // --- 2. Locally configured metered.ca credentials ---
  const appName = localStorage.getItem(METERED_APP_STORE_KEY);
  const apiKey  = localStorage.getItem(METERED_API_STORE_KEY);
  if (appName && apiKey) {
    devLog('[ICE] Trying metered.ca (' + appName + ')…');
    try {
      const url = 'https://' + appName + '.metered.live/api/v1/turn/credentials?apiKey=' + apiKey;
      const res = window.__TAURI__
        ? await tauriFetch(url)
        : await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const servers = await res.json();
      if (Array.isArray(servers) && servers.length > 0) {
        console.log('[TURN] Using', servers.length, 'ICE servers from local metered.ca config');
        devLog('[ICE] metered.ca: ' + servers.length + ' server(s) ✓');
        return servers;
      }
    } catch (e) {
      console.warn('[TURN] Local metered.ca fetch failed, falling back to STUN:', e.message);
      devLog('[ICE] metered.ca failed: ' + e.message, 'warn');
    }
  }

  // --- 3. STUN-only fallback ---
  devLog('[ICE] Using STUN-only fallback', 'warn');
  return FALLBACK_ICE;
}

// --- State -------------------------------------------------------------------

const IS_TAURI_DESKTOP = !!window.__TAURI__;
const IS_NATIVE_MOBILE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const IS_PLAIN_WEB     = !IS_TAURI_DESKTOP && !IS_NATIVE_MOBILE;
const DEFAULT_SHORTCUT = IS_PLAIN_WEB ? 'Space' : 'Shift+Space';

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
let connectingToHostId = null;
let isTalking         = false;
let freeHandMode      = false;
let recordingShortcut = false;
let myPseudo          = loadInitialPseudo();
let editingSelfPseudo = false;
let _cancelJoin       = null; // set during joinRoom(), called by Cancel button

// --- Video prototype (dev mode, 1:1) -----------------------------------------
localStorage.setItem(VIDEO_MODE_KEY, 'true');
var videoModeEnabled  = true;
var localVideoActive  = false;   // this peer is sharing their camera
var localVideoStream  = null;    // MediaStream (video only)
var localScreenActive = false;   // this peer is sharing their screen
var localScreenStream = null;    // MediaStream (screen share)
var _videoViewerPeerId = null;   // whose camera is displayed in viewer
var _screenViewerPeerId = null;  // whose screen is displayed in viewer
var _videoPopoutWindow = null;   // reference to video popup window
var _screenPopoutWindow = null;  // reference to screen popup window
var _devLogBuffer  = [];         // ring buffer of all log entries (max 200)
var _devLogChannel = null;       // BroadcastChannel to the detached devlog window

// --- WebRTC stats polling ---
var _statsIntervalId  = null;
var _statsTimerIntervalId = null;

// --- Anonymous room publish ---
var _publishSecret         = null;
var _publishedRoomId       = null;
var _publishedShareUrl     = null;
var _publishHeartbeatId    = null;
var _publishDebounceId     = null;
var _lastPublishAt         = 0;
var PUBLISH_HEARTBEAT_MS   = 50 * 60 * 1000; // 50 min (TTL is 1h)
var PUBLISH_DEBOUNCE_MS    = 10000;
var PUBLISH_MIN_INTERVAL   = 30000; // never POST more often than every 30s

async function publishRoom() {
  if (!isHost || !peer || !roomCode) return;
  var now = Date.now();
  var elapsed = now - _lastPublishAt;
  if (_lastPublishAt && elapsed < PUBLISH_MIN_INTERVAL) {
    // Too soon — schedule a retry after the cooldown
    schedulePublishRefresh();
    return;
  }
  _lastPublishAt = now;
  var label = activeChannel || null;
  var peerCount = connections.size;
  var headers = { 'Content-Type': 'application/json' };
  if (_publishSecret) headers['x-room-secret'] = _publishSecret;
  var res = await tauriFetch(ANONYMOUS_ROOMS_BASE, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ room_id: roomCode, label: label, peer_count: peerCount }),
  });
  if (!res.ok) {
    var body = null;
    try { body = await res.json(); } catch (_) {}
    throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
  }
  var data = await res.json();
  _publishSecret    = data.secret;
  _publishedRoomId  = data.room_code || data.room_id || null;
  _publishedShareUrl = data.share_url || null;
  updateRoomHeader();
  broadcastRoomPublished();
  if (!_publishHeartbeatId) {
    _publishHeartbeatId = setInterval(function() {
      if (isHost && _publishSecret) publishRoom().catch(function() {});
    }, PUBLISH_HEARTBEAT_MS);
  }
}

function unpublishRoom() {
  clearInterval(_publishHeartbeatId);
  clearTimeout(_publishDebounceId);
  _publishHeartbeatId = null;
  _publishDebounceId = null;
  _lastPublishAt = 0;
  var secret = _publishSecret;
  var id = roomCode;
  _publishSecret = null;
  _publishedRoomId = null;
  _publishedShareUrl = null;
  updateRoomHeader();
  broadcastRoomPublished();
  if (!secret || !id) return;
  tauriFetch(ANONYMOUS_ROOMS_BASE + '/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'x-room-secret': secret },
  }).catch(function(e) { console.warn('[publish] unpublish failed:', e.message); });
}

// Clear local publish state without deleting from API.
// Used when leaving a published room so the new host can take over.
function clearPublishState() {
  clearInterval(_publishHeartbeatId);
  clearTimeout(_publishDebounceId);
  _publishHeartbeatId = null;
  _publishDebounceId = null;
  _lastPublishAt = 0;
  _publishSecret = null;
  _publishedRoomId = null;
  _publishedShareUrl = null;
  updateRoomHeader();
}

function broadcastRoomPublished() {
  if (!isHost || !peer) return;
  var deputyId = currentDeputyId();
  connections.forEach(function(c, peerId) {
    if (!c.data) return;
    c.data.send({
      type: 'room-published',
      roomId: _publishedRoomId,
      secret: (peerId === deputyId) ? (_publishSecret || null) : null,
    });
  });
}

// Debounced re-publish to update peer_count on the API when membership changes.
function schedulePublishRefresh() {
  if (!isHost || !_publishSecret) return;
  clearTimeout(_publishDebounceId);
  _publishDebounceId = setTimeout(function() {
    if (isHost && _publishSecret) publishRoom().catch(function() {});
  }, PUBLISH_DEBOUNCE_MS);
}

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRoomFromUrlCandidate(raw) {
  if (!raw) return '';
  try {
    var url = new URL(raw);
    var room = (url.searchParams.get('room') || '').trim();
    return room ? decodeURIComponent(room) : '';
  } catch (_) {
    return '';
  }
}

function normalizeRoomCode(raw) {
  var code = (raw || '').trim();
  if (!code) return '';

  var fromDirectUrl = parseRoomFromUrlCandidate(code);
  if (fromDirectUrl) code = fromDirectUrl;

  if (!fromDirectUrl) {
    var roomMatch = code.match(/[?&]room=([^&#\s]+)/i);
    if (roomMatch && roomMatch[1]) {
      try { code = decodeURIComponent(roomMatch[1]); } catch (_) { code = roomMatch[1]; }
    }
  }

  if (UUID_RE.test(code)) return code;
  var uuidMatch = code.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];

  return code;
}

// Resolve a public lobby identifier to the actual PeerJS peer ID.
// Skips the lookup if the code is already a UUID (PeerJS peer ID).
// Returns the peer ID if found, or null if the code is not a published room.
async function lookupRoom(code) {
  if (UUID_RE.test(code)) return null;
  try {
    devLog('→ Resolving lobby "' + code + '"…');
    var res = await tauriFetch(ANONYMOUS_ROOMS_BASE + '/' + encodeURIComponent(code));
    if (!res.ok) {
      devLog('✗ Lobby "' + code + '" not found');
      return null;
    }
    var data = await res.json();
    return (data && data.room_id) || null;
  } catch (e) {
    devLog('✗ Lobby lookup failed: ' + e.message, 'error');
    return null;
  }
}

let shortcutStr = localStorage.getItem('ptt-shortcut') || DEFAULT_SHORTCUT;

function pseudoForHost() { return myPseudo || 'Host'; }
function pseudoForPeer() { return myPseudo || 'Anonymous'; }

function announcePseudoChange() {
  if (!inRoom || !peer) return;
  if (isHost) {
    connections.forEach(function(c) {
      if (c.data) c.data.send({ type: 'peer-renamed', peerId: peer.id, pseudo: pseudoForHost() });
    });
    return;
  }
  const hostConn = connections.get(roomCode);
  if (hostConn && hostConn.data) hostConn.data.send({ type: 'pseudo', pseudo: pseudoForPeer() });
}

function setMyPseudo(nextPseudo) {
  myPseudo = (nextPseudo || '').trim();
  sessionStorage.setItem(PSEUDO_SESSION_KEY, myPseudo);
  if (shouldPersistPseudoGlobally()) localStorage.setItem(PSEUDO_KEY, myPseudo);
  const homeInput = $('input-pseudo');
  const settingsInput = $('input-pseudo-settings');
  const inviteInput = $('input-pseudo-invite');
  if (homeInput && homeInput.value !== myPseudo) homeInput.value = myPseudo;
  if (settingsInput && settingsInput.value !== myPseudo) settingsInput.value = myPseudo;
  if (inviteInput && inviteInput.value !== myPseudo) inviteInput.value = myPseudo;
  if (inRoom) {
    updatePeerList();
    announcePseudoChange();
  }
  updateHomeLoggedOutLayout();
}

function updateHomeLoggedOutLayout() {
  var connected = !!presenceToken();
  var pseudoField = $('pseudo-field-home');
  var beforeConnect = $('divider-before-connect');
  var afterConnect = $('divider-after-connect');
  if (pseudoField) pseudoField.style.display = (!connected || !myPseudo) ? '' : 'none';
  if (beforeConnect) beforeConnect.style.display = connected ? 'none' : '';
  if (afterConnect) afterConnect.style.display = connected ? 'none' : '';
}

// Presence state
let presenceData     = []; // last fetched [{channel,connected}]
let activeChannel    = null; // channel name for the current presence session
let presenceInterval = null;

function updateRoomHeader() {
  $('room-code-display').textContent = roomDisplayCode();
  var publishBtn   = $('btn-publish-room');
  var unpublishBtn = $('btn-unpublish-room');
  var shareBtn     = $('btn-share-room');
  if (!publishBtn || !unpublishBtn) return;
  if (!isHost) {
    publishBtn.classList.add('hidden');
    unpublishBtn.classList.add('hidden');
  } else if (_publishSecret) {
    publishBtn.classList.add('hidden');
    unpublishBtn.classList.remove('hidden');
  } else {
    publishBtn.classList.remove('hidden');
    unpublishBtn.classList.add('hidden');
  }
  if (shareBtn) shareBtn.classList.toggle('hidden', !roomDisplayCode());
}

// peerId -> { data, media, pseudo, talking }
const connections = new Map();
const knownPeerIds = new Set();
var _hostConnGeneration = 0; // incremented each connection attempt to invalidate stale events
var _hostHeartbeatInterval = null;
var _hostHeartbeatMonitorInterval = null;
var _peerHeartbeatInterval = null;
var _peerHeartbeatSweepInterval = null;
var _lastHostHeartbeatAt = 0;

var HOST_HEARTBEAT_INTERVAL_MS = 2000;
var HOST_HEARTBEAT_TIMEOUT_MS  = 7000;
var MAX_JOIN_REDIRECTS         = 5;

// Room state machine
var ROOM_STATE_IDLE       = 'idle';
var ROOM_STATE_CONNECTING = 'connecting';
var ROOM_STATE_CONNECTED  = 'connected';
var ROOM_STATE_MIGRATING  = 'migrating';
var roomState = ROOM_STATE_IDLE;
var _migrationCandidateId = null;
var _migrationExcluded = new Set();
var _lastAuthoritativePeerIds = null;
var _authoritativeSuccessorIds = [];


function rememberPeer(peerId) {
  if (!peerId) return;
  if (peer && peer.id === peerId) return;
  knownPeerIds.add(peerId);
  if (isHost) reconcileHostSuccessorIds();
}

function forgetPeer(peerId) {
  if (!peerId) return;
  knownPeerIds.delete(peerId);
  if (isHost) reconcileHostSuccessorIds();
}

function resetKnownPeers(peerIds) {
  knownPeerIds.clear();
  (peerIds || []).forEach(rememberPeer);
  if (isHost) reconcileHostSuccessorIds();
}

function resetAuthoritativePeerIds(peerIds) {
  _lastAuthoritativePeerIds = new Set();
  (peerIds || []).forEach(function(peerId) {
    if (!peerId) return;
    if (peer && peer.id === peerId) return;
    _lastAuthoritativePeerIds.add(peerId);
  });
}

function setAuthoritativeSuccessorIds(successorIds) {
  var next = [];
  (successorIds || []).forEach(function(peerId) {
    if (!peerId) return;
    if (next.indexOf(peerId) !== -1) return;
    next.push(peerId);
  });
  _authoritativeSuccessorIds = next;
}

function hasOpenDataConnection(peerId) {
  var conn = connections.get(peerId);
  return !!(conn && conn.data && conn.data.open && !conn.data.closed);
}

function hostConnectedPeerIds() {
  return Array.from(connections.keys()).filter(function(peerId) {
    return hasOpenDataConnection(peerId);
  }).sort();
}

function reconcileHostSuccessorIds() {
  if (!isHost) return _authoritativeSuccessorIds.slice();
  var connectedPeerIds = hostConnectedPeerIds();
  var next = _authoritativeSuccessorIds.filter(function(peerId) {
    return connectedPeerIds.indexOf(peerId) !== -1;
  });
  connectedPeerIds.forEach(function(peerId) {
    if (next.indexOf(peerId) === -1) next.push(peerId);
  });
  _authoritativeSuccessorIds = next;
  return next.slice();
}

function preferredSuccessorCandidates(excludedPeerId) {
  var base = _authoritativeSuccessorIds.length
    ? _authoritativeSuccessorIds.slice()
    : authoritativeElectionCandidates(excludedPeerId);
  var next = [];
  function addCandidate(peerId) {
    if (!peerId) return;
    if (peerId === excludedPeerId) return;
    if (next.indexOf(peerId) !== -1) return;
    next.push(peerId);
  }
  base.forEach(addCandidate);
  if (peer && peer.id) addCandidate(peer.id);
  return next;
}

function currentDeputyId() {
  if (isHost) return reconcileHostSuccessorIds()[0] || null;
  if (_authoritativeSuccessorIds.length) return _authoritativeSuccessorIds[0] || null;
  return electHostId(roomCode);
}

function pruneHostGhostPeers(reason) {
  if (!isHost) return;
  Array.from(connections.keys()).forEach(function(peerId) {
    if (hasOpenDataConnection(peerId)) return;
    forgetPeer(peerId);
    removePeer(peerId);
  });
}

function hostElectionCandidates(excludedPeerId) {
  const candidates = Array.from(knownPeerIds).filter(function(id) { return id !== excludedPeerId; });
  if (peer && peer.id && peer.id !== excludedPeerId) candidates.push(peer.id);
  candidates.sort();
  return candidates;
}

function authoritativeElectionCandidates(excludedPeerId) {
  var basePeerIds = _lastAuthoritativePeerIds && _lastAuthoritativePeerIds.size
    ? Array.from(_lastAuthoritativePeerIds)
    : Array.from(knownPeerIds);
  var candidates = basePeerIds.filter(function(id) { return id !== excludedPeerId; });
  if (peer && peer.id && peer.id !== excludedPeerId) candidates.push(peer.id);
  candidates.sort();
  return candidates;
}

function authoritativeElectHostId(excludedPeerId) {
  var candidates = authoritativeElectionCandidates(excludedPeerId);
  return candidates[0] || null;
}

function electHostId(excludedPeerId) {
  const candidates = hostElectionCandidates(excludedPeerId);
  return candidates[0] || null;
}

function noteHostHeartbeat(at) {
  _lastHostHeartbeatAt = at || Date.now();
}

function notePeerHeartbeat(peerId, at) {
  var conn = connections.get(peerId);
  if (!conn) return;
  connections.set(peerId, Object.assign({}, conn, { lastHeartbeatAt: at || Date.now() }));
}

function stopHostHeartbeat() {
  if (_hostHeartbeatInterval) {
    clearInterval(_hostHeartbeatInterval);
    _hostHeartbeatInterval = null;
  }
}

function broadcastHostHeartbeat() {
  if (!inRoom || !isHost || !peer) return;
  var successorIds = reconcileHostSuccessorIds();
  var msg = {
    type: 'heartbeat',
    at: Date.now(),
    deputyId: successorIds[0] || null,
    successorIds: successorIds
  };
  connections.forEach(function(conn) {
    if (conn && conn.data) conn.data.send(msg);
  });
}

function startHostHeartbeat() {
  stopHostHeartbeat();
  broadcastHostHeartbeat();
  _hostHeartbeatInterval = setInterval(broadcastHostHeartbeat, HOST_HEARTBEAT_INTERVAL_MS);
}

function stopPeerHeartbeat() {
  if (_peerHeartbeatInterval) {
    clearInterval(_peerHeartbeatInterval);
    _peerHeartbeatInterval = null;
  }
}

function sendPeerHeartbeat() {
  if (!inRoom || isHost || !roomCode) return;
  var hostConn = connections.get(roomCode);
  if (!hostConn || !hostConn.data || hostConn.data.closed) return;
  hostConn.data.send({ type: 'heartbeat', at: Date.now() });
}

function startPeerHeartbeat() {
  stopPeerHeartbeat();
  sendPeerHeartbeat();
  _peerHeartbeatInterval = setInterval(sendPeerHeartbeat, HOST_HEARTBEAT_INTERVAL_MS);
}

function stopHostHeartbeatMonitor() {
  if (_hostHeartbeatMonitorInterval) {
    clearInterval(_hostHeartbeatMonitorInterval);
    _hostHeartbeatMonitorInterval = null;
  }
}

function stopPeerHeartbeatSweep() {
  if (_peerHeartbeatSweepInterval) {
    clearInterval(_peerHeartbeatSweepInterval);
    _peerHeartbeatSweepInterval = null;
  }
}

function checkHostHeartbeat() {
  if (!inRoom || isHost || !roomCode || connectingToHostId) return;
  if (!_lastHostHeartbeatAt) return;
  if (Date.now() - _lastHostHeartbeatAt <= HOST_HEARTBEAT_TIMEOUT_MS) return;
  if (roomState !== ROOM_STATE_CONNECTED) return;
  console.warn(
    '[heartbeat] Host ' + migrationPeerLabel(roomCode) +
    ' missed heartbeat timeout (' + HOST_HEARTBEAT_TIMEOUT_MS + ' ms). Starting migration.'
  );
  initiateHostMigration(roomCode);
}

function startHostHeartbeatMonitor() {
  stopHostHeartbeatMonitor();
  _hostHeartbeatMonitorInterval = setInterval(checkHostHeartbeat, 1000);
}

function removeStalePeer(peerId, reason) {
  var conn = connections.get(peerId);
  if (!conn) return;
  console.warn('[heartbeat] Removing stale peer ' + migrationPeerLabel(peerId) + ': ' + reason + '.');
  forgetPeer(peerId);
  connections.delete(peerId);
  detachAudio(peerId);
  if (conn.data) conn.data.close();
  if (conn.media) conn.media.close();
  connections.forEach(function(other) {
    if (other && other.data) other.data.send({ type: 'peer-left', peerId: peerId });
  });
  broadcastHostPeerLists();
  playGoodbye();
  updatePeerList();
}

function checkPeerHeartbeats() {
  if (!inRoom || !isHost) return;
  var now = Date.now();
  connections.forEach(function(conn, peerId) {
    if (!conn || !conn.data) return;
    if (!conn.lastHeartbeatAt) return;
    if (now - conn.lastHeartbeatAt <= HOST_HEARTBEAT_TIMEOUT_MS) return;
    removeStalePeer(peerId, 'missed heartbeat timeout (' + HOST_HEARTBEAT_TIMEOUT_MS + ' ms)');
  });
}

function startPeerHeartbeatSweep() {
  stopPeerHeartbeatSweep();
  _peerHeartbeatSweepInterval = setInterval(checkPeerHeartbeats, 1000);
}

// Silently disable / re-enable all home-screen CTAs during a join/create action
let homeActionInFlight = false;

function beginHomeAction() {
  if (homeActionInFlight) return false;
  homeActionInFlight = true;
  return true;
}

function endHomeAction() {
  homeActionInFlight = false;
}

function lockHomeCTAs() {
  ['btn-create','input-code','btn-rejoin'].forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.style.pointerEvents = 'none';
    if ('disabled' in el) el.disabled = true;
  });
  var list = document.getElementById('channels-list');
  if (list) {
    list.style.pointerEvents = 'none';
    list.setAttribute('aria-disabled', 'true');
  }
  var bar = document.getElementById('rejoin-bar');
  if (bar) bar.classList.add('hidden');
}
function unlockHomeCTAs() {
  ['btn-create','input-code','btn-rejoin'].forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.style.pointerEvents = '';
    if ('disabled' in el) el.disabled = false;
  });
  var list = document.getElementById('channels-list');
  if (list) {
    list.style.pointerEvents = '';
    list.removeAttribute('aria-disabled');
  }
  if (window._updateRejoinBar) window._updateRejoinBar();
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
    var label = originalLabel || el._origLabel || '';
    el.textContent = '';
    var spinner = document.createElement('span');
    spinner.className = 'btn-spinner';
    el.appendChild(spinner);
    el.appendChild(document.createTextNode(label));
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
  if (name === 'home') { startPresencePolling(); if (window._updateRejoinBar) window._updateRejoinBar(); }
  else                 stopPresencePolling();
}

function showError(msg) {
  $('error-message').textContent = msg;
  // Hide recovery hints by default
  var hint = $('error-recovery-hint');
  var retryBtn = $('btn-retry-mic');
  if (hint)     { hint.textContent = ''; hint.classList.add('hidden'); }
  if (retryBtn) retryBtn.classList.add('hidden');
  showScreen('error');
}

var _pendingMicAction = null; // function to re-run after mic permission is granted

function showMicDeniedError(retryFn) {
  _pendingMicAction = retryFn || null;

  var hint = '';
  var ua = navigator.userAgent || '';
  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    if (/iPhone|iPad|iPod/i.test(ua)) {
      hint = 'To allow access: open Settings → Voxal → Microphone.';
    } else {
      hint = 'To allow access: open Settings → Apps → Voxal → Permissions → Microphone.';
    }
  } else if (/iPhone|iPad|iPod/i.test(ua) || /CriOS|FxiOS|Safari/i.test(ua)) {
    hint = 'To allow access: tap the \u24b6 / \u2712 icon in the address bar → Website Settings → Microphone → Allow.';
  } else if (/Android/i.test(ua)) {
    hint = 'To allow access: tap the lock icon in the address bar → Site settings → Microphone → Allow.';
  } else {
    hint = 'To allow access: click the microphone icon in the browser address bar and choose \u201cAllow\u201d.';
  }

  $('error-message').textContent = 'Microphone access was denied.';
  var hintEl   = $('error-recovery-hint');
  var retryBtn = $('btn-retry-mic');
  if (hintEl)   { hintEl.textContent = hint; hintEl.classList.remove('hidden'); }
  if (retryBtn) retryBtn.classList.toggle('hidden', !retryFn);
  showScreen('error');
}

function isMicDeniedError(err) {
  var name = err && err.name;
  return name === 'NotAllowedError' || name === 'PermissionDeniedError';
}

var _copyToastTimer = null;

function showCopyToast(message) {
  var toast = $('copy-toast');
  if (!toast) return;
  toast.textContent = message || 'Copied!';
  toast.classList.add('visible');
  clearTimeout(_copyToastTimer);
  _copyToastTimer = setTimeout(function() { toast.classList.remove('visible'); }, 1500);
}

function copyTextToClipboard(text, toastMessage) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showCopyToast(toastMessage);
    }).catch(function() {
      fallbackCopy(text);
      showCopyToast(toastMessage);
    });
  } else {
    fallbackCopy(text);
    showCopyToast(toastMessage);
  }
}

function roomInviteBaseUrl() {
  try {
    var current = new URL(window.location.href);
    if (current.protocol === 'http:' || current.protocol === 'https:') {
      current.search = '';
      current.hash = '';
      return current.toString();
    }
  } catch (_) {}
  // Tauri (tauri://) or Capacitor (capacitor://) — use the canonical web URL
  // so shared links open in Safari/Chrome and iOS Universal Links can intercept them.
  return VOXAL_WEB_URL + '/';
}

function roomInviteUrl(roomId) {
  if (!roomId) return '';
  var url = new URL(roomInviteBaseUrl());
  url.searchParams.set('room', roomId);
  return url.toString();
}

function roomDisplayCode() {
  if (activeChannel && roomCode) return roomCode;
  return _publishedRoomId || roomCode || activeChannel || '';
}

function consumeRoomInviteFromQuery() {
  try {
    var current = new URL(window.location.href);
    var roomId = normalizeRoomCode(current.searchParams.get('room') || '');
    if (!roomId) return '';
    current.searchParams.delete('room');
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, current.toString());
    }
    return roomId;
  } catch (_) {
    return '';
  }
}

function isNonFatalPeerRuntimeError(err) {
  if (!err) return false;
  var type = err.type || '';
  var message = err.message || String(err);
  return type === 'peer-unavailable' || /Could not connect to peer\b/.test(message);
}

function friendlyPeerError(err) {
  var type = err && (err.type || '');
  var message = err && (err.message || String(err));
  if (type === 'network' || type === 'disconnected' || /network/i.test(message))
    return 'Network error — please check your connection and try again.';
  if (type === 'server-error' || type === 'unavailable-id')
    return 'Could not reach the signalling server. Try again in a moment.';
  if (type === 'peer-unavailable' || /Could not connect to peer\b/.test(message))
    return 'Room not found or host is unreachable.';
  return message || 'An unexpected error occurred.';
}

function handlePeerRuntimeError(err, settled, reject) {
  if (!settled) {
    err.message = friendlyPeerError(err);
    reject(err);
    return true;
  }
  if (inRoom && isNonFatalPeerRuntimeError(err)) {
    console.warn('[peer-runtime]', err);
    return true;
  }
  showError(friendlyPeerError(err));
  return true;
}

// --- Shortcut helpers --------------------------------------------------------

const MODIFIER_CODES = [
  'ControlLeft','ControlRight','AltLeft','AltRight',
  'ShiftLeft','ShiftRight','MetaLeft','MetaRight',
];

const MODIFIER_ONLY_MAP = {
  'AltLeft': 'Alt',     'AltRight': 'Alt',
  'ShiftLeft': 'Shift', 'ShiftRight': 'Shift',
  'ControlLeft': 'Ctrl','ControlRight': 'Ctrl',
  'MetaLeft': 'Meta',   'MetaRight': 'Meta',
};

const MODIFIER_ONLY_VARIANTS = {
  'Alt':   ['AltLeft',     'AltRight'],
  'Shift': ['ShiftLeft',   'ShiftRight'],
  'Ctrl':  ['ControlLeft', 'ControlRight'],
  'Meta':  ['MetaLeft',    'MetaRight'],
};

function isModifierOnly(s) { return s in MODIFIER_ONLY_VARIANTS; }

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
  if (isModifierOnly(shortcutStr)) {
    return (MODIFIER_ONLY_VARIANTS[shortcutStr] || []).includes(e.code);
  }
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

function shouldIgnorePTTShortcuts() {
  return editingSelfPseudo;
}

function displayShortcut(raw) {
  return raw
    .replace('Backquote', '`').replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1')
    .replace('Semicolon', ';').replace('Comma', ',').replace('Period', '.')
    .replace('Slash', '/').replace('BracketLeft', '[').replace('BracketRight', ']')
    .replace('Backslash', '\\\\').replace("Quote", "'").replace('Minus', '-').replace('Equal', '=');
}

var _editShortcutIconHtml = '<button id="btn-edit-shortcut" class="btn-icon shortcut-edit-inline" title="Change shortcut"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>';

function pttHintHtml(prefix, suffix) {
  return prefix + '<kbd id="shortcut-hint-kbd">' + displayShortcut(shortcutStr) + '</kbd>' + _editShortcutIconHtml + suffix;
}

function updateShortcutDisplay() {
  const label = displayShortcut(shortcutStr);
  const kbd = document.getElementById('shortcut-kbd');
  if (kbd) kbd.textContent = label;
  const hintKbd = $('shortcut-hint-kbd');
  if (hintKbd) hintKbd.textContent = label;
  const note = $('shortcut-focused-note');
  if (note) note.classList.toggle('hidden', !(window.__TAURI__ && isModifierOnly(shortcutStr)));
}

function startRecordingShortcut() {
  recordingShortcut = true;
  $('shortcut-recording').classList.remove('hidden');
}

function stopRecordingShortcut() {
  recordingShortcut = false;
  $('shortcut-recording').classList.add('hidden');
}

function clearRoomCodeInput() {
  var input = $('input-code');
  if (!input) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function startInviteRoomJoin(rawRoomCode) {
  var roomId = normalizeRoomCode(rawRoomCode);
  if (!roomId) return;
  showInviteLoading(roomId, 'Connecting…');
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  joinRoom(roomId).catch(function(err) { showError(err.message); });
}

// On web: try to open the native Voxal app first (voxal:// scheme).
// If the page goes hidden the app launched → cancel the web join.
// If 800 ms pass with the page still visible → fall back to browser join.
function _tryNativeAppThenJoin(roomId) {
  showInviteLoading(roomId, 'Opening Voxal…');

  var appLaunched = false;
  var WAIT_MS = 800;

  var onVis = function() {
    if (document.hidden) {
      appLaunched = true;
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVis);
      // Native app took over — go back to home so the web tab is clean on return
      showScreen('home');
    }
  };
  document.addEventListener('visibilitychange', onVis);

  // Trigger the custom scheme via a hidden link (avoids page-navigation errors)
  var a = document.createElement('a');
  a.href = 'voxal://join?room=' + encodeURIComponent(roomId);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  var timeout = setTimeout(function() {
    document.removeEventListener('visibilitychange', onVis);
    if (appLaunched) return;
    // App not installed or didn't respond — join in the browser
    showInviteLoading(roomId, 'Connecting…');
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    joinRoom(roomId).catch(function(err) { showError(err.message); });
  }, WAIT_MS);
}

function showInviteLoading(roomLabel, statusText) {
  var roomCodeEl = $('invite-room-code');
  if (roomCodeEl) roomCodeEl.textContent = roomLabel || '';
  var statusEl = $('invite-join-status');
  if (statusEl) statusEl.textContent = statusText || 'Connecting…';
  showScreen('invite-loading');
}

function applyNewShortcut(newShortcut) {
  stopRecordingShortcut();
  const old = shortcutStr;
  shortcutStr = newShortcut;
  localStorage.setItem('ptt-shortcut', newShortcut);
  updateShortcutDisplay();
  if (window.__TAURI__) {
    // Modifier-only shortcuts can't be registered as global hotkeys — they work only when focused
    const tauriShortcut = isModifierOnly(newShortcut) ? '' : newShortcut;
    window.__TAURI__.core.invoke('update_ptt_shortcut', { shortcut: tauriShortcut })
      .catch(function(err) { console.warn('Failed to update global shortcut:', err); shortcutStr = old; updateShortcutDisplay(); });
  }
}

// --- Peer list UI ------------------------------------------------------------

function shortId(id) {
  return id.length > 14 ? id.slice(0, 6) + '\u2026' + id.slice(-4) : id;
}

function isDevModeEnabled() {
  return localStorage.getItem(DEV_MODE_KEY) === 'true';
}

function devLog(msg, level) {
  var lvl = level || 'info';
  if (lvl === 'warn') console.warn('[dev]', msg);
  else if (lvl === 'error') console.error('[dev]', msg);
  else console.log('[dev]', msg);

  var now = new Date();
  var t = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  var entry = { t: t, msg: String(msg), lvl: lvl };

  _devLogBuffer.push(entry);
  while (_devLogBuffer.length > 200) _devLogBuffer.shift();

  if (_devLogChannel) {
    try { _devLogChannel.postMessage({ type: 'entry', entry: entry }); } catch (_) {}
  }

  if (!isDevModeEnabled()) return;
  var panel = document.getElementById('dev-log-entries');
  if (!panel) return;
  appendDevLogEntryToContainer(panel, entry);
}

function appendDevLogEntryToContainer(container, entry) {
  var el = document.createElement('div');
  el.className = 'dev-log-entry' + (entry.lvl !== 'info' ? ' ' + entry.lvl : '');
  var safe = entry.msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  el.innerHTML = '<span class="dev-log-time">' + entry.t + '</span><span class="dev-log-msg">' + safe + '</span>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  while (container.children.length > 200) container.removeChild(container.firstChild);
}

function updateDevLogPanel() {
  var panel = document.getElementById('dev-log-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !isDevModeEnabled());
}

// --- Rejoin snapshot ---------------------------------------------------------

function saveRejoinSnapshot() {
  if (!inRoom || !peer || !roomCode) return;
  _rejoinDismissed = false;
  var peerIds = Array.from(knownPeerIds).filter(function(id) { return id !== (peer && peer.id); });
  var snapshot = {
    hostId:    roomCode,
    deputyId:  currentDeputyId() || null,
    peerIds:   peerIds,
    wasHost:   isHost,
    savedAt:   Date.now()
  };
  localStorage.setItem(REJOIN_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

function loadRejoinSnapshot() {
  try {
    var raw = localStorage.getItem(REJOIN_SNAPSHOT_KEY);
    if (!raw) return null;
    var s = JSON.parse(raw);
    if (!s || !s.hostId || !s.savedAt) return null;
    if (Date.now() - s.savedAt > REJOIN_TTL_MS) { clearRejoinSnapshot(); return null; }
    return s;
  } catch (_) { return null; }
}

function clearRejoinSnapshot() {
  localStorage.removeItem(REJOIN_SNAPSHOT_KEY);
}

function rejoinCandidates(snapshot) {
  var seen = new Set();
  var result = [];
  // If we were the host, hostId was our own peer ID — skip it (it no longer exists)
  var ids = snapshot.wasHost
    ? [snapshot.deputyId].concat(snapshot.peerIds || [])
    : [snapshot.hostId, snapshot.deputyId].concat(snapshot.peerIds || []);
  ids.forEach(function(id) {
    if (id && !seen.has(id)) { seen.add(id); result.push(id); }
  });
  return result;
}

// --- WebRTC stats helpers ----------------------------------------------------

async function _collectPeerStats(peerId, conn) {
  if (!conn || !conn.media || !conn.media.peerConnection) return;
  try {
    var reports = await conn.media.peerConnection.getStats();
    var selectedPairId = null;
    var pairs = {};
    var localCandidates = {};
    var inboundRtp = null;

    reports.forEach(function(report) {
      if (report.type === 'candidate-pair' && report.nominated) {
        pairs[report.id] = report;
        if (!selectedPairId || report.state === 'succeeded') selectedPairId = report.id;
      }
      if (report.type === 'local-candidate') localCandidates[report.id] = report;
      if (report.type === 'inbound-rtp' && report.kind === 'audio') inboundRtp = report;
    });

    var stats = {};

    var pair = selectedPairId ? pairs[selectedPairId] : null;
    if (pair) {
      if (typeof pair.currentRoundTripTime === 'number') {
        stats.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      }
      var localCand = localCandidates[pair.localCandidateId];
      if (localCand) {
        stats.iceType = localCand.candidateType; // 'host', 'srflx', 'relay'
      }
    }

    if (inboundRtp) {
      var prev = (conn.webrtcStats && conn.webrtcStats._inboundRaw) || {};
      var lostDelta  = (inboundRtp.packetsLost || 0) - (prev.packetsLost || 0);
      var recvDelta  = (inboundRtp.packetsReceived || 0) - (prev.packetsReceived || 0);
      if (recvDelta + lostDelta > 0) {
        stats.lossPercent = Math.round((lostDelta / (recvDelta + lostDelta)) * 1000) / 10;
      } else if (conn.webrtcStats) {
        stats.lossPercent = conn.webrtcStats.lossPercent; // carry forward
      }
      if (typeof inboundRtp.jitter === 'number') {
        stats.jitterMs = Math.round(inboundRtp.jitter * 1000);
      }
      stats._inboundRaw = { packetsLost: inboundRtp.packetsLost || 0, packetsReceived: inboundRtp.packetsReceived || 0 };
    }

    conn.webrtcStats = stats;
  } catch (_) {}
}

function startStatsPolling() {
  stopStatsPolling();
  _statsIntervalId = setInterval(function() {
    if (!inRoom) { stopStatsPolling(); return; }
    connections.forEach(function(conn, peerId) { _collectPeerStats(peerId, conn); });
    // Always: update dot color to reflect ICE type
    connections.forEach(function(conn, peerId) {
      if (conn.webrtcStats && conn.webrtcStats.iceType) {
        _applyDotIceClass(document.getElementById('peer-item-' + peerId), conn.webrtcStats.iceType);
      }
    });
    // In dev mode: re-render inline badges without full peer list rebuild
    if (isDevModeEnabled()) {
      connections.forEach(function(conn, peerId) {
        var el = document.getElementById('peer-item-' + peerId);
        if (!el || !conn.webrtcStats) return;
        var existing = el.querySelector('.peer-webrtc-stats');
        if (existing) existing.remove();
        el.appendChild(_buildStatsBadge(conn.webrtcStats));
      });
    }
    // If a stats popover is open, refresh its contents
    _refreshOpenStatsPopover();
  }, 5000);
}

function stopStatsPolling() {
  if (_statsIntervalId) { clearInterval(_statsIntervalId); _statsIntervalId = null; }
}

var ICE_LABELS = { host: 'Direct', srflx: 'STUN', relay: 'TURN' };
var ICE_CLASSES = { host: 'ice-direct', srflx: 'ice-stun', relay: 'ice-relay' };
var ICE_DOT_CLASSES = ['peer-dot-direct', 'peer-dot-stun', 'peer-dot-relay'];

function _applyDotIceClass(el, iceType) {
  if (!el) return;
  var dot = el.querySelector('.peer-dot');
  if (!dot) return;
  ICE_DOT_CLASSES.forEach(function(c) { dot.classList.remove(c); });
  var cls = { host: 'peer-dot-direct', srflx: 'peer-dot-stun', relay: 'peer-dot-relay' }[iceType];
  if (cls) dot.classList.add(cls);
}

function _buildStatsBadge(stats) {
  var wrap = document.createElement('span');
  wrap.className = 'peer-webrtc-stats';
  if (stats.iceType) {
    var ice = document.createElement('span');
    ice.className = 'stat-badge ' + (ICE_CLASSES[stats.iceType] || 'ice-unknown');
    ice.textContent = ICE_LABELS[stats.iceType] || stats.iceType;
    wrap.appendChild(ice);
  }
  if (typeof stats.rttMs === 'number') {
    var rtt = document.createElement('span');
    rtt.className = 'stat-badge stat-neutral';
    rtt.textContent = stats.rttMs + ' ms';
    wrap.appendChild(rtt);
  }
  if (typeof stats.lossPercent === 'number') {
    var loss = document.createElement('span');
    loss.className = 'stat-badge ' + (stats.lossPercent > 5 ? 'stat-warn' : 'stat-neutral');
    loss.textContent = stats.lossPercent.toFixed(1) + '% loss';
    wrap.appendChild(loss);
  }
  if (typeof stats.jitterMs === 'number') {
    var jitter = document.createElement('span');
    jitter.className = 'stat-badge stat-neutral';
    jitter.textContent = stats.jitterMs + ' ms jitter';
    wrap.appendChild(jitter);
  }
  return wrap;
}

// --- Stats popover -----------------------------------------------------------

var _statsPopoverPeerId = null;

function _refreshOpenStatsPopover() {
  if (!_statsPopoverPeerId) return;
  var popover = document.getElementById('stats-popover');
  if (!popover) return;
  var conn = connections.get(_statsPopoverPeerId);
  var body = popover.querySelector('.stats-popover-body');
  if (!body) return;
  body.innerHTML = '';
  if (!conn || !conn.webrtcStats || !Object.keys(conn.webrtcStats).filter(function(k) { return k[0] !== '_'; }).length) {
    body.textContent = 'No stats yet…';
    return;
  }
  body.appendChild(_buildStatsBadge(conn.webrtcStats));
}

function showStatsPopover(peerId, anchorEl) {
  closeStatsPopover();
  _statsPopoverPeerId = peerId;

  var popover = document.createElement('div');
  popover.id = 'stats-popover';
  popover.className = 'stats-popover';

  var title = document.createElement('div');
  title.className = 'stats-popover-title';
  var conn = connections.get(peerId);
  title.textContent = (conn && conn.pseudo) || shortId(peerId);
  popover.appendChild(title);

  var body = document.createElement('div');
  body.className = 'stats-popover-body';
  body.textContent = 'Loading…';
  popover.appendChild(body);

  document.body.appendChild(popover);

  // Position near the anchor dot
  var rect = anchorEl.getBoundingClientRect();
  var top = rect.bottom + window.scrollY + 4;
  var left = rect.left + window.scrollX;
  // Clamp to viewport
  var pw = 200; // min-width from CSS
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';

  // Collect fresh stats then render
  _collectPeerStats(peerId, conn).then(function() { _refreshOpenStatsPopover(); });

  // Dismiss on click outside
  setTimeout(function() {
    document.addEventListener('click', _onDocClickDismissPopover, { capture: true, once: true });
  }, 0);
}

function _onDocClickDismissPopover(e) {
  var popover = document.getElementById('stats-popover');
  if (popover && popover.contains(e.target)) {
    // Click inside popover — re-attach listener
    setTimeout(function() {
      document.addEventListener('click', _onDocClickDismissPopover, { capture: true, once: true });
    }, 0);
    return;
  }
  closeStatsPopover();
}

function closeStatsPopover() {
  var existing = document.getElementById('stats-popover');
  if (existing) existing.remove();
  _statsPopoverPeerId = null;
  document.removeEventListener('click', _onDocClickDismissPopover, { capture: true });
}


function updatePeerList() {
  closeStatsPopover();
  const list = $('peers-list');
  list.innerHTML = '';
  const deputyPeerId = roomCode ? currentDeputyId() : null;
  const showPeerUuids = isDevModeEnabled();

  const appendRole = function(parent, label) {
    const role = document.createElement('span');
    role.className = 'peer-role';
    role.textContent = '· ' + label;
    parent.appendChild(role);
  };

  const appendPeerRole = function(parent, peerId) {
    if (!showPeerUuids) return;
    if (peerId === roomCode) appendRole(parent, 'host');
    else if (peerId && peerId === deputyPeerId) appendRole(parent, 'deputy');
  };

  const appendPeerUuid = function(parent, actualPeerId) {
    if (!showPeerUuids || !actualPeerId) return;
    const uuid = document.createElement('code');
    uuid.className = 'peer-uuid';
    uuid.textContent = actualPeerId;
    parent.appendChild(uuid);
  };

  const appendCopyPeerButton = function(parent, actualPeerId, label) {
    if (!showPeerUuids || !actualPeerId) return;
    const btn = document.createElement('button');
    btn.className = 'btn-icon peer-copy-btn';
    btn.title = 'Copy PeerJS UUID';
    btn.setAttribute('aria-label', 'Copy PeerJS UUID for ' + (label || actualPeerId));
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      copyTextToClipboard(actualPeerId, 'Peer UUID copied!');
    });
    parent.appendChild(btn);
  };

  const appendWebrtcStats = function(parent, peerId) {
    if (!showPeerUuids || !peerId) return;
    var conn = connections.get(peerId);
    if (!conn || !conn.webrtcStats) return;
    parent.appendChild(_buildStatsBadge(conn.webrtcStats));
  };

  const appendCameraLiveDot = function(parent, active, title) {
    if (!active) return;
    const dot = document.createElement('span');
    dot.className = 'peer-video-live-dot';
    dot.title = title || 'Camera live';
    dot.setAttribute('aria-label', title || 'Camera live');
    parent.appendChild(dot);
  };

  const appendScreenLiveDot = function(parent, active, title) {
    if (!active) return;
    const dot = document.createElement('span');
    dot.className = 'peer-screen-live-dot';
    dot.title = title || 'Screen shared';
    dot.setAttribute('aria-label', title || 'Screen shared');
    parent.appendChild(dot);
  };

  const addItem = (id, label, self, talking, editable, actualPeerId) => {
    const div = document.createElement('div');
    div.id = 'peer-item-' + id;
    div.className = 'peer-item' + (self ? ' peer-self' : '') + (talking ? ' talking' : '');
    const peerConn = actualPeerId ? connections.get(actualPeerId) : null;
    const videoLive = self && localVideoActive;
    const screenLive = self && localScreenActive;

    const dot = document.createElement('span');
    dot.className = 'peer-dot' + (!self ? ' peer-dot-clickable' : '');
    if (!self && actualPeerId) {
      dot.title = 'Connection stats';
      dot.addEventListener('click', function(e) {
        e.stopPropagation();
        if (_statsPopoverPeerId === actualPeerId) { closeStatsPopover(); return; }
        showStatsPopover(actualPeerId, dot);
      });
    }
    div.appendChild(dot);
    const peerMain = document.createElement('span');
    peerMain.className = 'peer-main';

    if (!editable) {
      const nameWrap = document.createElement('span');
      nameWrap.className = 'peer-label-row';
      nameWrap.textContent = label;
      appendPeerRole(nameWrap, actualPeerId);
      peerMain.appendChild(nameWrap);
      appendPeerUuid(peerMain, actualPeerId);
      div.appendChild(peerMain);
      appendCopyPeerButton(div, actualPeerId, label);
      // Video camera icon (dev mode video prototype)
      if (videoModeEnabled && actualPeerId) {
        if (peerConn && peerConn.videoActive) {
          var camBtn = document.createElement('button');
          camBtn.className = 'btn-icon peer-cam-btn';
          camBtn.title = 'View camera';
          camBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
          camBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (_videoViewerPeerId === actualPeerId) {
              closeVideoViewer();
            } else {
              openVideoViewer(actualPeerId);
            }
          });
          div.appendChild(camBtn);
        }
        // Screen share icon
        if (peerConn && peerConn.screenActive) {
          var scrBtn = document.createElement('button');
          scrBtn.className = 'btn-icon peer-cam-btn';
          scrBtn.title = 'View screen';
          scrBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
          scrBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (_screenViewerPeerId === actualPeerId) {
              closeScreenViewer();
            } else {
              openScreenViewer(actualPeerId);
            }
          });
          div.appendChild(scrBtn);
        }
      }
      appendWebrtcStats(div, actualPeerId);
      // Apply cached ICE dot color immediately
      const cachedConn = connections.get(actualPeerId);
      if (cachedConn && cachedConn.webrtcStats && cachedConn.webrtcStats.iceType) {
        _applyDotIceClass(div, cachedConn.webrtcStats.iceType);
      }
      list.appendChild(div);
      return;
    }

    const nameWrap = document.createElement('span');
    nameWrap.className = 'peer-self-main peer-label-row';

    if (editingSelfPseudo) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 20;
      input.className = 'peer-name-inline';
      input.placeholder = 'Your name…';
      input.value = myPseudo;
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          editingSelfPseudo = false;
          setMyPseudo(input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          editingSelfPseudo = false;
          updatePeerList();
        }
      });
      input.addEventListener('blur', function() {
        editingSelfPseudo = false;
        setMyPseudo(input.value);
      });
      nameWrap.appendChild(input);
      appendCameraLiveDot(nameWrap, videoLive, 'Your camera is live');
      appendScreenLiveDot(nameWrap, screenLive, 'Your screen is shared');
      appendPeerRole(nameWrap, actualPeerId);
      peerMain.appendChild(nameWrap);
      appendPeerUuid(peerMain, actualPeerId);
      div.appendChild(peerMain);
      appendCopyPeerButton(div, actualPeerId, label || 'You');
      list.appendChild(div);
      setTimeout(function() { input.focus(); input.select(); }, 0);
      return;
    }

    const name = document.createElement('span');
    name.textContent = myPseudo || 'You';
    nameWrap.appendChild(name);
    appendCameraLiveDot(nameWrap, videoLive, 'Your camera is live');
    appendScreenLiveDot(nameWrap, screenLive, 'Your screen is shared');
    appendPeerRole(nameWrap, peer && peer.id);
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon peer-edit-btn';
    editBtn.title = 'Edit name';
    editBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
    editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      editingSelfPseudo = true;
      updatePeerList();
    });
    nameWrap.appendChild(editBtn);
    peerMain.appendChild(nameWrap);
    appendPeerUuid(peerMain, actualPeerId);
    div.appendChild(peerMain);
    appendCopyPeerButton(div, actualPeerId, label || 'You');
    list.appendChild(div);
  };

  addItem('self', myPseudo || 'You', true, isTalking || freeHandMode, true, peer && peer.id);
  connections.forEach((conn, id) => addItem(id, conn.pseudo || shortId(id), false, conn.talking || false, false, id));

  // Invite nudge — shown when no other peers are in the room yet
  if (connections.size === 0) {
    var nudge = document.createElement('div');
    nudge.className = 'room-invite-nudge';
    var nudgeText = document.createElement('span');
    nudgeText.className = 'room-invite-nudge-text';
    nudgeText.textContent = 'Share your invite link to invite others';
    nudge.appendChild(nudgeText);

    var inviteUrl = roomInviteUrl(roomCode);
    if (navigator.share && IS_NATIVE_MOBILE) {
      var shareBtn = document.createElement('button');
      shareBtn.className = 'btn btn-secondary btn-sm';
      shareBtn.textContent = 'Share invite';
      shareBtn.addEventListener('click', function() {
        if (inviteUrl) navigator.share({ title: 'Join my Voxal room', url: inviteUrl }).catch(function() {});
      });
      nudge.appendChild(shareBtn);
    } else {
      var nudgeBtn = document.createElement('button');
      nudgeBtn.className = 'btn btn-secondary btn-sm';
      nudgeBtn.textContent = 'Copy invite link';
      nudgeBtn.addEventListener('click', function() {
        if (inviteUrl) copyTextToClipboard(inviteUrl, 'Invite link copied!');
      });
      nudge.appendChild(nudgeBtn);
    }
    list.appendChild(nudge);
  }

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

// RNNoise AudioWorklet state (shared across mic acquisitions)
let _rnnoiseCtx = null;       // AudioContext for the RNNoise pipeline
let _rnnoiseNode = null;      // AudioWorkletNode
let _rnnoiseReady = false;    // true once WASM is loaded
let _rnnoiseInitPromise = null;

async function initRNNoise() {
  if (_rnnoiseReady) return true;
  if (_rnnoiseInitPromise) return _rnnoiseInitPromise;

  _rnnoiseInitPromise = (async () => {
    try {
      // AudioWorklet requires a running AudioContext at 48kHz (RNNoise native rate)
      _rnnoiseCtx = new AudioContext({ sampleRate: 48000 });

      // Register the worklet processor
      await _rnnoiseCtx.audioWorklet.addModule('assets/rnnoise-processor.js');

      // Load WASM binary and compile it (main thread can use WebAssembly.compileStreaming)
      const wasmModule = await WebAssembly.compileStreaming(fetch('assets/rnnoise.wasm'));

      // Create the worklet node
      _rnnoiseNode = new AudioWorkletNode(_rnnoiseCtx, 'rnnoise-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1]
      });

      // Send compiled WASM module to the worklet thread
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('RNNoise init timeout')), 5000);
        _rnnoiseNode.port.onmessage = (e) => {
          if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
          else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
        };
        _rnnoiseNode.port.postMessage({ type: 'wasm-module', module: wasmModule });
      });

      _rnnoiseReady = true;
      devLog('[RNNoise] ✓ initialized');
      return true;
    } catch (err) {
      devLog('[RNNoise] ✗ init failed: ' + err.message);
      _rnnoiseCtx = null;
      _rnnoiseNode = null;
      _rnnoiseInitPromise = null;
      return false;
    }
  })();
  return _rnnoiseInitPromise;
}

function applyRNNoise(stream) {
  if (!_rnnoiseCtx || !_rnnoiseNode || !_rnnoiseReady) return stream;

  // Resume context if suspended (browser autoplay policy)
  if (_rnnoiseCtx.state === 'suspended') _rnnoiseCtx.resume();

  const source = _rnnoiseCtx.createMediaStreamSource(stream);
  const dest = _rnnoiseCtx.createMediaStreamDestination();

  source.connect(_rnnoiseNode);
  _rnnoiseNode.connect(dest);

  // Keep a reference so we can disconnect later
  dest.stream._rnnoiseSource = source;
  dest.stream._rnnoiseDest = dest;
  dest.stream._rnnoiseOriginal = stream;

  return dest.stream;
}

function getNoiseSuppressionMode() {
  return localStorage.getItem(NOISE_SUPPRESSION_KEY) || 'rnnoise';
}

function syncNoiseSuppressionControls() {
  var mode = getNoiseSuppressionMode();
  document.querySelectorAll('input[name="noise-suppression-mode"]').forEach(function(input) {
    input.checked = (input.value === mode);
  });
}

function selectedMicDeviceId() {
  return localStorage.getItem(MIC_DEVICE_KEY) || '';
}

function selectedCameraDeviceId() {
  return localStorage.getItem(CAMERA_DEVICE_KEY) || '';
}

function selectedSpeakerDeviceId() {
  return localStorage.getItem(SPEAKER_DEVICE_KEY) || '';
}

function selectedMicConstraints() {
  var micDeviceId = selectedMicDeviceId();
  return micDeviceId ? { deviceId: { exact: micDeviceId } } : {};
}

function selectedCameraConstraints() {
  var cameraId = selectedCameraDeviceId();
  return cameraId
    ? { deviceId: { exact: cameraId } }
    : { facingMode: 'user' };
}

function readStoredDeviceLabels() {
  try {
    var raw = localStorage.getItem(DEVICE_LABELS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeStoredDeviceLabels(map) {
  try { localStorage.setItem(DEVICE_LABELS_KEY, JSON.stringify(map || {})); } catch (_) {}
}

function setDeviceSelectOptions(select, devices, selectedId, prefix, labelMap) {
  if (!select) return;
  var html = '<option value="">System default</option>';
  devices.forEach(function(d, idx) {
    var label = d.label || (labelMap && labelMap[d.deviceId]) || (prefix + ' ' + (idx + 1));
    html += '<option value="' + d.deviceId + '">' +
      label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</option>';
  });
  select.innerHTML = html;
  var hasSelected = selectedId && devices.some(function(d) { return d.deviceId === selectedId; });
  select.value = hasSelected ? selectedId : '';
}

async function refreshMediaDeviceSelectors() {
  var micSelect = document.getElementById('select-mic-device');
  var camSelect = document.getElementById('select-camera-device');
  var speakerSelect = document.getElementById('select-speaker-device');
  if (!micSelect && !camSelect && !speakerSelect) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    if (micSelect) micSelect.innerHTML = '<option value="">Unavailable in this browser</option>';
    if (camSelect) camSelect.innerHTML = '<option value="">Unavailable in this browser</option>';
    if (speakerSelect) speakerSelect.innerHTML = '<option value="">Unavailable in this browser</option>';
    return;
  }

  try {
    var devices = await navigator.mediaDevices.enumerateDevices();
    var mics = devices.filter(function(d) { return d.kind === 'audioinput'; });
    var cams = devices.filter(function(d) { return d.kind === 'videoinput'; });
    var speakers = devices.filter(function(d) { return d.kind === 'audiooutput'; });
    var labelMap = readStoredDeviceLabels();
    devices.forEach(function(d) {
      if (d.deviceId && d.label) labelMap[d.deviceId] = d.label;
    });
    writeStoredDeviceLabels(labelMap);
    setDeviceSelectOptions(micSelect, mics, selectedMicDeviceId(), 'Microphone', labelMap);
    setDeviceSelectOptions(camSelect, cams, selectedCameraDeviceId(), 'Camera', labelMap);
    setDeviceSelectOptions(speakerSelect, speakers, selectedSpeakerDeviceId(), 'Speaker', labelMap);
  } catch (e) {
    console.warn('[Media devices] enumerate failed:', e.message);
  }
}

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

  const mode = getNoiseSuppressionMode();
  const useBrowserNS = (mode === 'browser');
  const useRNNoise = (mode === 'rnnoise');
  var audioConstraints = {
    channelCount: 1,
    sampleRate: useRNNoise ? 48000 : 16000,
    echoCancellation: true,
    noiseSuppression: useBrowserNS,
    autoGainControl: true
  };
  Object.assign(audioConstraints, selectedMicConstraints());

  const rawStream = await getUserMedia({
    audio: audioConstraints,
    video: false,
  });

  if (useRNNoise) {
    const ok = await initRNNoise();
    if (ok) return applyRNNoise(rawStream);
    // Fallback to raw stream if RNNoise fails
    devLog('[RNNoise] Falling back to raw stream');
  }

  return rawStream;
}

function attachAudio(peerId, remoteStream) {
  let el = document.getElementById('audio-' + peerId);
  if (!el) { el = new Audio(); el.id = 'audio-' + peerId; el.autoplay = true; document.body.appendChild(el); }
  el.srcObject = remoteStream;
  applySpeakerSink(el);
}

function detachAudio(peerId) { const el = document.getElementById('audio-' + peerId); if (el) el.remove(); }

async function applySpeakerSink(el) {
  if (!el || typeof el.setSinkId !== 'function') return;
  var sinkId = selectedSpeakerDeviceId();
  try {
    await el.setSinkId(sinkId || 'default');
  } catch (e) {
    console.warn('[Audio output] setSinkId failed:', e.message);
  }
}

function applySpeakerSinkToAllAudio() {
  document.querySelectorAll('audio[id^="audio-"]').forEach(function(el) {
    applySpeakerSink(el);
  });
}

function initCollapsibleSettingsCards() {
  function collapseOtherCards(openCard) {
    document.querySelectorAll('.settings-card[data-collapsible-init="1"]').forEach(function(other) {
      if (other === openCard) return;
      var otherBtn = other.querySelector(':scope > .settings-card-toggle');
      other.classList.add('is-collapsed');
      if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
    });
  }

  document.querySelectorAll('.settings-card').forEach(function(card) {
    if (card.dataset.collapsibleInit === '1') return;
    if (card.querySelector(':scope > details.turn-section')) return;
    var title = card.querySelector(':scope > .settings-group-title');
    if (!title) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-card-toggle';
    btn.textContent = title.textContent;
    btn.setAttribute('aria-expanded', 'false');
    title.replaceWith(btn);
    card.classList.add('is-collapsed');
    btn.addEventListener('click', function() {
      var wasCollapsed = card.classList.contains('is-collapsed');
      if (wasCollapsed) {
        collapseOtherCards(card);
        var advancedDetails = document.getElementById('turn-details');
        if (advancedDetails) advancedDetails.open = false;
      }
      var collapsed = card.classList.toggle('is-collapsed');
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    card.dataset.collapsibleInit = '1';
  });

  var advancedDetails = document.getElementById('turn-details');
  if (advancedDetails && advancedDetails.dataset.singleOpenInit !== '1') {
    advancedDetails.addEventListener('toggle', function() {
      if (!advancedDetails.open) return;
      collapseOtherCards(null);
    });
    advancedDetails.dataset.singleOpenInit = '1';
  }
}

function collapseAllSettingsCards() {
  document.querySelectorAll('.settings-card[data-collapsible-init="1"]').forEach(function(card) {
    card.classList.add('is-collapsed');
    var btn = card.querySelector(':scope > .settings-card-toggle');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
  var advancedDetails = document.getElementById('turn-details');
  if (advancedDetails) advancedDetails.open = false;
}

var _micTestStream = null;
var _micTestCtx = null;
var _micTestAnalyser = null;
var _micTestRaf = null;
var _micTestRecorder = null;
var _micTestChunks = [];
var _micTestPlaybackUrl = '';
var _cameraPreviewStream = null;

function clearMicTestPlayback() {
  var audio = document.getElementById('mic-test-playback');
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.classList.add('hidden');
  if (_micTestPlaybackUrl) {
    URL.revokeObjectURL(_micTestPlaybackUrl);
    _micTestPlaybackUrl = '';
  }
}

function renderMicTestPlayback(blob) {
  clearMicTestPlayback();
  if (!blob || !blob.size) return;
  var audio = document.getElementById('mic-test-playback');
  if (!audio) return;
  _micTestPlaybackUrl = URL.createObjectURL(blob);
  audio.src = _micTestPlaybackUrl;
  audio.classList.remove('hidden');
  audio.play().catch(function() {});
}

async function stopMicTest(options) {
  options = options || {};
  var replay = !!options.replay;
  if (_micTestRaf) {
    cancelAnimationFrame(_micTestRaf);
    _micTestRaf = null;
  }
  var recorder = _micTestRecorder;
  var chunks = _micTestChunks;
  var recordedBlob = null;
  if (recorder && recorder.state !== 'inactive') {
    recordedBlob = await new Promise(function(resolve) {
      recorder.onstop = function() {
        resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null);
      };
      recorder.stop();
    });
  } else if (chunks.length) {
    recordedBlob = new Blob(chunks, { type: 'audio/webm' });
  }
  _micTestRecorder = null;
  _micTestChunks = [];
  if (_micTestCtx) {
    _micTestCtx.close().catch(function() {});
    _micTestCtx = null;
  }
  _micTestAnalyser = null;
  if (_micTestStream) {
    _micTestStream.getTracks().forEach(function(t) { t.stop(); });
    _micTestStream = null;
  }
  var fill = document.getElementById('mic-test-level-fill');
  if (fill) {
    fill.style.width = '0%';
    var meter = fill.closest('.media-level');
    if (meter) meter.classList.add('hidden');
  }
  var btn = document.getElementById('btn-test-mic');
  if (btn) btn.textContent = 'Test';
  if (replay) renderMicTestPlayback(recordedBlob);
  else clearMicTestPlayback();
}

async function startMicTest() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  await stopMicTest();
  clearMicTestPlayback();
  var constraints = { audio: Object.assign({ echoCancellation: true }, selectedMicConstraints()), video: false };
  _micTestStream = await navigator.mediaDevices.getUserMedia(constraints);
  _micTestCtx = new (window.AudioContext || window.webkitAudioContext)();
  var source = _micTestCtx.createMediaStreamSource(_micTestStream);
  _micTestAnalyser = _micTestCtx.createAnalyser();
  _micTestAnalyser.fftSize = 1024;
  source.connect(_micTestAnalyser);
  if (typeof window.MediaRecorder === 'function') {
    try {
      _micTestRecorder = new MediaRecorder(_micTestStream);
      _micTestChunks = [];
      _micTestRecorder.ondataavailable = function(ev) {
        if (ev.data && ev.data.size > 0) _micTestChunks.push(ev.data);
      };
      _micTestRecorder.start();
    } catch (e) {
      _micTestRecorder = null;
      _micTestChunks = [];
      console.warn('[Mic test] recorder unavailable:', e.message);
    }
  }

  var btn = document.getElementById('btn-test-mic');
  if (btn) btn.textContent = 'Stop & Replay';
  var fill = document.getElementById('mic-test-level-fill');
  if (fill) {
    var meter = fill.closest('.media-level');
    if (meter) meter.classList.remove('hidden');
  }
  var data = new Uint8Array(_micTestAnalyser.fftSize);
  var tick = function() {
    if (!_micTestAnalyser) return;
    _micTestAnalyser.getByteTimeDomainData(data);
    var sum = 0;
    for (var i = 0; i < data.length; i++) {
      var centered = (data[i] - 128) / 128;
      sum += centered * centered;
    }
    var rms = Math.sqrt(sum / data.length);
    var percent = Math.max(0, Math.min(100, Math.round(rms * 220)));
    if (fill) fill.style.width = percent + '%';
    _micTestRaf = requestAnimationFrame(tick);
  };
  tick();
}

async function toggleMicTest() {
  if (_micTestStream) await stopMicTest({ replay: true });
  else {
    try { await startMicTest(); }
    catch (e) { showCopyToast('Microphone test failed'); console.warn('[Mic test]', e.message); }
  }
}

function stopCameraPreview() {
  if (_cameraPreviewStream) {
    _cameraPreviewStream.getTracks().forEach(function(t) { t.stop(); });
    _cameraPreviewStream = null;
  }
  var video = document.getElementById('camera-preview-video');
  if (video) {
    video.srcObject = null;
    video.classList.add('hidden');
  }
  var btn = document.getElementById('btn-preview-camera');
  if (btn) btn.textContent = 'Preview';
}

async function startCameraPreview() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  stopCameraPreview();
  _cameraPreviewStream = await navigator.mediaDevices.getUserMedia({
    video: selectedCameraConstraints(),
    audio: false
  });
  var video = document.getElementById('camera-preview-video');
  if (video) {
    video.srcObject = _cameraPreviewStream;
    video.classList.remove('hidden');
    video.play().catch(function() {});
  }
  var btn = document.getElementById('btn-preview-camera');
  if (btn) btn.textContent = 'Stop Preview';
}

async function toggleCameraPreview() {
  if (_cameraPreviewStream) stopCameraPreview();
  else {
    try { await startCameraPreview(); }
    catch (e) { showCopyToast(cameraAccessHint(e)); console.warn('[Camera preview]', e.message); }
  }
}

async function testSpeakerOutput() {
  var statusEl = document.getElementById('speaker-test-status');
  if (statusEl) statusEl.textContent = 'Playing…';
  var ctx = new (window.AudioContext || window.webkitAudioContext)();
  var dest = ctx.createMediaStreamDestination();
  var tone = new Audio();
  tone.autoplay = true;
  tone.srcObject = dest.stream;
  tone.volume = 0.9;
  if (typeof tone.setSinkId === 'function') {
    try {
      var sink = selectedSpeakerDeviceId();
      await tone.setSinkId(sink || 'default');
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Output routing unavailable';
      console.warn('[Speaker test]', e.message);
    }
  }
  var now = ctx.currentTime;
  var notes = [523.25, 659.25, 783.99, 659.25, 698.46, 880];
  notes.forEach(function(freq, idx) {
    var start = now + (idx * 0.13);
    var end = start + 0.12;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(start);
    osc.stop(end);
  });
  setTimeout(function() {
    tone.pause();
    tone.srcObject = null;
    ctx.close().catch(function() {});
    if (statusEl) statusEl.textContent = '';
  }, 1300);
}

// --- PTT & hands-free ---------------------------------------------------------

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
  btn.setAttribute('aria-pressed', String(active));
  btn.classList.toggle('active', active);
  $('ptt-btn').classList.toggle('freehand', active);
  if (!active) $('ptt-btn').classList.remove('active');

  if (active) {
    var isMobile = window.Capacitor && window.Capacitor.isNativePlatform();
    if (isMobile) {
      $('ptt-hint').textContent = 'Hands-free · tap to stop';
    } else {
      $('ptt-hint').innerHTML = pttHintHtml('Hands-free · press ', ' to stop');
    }
    $('ptt-status').textContent = '\u25cf Live';
  } else {
    var isMobile = window.Capacitor && window.Capacitor.isNativePlatform();
    if (isMobile) {
      $('ptt-hint').textContent = 'Hold to talk · double-tap for hands-free';
    } else {
      $('ptt-hint').innerHTML = pttHintHtml('Hold ', ' anywhere to talk · x2 for hands-free');
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

function shouldRetainPeerWithoutMedia(peerId) {
  return knownPeerIds.has(peerId);
}

function clearPeerMedia(peerId) {
  const conn = connections.get(peerId);
  if (!conn) return;
  if (conn.data || shouldRetainPeerWithoutMedia(peerId)) {
    connections.set(peerId, Object.assign({}, conn, { media: null, talking: false }));
  } else {
    connections.delete(peerId);
  }
  detachAudio(peerId);
  updatePeerList();
}

function isCurrentPeerDataConnection(peerId, dataConn) {
  // Reject stale close events fired synchronously during leaveRoom() → removePeer():
  // PeerJS emits 'close' synchronously via EventEmitter when data.close() is called,
  // so the handler runs while inRoom is already false but connections is still populated.
  if (!inRoom) return false;
  const conn = connections.get(peerId);
  return !!conn && conn.data === dataConn;
}

function shouldAcceptJoinerDataConnection(joinerId) {
  if (isHost) {
    return true;
  }
  if (!inRoom || !peer) {
    return false;
  }
  if (connectingToHostId) {
    return false;
  }
  var hostConn = connections.get(roomCode);
  if (hostConn && hostConn.data && hostConn.data.open) {
    return false;
  }
  var electedHostId = preferredSuccessorCandidates(roomCode)[0] || null;
  var accepted = joinerId !== roomCode && electedHostId === peer.id;
  return accepted;
}

// --- Video prototype helpers -------------------------------------------------

function updateVideoModeUI() {
  // Video mode toggle in settings (visible only when dev mode + host + in room)
  var settingRow = document.getElementById('video-mode-setting');
  if (settingRow) {
    settingRow.classList.toggle('hidden', !isDevModeEnabled());
    var toggleBtn = document.getElementById('btn-video-mode');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', videoModeEnabled);
      toggleBtn.textContent = videoModeEnabled ? 'ON' : 'OFF';
      toggleBtn.setAttribute('aria-pressed', String(videoModeEnabled));
    }
  }
  // Share camera button in room controls (visible when video mode is active)
  var shareBtn = document.getElementById('btn-share-camera');
  if (shareBtn) {
    shareBtn.classList.toggle('hidden', !videoModeEnabled);
    shareBtn.classList.toggle('active', localVideoActive);
    shareBtn.setAttribute('aria-pressed', String(localVideoActive));
  }
  // Share screen button (visible when video mode is active, hidden on mobile)
  var screenBtn = document.getElementById('btn-share-screen');
  if (screenBtn) {
    var canShareScreen = videoModeEnabled && !IS_NATIVE_MOBILE && !!navigator.mediaDevices && !!navigator.mediaDevices.getDisplayMedia;
    screenBtn.classList.toggle('hidden', !canShareScreen);
    screenBtn.classList.toggle('active', localScreenActive);
    screenBtn.setAttribute('aria-pressed', String(localScreenActive));
  }
  if (inRoom) updatePeerList();
}

function cameraAccessHint(err) {
  var name = String((err && err.name) || '');
  var message = String((err && err.message) || '');
  var policyBlocked = /permissions policy|camera is not allowed in this document/i.test(message) || name === 'SecurityError';
  if (policyBlocked && _isIframe) {
    return 'Camera is blocked in this iframe — add allow="camera" to the <iframe>.';
  }
  if (policyBlocked || name === 'NotAllowedError') {
    return 'Camera access was blocked by the browser.';
  }
  return 'Camera access failed';
}

function toggleVideoMode() {
  videoModeEnabled = !videoModeEnabled;
  localStorage.setItem(VIDEO_MODE_KEY, String(videoModeEnabled));
  // Notify peers if we're host in a room
  if (isHost && inRoom) {
    connections.forEach(function(c) {
      if (c.data) c.data.send({ type: 'video-mode', enabled: videoModeEnabled });
    });
  }
  if (!videoModeEnabled) stopVideoShare();
  updateVideoModeUI();
}

async function startVideoShare() {
  if (localVideoActive) return;
  try {
    localVideoStream = await navigator.mediaDevices.getUserMedia({
      video: selectedCameraConstraints(),
      audio: false
    });
  } catch (e) {
    devLog('[Video] Camera share failed: ' + (e && e.message ? e.message : String(e)), 'warn');
    showCopyToast(cameraAccessHint(e));
    return;
  }
  localVideoActive = true;
  // Auto-activate hands-free when sharing camera
  if (!freeHandMode) setFreeHand(true);


  // Open a video MediaConnection to each connected peer
  connections.forEach(function(c, peerId) {
    if (!peer || peerId === peer.id) return;
    var videoCall = peer.call(peerId, localVideoStream, { metadata: { type: 'video' } });
    if (!videoCall) return;
    videoCall.on('stream', function(remote) {
      // Only use this stream if we don't already have one from an incoming call
      var existing = connections.get(peerId);
      if (!existing || !existing.remoteVideoStream || !existing.remoteVideoStream.active) {
        attachRemoteVideo(peerId, remote);
      }
    });
    videoCall.on('close', function() {
      // Only clean up outgoing ref; remote status is driven by video-stop messages
      if (c.videoMediaOut === videoCall) c.videoMediaOut = null;
    });
    c.videoMediaOut = videoCall;
  });
  // Signal via data channel
  var msg = { type: 'video-offer', peerId: peer.id };
  if (isHost) {
    connections.forEach(function(c) { if (c.data) c.data.send(msg); });
  } else {
    var hc = connections.get(roomCode);
    if (hc && hc.data) hc.data.send(msg);
  }
  updateVideoModeUI();
}

function stopVideoShare() {
  if (!localVideoActive && !localVideoStream) return;
  if (localVideoStream) {
    localVideoStream.getTracks().forEach(function(t) { t.stop(); });
    localVideoStream = null;
  }
  connections.forEach(function(c) {
    // Just drop the reference; tracks are already stopped above via localVideoStream
    c.videoMediaOut = null;
  });
  if (peer && inRoom) {
    var msg = { type: 'video-stop', peerId: peer.id };
    if (isHost) {
      connections.forEach(function(c) { if (c.data) c.data.send(msg); });
    } else {
      var hc = connections.get(roomCode);
      if (hc && hc.data) hc.data.send(msg);
    }
  }
  localVideoActive = false;
  updateVideoModeUI();
}

// --- Screen sharing (dev mode) -----------------------------------------------

async function startScreenShare() {
  if (localScreenActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showCopyToast('Screen sharing not supported');
    return;
  }
  try {
    localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false
    });
  } catch (e) {
    showCopyToast('Screen share cancelled');
    return;
  }
  localScreenActive = true;
  // Auto-activate hands-free when sharing screen
  if (!freeHandMode) setFreeHand(true);
  // Stop sharing when browser's native "Stop sharing" is clicked
  localScreenStream.getVideoTracks()[0].addEventListener('ended', function() {
    stopScreenShare();
  });
  // Open a screen MediaConnection to each connected peer
  connections.forEach(function(c, peerId) {
    if (!peer || peerId === peer.id) return;
    var screenCall = peer.call(peerId, localScreenStream, { metadata: { type: 'screen' } });
    if (!screenCall) return;
    screenCall.on('stream', function(remote) {
      var existing = connections.get(peerId);
      if (!existing || !existing.remoteScreenStream || !existing.remoteScreenStream.active) {
        attachRemoteScreen(peerId, remote);
      }
    });
    screenCall.on('close', function() {
      if (c.screenMediaOut === screenCall) c.screenMediaOut = null;
    });
    c.screenMediaOut = screenCall;
  });
  // Signal via data channel
  var msg = { type: 'screen-offer', peerId: peer.id };
  if (isHost) {
    connections.forEach(function(c) { if (c.data) c.data.send(msg); });
  } else {
    var hc = connections.get(roomCode);
    if (hc && hc.data) hc.data.send(msg);
  }
  updateVideoModeUI();
}

function stopScreenShare() {
  if (!localScreenActive && !localScreenStream) return;
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(function(t) { t.stop(); });
    localScreenStream = null;
  }
  connections.forEach(function(c) {
    c.screenMediaOut = null;
  });
  if (peer && inRoom) {
    var msg = { type: 'screen-stop', peerId: peer.id };
    if (isHost) {
      connections.forEach(function(c) { if (c.data) c.data.send(msg); });
    } else {
      var hc = connections.get(roomCode);
      if (hc && hc.data) hc.data.send(msg);
    }
  }
  localScreenActive = false;
  updateVideoModeUI();
}

function handleIncomingScreenCall(call) {
  call.answer(new MediaStream());
  call.on('stream', function(remote) {
    attachRemoteScreen(call.peer, remote);
    markPeerScreenActive(call.peer, true);
  });
  call.on('close', function() {
    var conn = connections.get(call.peer);
    if (conn && conn.screenMedia === call) {
      conn.screenMedia = null;
      conn.remoteScreenStream = null;
      conn.screenActive = false;
      if (_screenViewerPeerId === call.peer) closeScreenViewer();
      updatePeerList();
    }
  });
  call.on('error', function(err) { console.warn('[screen-call]', err); });
  var conn = connections.get(call.peer);
  if (conn) conn.screenMedia = call;
}

function attachRemoteScreen(peerId, remoteStream) {
  var conn = connections.get(peerId);
  if (conn) conn.remoteScreenStream = remoteStream;
  updatePeerList();
  if (_screenViewerPeerId === peerId) {
    openScreenViewer(peerId);
  }
}

function detachRemoteScreen(peerId) {
  var conn = connections.get(peerId);
  if (conn) {
    if (conn.screenMedia) { conn.screenMedia.close(); conn.screenMedia = null; }
    conn.remoteScreenStream = null;
    conn.screenActive = false;
  }
  if (_screenViewerPeerId === peerId) closeScreenViewer();
  updatePeerList();
}

function markPeerScreenActive(peerId, active) {
  var conn = connections.get(peerId);
  if (conn) conn.screenActive = active;
  if (!active && _screenViewerPeerId === peerId) closeScreenViewer();
  updatePeerList();
}

function handleIncomingVideoCall(call) {
  // Always answer with empty stream — we send our video via our own outgoing call
  call.answer(new MediaStream());
  call.on('stream', function(remote) {
    attachRemoteVideo(call.peer, remote);
    markPeerVideoActive(call.peer, true);
  });
  call.on('close', function() {
    // Only detach if this call is still the active incoming connection
    var conn = connections.get(call.peer);
    if (conn && conn.videoMedia === call) {
      conn.videoMedia = null;
      conn.remoteVideoStream = null;
      conn.videoActive = false;
      if (_videoViewerPeerId === call.peer) closeVideoViewer();
      updatePeerList();
    }
  });
  call.on('error', function(err) { console.warn('[video-call]', err); });
  var conn = connections.get(call.peer);
  if (conn) conn.videoMedia = call;
}

function attachRemoteVideo(peerId, remoteStream) {
  var conn = connections.get(peerId);
  if (conn) conn.remoteVideoStream = remoteStream;
  updatePeerList();
  // Re-open viewer if it's already pointing at this peer (e.g. reconnect)
  if (_videoViewerPeerId === peerId) {
    openVideoViewer(peerId);
  }
}

function detachRemoteVideo(peerId) {
  var conn = connections.get(peerId);
  if (conn) {
    if (conn.videoMedia) { conn.videoMedia.close(); conn.videoMedia = null; }
    conn.remoteVideoStream = null;
    conn.videoActive = false;
  }
  if (_videoViewerPeerId === peerId) closeVideoViewer();
  updatePeerList();
}

function markPeerVideoActive(peerId, active) {
  var conn = connections.get(peerId);
  if (conn) conn.videoActive = active;
  if (!active && _videoViewerPeerId === peerId) closeVideoViewer();
  updatePeerList();
}

function openVideoViewer(peerId) {
  var conn = connections.get(peerId);
  if (!conn || !conn.remoteVideoStream) return;
  _videoViewerPeerId = peerId;
  _videoPopoutWindow = null;

  // On Tauri desktop, open directly in pop-out window (no integrated panel)
  if (IS_TAURI_DESKTOP) {
    popOutVideoViewer();
    return;
  }

  var panel = document.getElementById('video-viewer-panel');
  var vid   = document.getElementById('video-viewer-element');
  if (!panel || !vid) return;
  vid.srcObject = conn.remoteVideoStream;
  var title = document.getElementById('video-viewer-title');
  if (title) title.textContent = '📹 ' + (conn.pseudo || 'Camera');
  panel.classList.remove('hidden');
  if (!IS_NATIVE_MOBILE && /Mobi|Android/i.test(navigator.userAgent)) {
    if (panel.requestFullscreen) panel.requestFullscreen().catch(function() {});
  }
}

function openScreenViewer(peerId) {
  var conn = connections.get(peerId);
  if (!conn || !conn.remoteScreenStream) return;
  _screenViewerPeerId = peerId;
  _screenPopoutWindow = null;

  if (IS_TAURI_DESKTOP) {
    popOutScreenViewer();
    return;
  }

  var panel = document.getElementById('screen-viewer-panel');
  var vid   = document.getElementById('screen-viewer-element');
  if (!panel || !vid) return;
  vid.srcObject = conn.remoteScreenStream;
  var title = document.getElementById('screen-viewer-title');
  if (title) title.textContent = '🖥 ' + (conn.pseudo || 'Screen');
  panel.classList.remove('hidden');
  if (!IS_NATIVE_MOBILE && /Mobi|Android/i.test(navigator.userAgent)) {
    if (panel.requestFullscreen) panel.requestFullscreen().catch(function() {});
  }
}

var _videoLoopbackPC = null;
var _videoPopoutUnlisten = null;

function popOutVideoViewer() {
  if (!_videoViewerPeerId) return;
  var conn = connections.get(_videoViewerPeerId);
  var stream = conn && conn.remoteVideoStream;
  if (!conn || !stream) return;

  // Web/mobile (non-Tauri): use Picture-in-Picture API
  if (!IS_TAURI_DESKTOP) {
    var vid = document.getElementById('video-viewer-element');
    if (vid) {
      if (document.pictureInPictureEnabled && vid.requestPictureInPicture) {
        vid.requestPictureInPicture().then(function() {
          var panel = document.getElementById('video-viewer-panel');
          if (panel) panel.classList.add('hidden');
        }).catch(function(e) {
          console.warn('[video] PiP failed:', e.message);
          showCopyToast('Picture-in-Picture not available');
        });
      } else if (vid.webkitSetPresentationMode) {
        vid.webkitSetPresentationMode('picture-in-picture');
        var panel = document.getElementById('video-viewer-panel');
        if (panel) panel.classList.add('hidden');
      } else {
        showCopyToast('Picture-in-Picture not available');
      }
    }
    return;
  }

  // Tauri: open a WebviewWindow and relay video via WebRTC loopback + Tauri events
  var tauriEvent = window.__TAURI__.event;
  var peerName = (conn.pseudo || 'Camera');

  // Register listener FIRST, then open window to avoid race
  tauriEvent.listen('video-popup-signal', async function(ev) {
    var msg = ev.payload;
    if (msg.type === 'ready') {
      _videoLoopbackPC = new RTCPeerConnection();
      stream.getTracks().forEach(function(t) { _videoLoopbackPC.addTrack(t, stream); });
      var offer = await _videoLoopbackPC.createOffer();
      await _videoLoopbackPC.setLocalDescription(offer);
      await new Promise(function(resolve) {
        if (_videoLoopbackPC.iceGatheringState === 'complete') return resolve();
        _videoLoopbackPC.onicecandidate = function(ev) { if (!ev.candidate) resolve(); };
      });
      tauriEvent.emit('video-main-signal', {
        type: 'offer',
        sdp: { type: _videoLoopbackPC.localDescription.type, sdp: _videoLoopbackPC.localDescription.sdp }
      });
    }
    if (msg.type === 'answer') {
      if (_videoLoopbackPC) {
        await _videoLoopbackPC.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    }
    if (msg.type === 'pop-in') {
      _cleanupLoopback();
      _videoViewerPeerId = null;
    }
  }).then(function(unlisten) {
    _videoPopoutUnlisten = unlisten;
    // Get video dimensions from the track
    var videoTrack = stream.getVideoTracks()[0];
    var settings = videoTrack ? videoTrack.getSettings() : {};
    var vw = settings.width || 640;
    var vh = settings.height || 480;
    // Cap to reasonable window size
    if (vw > 1280) { vh = Math.round(vh * 1280 / vw); vw = 1280; }
    // Open the popup AFTER listener is ready
    var WebviewWindow = window.__TAURI__.webviewWindow.WebviewWindow;
    var popWin = new WebviewWindow('video-popup', {
      url: 'video-popup.html',
      title: peerName,
      width: vw,
      height: vh,
      resizable: true,
      alwaysOnTop: true,
    });
    _videoPopoutWindow = popWin;
    popWin.once('tauri://destroyed', function() {
      _cleanupLoopback();
      _videoViewerPeerId = null;
    });
    popWin.once('tauri://error', function(e) {
      console.error('[video] Window creation error:', e);
      _cleanupLoopback();
    });
  }).catch(function(err) {
    console.error('[video] Failed to set up pop-out:', err);
  });

  var panel = document.getElementById('video-viewer-panel');
  if (panel) panel.classList.add('hidden');
}

function _cleanupLoopback() {
  if (_videoLoopbackPC) { _videoLoopbackPC.close(); _videoLoopbackPC = null; }
  if (_videoPopoutUnlisten) { _videoPopoutUnlisten(); _videoPopoutUnlisten = null; }
}

var _screenLoopbackPC = null;
var _screenPopoutUnlisten = null;

function popOutScreenViewer() {
  if (!_screenViewerPeerId) return;
  var conn = connections.get(_screenViewerPeerId);
  var stream = conn && conn.remoteScreenStream;
  if (!conn || !stream) return;

  // Web/mobile (non-Tauri): use Picture-in-Picture API
  if (!IS_TAURI_DESKTOP) {
    var vid = document.getElementById('screen-viewer-element');
    if (vid) {
      if (document.pictureInPictureEnabled && vid.requestPictureInPicture) {
        vid.requestPictureInPicture().then(function() {
          var panel = document.getElementById('screen-viewer-panel');
          if (panel) panel.classList.add('hidden');
        }).catch(function(e) {
          showCopyToast('Picture-in-Picture not available');
        });
      } else {
        showCopyToast('Picture-in-Picture not available');
      }
    }
    return;
  }

  // Tauri: open a WebviewWindow for screen share
  var tauriEvent = window.__TAURI__.event;
  var peerName = (conn.pseudo || 'Screen') + ' — Screen';

  tauriEvent.listen('screen-popup-signal', async function(ev) {
    var msg = ev.payload;
    if (msg.type === 'ready') {
      var freshConn = connections.get(_screenViewerPeerId);
      var freshStream = freshConn && freshConn.remoteScreenStream;
      if (!freshStream || !freshStream.getVideoTracks().length) {
        console.warn('[screen] No video tracks in screen stream');
        return;
      }
      _screenLoopbackPC = new RTCPeerConnection();
      freshStream.getTracks().forEach(function(t) { _screenLoopbackPC.addTrack(t, freshStream); });
      var offer = await _screenLoopbackPC.createOffer();
      await _screenLoopbackPC.setLocalDescription(offer);
      await new Promise(function(resolve) {
        if (_screenLoopbackPC.iceGatheringState === 'complete') return resolve();
        _screenLoopbackPC.onicecandidate = function(ev) { if (!ev.candidate) resolve(); };
      });
      tauriEvent.emit('screen-main-signal', {
        type: 'offer',
        sdp: { type: _screenLoopbackPC.localDescription.type, sdp: _screenLoopbackPC.localDescription.sdp }
      });
    }
    if (msg.type === 'answer') {
      if (_screenLoopbackPC) {
        await _screenLoopbackPC.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    }
    if (msg.type === 'pop-in') {
      _cleanupScreenLoopback();
      _screenViewerPeerId = null;
    }
  }).then(function(unlisten) {
    _screenPopoutUnlisten = unlisten;
    var videoTrack = stream.getVideoTracks()[0];
    var settings = videoTrack ? videoTrack.getSettings() : {};
    var vw = settings.width || 1280;
    var vh = settings.height || 720;
    if (vw > 1920) { vh = Math.round(vh * 1920 / vw); vw = 1920; }
    var WebviewWindow = window.__TAURI__.webviewWindow.WebviewWindow;
    var popWin = new WebviewWindow('screen-popup', {
      url: 'screen-popup.html',
      title: peerName,
      width: vw,
      height: vh,
      resizable: true,
      alwaysOnTop: true,
    });
    _screenPopoutWindow = popWin;
    popWin.once('tauri://destroyed', function() {
      _cleanupScreenLoopback();
      _screenViewerPeerId = null;
    });
    popWin.once('tauri://error', function(e) {
      console.error('[screen] Window creation error:', e);
      _cleanupScreenLoopback();
    });
  }).catch(function(err) {
    console.error('[screen] Failed to set up pop-out:', err);
  });

  var panel = document.getElementById('screen-viewer-panel');
  if (panel) panel.classList.add('hidden');
}

function _cleanupScreenLoopback() {
  if (_screenLoopbackPC) { _screenLoopbackPC.close(); _screenLoopbackPC = null; }
  if (_screenPopoutUnlisten) { _screenPopoutUnlisten(); _screenPopoutUnlisten = null; }
}

// Called by the popup when user clicks "Pop In" or closes the popup
window._voxalVideoPopIn = function() {
  _videoPopoutWindow = null;
  window._voxalVideoStream = null;
  if (_videoViewerPeerId) {
    openVideoViewer(_videoViewerPeerId);
  }
};

function closeVideoViewer() {
  var panel = document.getElementById('video-viewer-panel');
  var vid   = document.getElementById('video-viewer-element');
  if (panel) panel.classList.add('hidden');
  if (vid) vid.srcObject = null;
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(function() {});
  }
  if (_videoPopoutWindow && !_videoPopoutWindow.closed) {
    _videoPopoutWindow.close();
  }
  _videoPopoutWindow = null;
  window._voxalVideoStream = null;
  _cleanupLoopback();
  _videoViewerPeerId = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(function() {});
}

function closeScreenViewer() {
  var panel = document.getElementById('screen-viewer-panel');
  var vid   = document.getElementById('screen-viewer-element');
  if (panel) panel.classList.add('hidden');
  if (vid) vid.srcObject = null;
  if (_screenPopoutWindow && !_screenPopoutWindow.closed) {
    _screenPopoutWindow.close();
  }
  _screenPopoutWindow = null;
  _cleanupScreenLoopback();
  _screenViewerPeerId = null;
}

function resetVideoState() {
  stopVideoShare();
  stopScreenShare();
  videoModeEnabled = true;
  localStorage.setItem(VIDEO_MODE_KEY, 'true');
  localVideoActive = false;
  localVideoStream = null;
  localScreenActive = false;
  localScreenStream = null;
  _videoViewerPeerId = null;
  _screenViewerPeerId = null;
  if (_videoPopoutWindow && !_videoPopoutWindow.closed) _videoPopoutWindow.close();
  _videoPopoutWindow = null;
  if (_screenPopoutWindow && !_screenPopoutWindow.closed) _screenPopoutWindow.close();
  _screenPopoutWindow = null;
  window._voxalVideoStream = null;
  connections.forEach(function(c) {
    c.videoMedia = null;
    c.videoMediaOut = null;
    c.remoteVideoStream = null;
    c.videoActive = false;
    c.screenMedia = null;
    c.screenMediaOut = null;
    c.remoteScreenStream = null;
    c.screenActive = false;
  });
  closeVideoViewer();
  closeScreenViewer();
  updateVideoModeUI();
}

// --- End video prototype helpers ---------------------------------------------

function leaveRoom() {
  saveRejoinSnapshot();
  resetVideoState();
  // If this host is the last participant in a published lobby, delete it from the API
  if (isHost && _publishSecret && connections.size === 0) {
    unpublishRoom();
  } else {
    clearPublishState();
  }
  inRoom = false; freeHandMode = false; isTalking = false;
  connectingToHostId = null;
  ++_hostConnGeneration; // invalidate any pending retry timers
  _lastHostHeartbeatAt = 0;
  roomState = ROOM_STATE_IDLE;
  _migrationExcluded.clear();
  _migrationCandidateId = null;
  _lastAuthoritativePeerIds = null;
  _authoritativeSuccessorIds = [];
  stopMigrationSettle();
  stopStatsPolling();
  closeStatsPopover();
  stopHostHeartbeat();
  stopHostHeartbeatMonitor();
  stopPeerHeartbeat();
  stopPeerHeartbeatSweep();
  knownPeerIds.clear();
  releaseAudioFocus();
  nativePTTLeave();
  stopKeepAlive();
  localStorage.removeItem('active-room-code');
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

var HOST_CONNECT_TIMEOUT    = 8000; // per-attempt timeout
var HOST_RETRY_DELAY        = 2000; // delay between retries
var HOST_MAX_RETRIES        = 3;    // retries before re-electing
var MIGRATION_SETTLE_MS     = 8000; // grace period for peers to reconnect to new host
var _migrationSettleTimer   = null;

function isMigrationSettling() {
  return !!_migrationSettleTimer;
}

function stopMigrationSettle() {
  if (_migrationSettleTimer) {
    clearTimeout(_migrationSettleTimer);
    _migrationSettleTimer = null;
  }
}

function startMigrationSettle() {
  stopMigrationSettle();
  _migrationSettleTimer = setTimeout(function() {
    _migrationSettleTimer = null;
    if (!inRoom || !isHost) return;
    // Grace period over — prune peers that never reconnected and re-broadcast clean list
    broadcastHostPeerLists();
  }, MIGRATION_SETTLE_MS);
}

// Ensure every peer we know about has at least a placeholder entry in connections
// so they stay visible in the peer list while reconnecting after host migration.
function ensurePlaceholdersForKnownPeers() {
  knownPeerIds.forEach(function(peerId) {
    if (!peerId || (peer && peer.id === peerId)) return;
    if (connections.has(peerId)) return;
    connections.set(peerId, { data: null, media: null, pseudo: shortId(peerId), talking: false });
  });
}

function migrationPeerAlias(peerId) {
  if (!peerId) return '';
  if (peer && peer.id === peerId) return (myPseudo || '').trim();
  const conn = connections.get(peerId);
  return conn && conn.pseudo ? String(conn.pseudo).trim() : '';
}

function migrationAliasCounts() {
  const counts = new Map();

  function addAlias(alias) {
    if (!alias) return;
    counts.set(alias, (counts.get(alias) || 0) + 1);
  }

  addAlias((myPseudo || '').trim());
  connections.forEach(function(conn) {
    addAlias(conn && conn.pseudo ? String(conn.pseudo).trim() : '');
  });

  return counts;
}

function migrationPeerLabel(peerId) {
  if (!peerId) return 'none';
  const alias = migrationPeerAlias(peerId);
  if (!alias) return shortId(peerId) + ' [' + peerId + ']';
  const aliasCounts = migrationAliasCounts();
  if ((aliasCounts.get(alias) || 0) > 1) return alias + ' [' + peerId + ']';
  return alias;
}

function migrationCandidatesLabel(candidates) {
  if (!candidates || !candidates.length) return 'none';
  return candidates.map(migrationPeerLabel).join(', ');
}

function initiateHostMigration(failedOrOldHostId) {
  if (!inRoom) return;

  // Case A: starting migration from connected state
  if (roomState === ROOM_STATE_CONNECTED) {
    const oldHostId = failedOrOldHostId || roomCode;
    if (oldHostId !== roomCode) {
      return; // stale, not from current host
    }
    roomState = ROOM_STATE_MIGRATING;
    _migrationExcluded = new Set([oldHostId]);
    _migrationCandidateId = null;
    connectingToHostId = null;

    // Cleanup OLD HOST only — keep audio mesh and other peer state
    forgetPeer(oldHostId);
    const oldConn = connections.get(oldHostId);
    if (oldConn) {
      if (oldConn.data) { try { oldConn.data.close(); } catch (_) {} }
      if (oldConn.media) { try { oldConn.media.close(); } catch (_) {} }
      connections.delete(oldHostId);
      detachAudio(oldHostId);
    }
    playGoodbye();
    proceedWithHostElection();
    return;
  }

  // Case B: candidate failed during ongoing migration
  if (roomState === ROOM_STATE_MIGRATING) {
    if (failedOrOldHostId && failedOrOldHostId === _migrationCandidateId) {
      _migrationExcluded.add(failedOrOldHostId);
      _migrationCandidateId = null;
      console.warn('[migration] Candidate ' + migrationPeerLabel(failedOrOldHostId) + ' failed; re-electing.');
      proceedWithHostElection();
    } else {
    }
    // else: stale event, ignore
    return;
  }
}

function proceedWithHostElection() {
  if (!inRoom || !peer) return;
  const candidates = preferredSuccessorCandidates(roomCode).filter(function(id) {
    return !_migrationExcluded.has(id);
  });
  const newHostId = candidates[0] || null;
  const nextDeputyId = newHostId ? preferredSuccessorCandidates(roomCode).filter(function(id) {
    return id !== newHostId && !_migrationExcluded.has(id);
  })[0] || null : null;

  console.warn(
    '[migration] Self ' + migrationPeerLabel(peer.id) +
    '. Candidates: ' + migrationCandidatesLabel(candidates) +
    '. Elected: ' + migrationPeerLabel(newHostId) +
    '. Next deputy: ' + migrationPeerLabel(nextDeputyId) + '.'
  );

  if (!newHostId) {
    console.warn('[migration] No host candidate remains, leaving room.');
    leaveRoom();
    return;
  }

  if (newHostId === peer.id) {
    becomeHost();
  } else {
    connectToNewHost(newHostId);
  }
  updatePeerList();
}

function becomeHost() {
  connectingToHostId = null;
  roomState = ROOM_STATE_CONNECTED;
  _migrationExcluded.clear();
  _migrationCandidateId = null;
  isHost = true;
  roomCode = peer.id;
  _lastHostHeartbeatAt = 0;
  stopPeerHeartbeat();
  stopHostHeartbeatMonitor();
  startPeerHeartbeatSweep();
  ensurePlaceholdersForKnownPeers();
  startMigrationSettle();
  startHostHeartbeat();
  localStorage.setItem('active-room-code', peer.id);
  console.log(
    '[migration] This peer became host: ' + migrationPeerLabel(peer.id) +
    '. Deputy is now ' + migrationPeerLabel(currentDeputyId() || null) + '.'
  );
  iframeEmit({ type: 'host-changed', roomCode: peer.id, isSelf: true });
  saveRejoinSnapshot();
  updateRoomHeader();
  updatePeerList();
  // Broadcast peer-list to any existing data connections
  connections.forEach(function(c) {
    if (c.data) {
      c.data.send({
        type: 'peer-list',
        peers: buildHostPeerList(peer.id),
        hostId: peer.id,
        hostPseudo: pseudoForHost()
      });
    }
  });
  // peer.on('connection') is already wired in joinRoom() and will route here
  // since isHost is now true

  // If the room was published as a public lobby, update the API with our new peer ID
  if (_publishedRoomId && _publishSecret) {
    publishRoom().catch(function(e) { console.warn('[migration] re-publish failed:', e.message); });
  }
}

function buildHostPeerList(excludedPeerId) {
  // During the migration settle window, include all known peers so non-host peers
  // don't see a blank roster while reconnecting. After the settle, use only peers
  // with open data connections.
  var peerIds = (!isHost || isMigrationSettling()) ? Array.from(knownPeerIds) : hostConnectedPeerIds();
  return peerIds
    .filter(function(id) { return id !== excludedPeerId; })
    .map(function(id) {
      const conn = connections.get(id);
      const pseudo = (conn && conn.pseudo ? String(conn.pseudo).trim() : '') || shortId(id);
      var entry = { id: id, pseudo: pseudo };
      if (conn && conn.videoActive) entry.videoActive = true;
      if (conn && conn.screenActive) entry.screenActive = true;
      return entry;
    });
}

function connectToNewHost(newHostId) {
  connectingToHostId = newHostId;
  _migrationCandidateId = newHostId;
  rememberPeer(newHostId);
  stopHostHeartbeat();
  stopPeerHeartbeatSweep();
  console.log('[migration] Preparing connection to elected host ' + migrationPeerLabel(newHostId) + '.');
  updateRoomHeader();
  _attemptHostConnection(newHostId, HOST_MAX_RETRIES);
}

function _attemptHostConnection(targetHostId, retriesLeft) {
  if (!inRoom || !peer || peer.destroyed) return;
  if (targetHostId !== _migrationCandidateId) return;

  var gen = ++_hostConnGeneration;
  var hostData = peer.connect(targetHostId, { reliable: true });
  var receivedPeerList = false;
  var opened = false;
  var handled = false;

  console.log(
    '[migration] Connecting to host ' + migrationPeerLabel(targetHostId) +
    '. Gen: ' + gen + '. Retries left: ' + retriesLeft + '.'
  );

  // Timeout if connection doesn't open
  var timer = setTimeout(function() {
    if (gen !== _hostConnGeneration) return;
    console.warn('[migration] Connection to ' + migrationPeerLabel(targetHostId) + ' timed out before opening.');
    if (!opened && !handled) hostData.close();
  }, HOST_CONNECT_TIMEOUT);

  hostData.on('open', function() {
    if (gen !== _hostConnGeneration) { hostData.close(); return; }
    opened = true;
    clearTimeout(timer);
    hostData.send({ type: 'hello', pseudo: pseudoForPeer() });
  });

  hostData.on('data', function(msg) {
    if (gen !== _hostConnGeneration) return;

    if (msg && msg.type === 'peer-list') {
      receivedPeerList = true;
      _migrationCandidateId = null;
      _migrationExcluded.clear();
      roomState = ROOM_STATE_CONNECTED;
      roomCode = targetHostId;
      isHost = false;
      connectingToHostId = null;
      clearPublishState();
      noteHostHeartbeat();
      startHostHeartbeatMonitor();
      stopPeerHeartbeatSweep();
      startPeerHeartbeat();
      localStorage.setItem('active-room-code', targetHostId);
      iframeEmit({ type: 'host-changed', roomCode: targetHostId, isSelf: false });
      updateRoomHeader();
      var prev = connections.get(targetHostId) || { media: null, talking: false };
      connections.set(targetHostId, Object.assign({}, prev, { data: hostData, pseudo: msg.hostPseudo || shortId(targetHostId) }));
      console.log('[migration] Connected to new host ' + migrationPeerLabel(targetHostId) + '. Received peer-list.');
      handleHostMessage(msg);
      return;
    }

    if (receivedPeerList) handleHostMessage(msg);
  });

  hostData.on('close', function() {
    clearTimeout(timer);
    if (gen !== _hostConnGeneration) return;
    if (handled) return;

    if (receivedPeerList) {
      // Was live then dropped — host died during our session
      handled = true;
      stopPeerHeartbeat();
      console.warn('[migration] Connection to host ' + migrationPeerLabel(targetHostId) + ' closed after receiving peer-list.');
      if (inRoom) initiateHostMigration(targetHostId);
      return;
    }

    // Never received peer-list — connection failed before success
    handled = true;
    if (!inRoom) return;
    if (retriesLeft > 0) {
      console.warn('[migration] Failed to connect to ' + migrationPeerLabel(targetHostId) + '. Retrying (' + retriesLeft + ' left).');
      setTimeout(function() {
        _attemptHostConnection(targetHostId, retriesLeft - 1);
      }, HOST_RETRY_DELAY);
    } else {
      console.warn('[migration] Failed to connect to ' + migrationPeerLabel(targetHostId) + '. No retries remain, re-electing.');
      _migrationExcluded.add(targetHostId);
      _migrationCandidateId = null;
      proceedWithHostElection();
    }
  });

  hostData.on('error', function(err) {
    console.warn('[migration] Host connection error: ' + (err && err.message ? err.message : String(err)));
  });
}

function connectToHost(hostId, opts) {
  var redirectsLeft = opts.redirectsLeft || 0;
  var onInitialJoinResolve = opts.onInitialJoinResolve || null;
  var onInitialJoinReject = opts.onInitialJoinReject || null;

  if (!peer || peer.destroyed) return;

  var gen = ++_hostConnGeneration;
  var hostData = peer.connect(hostId, { reliable: true });
  var receivedPeerList = false;
  var redirected = false;
  var opened = false;
  var handled = false;

  console.log(
    '[initial] Connecting to host ' + migrationPeerLabel(hostId) +
    '. Gen: ' + gen + '. Redirects left: ' + redirectsLeft + '.'
  );
  devLog('→ DC to ' + hostId + ' (gen ' + gen + ')');

  // Timeout if connection doesn't open
  var timer = setTimeout(function() {
    if (gen !== _hostConnGeneration) return;
    console.warn('[initial] Connection to ' + migrationPeerLabel(hostId) + ' timed out before opening.');
    devLog('✗ DC timed out (8s)', 'warn');
    if (!opened && !handled) {
      handled = true;
      hostData.close();
      if (onInitialJoinReject) onInitialJoinReject(new Error('Could not reach host — connection timed out.'));
    }
  }, HOST_CONNECT_TIMEOUT);

  hostData.on('open', function() {
    if (gen !== _hostConnGeneration) { hostData.close(); return; }
    opened = true;
    clearTimeout(timer);
    devLog('✓ DC open → hello sent');
    hostData.send({ type: 'hello', pseudo: pseudoForPeer() });
  });

  hostData.on('data', function(msg) {
    if (gen !== _hostConnGeneration) return;

    // Handle redirect
    if (msg && msg.type === 'redirect') {
      if (!msg.hostId) {
        if (onInitialJoinReject && !handled) {
          handled = true;
          onInitialJoinReject(new Error('Received redirect without a host id.'));
        }
        return;
      }
      if (msg.hostId === hostId) {
        if (onInitialJoinReject && !handled) {
          handled = true;
          onInitialJoinReject(new Error('Received a redirect back to the same host.'));
        }
        return;
      }
      if (redirectsLeft <= 0) {
        if (onInitialJoinReject && !handled) {
          handled = true;
          onInitialJoinReject(new Error('Too many host redirects while joining.'));
        }
        return;
      }
      redirected = true;
      console.log('[initial] ' + migrationPeerLabel(hostId) + ' redirected to ' + migrationPeerLabel(msg.hostId) + '.');
      devLog('↻ Redirected to ' + msg.hostId);
      resetKnownPeers([msg.hostId]);
      hostData.close();
      connectToHost(msg.hostId, { redirectsLeft: redirectsLeft - 1, onInitialJoinResolve: onInitialJoinResolve, onInitialJoinReject: onInitialJoinReject });
      return;
    }

    // Handle peer-list (join success)
    if (msg && msg.type === 'peer-list') {
      receivedPeerList = true;
      devLog('✓ Joined! ' + (msg.peers ? msg.peers.length : 0) + ' peer(s) in room');
      finishJoin(hostId, hostData);
      handleHostMessage(msg);
      if (onInitialJoinResolve) onInitialJoinResolve(peer.id);
      return;
    }

    // Pass other messages to host handler (after peer-list received)
    if (receivedPeerList) handleHostMessage(msg);
  });

  hostData.on('close', function() {
    clearTimeout(timer);
    if (gen !== _hostConnGeneration) return;
    if (handled) return;

    if (receivedPeerList) {
      // Was live (joined) then dropped — host actually died
      stopPeerHeartbeat();
      console.warn('[initial] Connection to host ' + migrationPeerLabel(hostId) + ' closed after receiving peer-list.');
      if (inRoom) initiateHostMigration(hostId);
      return;
    }

    // Never received peer-list — connection failed before joining
    handled = true;
    devLog('✗ DC closed before joining', 'warn');
    if (redirected) return;
    if (onInitialJoinReject) onInitialJoinReject(new Error('Connection to host closed before joining.'));
  });

  hostData.on('error', function(err) {
    var msg = err && err.message ? err.message : String(err);
    console.warn('[initial] Host connection error: ' + msg);
    devLog('✗ DC error: ' + msg, 'error');
  });
}

function handleIncomingCall(call) {
  // Route video calls to the video handler
  if (call.metadata && call.metadata.type === 'video') {
    handleIncomingVideoCall(call);
    return;
  }
  // Route screen share calls to the screen handler
  if (call.metadata && call.metadata.type === 'screen') {
    handleIncomingScreenCall(call);
    return;
  }
  call.answer(stream);
  call.on('stream', function(remote) {
    attachAudio(call.peer, remote);
    const prev = connections.get(call.peer) || { data: null, pseudo: shortId(call.peer), talking: false };
    connections.set(call.peer, Object.assign({}, prev, { media: call }));
    updatePeerList();
  });
  call.on('close', function() { clearPeerMedia(call.peer); });
  call.on('error', function(err) { console.warn('[call]', err); });
}

// --- Host logic --------------------------------------------------------------

function sendHostPeerList(dataConn, excludedPeerId) {
  if (!dataConn) return;
  var successorIds = reconcileHostSuccessorIds();
  dataConn.send({
    type: 'peer-list',
    peers: buildHostPeerList(excludedPeerId),
    hostId: peer.id,
    hostPseudo: pseudoForHost(),
    hostVideoActive: localVideoActive,
    hostScreenActive: localScreenActive,
    videoModeEnabled: videoModeEnabled,
    deputyId: successorIds[0] || null,
    successorIds: successorIds
  });
  dataConn.send({
    type: 'heartbeat',
    at: Date.now(),
    deputyId: successorIds[0] || null,
    successorIds: successorIds
  });
}

function broadcastHostPeerLists() {
  // Don't prune ghost peers during the migration settle window — they may still reconnect.
  if (!isMigrationSettling()) pruneHostGhostPeers('broadcast-peer-list');
  connections.forEach(function(conn, peerId) {
    if (!conn || !conn.data) return;
    sendHostPeerList(conn.data, peerId);
  });
  // Keep the deputy in sync with the room secret whenever successor chain changes
  if (_publishedRoomId) {
    broadcastRoomPublished();
    schedulePublishRefresh();
  }
}

function handleJoinerDataConnection(dataConn) {
  const joinerId = dataConn.peer;

  dataConn.on('open', function() {
    const previous = connections.get(joinerId);
    dataConn._voxalExistingPeer = !!previous;
    rememberPeer(joinerId);
    const existing = previous || { media: null, pseudo: shortId(joinerId), talking: false };
    connections.set(joinerId, Object.assign({}, existing, {
      data: dataConn,
      pseudo: existing.pseudo || shortId(joinerId),
      lastHeartbeatAt: Date.now()
    }));
    if (previous && previous.data && previous.data !== dataConn) {
      console.warn('[host] Replacing duplicate data connection from ' + migrationPeerLabel(joinerId) + '.');
      previous.data.close();
    }
  });

  dataConn.on('data', function(msg) {
    if (!isCurrentPeerDataConnection(joinerId, dataConn)) return;
    notePeerHeartbeat(joinerId, msg && msg.at ? msg.at : Date.now());
    if (msg.type === 'hello') {
      rememberPeer(joinerId);
      const pseudo = msg.pseudo || shortId(joinerId);
      const existing = connections.get(joinerId) || { data: dataConn, media: null, talking: false };
      connections.set(joinerId, Object.assign({}, existing, { pseudo: pseudo }));

      sendHostPeerList(dataConn, joinerId);

      // Inform joiner of the public lobby ID if the room is published
      if (_publishedRoomId) {
        var isDeputy = (joinerId === currentDeputyId());
        dataConn.send({ type: 'room-published', roomId: _publishedRoomId, secret: isDeputy ? (_publishSecret || null) : null });
      }

      // Inform joiner of video mode if enabled
      if (videoModeEnabled) {
        dataConn.send({ type: 'video-mode', enabled: true });
      }

      if (!dataConn._voxalExistingPeer) {
        connections.forEach(function(c, id) {
          if (id !== joinerId && c.data) c.data.send({ type: 'peer-joined', peerId: joinerId, pseudo: pseudo });
        });
        playCarillon();
      }
      // Always broadcast updated peer-list to all existing peers so they receive
      // the latest successorIds (deputy chain). Without this, existing peers only
      // see peer-joined (which carries no successorIds) and keep stale election
      // state — causing split-brain if the host dies right after the new join.
      broadcastHostPeerLists();

      // If host has active video, call the newcomer
      if (localVideoActive && localVideoStream) {
        var videoCall = peer.call(joinerId, localVideoStream, { metadata: { type: 'video' } });
        if (videoCall) {
          var jConn = connections.get(joinerId);
          if (jConn) jConn.videoMediaOut = videoCall;
          videoCall.on('stream', function(remote) {
            var ex = connections.get(joinerId);
            if (!ex || !ex.remoteVideoStream || !ex.remoteVideoStream.active) {
              attachRemoteVideo(joinerId, remote);
            }
          });
          videoCall.on('close', function() {
            var jc = connections.get(joinerId);
            if (jc && jc.videoMediaOut === videoCall) jc.videoMediaOut = null;
          });
        }
      }
      // Tell other video-active peers to call the newcomer
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.videoActive && c.data) {
          c.data.send({ type: 'video-call-peer', peerId: joinerId });
        }
      });

      // If host has active screen share, call the newcomer
      if (localScreenActive && localScreenStream) {
        var screenCall = peer.call(joinerId, localScreenStream, { metadata: { type: 'screen' } });
        if (screenCall) {
          var jConn2 = connections.get(joinerId);
          if (jConn2) jConn2.screenMediaOut = screenCall;
          screenCall.on('close', function() {
            var jc2 = connections.get(joinerId);
            if (jc2 && jc2.screenMediaOut === screenCall) jc2.screenMediaOut = null;
          });
        }
      }
      // Tell other screen-active peers to call the newcomer
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.screenActive && c.data) {
          c.data.send({ type: 'screen-call-peer', peerId: joinerId });
        }
      });

      updatePeerList();

    } else if (msg.type === 'heartbeat') {
      return;

    } else if (msg.type === 'talking') {
      updatePeerTalking(joinerId, msg.active);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'talking', peerId: joinerId, active: msg.active });
      });
    } else if (msg.type === 'pseudo') {
      const pseudo = msg.pseudo || shortId(joinerId);
      const existing = connections.get(joinerId) || { data: dataConn, media: null, talking: false };
      connections.set(joinerId, Object.assign({}, existing, { pseudo: pseudo }));
      updatePeerList();
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'peer-renamed', peerId: joinerId, pseudo: pseudo });
      });
    } else if (msg.type === 'video-offer') {
      // Relay to all other peers
      markPeerVideoActive(joinerId, true);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'video-offer', peerId: joinerId });
      });
    } else if (msg.type === 'video-stop') {
      // Relay to all other peers
      detachRemoteVideo(joinerId);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'video-stop', peerId: joinerId });
      });
    } else if (msg.type === 'screen-offer') {
      markPeerScreenActive(joinerId, true);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'screen-offer', peerId: joinerId });
      });
    } else if (msg.type === 'screen-stop') {
      detachRemoteScreen(joinerId);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) c.data.send({ type: 'screen-stop', peerId: joinerId });
      });
    }
  });

  dataConn.on('close', function() {
    if (!isCurrentPeerDataConnection(joinerId, dataConn)) return;
    forgetPeer(joinerId);
    connections.forEach(function(c) { if (c.data) c.data.send({ type: 'peer-left', peerId: joinerId }); });
    playGoodbye();
    removePeer(joinerId);
    broadcastHostPeerLists();
  });

  dataConn.on('error', function(err) { console.warn('[data]', err); });
}

function handleJoinRedirectConnection(dataConn) {
  const joinerId = dataConn.peer;

  dataConn.on('open', function() {
    if (!inRoom || isHost || !roomCode || joinerId === roomCode) {
      dataConn.close();
      return;
    }
    console.log(
      '[join] Redirecting ' + migrationPeerLabel(joinerId) +
      ' to current host ' + migrationPeerLabel(roomCode) + '.'
    );
    dataConn.send({
      type: 'redirect',
      hostId: roomCode,
      hostPseudo: migrationPeerAlias(roomCode) || shortId(roomCode)
    });
    setTimeout(function() { dataConn.close(); }, 100);
  });

  dataConn.on('error', function(err) { console.warn('[data]', err); });
}

function applyHostRoutingHints(msg) {
  if (!msg) return;
  if (Array.isArray(msg.successorIds)) {
    setAuthoritativeSuccessorIds(msg.successorIds);
    return;
  }
  if (msg.deputyId) {
    setAuthoritativeSuccessorIds([msg.deputyId]);
  }
}

async function createRoom(onJoined) {
  stream = await getMicStream();
  audioTrack = stream.getAudioTracks()[0];
  audioTrack.enabled = false;
  knownPeerIds.clear();
  _lastAuthoritativePeerIds = null;
  _authoritativeSuccessorIds = [];
  const iceServers = await fetchIceServers();
  peer = new Peer({ config: { iceServers } });
  peer.on('connection', function(dataConn) { handleJoinerDataConnection(dataConn); });
  peer.on('call',       function(call)     { handleIncomingCall(call); });
  let settled = false;
  await new Promise(function(resolve, reject) {
    peer.on('open', function(id) {
      isHost = true; roomCode = id; inRoom = true;
      roomState = ROOM_STATE_CONNECTED;
      stopHostHeartbeatMonitor();
      stopPeerHeartbeat();
      startPeerHeartbeatSweep();
      startHostHeartbeat();
      localStorage.setItem('active-room-code', id);
      updateRoomHeader();
      nativePTTJoin(id);
      startKeepAlive();
      requestAudioFocus(); // Keep foreground service running while in room
      showScreen('room');
      updatePeerList();
      updateShortcutDisplay();
      updateVideoModeUI();
      startStatsPolling();
      saveRejoinSnapshot();
      iframeEmit({ type: 'joined', roomCode: id, peerId: id });
      if (onJoined) onJoined(id);
      if (!settled) {
        settled = true;
        resolve(id);
      }
    });
    peer.on('error', function(err) {
      if (!settled) {
        settled = true;
        handlePeerRuntimeError(err, false, reject);
        return;
      }
      handlePeerRuntimeError(err, true, reject);
    });
  });
}

// --- Non-host logic ----------------------------------------------------------

function handleHostMessage(msg) {
  noteHostHeartbeat(msg && msg.at ? msg.at : Date.now());
  applyHostRoutingHints(msg);
  if (msg.type === 'heartbeat') return;
  if (msg.type === 'peer-list') {
    const listedPeerIds = msg.peers.map(function(p) { return p.id; }).concat([roomCode]);
    const listedPeerSet = new Set(listedPeerIds);

    resetAuthoritativePeerIds(listedPeerIds);
    resetKnownPeers(listedPeerIds);

    Array.from(connections.keys()).forEach(function(existingPeerId) {
      if (!listedPeerSet.has(existingPeerId)) {
        removePeer(existingPeerId);
      }
    });

    const authoritativePeers = msg.peers.concat([{ id: roomCode, pseudo: msg.hostPseudo || shortId(roomCode), videoActive: !!msg.hostVideoActive, screenActive: !!msg.hostScreenActive }]);
    authoritativePeers.forEach(function(p) {
      const peerId = p.id;
      const pseudo = p.pseudo;
      const prev = connections.get(peerId) || { data: null, talking: false };
      var update = { pseudo: pseudo, media: prev.media || null };
      if (p.videoActive) update.videoActive = true;
      if (p.screenActive) update.screenActive = true;
      connections.set(peerId, Object.assign({}, prev, update));
    });

    // Sync video mode state from host
    if (msg.videoModeEnabled !== undefined) {
      videoModeEnabled = true;
      updateVideoModeUI();
    }

    authoritativePeers.forEach(function(p) {
      const peerId = p.id;
      const prev = connections.get(peerId) || { data: null, talking: false };
      if (prev.media) return;

      const call = peer.call(peerId, stream);
      call.on('stream', function(remote) { attachAudio(peerId, remote); });
      call.on('close',  function()       { clearPeerMedia(peerId); });
      connections.set(peerId, Object.assign({}, connections.get(peerId), { media: call }));
    });
    updatePeerList();
    saveRejoinSnapshot();

  } else if (msg.type === 'peer-joined') {
    rememberPeer(msg.peerId);
    if (!connections.has(msg.peerId)) {
      connections.set(msg.peerId, { data: null, media: null, pseudo: msg.pseudo || shortId(msg.peerId), talking: false });
      playCarillon();
      updatePeerList();
    }

  } else if (msg.type === 'peer-left') {
    forgetPeer(msg.peerId);
    playGoodbye();
    removePeer(msg.peerId);

  } else if (msg.type === 'talking') {
    updatePeerTalking(msg.peerId, msg.active);
  } else if (msg.type === 'peer-renamed') {
    const existing = connections.get(msg.peerId) || { data: null, media: null, talking: false };
    connections.set(msg.peerId, Object.assign({}, existing, { pseudo: msg.pseudo || shortId(msg.peerId) }));
    updatePeerList();
  } else if (msg.type === 'room-published') {
    _publishedRoomId = msg.roomId || null;
    _publishSecret = msg.secret || null;
    updateRoomHeader();
  } else if (msg.type === 'video-mode') {
    videoModeEnabled = true;
    updateVideoModeUI();
  } else if (msg.type === 'video-offer') {
    markPeerVideoActive(msg.peerId, true);
  } else if (msg.type === 'video-stop') {
    detachRemoteVideo(msg.peerId);
  } else if (msg.type === 'video-call-peer') {
    // Host is telling us to call a newcomer with our video
    if (localVideoActive && localVideoStream && msg.peerId) {
      var vc = peer.call(msg.peerId, localVideoStream, { metadata: { type: 'video' } });
      if (vc) {
        var tc = connections.get(msg.peerId);
        if (tc) tc.videoMediaOut = vc;
        vc.on('stream', function(remote) {
          var ex = connections.get(msg.peerId);
          if (!ex || !ex.remoteVideoStream || !ex.remoteVideoStream.active) {
            attachRemoteVideo(msg.peerId, remote);
          }
        });
        vc.on('close', function() {
          var tc2 = connections.get(msg.peerId);
          if (tc2 && tc2.videoMediaOut === vc) tc2.videoMediaOut = null;
        });
      }
    }
  } else if (msg.type === 'screen-offer') {
    markPeerScreenActive(msg.peerId, true);
  } else if (msg.type === 'screen-stop') {
    detachRemoteScreen(msg.peerId);
  } else if (msg.type === 'screen-call-peer') {
    // Host is telling us to call a newcomer with our screen
    if (localScreenActive && localScreenStream && msg.peerId) {
      var sc = peer.call(msg.peerId, localScreenStream, { metadata: { type: 'screen' } });
      if (sc) {
        var tc3 = connections.get(msg.peerId);
        if (tc3) tc3.screenMediaOut = sc;
        sc.on('stream', function(remote) {
          var ex2 = connections.get(msg.peerId);
          if (!ex2 || !ex2.remoteScreenStream || !ex2.remoteScreenStream.active) {
            attachRemoteScreen(msg.peerId, remote);
          }
        });
        sc.on('close', function() {
          var tc4 = connections.get(msg.peerId);
          if (tc4 && tc4.screenMediaOut === sc) tc4.screenMediaOut = null;
        });
      }
    }
  }
}

async function joinRoom(code, onJoined) {
  code = normalizeRoomCode(code);
  if (!code) return;
  devLog('→ Joining room ' + code + '…');
  // Resolve public lobby identifier to PeerJS peer ID if applicable
  var resolved = await lookupRoom(code);
  if (resolved) {
    devLog('✓ Resolved lobby "' + code + '" → ' + resolved);
    code = resolved;
  }
  if (!stream) {
    devLog('→ Acquiring mic…');
    try {
      stream = await getMicStream();
    } catch (e) {
      devLog('✗ Mic error: ' + e.message, 'error');
      throw e;
    }
    audioTrack = stream.getAudioTracks()[0];
    audioTrack.enabled = false;
    devLog('✓ Mic OK');
  }
  resetKnownPeers([code]);
  _lastAuthoritativePeerIds = null;
  _authoritativeSuccessorIds = [];
  const iceServers = await fetchIceServers();
  devLog('✓ ICE: ' + iceServers.length + ' server(s)');
  devLog('→ Connecting to PeerJS broker…');
  peer = new Peer({ config: { iceServers } });
  // Accept incoming connections in case this peer becomes host after migration
  peer.on('connection', function(dataConn) {
    if (shouldAcceptJoinerDataConnection(dataConn.peer)) {
      if (!isHost) becomeHost();
      handleJoinerDataConnection(dataConn);
      return;
    }
    if (inRoom && roomCode) handleJoinRedirectConnection(dataConn);
  });
  peer.on('call',  function(call) { handleIncomingCall(call); });
  let settled = false;
  await new Promise(function(resolve, reject) {
    var joinTimeout = setTimeout(function() {
      devLog('✗ Timed out after 30s', 'error');
      peer.destroy();
      settle(reject, new Error('Could not join room — connection timed out. Please check your network and try again.'));
    }, 30000);

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(joinTimeout);
      _cancelJoin = null;
      fn(val);
    }

    // Expose a cancel handle so the UI can abort mid-attempt
    _cancelJoin = function() {
      devLog('→ Cancelled');
      peer.destroy();
      settle(reject, new Error('Connection cancelled.'));
    };

    peer.on('open', function() {
      devLog('✓ PeerJS open (' + peer.id + ') → connecting to host');
      if (onJoined) onJoined(peer.id); // register presence as soon as we have our peer_id
      roomState = ROOM_STATE_CONNECTING;
      connectToHost(code, {
        redirectsLeft: MAX_JOIN_REDIRECTS,
        onInitialJoinResolve: function(peerId) { settle(resolve, peerId); },
        onInitialJoinReject:  function(err)    { settle(reject, err); }
      });
    });
    peer.on('error', function(err) {
      if (!settled) {
        devLog('✗ PeerJS error: ' + (err.message || String(err)), 'error');
        handlePeerRuntimeError(err, false, function(e) { settle(reject, e); });
        return;
      }
      handlePeerRuntimeError(err, true, reject);
    });
  });
}

async function attemptRejoin() {
  var snapshot = loadRejoinSnapshot();
  if (!snapshot) throw new Error('No room to rejoin.');
  var candidates = rejoinCandidates(snapshot);
  if (!candidates.length) throw new Error('No peers from the previous room are available.');

  for (var i = 0; i < candidates.length; i++) {
    try {
      await joinRoom(candidates[i]);
      return; // success — new room state will overwrite the snapshot
    } catch (err) {
      // Clean up the failed Peer before retrying
      if (peer && !peer.destroyed) { try { peer.destroy(); } catch (_) {} }
      peer = null;
      if (!isNonFatalPeerRuntimeError(err)) {
        // Fatal error — release mic and bail
        if (stream) { stream.getTracks().forEach(function(t) { t.stop(); }); stream = null; audioTrack = null; }
        throw err;
      }
      // Non-fatal (peer-unavailable): try next candidate
    }
  }

  // All candidates exhausted
  if (stream) { stream.getTracks().forEach(function(t) { t.stop(); }); stream = null; audioTrack = null; }
  throw new Error('Could not reconnect — no peers from the previous room are available.');
}

function finishJoin(targetHostId, hostData) {
  if (inRoom) return;
  roomCode = targetHostId;
  isHost = false;
  inRoom = true;
  connectingToHostId = null;
  roomState = ROOM_STATE_CONNECTED;
  noteHostHeartbeat();
  startHostHeartbeatMonitor();
  stopPeerHeartbeatSweep();
  startPeerHeartbeat();
  clearRoomCodeInput();
  localStorage.setItem('active-room-code', targetHostId);
  rememberPeer(targetHostId);
  connections.set(targetHostId, { data: hostData, media: null, pseudo: shortId(targetHostId), talking: false });
  updateRoomHeader();
  nativePTTJoin(targetHostId);
  startKeepAlive();
  requestAudioFocus(); // Keep foreground service running while in room
  showScreen('room');
  updatePeerList();
  updateShortcutDisplay();
  updateVideoModeUI();
  startStatsPolling();
  iframeEmit({ type: 'joined', roomCode: targetHostId, peerId: peer.id });
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
      if (div.classList.contains('loading') || !beginHomeAction()) return;
      div.classList.add('loading');
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      lockHomeCTAs();
      joinChannel(presenceData[idx]).catch(function(err) { showError(err.message); }).finally(function() { div.classList.remove('loading'); unlockHomeCTAs(); endHomeAction(); });
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
    showInviteLoading(activeChannel || '', 'Creating room…');
    await createRoom(postPresence);
  } else {
    const hostId = connected.map(function(c) { return c.peer_id; }).sort()[0];
    await joinRoom(hostId, postPresence);
  }
}

// --- Bootstrap ---------------------------------------------------------------

window.addEventListener('DOMContentLoaded', function() {

  // Notify capacitor-updater that the bundle loaded successfully (enables auto-revert on crash)
  if (IS_NATIVE_MOBILE && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorUpdater) {
    window.Capacitor.Plugins.CapacitorUpdater.notifyAppReady();
  }

  // Dev log panel: show/hide based on current dev mode state
  updateDevLogPanel();
  var toggleBtn = document.getElementById('btn-toggle-dev-log');
  if (toggleBtn) toggleBtn.addEventListener('click', function() {
    var panel = document.getElementById('dev-log-panel');
    if (!panel) return;
    var collapsed = panel.classList.toggle('collapsed');
    toggleBtn.textContent = collapsed ? '▸' : '▾';
    toggleBtn.setAttribute('aria-label', collapsed ? 'Expand log' : 'Collapse log');
  });
  var clearBtn = document.getElementById('btn-clear-dev-log');
  if (clearBtn) clearBtn.addEventListener('click', function() {
    var entries = document.getElementById('dev-log-entries');
    if (entries) entries.innerHTML = '';
    _devLogBuffer.length = 0;
    if (_devLogChannel) try { _devLogChannel.postMessage({ type: 'clear' }); } catch (_) {}
  });
  var popoutBtn = document.getElementById('btn-popout-dev-log');
  if (popoutBtn) popoutBtn.addEventListener('click', openDevLogWindow);
  var copyLogBtn = document.getElementById('btn-copy-dev-log');
  if (copyLogBtn) copyLogBtn.addEventListener('click', function() {
    var entries = document.getElementById('dev-log-entries');
    if (!entries) return;
    var lines = Array.from(entries.querySelectorAll('.dev-log-entry')).map(function(el) {
      var time = el.querySelector('.dev-log-time');
      var msg  = el.querySelector('.dev-log-msg');
      return (time ? time.textContent : '') + '  ' + (msg ? msg.textContent : '');
    });
    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() { showCopyToast('Log copied'); }).catch(function() { fallbackCopy(text); showCopyToast('Log copied'); });
    } else {
      fallbackCopy(text);
      showCopyToast('Log copied');
    }
  });

  const homePseudoInput = $('input-pseudo');
  if (homePseudoInput) {
    homePseudoInput.value = myPseudo;
    homePseudoInput.addEventListener('input', function(e) { setMyPseudo(e.target.value); });
  }
  const settingsPseudoInput = $('input-pseudo-settings');
  if (settingsPseudoInput) {
    settingsPseudoInput.value = myPseudo;
    settingsPseudoInput.addEventListener('input', function(e) { setMyPseudo(e.target.value); });
  }
  const invitePseudoInput = $('input-pseudo-invite');
  if (invitePseudoInput) {
    invitePseudoInput.value = myPseudo;
    invitePseudoInput.addEventListener('input', function(e) { setMyPseudo(e.target.value); });
  }

  // Connect button: visible only when NOT logged in
  window.updateConnectVisibility = function updateConnectVisibility() {
    var connected = !!presenceToken();
    var btnMain = document.getElementById('btn-connect-voxal-home');
    var btnSettings = document.getElementById('btn-connect-voxal');
    var orgSection = document.getElementById('account-org-section');
    if (btnMain)     btnMain.style.display     = connected ? 'none' : '';
    if (btnSettings) btnSettings.style.display = connected ? 'none' : '';
    if (orgSection) orgSection.classList.toggle('hidden', !connected);
    updateHomeLoggedOutLayout();
  }

  // Disconnect row: visible only when token is set
  window.updateDisconnectVisibility = function updateDisconnectVisibility() {
    var row = $('disconnect-row');
    if (row) row.style.display = presenceToken() ? '' : 'none';
  }
  updateDisconnectVisibility(); updateConnectVisibility();
  initCollapsibleSettingsCards();

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

  if (window.__TAURI__ && shortcutStr !== DEFAULT_SHORTCUT && !isModifierOnly(shortcutStr)) {
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
  if (!isNativeMobile && !window.__TAURI__) {
    document.body.classList.add('platform-web');
  }
  if (isNativeMobile) {
    document.body.classList.add('platform-mobile');
    var _sn = $('shortcut-normal'); if (_sn) _sn.style.display = 'none';
    var _sr = $('shortcut-recording'); if (_sr) _sr.style.display = 'none';
    var _ss = $('shortcut-spacer'); if (_ss) _ss.style.display = 'none';
    $('ptt-hint').textContent = 'Hold to talk · double-tap for hands-free';
    $('btn-copy').title = 'Copy room code';
  }

  $('btn-create').addEventListener('click', function() {
    if (!beginHomeAction()) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    var btn = $('btn-create');
    setLoading(btn, true, 'Create Room');
    lockHomeCTAs();
    createRoom().catch(function(err) {
      if (isMicDeniedError(err)) showMicDeniedError(function() { $('btn-create').click(); });
      else showError(err.message);
    }).finally(function() { setLoading(btn, false); unlockHomeCTAs(); endHomeAction(); });
  });
  $('btn-join').addEventListener('click', function() {
    var btn = $('btn-join');
    // If currently connecting, act as Cancel
    if (_cancelJoin) {
      _cancelJoin();
      _cancelJoin = null;
      return;
    }
    if (!beginHomeAction()) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    btn.innerHTML = '<span class="btn-spinner"></span>Cancel';
    btn.classList.add('btn-ghost');
    btn.classList.remove('btn-secondary');
    lockHomeCTAs();
    joinRoom($('input-code').value.trim())
      .catch(function(err) {
        if (err.message === 'Connection cancelled.') { showCopyToast('Connection cancelled'); return; }
        if (isMicDeniedError(err)) showMicDeniedError(function() { $('btn-join').click(); });
        else showError(err.message);
      })
      .finally(function() {
        btn.textContent = 'Join';
        btn.classList.remove('btn-ghost');
        btn.classList.add('btn-secondary');
        unlockHomeCTAs();
        endHomeAction();
      });
  });
  function normalizeRoomInputField() {
    var input = $('input-code');
    if (!input) return;
    var normalized = normalizeRoomCode(input.value);
    if (normalized && normalized !== input.value) input.value = normalized;
  }
  $('input-code').addEventListener('paste', function() {
    // Let the pasted value land first, then normalize invite URLs to room codes.
    setTimeout(normalizeRoomInputField, 0);
  });
  $('input-code').addEventListener('blur', normalizeRoomInputField);
  $('input-code').addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var joinBtn = $('btn-join');
    if (joinBtn) joinBtn.click();
  });

  var cancelInviteJoinBtn = $('btn-cancel-invite-join');
  if (cancelInviteJoinBtn) {
    cancelInviteJoinBtn.addEventListener('click', function() {
      if (_cancelJoin) {
        _cancelJoin();
        _cancelJoin = null;
      }
      showScreen('home');
    });
  }

  var invitedRoomCode = consumeRoomInviteFromQuery();
  if (invitedRoomCode) {
    // On native (Tauri/Capacitor) the deep-link is already being handled; join directly.
    // On web: try opening the native app first, fall back to browser join after 800 ms.
    var isNative = window.__TAURI__ || (window.Capacitor && window.Capacitor.isNativePlatform());
    if (isNative) {
      startInviteRoomJoin(invitedRoomCode);
    } else {
      _tryNativeAppThenJoin(invitedRoomCode);
    }
  }

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

  let _prefsWin   = null; // track the Tauri preferences window
  let _devLogWin  = null; // track the Tauri devlog window
  let _aboutWin   = null; // track the Tauri about window

  function setDevLogPopped(popped) {
    var panel = document.getElementById('dev-log-panel');
    if (panel) panel.classList.toggle('popped-out', popped);
  }

  function closeDevLogWindow() {
    if (!_devLogWin) return;
    try {
      _devLogWin.close();
    } catch (_) {}
    _devLogWin = null;
    setDevLogPopped(false);
  }

  function openDevLogWindow() {
    if (!_devLogChannel) {
      _devLogChannel = new BroadcastChannel('voxal-devlog');
      _devLogChannel.onmessage = function(e) {
        if (e.data && e.data.type === 'ready') {
          _devLogChannel.postMessage({ type: 'backfill', entries: _devLogBuffer.slice() });
        } else if (e.data && e.data.type === 'clear') {
          var panel = document.getElementById('dev-log-entries');
          if (panel) panel.innerHTML = '';
          _devLogBuffer.length = 0;
        } else if (e.data && e.data.type === 'dock') {
          closeDevLogWindow();
        }
      };
    }
    if (window.__TAURI__) {
      try {
        const { WebviewWindow } = window.__TAURI__.webviewWindow;
        if (_devLogWin) {
          _devLogWin.setFocus().catch(function() { _devLogWin = null; openDevLogWindow(); });
          return;
        }
        const win = new WebviewWindow('devlog', {
          url: 'devlog.html',
          title: 'Voxal — Dev Log',
          width: 640,
          height: 480,
          resizable: true,
          center: true,
        });
        _devLogWin = win;
        win.once('tauri://destroyed', function() { _devLogWin = null; setDevLogPopped(false); });
        setDevLogPopped(true);
        return;
      } catch (e) {
        console.warn('[DevLog] Could not open devlog window:', e.message);
      }
    }
    // Web fallback
    var w = window.open('devlog.html', 'voxal-devlog', 'width=640,height=480,resizable=yes');
    if (w) {
      _devLogWin = w;
      w.focus();
      setDevLogPopped(true);
    }
  }

  window.addEventListener('beforeunload', closeDevLogWindow);

  function initAboutSection(versionElId, dateElId) {
    var versionEl = document.getElementById(versionElId);
    var dateEl    = document.getElementById(dateElId);
    if (!versionEl || !dateEl) return;

    var buildDate = new Date(VOXAL_BUILD_DATE).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
    dateEl.textContent = buildDate;

    function setVersion(v) { versionEl.textContent = 'v' + v; }

    if (window.Capacitor && window.Capacitor.isNativePlatform() &&
        window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.getInfo()
        .then(function(info) { setVersion(info.version); })
        .catch(function() { setVersion(VOXAL_VERSION); });
    } else {
      setVersion(VOXAL_VERSION);
    }
  }

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
          width: 1040,
          height: 760,
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
    $('input-pseudo-settings').value = myPseudo;
    $('input-service-url').value    = localStorage.getItem(SERVICE_URL_KEY) || 'https://vybzjzwsqrggatcrnqxe.supabase.co/functions/v1/session';
    $('input-metered-app').value    = localStorage.getItem(METERED_APP_STORE_KEY) || '';
    $('input-metered-key').value    = localStorage.getItem(METERED_API_STORE_KEY) || '';
    syncNoiseSuppressionControls();
    refreshMediaDeviceSelectors();
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
    // Sync dev mode toggle
    var devBtn = document.getElementById('toggle-dev-mode-modal');
    if (devBtn) {
      var devOn = isDevModeEnabled();
      devBtn.setAttribute('aria-checked', String(devOn));
      devBtn.classList.toggle('active', devOn);
      devBtn.textContent = devOn ? 'ON' : 'OFF';
    }
    updateVideoModeUI();
    stopMicTest();
    stopCameraPreview();
    collapseAllSettingsCards();
    // Populate About section
    initAboutSection('about-version-modal', 'about-build-date-modal');
    $('modal-settings').classList.remove('hidden');
    if (presenceToken()) loadOrgs();
  }
  function closeSettings() {
    stopMicTest();
    stopCameraPreview();
    var speakerStatus = $('speaker-test-status');
    if (speakerStatus) speakerStatus.textContent = '';
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
  document.querySelectorAll('input[name="noise-suppression-mode"]').forEach(function(input) {
    input.addEventListener('change', function(e) {
      if (!e.target.checked) return;
      localStorage.setItem(NOISE_SUPPRESSION_KEY, e.target.value);
    });
  });
  var micSelect = $('select-mic-device');
  if (micSelect) {
    micSelect.addEventListener('change', function(e) {
      if (e.target.value) localStorage.setItem(MIC_DEVICE_KEY, e.target.value);
      else localStorage.removeItem(MIC_DEVICE_KEY);
      if (_micTestStream) startMicTest().catch(function(err) { console.warn('[Mic test]', err.message); stopMicTest(); });
    });
  }
  var camSelect = $('select-camera-device');
  if (camSelect) {
    camSelect.addEventListener('change', function(e) {
      if (e.target.value) localStorage.setItem(CAMERA_DEVICE_KEY, e.target.value);
      else localStorage.removeItem(CAMERA_DEVICE_KEY);
      if (_cameraPreviewStream) startCameraPreview().catch(function(err) { console.warn('[Camera preview]', err.message); stopCameraPreview(); });
    });
  }
  var speakerSelect = $('select-speaker-device');
  if (speakerSelect) {
    speakerSelect.addEventListener('change', function(e) {
      if (e.target.value) localStorage.setItem(SPEAKER_DEVICE_KEY, e.target.value);
      else localStorage.removeItem(SPEAKER_DEVICE_KEY);
      applySpeakerSinkToAllAudio();
    });
  }
  refreshMediaDeviceSelectors();
  syncNoiseSuppressionControls();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshMediaDeviceSelectors);
  }
  $('btn-open-settings').addEventListener('click', function() {
    // On web/mobile, open settings.
    if (!window.__TAURI__) openSettings();
  });
  $('btn-open-settings-room').addEventListener('click', function() {
    openSettings();
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
  var btnMicTest = $('btn-test-mic');
  if (btnMicTest) btnMicTest.addEventListener('click', toggleMicTest);
  var btnSpeakerTest = $('btn-test-speaker');
  if (btnSpeakerTest) btnSpeakerTest.addEventListener('click', function() { testSpeakerOutput().catch(function(e) { console.warn('[Speaker test]', e.message); }); });
  var btnCameraPreview = $('btn-preview-camera');
  if (btnCameraPreview) btnCameraPreview.addEventListener('click', toggleCameraPreview);
  $('btn-disconnect').addEventListener('click', disconnectAccount);
  $('btn-connect-voxal').addEventListener('click', connectWithVoxalAccount);

  var devToggleModal = document.getElementById('toggle-dev-mode-modal');
  if (devToggleModal) {
    devToggleModal.addEventListener('click', function() {
      var on = !isDevModeEnabled();
      localStorage.setItem(DEV_MODE_KEY, String(on));
      devToggleModal.setAttribute('aria-checked', String(on));
      devToggleModal.classList.toggle('active', on);
      devToggleModal.textContent = on ? 'ON' : 'OFF';
      // Auto-open Advanced details when dev mode is turned on
      var advDetails = devToggleModal.closest('details');
      if (advDetails && on) advDetails.open = true;
      updateDevLogPanel();
      updateVideoModeUI();
      if (inRoom) {
        updatePeerList();
      }
    });
  }

  // iOS/Android: deep links come back via @capacitor/app appUrlOpen.
  // Handles both voxal:// custom scheme and https://ptt.voxal.app App Links.
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    var CapApp = window.Capacitor.Plugins.App;
    CapApp.addListener('appUrlOpen', function(data) {
      if (data && data.url) handleDeepLink(data.url);
    });
    // Handle cold-launch via deep link
    CapApp.getLaunchUrl().then(function(data) {
      if (data && data.url) handleDeepLink(data.url);
    }).catch(function() {});

    // On Android, PeerJS drops its WebSocket signaling connection while backgrounded.
    // On resume, reconnect the peer without creating a new one (preserves host state).
    CapApp.addListener('resume', function() {
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      if (!inRoom || !peer) return;
      if (peer.disconnected && !peer.destroyed) {
        console.log('[android] Peer disconnected while backgrounded, reconnecting signaling...');
        peer.reconnect();
      }
    });
  }

  // Tauri: "Voxal → Preferences…" and "About Voxal" menu items
  if (window.__TAURI__) {
    window.__TAURI__.event.listen('open-preferences', openSettings);
    window.__TAURI__.event.listen('open-about', function() {
      if (_aboutWin) {
        _aboutWin.setFocus().catch(function() { _aboutWin = null; openAboutWindow(); });
        return;
      }
      openAboutWindow();
    });
    window.__TAURI__.event.listen('update-available', function(e) {
      showCopyToast('Updating to v' + (e.payload || '?') + '…');
    });
  }

  function openAboutWindow() {
    try {
      const { WebviewWindow } = window.__TAURI__.webviewWindow;
      const win = new WebviewWindow('about', {
        url: 'about.html',
        title: 'About Voxal',
        width: 340,
        height: 420,
        resizable: false,
        center: true,
        minimizable: false,
        maximizable: false,
      });
      _aboutWin = win;
      win.once('tauri://destroyed', function() { _aboutWin = null; });
    } catch (e) {
      console.warn('[About] Could not open about window:', e.message);
    }
  }

  // Cross-window sync: when settings.html (Tauri preferences window) writes to
  // localStorage, the main window receives a storage event and refreshes.
  window.addEventListener('storage', function(e) {
    if (e.key === THEME_KEY) {
      applyTheme(e.newValue || 'system');
      return;
    }
    if (e.key === PSEUDO_KEY && window.__TAURI__) {
      myPseudo = e.newValue || '';
      sessionStorage.setItem(PSEUDO_SESSION_KEY, myPseudo);
      const homeInput = $('input-pseudo');
      const settingsInput = $('input-pseudo-settings');
      const inviteInput = $('input-pseudo-invite');
      if (homeInput) homeInput.value = myPseudo;
      if (settingsInput) settingsInput.value = myPseudo;
      if (inviteInput) inviteInput.value = myPseudo;
      updateHomeLoggedOutLayout();
      if (inRoom) {
        updatePeerList();
        announcePseudoChange();
      }
      return;
    }
    var relevantKeys = [PRESENCE_TOKEN_KEY, PRESENCE_ORG_KEY, METERED_APP_STORE_KEY,
                          METERED_API_STORE_KEY, METERED_STATUS_STORE_KEY, DEV_MODE_KEY,
                          SPEAKER_DEVICE_KEY];
    if (relevantKeys.indexOf(e.key) === -1) return;
    if (e.key === DEV_MODE_KEY) {
      updateDevLogPanel();
      if (inRoom) {
        if (isDevModeEnabled()) startStatsPolling(); else stopStatsPolling();
        updateVideoModeUI();
        updatePeerList();
      }
      return;
    }
    if (e.key === SPEAKER_DEVICE_KEY) {
      applySpeakerSinkToAllAudio();
      return;
    }
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

  window.addEventListener('online', function() {
    updateTurnBadge();
    // Auto-reconnect the PeerJS signaling channel if we dropped while offline
    if (inRoom && peer && peer.disconnected && !peer.destroyed) {
      console.log('[network] Back online — reconnecting peer signaling...');
      peer.reconnect();
    }
  });
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
        showInviteLoading(activeChannel || '', 'Creating room…');
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
    var text = roomDisplayCode();
    if (!text) return;
    copyTextToClipboard(text, 'Room code copied!');
  });
  $('btn-leave').addEventListener('click', leaveRoom);

  $('btn-publish-room').addEventListener('click', function() {
    var btn = $('btn-publish-room');
    btn.disabled = true;
    publishRoom()
      .catch(function(err) { showError('Could not publish room: ' + err.message); })
      .finally(function() { btn.disabled = false; });
  });

  $('btn-unpublish-room').addEventListener('click', function() {
    unpublishRoom();
  });

  $('btn-share-room').addEventListener('click', function() {
    var roomId = roomDisplayCode();
    if (!roomId) return;
    var url = roomInviteUrl(roomId);
    if (!url) return;
    if (navigator.share) {
      navigator.share({ title: 'Join my Voxal room', url: url }).catch(function(e) { console.warn('[Share]', e); });
    } else {
      fallbackCopy(url); showCopyToast('Invite link copied!');
    }
  });

  // --- Rejoin bar ---
  function _createRejoinBar() {
    var bar = document.createElement('div');
    bar.id = 'rejoin-bar';
    bar.className = 'rejoin-bar';
    bar.innerHTML =
      '<span class="rejoin-icon">↩</span>' +
      '<span id="rejoin-label" class="rejoin-label">Last room</span>' +
      '<button id="btn-rejoin" class="btn btn-secondary rejoin-btn">Rejoin</button>' +
      '<button id="btn-dismiss-rejoin" class="btn-icon rejoin-dismiss" aria-label="Dismiss">✕</button>';
    var joinRow = document.querySelector('.join-row');
    if (joinRow && joinRow.parentNode) joinRow.parentNode.insertBefore(bar, joinRow.nextSibling);
    _wireRejoinBar(bar);
    return bar;
  }

  function _wireRejoinBar(bar) {
    bar.querySelector('#btn-rejoin').addEventListener('click', function() {
      var btn = $('btn-rejoin');
      var snapshot = loadRejoinSnapshot();
      if (!snapshot) { var b = $('rejoin-bar'); if (b) b.remove(); return; }
      setLoading(btn, true, 'Rejoin');
      lockHomeCTAs();
      bar.querySelector('#btn-dismiss-rejoin').disabled = true;
      attemptRejoin()
        .catch(function(err) {
          showError(err.message);
          clearRejoinSnapshot();
          _rejoinDismissed = true;
          var b = $('rejoin-bar');
          if (b) b.remove();
        })
        .finally(function() {
          setLoading(btn, false, 'Rejoin');
          unlockHomeCTAs();
          var d = bar.querySelector('#btn-dismiss-rejoin');
          if (d) d.disabled = false;
          endHomeAction();
        });
    });
    bar.querySelector('#btn-dismiss-rejoin').addEventListener('click', function() {
      clearRejoinSnapshot();
      _rejoinDismissed = true;
      bar.remove();
    });
  }

  var updateRejoinBar = function() {
    var snapshot = loadRejoinSnapshot();
    var bar = $('rejoin-bar');
    if (!snapshot || _rejoinDismissed) { if (bar) bar.classList.add('hidden'); return; }
    // No point rejoining if there were no other peers in the room
    if (rejoinCandidates(snapshot).length === 0) { if (bar) bar.classList.add('hidden'); return; }
    if (!bar) bar = _createRejoinBar();
    var peerCount = (snapshot.peerIds || []).length;
    var labelEl = $('rejoin-label');
    if (labelEl) labelEl.textContent = 'Last room · ' + peerCount + ' peer' + (peerCount !== 1 ? 's' : '');
    bar.classList.remove('hidden');
  };
  window._updateRejoinBar = updateRejoinBar;

  // Wire the initially-rendered rejoin bar (if present in DOM on first load)
  var _initialBar = $('rejoin-bar');
  if (_initialBar) _wireRejoinBar(_initialBar);
  $('btn-back').addEventListener('click', function() { showScreen('home'); });
  $('btn-retry-mic').addEventListener('click', function() {
    if (typeof _pendingMicAction === 'function') {
      _pendingMicAction();
      _pendingMicAction = null;
    }
  });

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
      pttBtn.classList.add('active'); // visual press feedback while hands-free is on
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
  // Edit shortcut — delegated since the button is dynamically rendered in ptt-hint
  $('ptt-hint').addEventListener('click', function(e) {
    var btn = e.target.closest('#btn-edit-shortcut');
    if (btn) startRecordingShortcut();
  });
  $('btn-cancel-shortcut').addEventListener('click', stopRecordingShortcut);

  // Video prototype buttons
  $('btn-share-camera').addEventListener('click', function() {
    if (localVideoActive) stopVideoShare(); else startVideoShare();
  });
  var screenBtnEl = $('btn-share-screen');
  if (screenBtnEl) {
    screenBtnEl.addEventListener('click', function() {
      if (localScreenActive) stopScreenShare(); else startScreenShare();
    });
  }
  $('video-viewer-close').addEventListener('click', closeVideoViewer);
  $('video-viewer-minimize').addEventListener('click', popOutVideoViewer);
  $('video-viewer-maximize').addEventListener('click', function() {
    var panel = document.getElementById('video-viewer-panel');
    if (panel) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function() {});
      } else if (panel.requestFullscreen) {
        panel.requestFullscreen().catch(function() {});
      }
    }
  });
  $('screen-viewer-close').addEventListener('click', closeScreenViewer);
  $('screen-viewer-minimize').addEventListener('click', popOutScreenViewer);
  $('screen-viewer-maximize').addEventListener('click', function() {
    var panel = document.getElementById('screen-viewer-panel');
    if (panel) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function() {});
      } else if (panel.requestFullscreen) {
        panel.requestFullscreen().catch(function() {});
      }
    }
  });

  // Hide maximize and minimize buttons on iOS (WKWebView doesn't support fullscreen or PiP for WebRTC)
  if (window.Capacitor && window.Capacitor.isNativePlatform() && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    $('video-viewer-maximize').style.display = 'none';
    $('video-viewer-minimize').style.display = 'none';
    $('screen-viewer-maximize').style.display = 'none';
    $('screen-viewer-minimize').style.display = 'none';
  }

  // Return from PiP to integrated panel
  var viewerVid = document.getElementById('video-viewer-element');
  if (viewerVid) {
    viewerVid.addEventListener('leavepictureinpicture', function() {
      if (_videoViewerPeerId) openVideoViewer(_videoViewerPeerId);
    });
    // iOS webkit PiP: return to inline when exiting PiP
    viewerVid.addEventListener('webkitpresentationmodechanged', function() {
      if (viewerVid.webkitPresentationMode === 'inline' && _videoViewerPeerId) {
        openVideoViewer(_videoViewerPeerId);
      }
    });
    // iOS: when user exits native video fullscreen, hide the panel
    viewerVid.addEventListener('webkitendfullscreen', function() {
      var panel = document.getElementById('video-viewer-panel');
      if (panel) panel.classList.add('hidden');
    });
  }

  // Make video viewer panel draggable (mouse + touch)
  (function() {
    var titlebar = document.getElementById('video-viewer-titlebar');
    var panel = document.getElementById('video-viewer-panel');
    var dragging = false, startX, startY, startLeft, startTop;
    function dragStart(x, y) {
      dragging = true;
      startX = x; startY = y;
      var rect = panel.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
    }
    function dragMove(x, y) {
      if (!dragging) return;
      panel.style.left = (startLeft + x - startX) + 'px';
      panel.style.top = (startTop + y - startY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    function dragEnd() { dragging = false; }
    titlebar.addEventListener('mousedown', function(e) { dragStart(e.clientX, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', function(e) { dragMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup', dragEnd);
    titlebar.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) { dragStart(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
    }, { passive: false });
    document.addEventListener('touchmove', function(e) {
      if (dragging && e.touches.length === 1) { dragMove(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: true });
    document.addEventListener('touchend', dragEnd);
    document.addEventListener('touchcancel', dragEnd);
  })();

  // Make screen viewer panel draggable (mouse + touch)
  (function() {
    var titlebar = document.getElementById('screen-viewer-titlebar');
    var panel = document.getElementById('screen-viewer-panel');
    if (!titlebar || !panel) return;
    var dragging = false, startX, startY, startLeft, startTop;
    function dragStart(x, y) {
      dragging = true;
      startX = x; startY = y;
      var rect = panel.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
    }
    function dragMove(x, y) {
      if (!dragging) return;
      panel.style.left = (startLeft + x - startX) + 'px';
      panel.style.top = (startTop + y - startY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    function dragEnd() { dragging = false; }
    titlebar.addEventListener('mousedown', function(e) { dragStart(e.clientX, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', function(e) { dragMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup', dragEnd);
    titlebar.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) { dragStart(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
    }, { passive: false });
    document.addEventListener('touchmove', function(e) {
      if (dragging && e.touches.length === 1) { dragMove(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: true });
    document.addEventListener('touchend', dragEnd);
    document.addEventListener('touchcancel', dragEnd);
  })();

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
    if (shouldIgnorePTTShortcuts()) return;
    if (recordingShortcut) { e.preventDefault(); if (!MODIFIER_CODES.includes(e.code)) { const s = shortcutFromEvent(e); if (s) applyNewShortcut(s); } return; }
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
    if (recordingShortcut && MODIFIER_ONLY_MAP[e.code]) { e.preventDefault(); applyNewShortcut(MODIFIER_ONLY_MAP[e.code]); return; }
    if (shouldIgnorePTTShortcuts()) return;
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
    if (isModifierOnly(shortcutStr) && (MODIFIER_ONLY_VARIANTS[shortcutStr] || []).includes(e.code)) setTalking(false);
  });

  // Tauri-only: global shortcut works even when app is in background
  if (window.__TAURI__) {
    const listen = window.__TAURI__.event.listen;
    var lastTauriRelease = 0;
    var ignoreTauriRelease = false;
    listen('ptt-press', function() {
      if (recordingShortcut || shouldIgnorePTTShortcuts()) return;
      var now = Date.now();
      if (now - lastTauriRelease < DOUBLE_TAP_MS) {
        // Double-press: toggle hands-free mode (same as double-tap on mobile)
        lastTauriRelease = 0;
        ignoreTauriRelease = true;
        setFreeHand(!freeHandMode);
        return;
      }
      if (freeHandMode) {
        // In hands-free mode: shortcut acts as PTT override (mic already on — just show visual feedback)
        $('ptt-btn').classList.add('active');
      } else {
        setTalking(true);
      }
    });
    listen('ptt-release', function() {
      if (recordingShortcut || shouldIgnorePTTShortcuts()) return;
      if (ignoreTauriRelease) { ignoreTauriRelease = false; return; }
      lastTauriRelease = Date.now();
      if (freeHandMode) {
        // Release while in hands-free mode: turn off hands-free (mic goes silent)
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
      if (inRoom) {
        startKeepAlive();
        if (peer && peer.disconnected && !peer.destroyed) {
          peer.reconnect();
        }
        // Only non-host peers have a host DataConnection in the map.
        if (!isHost && !connectingToHostId) {
          const hostConn = connections.get(roomCode);
          if (!hostConn || !hostConn.data || hostConn.data.closed) {
            console.warn('[visibility] Host connection lost, reconnecting...');
            initiateHostMigration(roomCode);
          }
        }
      }
    }
  });
});
