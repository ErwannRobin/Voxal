/* voxal – main.js
 *
 * Topology:
 *   Signaling      : star (host ↔ each peer via DataConnection)
 *   Audio          : full mesh (every peer ↔ every peer via MediaConnection / Opus) — ALWAYS, never SFU-routed
 *   Video / screen : full mesh by default; optionally routed through Cloudflare's
 *                    Realtime SFU per selectVideoTopology()'s decision — see
 *                    docs/video-routing.md. Cloudflare identifiers never appear
 *                    in this protocol; only the opaque `topology`/`providerRef`
 *                    fields below cross the wire, and only for video/screen.
 *
 * Data protocol:
 *   hello        { pseudo, protocolVersion,        joiner -> host on connect
 *                  appVersion }
 *   peer-list    { peers:[{id,pseudo,              host -> joiner (reply to hello)
 *                  protocolVersion,appVersion,
 *                  videoActive?,screenActive?,
 *                  videoTopology?,screenTopology?,
 *                  videoProviderRef?,screenProviderRef?}],
 *                  hostId, hostPseudo, deputyId, successorIds,
 *                  hostVideoActive, hostScreenActive,
 *                  hostVideoTopology, hostScreenTopology,
 *                  hostVideoProviderRef, hostScreenProviderRef,
 *                  protocolVersion, appVersion }
 *   peer-joined  { peerId, pseudo }               host -> all existing peers
 *   peer-left    { peerId }                       host -> all
 *   talking      { peerId, active }               non-host -> host (relayed to all)
 *   pseudo       { pseudo }                        non-host -> host (relayed as peer-renamed)
 *   peer-renamed { peerId, pseudo }               host -> all
 *   heartbeat    { at, deputyId, successorIds }   host <-> peers
 *   redirect     { hostId, hostPseudo }          non-host -> misdirected joiner
 *   room-published { roomId }                   host -> all (lobby ID changed)
 *   video-mode   { enabled }                    host -> peer (toggle video mode, dev only)
 *   video-offer  { peerId, topology, providerRef? } peer -> host (relayed) — peer started camera.
 *                  topology: 'p2p' (default, expect a MediaConnection) | 'sfu' (subscribe via
 *                  the Cloudflare SFU router instead — see sfuSubscribeVideo()). providerRef is
 *                  {sessionId, trackName}: opaque SFU-internal routing identifiers, read only
 *                  inside the SFU router functions. A subscriber MUST have it — without naming
 *                  the remote track there is nothing for the SFU to forward.
 *   video-stop   { peerId }                     peer -> host (relayed) — peer stopped camera
 *   audio-check-request  { peerId, from,        viewer -> host (relayed to target); dev only
 *                          durationMs }
 *   audio-check-response { peerId, report,       target -> host (relayed to requester); dev only
 *                          declined, from }
 *   device-info-request  { peerId, from }       viewer -> host (relayed to target); dev only
 *   device-info-response { peerId, info,        target -> host (relayed to requester); dev only
 *                          declined, from }
 *   log-session-request  { peerId, from,        viewer -> host (relayed to target); dev only
 *                          fromPseudo }
 *   log-session-stop     { peerId, from }       viewer -> host (relayed to target); dev only
 *   log-session-response { peerId, granted,     target -> host (relayed to requester); dev only
 *                          reason, from }
 *   log-entries          { peerId, entries,     target -> host (relayed to requester); dev only
 *                          from }
 *   log-session-end      { peerId, reason, from } target -> host (relayed to requester); dev only
 *
 * Dev-mode debugging: the host advertises `debugMode` in every peer-list and
 * heartbeat. When on, a device-info "i" button appears next to each roster name.
 * Snapshots (device / audio / network) are collected on demand only and each
 * peer can opt out of sharing via Settings → Advanced (default on). The same
 * panel can ask a peer for its live debug log; that stream is authorized
 * separately, per session, by an explicit prompt on the peer's own device.
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

// Wire-protocol version exchanged in the `hello` / `peer-list` handshake. Bump
// ONLY when the data protocol between peers changes in a way that matters for
// interop. It is independent of VOXAL_VERSION (the app's display version): many
// app releases can share the same protocol version. Used for skew detection, not
// (yet) to gate behavior — keep protocol changes additive/tolerant so mixed
// rooms keep working.
const PROTOCOL_VERSION = 1;

const METERED_APP_STORE_KEY    = 'metered-app-name';
const METERED_API_STORE_KEY    = 'metered-api-key';
const METERED_STATUS_STORE_KEY  = 'metered-status';  // 'ok' | 'error' | null
const METERED_COUNT_STORE_KEY   = 'metered-count';   // number of servers when ok
const METERED_SERVERS_STORE_KEY = 'metered-servers'; // JSON array of ICE server objects
const TURN_FALLBACK_KEY         = 'turn-fallback';   // JSON RTCIceServer[] override for the free relay fallback ('[]' disables)
const ANON_TURN_URL_KEY         = 'anon-turn-url';   // override for the anonymous TURN credential endpoint

// How many separate times the browser has made the user answer a microphone
// prompt, and whether they have told us they know how to stop it.
const MIC_PROMPT_COUNT_KEY   = 'mic-prompt-count';
const MIC_HINT_DISMISSED_KEY = 'mic-hint-dismissed';

const JITTER_BUFFER_KEY     = 'jitter-buffer';     // 'auto' | milliseconds as a string ('0' = browser default)
const NOISE_SUPPRESSION_KEY = 'noise-suppression'; // 'rnnoise' | 'browser' | 'off'
// 'prefer-p2p' | 'allow-sfu' | 'p2p-only'. Governs CAMERA/SCREEN-SHARE routing
// ONLY — see selectVideoTopology() below. Voice/PTT audio never reads this key
// and is never routed through an SFU, under any value of this setting.
const VIDEO_ROUTING_KEY      = 'video-routing-mode';
const VIDEO_ROUTING_DEFAULT  = 'allow-sfu';
// Local-test-double override for the SFU allocation endpoints, mirroring how
// `localStorage['peerjs-server']` (see peerServerOptions()) points the mesh E2E
// harness at a local broker instead of the PeerJS cloud broker. Unset in
// production. JSON: { sessionUrl, trackUrl }.
const SFU_SERVER_OVERRIDE_KEY = 'sfu-server';
const MIC_DEVICE_KEY        = 'mic-device-id';
const CAMERA_DEVICE_KEY     = 'camera-device-id';
const SPEAKER_DEVICE_KEY    = 'speaker-device-id';
const DEVICE_LABELS_KEY     = 'media-device-labels';
// Transient. Main window → desktop preferences window: "a call is live, do not
// touch the capture devices". settings.html runs in a SEPARATE WebView, and on
// macOS a getUserMedia there reconfigures the shared capture session and kills
// the main window's live tracks — which is what made opening Preferences during
// a call drop both audio and video. Cleared on leave and on load (see below).
const ROOM_ACTIVE_KEY       = 'room-active';

// Tell the desktop preferences window whether a call is live. Only ever written
// here — the main window is the sole authority — so a value still present at
// load is by definition left over from a previous run (a crash, or a reload
// mid-call) and is cleared rather than trusted. Getting that wrong in the
// permissive direction drops a call; in the restrictive direction it costs
// nothing but generic device names in Preferences.
function publishRoomActive(active) {
  try {
    if (active) localStorage.setItem(ROOM_ACTIVE_KEY, String(Date.now()));
    else localStorage.removeItem(ROOM_ACTIVE_KEY);
  } catch (_) { /* private mode / quota — the probe just stays conservative */ }
}
try { localStorage.removeItem(ROOM_ACTIVE_KEY); } catch (_) {}

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
const DEFAULT_VOXAL_CONNECT_URL = 'https://voxal.app';
// Canonical web URL — used for invite links on native (Tauri/iOS) and for Universal Links
const VOXAL_WEB_URL             = 'https://web.voxal.app';
const PRESENCE_TOKEN_KEY        = 'presence-api-token';
const PRESENCE_ORG_KEY          = 'presence-org-id';
const SERVICE_URL_KEY           = 'service-url';
const PSEUDO_KEY                = 'pseudo';
const PSEUDO_SESSION_KEY        = 'pseudo-session';
const DEV_MODE_KEY              = 'dev-mode';
const DEBUG_INFO_SHARE_KEY      = 'debug-share-device-info'; // opt-out for sharing device diagnostics in dev mode (default ON)
const VIDEO_MODE_KEY            = 'video-mode-enabled';
const SELF_VIDEO_CORNER_KEY     = 'self-video-corner'; // corner the minimized self-view badge was dragged to
const REJOIN_SNAPSHOT_KEY       = 'rejoin-snapshot';
const REJOIN_TTL_MS             = 30 * 60 * 1000; // 30 minutes
var   _rejoinDismissed          = false;
const RECENT_ROOMS_KEY          = 'recent-rooms';
const RECENT_ROOMS_MAX          = 5;

function presenceBase()       { return (localStorage.getItem(SERVICE_URL_KEY) || DEFAULT_PRESENCE_BASE).replace(/\/$/, ''); }
function voxalConnectUrl()    { return localStorage.getItem('voxal-connect-url') || DEFAULT_VOXAL_CONNECT_URL; }
function presenceToken()      { return localStorage.getItem(PRESENCE_TOKEN_KEY) || ''; }
function presenceOrgId()      { return localStorage.getItem(PRESENCE_ORG_KEY)   || ''; }
function presenceConfigured() { return !!(presenceToken() && presenceOrgId()); }

// Optional PeerJS broker override (host/port/path/key/secure). Defaults to {} so
// production uses the PeerJS cloud broker unchanged. Used by the E2E mesh harness
// to point peers at a local PeerServer (localStorage['peerjs-server']).
function peerServerOptions() {
  try {
    var raw = localStorage.getItem('peerjs-server');
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

// Camera/screen-share routing preference. Never applies to voice — see
// VIDEO_ROUTING_KEY above.
function videoRoutingPreference() {
  var v = localStorage.getItem(VIDEO_ROUTING_KEY);
  // Every valid value must be listed explicitly. Leaving one out means an
  // explicit user choice silently falls through to the default — which, now
  // that the default is 'allow-sfu', would quietly downgrade someone who
  // deliberately picked 'prefer-p2p'.
  return (v === 'prefer-p2p' || v === 'allow-sfu' || v === 'p2p-only') ? v : VIDEO_ROUTING_DEFAULT;
}

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
//   { source: 'voxal', type: 'popout', url: '<standalone url>' }        (user popped out; embed left the room)
//   { source: 'voxal', type: 'popout-blocked', url: '<standalone url>' } (browser blocked window.open)

var _isIframe = (function() { try { return window.self !== window.top; } catch(e) { return true; } })();
var IS_TINY_EMBED = (function() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var tinyParam = (params.get('tiny') || '').toLowerCase();
    var compactParam = (params.get('compact') || '').toLowerCase();
    return (
      params.get('ui') === 'tiny' ||
      params.get('embed') === 'tiny' ||
      tinyParam === '1' ||
      tinyParam === 'true' ||
      compactParam === '1' ||
      compactParam === 'true'
    );
  } catch (_) {
    return false;
  }
})();
var HIDE_EMBED_HEADER = (function() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var raw = (
      params.get('hideHeader') ||
      params.get('noHeader') ||
      ''
    ).toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  } catch (_) {
    return false;
  }
})();
var FORCE_WEB_JOIN = (function() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var raw = (
      params.get('forceWeb') ||
      params.get('webOnly') ||
      params.get('web') ||
      ''
    ).toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  } catch (_) {
    return false;
  }
})();
// Opt-in: embedders enable the "pop out to a standalone window" affordance by
// adding ?popout=1 (aliases: allowPopout / canPopout) to the iframe src.
var ALLOW_POPOUT = (function() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var raw = (
      params.get('popout') ||
      params.get('allowPopout') ||
      params.get('canPopout') ||
      ''
    ).toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  } catch (_) {
    return false;
  }
})();

function getAllowedParentOrigin() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var raw = params.get('parentOrigin');
    if (!raw) return window.location.origin;
    var parsed = new URL(raw, window.location.href);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch (_) {
    try {
      if (document.referrer) {
        var ref = new URL(document.referrer, window.location.href);
        if (/^https?:$/.test(ref.protocol)) return ref.origin;
      }
    } catch (_) {}
    return window.location.origin;
  }
}

function iframeEmit(msg) {
  if (!_isIframe) return;
  var targetOrigin = getAllowedParentOrigin();
  if (!targetOrigin) return;
  window.parent.postMessage(Object.assign({ source: 'voxal' }, msg), targetOrigin);
}

// Should we trust an inbound postMessage from the embedding page? Backward
// compatible: if the embed did NOT declare ?parentOrigin we allow any origin
// (legacy behavior). If it DID, every command must come from that origin — so an
// embed can lock itself down by passing ?parentOrigin=https://its.site.
function isTrustedParentMessage(e) {
  try {
    if (!new URLSearchParams(window.location.search || '').get('parentOrigin')) return true;
  } catch (_) {
    return true;
  }
  var allowed = getAllowedParentOrigin();
  return !!allowed && e.origin === allowed;
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

    // ── Universal Links: https://ptt.voxal.app/*?room=<id> (and voxal.app aliases) ──
    if ((url.protocol === 'https:' || url.protocol === 'http:') &&
        (url.hostname === 'ptt.voxal.app' ||
         url.hostname === 'voxal.app' ||
         url.hostname === 'www.voxal.app' ||
         url.hostname === 'web.voxal.app' ||
         url.hostname === 'localhost' ||
         url.hostname === '127.0.0.1')) {
      const token = url.searchParams.get('token');
      const state = url.searchParams.get('state');
      if (token) {
        handleAuthCallbackToken(token, state);
        return;
      }
      const roomId = url.searchParams.get('room');
      if (roomId) {
        if (_audioCtx.state === 'suspended') _audioCtx.resume();
        var doJoinUL = function() {
          var joinFn = !UUID_RE.test(roomId) ? joinOrCreateByChannelName : joinRoom;
          joinFn(roomId).catch(function(err) { showError(err.message); });
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
        var joinFn = !UUID_RE.test(roomId) ? joinOrCreateByChannelName : joinRoom;
        joinFn(roomId).catch(function(err) { showError(err.message); });
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

function handleAuthCallbackToken(token, state) {
  if (!token) return;
  const expected = sessionStorage.getItem('voxal-auth-state');
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage({ token: token, state: state || expected || '' }, window.location.origin);
      window.close();
      return;
    } catch (e) {
      console.warn('[Auth] Popup relay failed, applying locally:', e.message);
    }
  }
  if (expected && state !== expected) { console.warn('[Auth] State mismatch — ignoring'); return; }
  sessionStorage.removeItem('voxal-auth-state');

  localStorage.setItem(PRESENCE_TOKEN_KEY, token);
  const inp = document.getElementById('input-presence-token');
  if (inp) inp.value = token;
  if (typeof updateDisconnectVisibility === 'function') updateDisconnectVisibility();
  if (typeof updateConnectVisibility === 'function') updateConnectVisibility();
  selectOrgAndStartPolling();
}

// Where the auth server sends a web browser back to. A fixed, allowlistable
// path on our own origin — the same shape Google and Facebook use. Custom
// schemes (voxal://) are for native apps only: handing one to a browser
// dead-ends at the OS ("no application is configured to open this URL") and the
// user is never signed in.
const AUTH_CALLBACK_PATH = '/auth/callback';

function authRedirectUri() {
  return window.location.origin + AUTH_CALLBACK_PATH;
}

// Native (Tauri desktop, Capacitor mobile) round-trips through the OS via the
// custom scheme; everything else comes back over https.
function authUsesDeepLink() {
  return IS_TAURI_DESKTOP || IS_NATIVE_MOBILE;
}

// Builds the /connect URL and records the state we will validate on return.
// Split out from the navigation so it can be asserted directly — location.assign
// is not reliably stubbable in a real browser.
function buildConnectUrl() {
  const state = generateState();
  sessionStorage.setItem('voxal-auth-state', state);
  const connectUrl = new URL(voxalConnectUrl() + '/connect');
  connectUrl.searchParams.set('state', state);
  connectUrl.searchParams.set('caller', IS_TAURI_DESKTOP ? 'desktop' : IS_NATIVE_MOBILE ? 'mobile' : 'web');
  connectUrl.searchParams.set('responseMode', authUsesDeepLink() ? 'deep-link' : 'redirect');
  if (!authUsesDeepLink()) {
    connectUrl.searchParams.set('redirect_uri', authRedirectUri());
  }
  return connectUrl.toString();
}

async function connectWithVoxalAccount() {
  // A same-tab redirect leaves the page, which would tear down an active call.
  if (!authUsesDeepLink() && inRoom) {
    showError('Leave the room before connecting your account — signing in reloads the page.');
    return false;
  }

  const connectUrl = buildConnectUrl();

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
  } else if (IS_NATIVE_MOBILE) {
    // iOS/Android: open in system browser; appUrlOpen fires when the OS routes
    // voxal:// back into the app.
    window.open(connectUrl, '_system');
  } else {
    // Web: navigate this tab. No popup — popups get blocked, and the
    // Cross-Origin-Opener-Policy: same-origin header this app needs for RNNoise
    // severs window.opener, so a popup could never post the token back anyway.
    sessionStorage.setItem(AUTH_PENDING_KEY, String(Date.now()));
    window.location.assign(connectUrl);
  }
  return true;
}

// Marks that we navigated away to sign in, so a return with no token can be
// reported instead of silently doing nothing.
const AUTH_PENDING_KEY = 'voxal-auth-pending';

// Handle https://<origin>/auth/callback?token=…&state=… on load.
//
// Returns true when a token was consumed. The token is stripped from the URL
// immediately: left in the address bar it leaks through history, screenshots
// and the Referer header on the next navigation.
function consumeAuthCallbackFromUrl() {
  var params;
  try { params = new URLSearchParams(window.location.search || ''); } catch (_) { return false; }
  var token = params.get('token');
  var state = params.get('state');
  if (!token) return false;

  sessionStorage.removeItem(AUTH_PENDING_KEY);
  handleAuthCallbackToken(token, state);

  params.delete('token');
  params.delete('state');
  var query = params.toString();
  try {
    window.history.replaceState({}, '',
      window.location.pathname.replace(/^\/auth\/callback$/, '/') + (query ? '?' + query : ''));
  } catch (_) {}
  return true;
}

// If we come back from the auth server with nothing, say so. Without this the
// user just lands on the home screen still signed out, with no explanation —
// which is exactly how the voxal:// dead end presented.
function reportAbandonedAuth() {
  if (!sessionStorage.getItem(AUTH_PENDING_KEY)) return;
  sessionStorage.removeItem(AUTH_PENDING_KEY);
  if (presenceToken()) return; // it worked after all
  showError('Sign-in did not complete. If your browser offered to open a "voxal://" link, ' +
            'the auth server still needs to be updated to redirect back to the web app.');
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
  return (await res.json()).presence; // [{channel:{id,name}, peer_count, connected:[{user_id,peer_id,display_name,room_id,peer_count,deputy_peer_id,updated_at}]}]
}

async function fetchOrgs() {
  const res = await tauriFetch(presenceBase() + '/orgs', {
    headers: { 'x-api-token': presenceToken() },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).organisations; // [{id,name,avatar_url,role}]
}

async function postSession(channelName, peerId, extraFields) {
  var payload = Object.assign({
    org_id: presenceOrgId(),
    channel_name: channelName,
    peer_id: peerId
  }, extraFields || {});

  var res = await tauriFetch(presenceBase(), {
    method: 'POST',
    headers: { 'x-api-token': presenceToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // Presence API compatibility fallback: if optional metadata is rejected, retry
  // with the minimal legacy payload so channel registration still succeeds.
  if (!res.ok && extraFields && Object.keys(extraFields).length) {
    res = await tauriFetch(presenceBase(), {
      method: 'POST',
      headers: { 'x-api-token': presenceToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: presenceOrgId(),
        channel_name: channelName,
        peer_id: peerId
      }),
    });
  }

  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function deleteSession() {
  if (!presenceConfigured()) return;
  tauriFetch(presenceBase(), {
    method: 'DELETE',
    headers: { 'x-api-token': presenceToken() },
  }).catch(function(e) { console.warn('[Presence] deleteSession:', e.message); });
}

const FALLBACK_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Best-effort free TURN relay for peers behind symmetric NAT / strict firewalls
// when no org or metered.ca TURN is configured. STUN can't traverse those — only
// a TURN relay can — and TCP/443 + TLS (turns:) are the transports that slip past
// corporate firewalls (UDP/3478 is commonly blocked). A TURN relay only forwards
// encrypted DTLS-SRTP, so it never has access to the audio.
//
// These are the public Open Relay credentials: shared, rate-limited and NOT
// guaranteed (Open Relay has been moving toward per-account API keys, so verify
// before relying on them). Point this at your own coturn / a metered.ca free tier
// without a rebuild by setting localStorage['turn-fallback'] to a JSON array of
// RTCIceServer objects — or to '[]' to disable the relay fallback entirely.
const DEFAULT_FALLBACK_TURN = [
  { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

function fallbackTurnServers() {
  var raw = localStorage.getItem(TURN_FALLBACK_KEY);
  if (raw === null) return DEFAULT_FALLBACK_TURN;
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_FALLBACK_TURN;
  } catch (_) {
    return DEFAULT_FALLBACK_TURN;
  }
}

// Map the stored turn-fallback value to the friendly relay-mode UI:
//   absent            → 'auto'   (default public relay)
//   '[]' / empty array → 'off'    (direct / STUN only)
//   array of servers   → 'custom' (first server populates the URL/user/pass fields)
function relayStateFromStorage() {
  var raw = localStorage.getItem(TURN_FALLBACK_KEY);
  var empty = { mode: 'auto', url: '', username: '', credential: '' };
  if (raw === null) return empty;
  var parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return empty; }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { mode: 'off', url: '', username: '', credential: '' };
  }
  var first = parsed[0] || {};
  return { mode: 'custom', url: first.urls || '', username: first.username || '', credential: first.credential || '' };
}

// Persist the relay choice from the advanced settings controls.
function relayStateToStorage(mode, url, username, credential) {
  if (mode === 'auto') { localStorage.removeItem(TURN_FALLBACK_KEY); return; }
  if (mode === 'off')  { localStorage.setItem(TURN_FALLBACK_KEY, '[]'); return; }
  var trimmedUrl = (url || '').trim();
  if (!trimmedUrl) { localStorage.setItem(TURN_FALLBACK_KEY, '[]'); return; } // custom but nothing entered yet
  var server = { urls: trimmedUrl };
  var u = (username || '').trim(); if (u) server.username = u;
  var p = (credential || '').trim(); if (p) server.credential = p;
  localStorage.setItem(TURN_FALLBACK_KEY, JSON.stringify([server]));
}

// Populate the advanced "Jitter buffer" controls from storage.
function loadJitterControls() {
  var st = jitterBufferSetting();
  document.querySelectorAll('input[name="jitter-mode"]').forEach(function(r) { r.checked = (r.value === st.mode); });
  var slider = $('input-jitter-ms');
  // Seed the slider from the adaptive baseline so switching to Manual starts
  // from what auto would have used, rather than snapping to 0.
  if (slider) slider.value = String(st.mode === 'manual' ? st.ms : Math.round(AUDIO_PLAYOUT_DELAY_BASE * 1000));
  var out = $('jitter-ms-value');
  if (out && slider) out.textContent = slider.value + ' ms';
  var manual = $('jitter-manual');
  if (manual) manual.classList.toggle('hidden', st.mode !== 'manual');
}

// Persist the jitter choice from the advanced controls and apply it live.
function syncJitterFromControls() {
  var checked = document.querySelector('input[name="jitter-mode"]:checked');
  var mode = checked ? checked.value : 'auto';
  var manual = $('jitter-manual');
  if (manual) manual.classList.toggle('hidden', mode !== 'manual');
  var slider = $('input-jitter-ms');
  var out = $('jitter-ms-value');
  if (out && slider) out.textContent = slider.value + ' ms';
  setJitterBufferSetting(mode, slider ? slider.value : 0);
  // A host changing the room-wide value must republish it immediately rather
  // than waiting for the next heartbeat.
  if (inRoom && isHost) broadcastHostPeerLists();
}

// Populate the advanced "Fallback relay" controls from storage.
function loadRelayControls() {
  var st = relayStateFromStorage();
  document.querySelectorAll('input[name="relay-mode"]').forEach(function(r) { r.checked = (r.value === st.mode); });
  if ($('input-relay-url'))  $('input-relay-url').value  = st.url;
  if ($('input-relay-user')) $('input-relay-user').value = st.username;
  if ($('input-relay-pass')) $('input-relay-pass').value = st.credential;
  var custom = $('relay-custom'); if (custom) custom.classList.toggle('hidden', st.mode !== 'custom');
}

// Persist the advanced "Fallback relay" controls to storage (on any change).
function syncRelayFromControls() {
  var checked = document.querySelector('input[name="relay-mode"]:checked');
  var mode = checked ? checked.value : 'auto';
  var custom = $('relay-custom'); if (custom) custom.classList.toggle('hidden', mode !== 'custom');
  relayStateToStorage(
    mode,
    $('input-relay-url')  ? $('input-relay-url').value  : '',
    $('input-relay-user') ? $('input-relay-user').value : '',
    $('input-relay-pass') ? $('input-relay-pass').value : ''
  );
}

// Populate/persist the "Video routing" radios (camera/screen-share only, never
// audio — see VIDEO_ROUTING_KEY). Loading never triggers a topology change;
// only an actual `change` event does (see the listener near the other
// settings-modal wiring), and the storage-event branch calls
// reconcileVideoTopology() separately after this resync.
function syncVideoRoutingControls() {
  var mode = videoRoutingPreference();
  document.querySelectorAll('input[name="video-routing-mode"]').forEach(function(r) { r.checked = (r.value === mode); });
}

// Public STUN plus the best-effort free TURN relay — used when no org/metered
// TURN is configured so that peers behind firewalls can still connect.
function fallbackIceServers() {
  return FALLBACK_STUN.concat(fallbackTurnServers());
}

// ICE servers pushed in by the embedding page via postMessage {type:'config'}.
// When set, they take precedence over every other source — the embedder is
// telling us exactly which STUN/TURN servers to use. Kept in memory only (not
// persisted): the parent re-sends on each load, and the creds never touch
// localStorage. Validated + applied by applyIframeConfig().
var _iframeIceServers = null;

function applyIframeConfig(msg) {
  if (!msg || !Array.isArray(msg.iceServers)) return;
  var servers = msg.iceServers.filter(function(s) {
    return s && typeof s === 'object' && (typeof s.urls === 'string' || Array.isArray(s.urls));
  });
  _iframeIceServers = servers.length ? servers : null; // empty array clears the override
  var n = _iframeIceServers ? _iframeIceServers.length : 0;
  devLog('[ICE] Applied ' + n + ' ICE server(s) from the embedding page');
  iframeEmit({ type: 'config-applied', iceServers: n });
}

// --- Anonymous TURN credentials ----------------------------------------------
//
// A relay API key can never ship in the client: src/ is static files, so anyone
// could read it and drain the quota. Instead a small server endpoint holds the
// secret and hands out SHORT-LIVED credentials (see api/ice-servers.js). This is
// what gives users with no account a working relay.

const DEFAULT_ANON_TURN_URL = 'https://ptt.voxal.app/api/ice-servers';

// Where to ask for anonymous credentials.
//   - explicit override wins (self-hosters, tests);
//   - on plain web over http(s) use a SAME-ORIGIN path, so a self-hosted deploy
//     automatically uses its own endpoint rather than ptt.voxal.app's quota;
//   - native (Capacitor/Tauri) has no same-origin server — the page is loaded
//     from capacitor:// or the Tauri asset protocol — so it needs the absolute URL.
function anonymousTurnUrl() {
  var override = localStorage.getItem(ANON_TURN_URL_KEY);
  if (override) return override.trim();
  if (IS_PLAIN_WEB && /^https?:$/.test(location.protocol)) return '/api/ice-servers';
  return DEFAULT_ANON_TURN_URL;
}

// --- Cloudflare SFU endpoints (video/screen-share only) ----------------------
//
// Same same-origin-on-web / absolute-on-native resolution as anonymousTurnUrl()
// above, plus a JSON override for the mesh E2E harness. This never applies to
// audio — see VIDEO_ROUTING_KEY.
const DEFAULT_SFU_SESSION_URL     = 'https://ptt.voxal.app/api/sfu-session';
const DEFAULT_SFU_TRACK_URL       = 'https://ptt.voxal.app/api/sfu-track';
const DEFAULT_SFU_RENEGOTIATE_URL = 'https://ptt.voxal.app/api/sfu-renegotiate';

function _sfuServerOverride() {
  try {
    var raw = localStorage.getItem(SFU_SERVER_OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function sfuSessionUrl() {
  var override = _sfuServerOverride();
  if (override && override.sessionUrl) return override.sessionUrl;
  if (IS_PLAIN_WEB && /^https?:$/.test(location.protocol)) return '/api/sfu-session';
  return DEFAULT_SFU_SESSION_URL;
}

function sfuTrackUrl() {
  var override = _sfuServerOverride();
  if (override && override.trackUrl) return override.trackUrl;
  if (IS_PLAIN_WEB && /^https?:$/.test(location.protocol)) return '/api/sfu-track';
  return DEFAULT_SFU_TRACK_URL;
}

function sfuRenegotiateEndpoint() {
  var override = _sfuServerOverride();
  if (override && override.renegotiateUrl) return override.renegotiateUrl;
  if (IS_PLAIN_WEB && /^https?:$/.test(location.protocol)) return '/api/sfu-renegotiate';
  return DEFAULT_SFU_RENEGOTIATE_URL;
}

// Credentials are time-boxed, so keep them only until they expire.
// A cold serverless start plus the provider round trip can exceed 5s; aborting
// there would silently drop us onto the retired public relay. The prefetch is
// off the critical path, so a longer ceiling costs nothing.
const ANON_TURN_TIMEOUT_MS = 8000;

var _anonIceCache = null; // { servers, expiresAt }
// Why the last anonymous-credential attempt failed, so the echo test can say
// so instead of blaming the retired built-in relay.
var _anonTurnError = null;

function _anonIceCacheValid(now) {
  return !!(_anonIceCache && _anonIceCache.expiresAt > (now || Date.now()));
}

async function fetchAnonymousIceServers() {
  var now = Date.now();
  if (_anonIceCacheValid(now)) return _anonIceCache.servers.slice();

  var url = anonymousTurnUrl();
  if (!url) return null;

  // `no-store` is not optional: KNOWLEDGE/learning.md records the browser HTTP
  // cache replaying stale anonymous-rooms GETs for days, and a cached credential
  // is one that outlives its own expiry. tauriFetch goes through Rust, which is
  // immune, and falls back to plain fetch elsewhere.
  var res = window.__TAURI__
    ? await tauriFetch(url)
    : await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ANON_TURN_TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  var data = await res.json();
  var servers = data && Array.isArray(data.ice_servers) ? data.ice_servers : null;
  if (!servers || !servers.length) return null;

  var expiresAt = data.expires_at ? Date.parse(data.expires_at) : NaN;
  // Expire slightly early rather than handing out a credential about to die.
  _anonIceCache = {
    servers: servers,
    expiresAt: isFinite(expiresAt) ? expiresAt - 60000 : now + 10 * 60 * 1000,
  };
  return servers.slice();
}

// What fetchIceServers() actually resolved, last time it ran.
//
// The connection-status badge used to read localStorage['metered-status'], which
// only the ORG path ever writes — so an anonymous user with a perfectly working
// relay was told "TURN not configured". It was also persisted, so it could go on
// claiming "ok" long after a credential died. Deriving the status from the live
// resolution fixes both directions.
var _lastIceResolution = null; // { source, relayCount, at }

// Set when a Test-over-network run genuinely completed over a relay. That round
// trip is the only actual PROOF a relay works, as opposed to being configured.
var _relayVerifiedAt = null;

function noteIceResolution(source, servers) {
  _lastIceResolution = {
    source: source,
    relayCount: countRelayServers(servers),
    at: Date.now(),
  };
  // The badge lives in the bootstrap scope and is published on window, so it may
  // not exist yet when ICE is prefetched at startup.
  if (typeof updateTurnBadge === 'function') updateTurnBadge();
  return servers;
}

// 0. Iframe-provided ICE servers (postMessage 'config') — highest precedence
// 1. Try org TURN (backend-managed, short-lived credentials — preferred)
// 2. Try locally configured metered.ca credentials (manual fallback)
// 3. Fall back to public STUN + best-effort free TURN relay
async function fetchIceServers() {
  // --- 0. ICE servers supplied by the embedding page ---
  if (_iframeIceServers && _iframeIceServers.length) {
    devLog('[ICE] Using ' + _iframeIceServers.length + ' embed-provided server(s)');
    return noteIceResolution('embed', _iframeIceServers.slice());
  }

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
          return noteIceResolution('org', ice_servers);
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
        return noteIceResolution('metered', servers);
      }
    } catch (e) {
      console.warn('[TURN] Local metered.ca fetch failed, falling back to STUN:', e.message);
      devLog('[ICE] metered.ca failed: ' + e.message, 'warn');
    }
  }

  // --- 2.5. Anonymous TURN credentials from our own endpoint ---
  // This is the path that gives account-less users a working relay. It comes
  // after any explicitly configured source, so an org or custom relay still wins.
  _anonTurnError = null;
  try {
    devLog('[ICE] Requesting anonymous TURN credentials…');
    var anon = await fetchAnonymousIceServers();
    if (anon && anon.length) {
      console.log('[TURN] Using', anon.length, 'anonymous ICE server(s)');
      devLog('[ICE] Anonymous TURN: ' + anon.length + ' server(s) ✓');
      return noteIceResolution('anonymous', FALLBACK_STUN.concat(anon));
    }
    _anonTurnError = 'no servers returned';
    devLog('[ICE] Anonymous TURN: none available, trying next…', 'warn');
  } catch (e) {
    _anonTurnError = e.message;
    console.warn('[TURN] Anonymous TURN fetch failed:', e.message);
    devLog('[ICE] Anonymous TURN failed: ' + e.message, 'warn');
  }

  // --- 3. Public STUN + best-effort free TURN relay ---
  var fb = fallbackIceServers();
  var relays = fb.filter(function(s) { return /^turns?:/.test(s.urls); }).length;
  devLog('[ICE] Using public fallback: ' + fb.length + ' server(s), ' + relays + ' relay(s)', 'warn');
  return noteIceResolution('fallback', fb);
}

// Re-resolve ICE because the identity changed (Voxal Connect sign-in, sign-out,
// or an org switch).
//
// Which source wins depends on who you are: an org relay outranks the anonymous
// one. Without this, signing in kept using the anonymous credential until the
// next room, and signing out left the status menu naming an org relay we can no
// longer mint credentials for — stale in the direction that matters, because it
// claims a relay is available when it is not.
//
// The anonymous cache is deliberately NOT dropped: those credentials are not
// tied to the account, they stay valid across a sign-in/out, and discarding them
// would buy nothing but an extra round trip.
function refreshIceServers() {
  // These three are written only by the org leg of fetchIceServers() (and by the
  // manual metered.ca test). Clearing them on the way out of an org stops the
  // settings panel reporting servers that belonged to the previous session.
  if (_lastIceResolution && _lastIceResolution.source === 'org') {
    localStorage.removeItem(METERED_STATUS_STORE_KEY);
    localStorage.removeItem(METERED_COUNT_STORE_KEY);
    localStorage.removeItem(METERED_SERVERS_STORE_KEY);
  }
  // Back to "Checking relay…" rather than the previous identity's answer, which
  // would otherwise sit there looking authoritative for the whole round trip.
  _lastIceResolution = null;
  // A verified round trip proved the OLD relay worked; it says nothing about the
  // new one.
  _relayVerifiedAt = null;
  if (typeof updateTurnBadge === 'function') updateTurnBadge();
  return fetchIceServers().catch(function(e) {
    console.warn('[ICE] refresh after identity change failed:', e.message);
  });
}

// --- State -------------------------------------------------------------------

const IS_TAURI_DESKTOP = !!window.__TAURI__;
const IS_NATIVE_MOBILE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const IS_PLAIN_WEB     = !IS_TAURI_DESKTOP && !IS_NATIVE_MOBILE;
// Any phone/tablet — native app or mobile browser. RNNoise's real-time worklet
// underruns on these regardless of wrapper (the WebView and the mobile browser
// share the same audio stack). The Mac+touch test catches iPadOS Safari, whose
// default UA masquerades as desktop macOS.
const IS_MOBILE_DEVICE = IS_NATIVE_MOBILE ||
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
  ((navigator.maxTouchPoints || 0) > 1 && /Mac/.test(navigator.platform || ''));
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
let _preRenameMyPseudo       = null; // original myPseudo before a room-forced rename
let _preRenameAnonPseudo     = null; // original anon.pseudo before a room-forced rename
let editingSelfPseudo = false;
let _cancelJoin       = null; // set during joinRoom()/createRoom(), called by Cancel button
let _prevScreen       = null; // screen shown before invite-loading (null = page entry point)
let _invitePendingRoomId = '';
let _invitePendingPeerCount = null;
let _micAcquirePromise = null;
let _pendingTalkingStart = false;

// --- Video / screen sharing ---------------------------------------------------
// Video is a normal room capability, on by default. "Enabled" only means the
// controls are offered — every camera stays off until its owner opts in.
var videoModeEnabled  = readVideoModeEnabled();
var localVideoActive  = false;   // this peer is sharing their camera
var localVideoStream  = null;    // MediaStream (video only)
var localScreenActive = false;   // this peer is sharing their screen
var localScreenStream = null;    // MediaStream (screen share)
var _videoViewerPeerId = null;   // whose camera is displayed in the fallback viewer
var _screenViewerPeerId = null;  // whose screen is displayed in the fallback viewer
var _videoPopoutWindow = null;   // reference to video popup window
var _screenPopoutWindow = null;  // reference to screen popup window

// --- Video/screen topology state (P2P mesh vs Cloudflare SFU) ----------------
// Never touches audio. See selectVideoTopology() and docs/video-routing.md.
//
// Learned lazily: null = unknown (assume potentially available so a first
// publish attempt can try), true/false = the last mint attempt's outcome,
// cached briefly so a misconfigured/unreachable backend is a fast, quiet
// fallback to P2P rather than a hang or a repeated failing request per peer.
var _sfuAvailability = null;
var _sfuAvailabilityCheckedAt = 0;
var SFU_AVAILABILITY_TTL_MS = 60000;

// Voxal-level track registry: 'participantId:kind' -> track record. Cloudflare
// identifiers (sessionId) live only inside the _sfu* functions below and the
// `_providerRef` field here, which is never logged and never read elsewhere.
var _videoTrackRegistry = new Map();

// Our own outgoing SFU publish sessions — one independent RTCPeerConnection per
// kind (video/screen never share a session; see the "SFU router" comment near
// sfuPublishTrack() for why).
var _sfuPublishSessions = { video: null, screen: null }; // kind -> { pc, cfSessionId }
// The topology decision made when we last (re)published each kind, so
// unpublish/reconcile know whether to tear down an SFU session.
var _localVideoTopology = { video: null, screen: null };
var _stagePinnedKey = null;      // tile key the user pinned as the stage focus
var _hiddenStageKeys = new Set(); // tile keys the user chose not to watch (local only — nothing is signalled)
var SELF_CAMERA_TILE_KEY = 'camera:self';
// Which tiles the grid currently holds and which are minimized into the overflow
// ribbon, in display order. Grid membership is sticky (see partitionStageTiles)
// so faces don't jump slots on every press, and the ribbon list is what tells
// noteStageSpeaker() whether a talker is currently minimized and worth promoting.
var _stageGridKeys = [];
var _stageRibbonKeys = [];
// peerId -> monotonic sequence number of the last time they started talking.
// This is the "most recent speaker" order the grid and the ribbon are built from.
var _speakerRecency = new Map();
var _speakerSeq = 0;
var _devLogBuffer  = [];         // ring buffer of all log entries (max 200)
var _devLogChannel = null;       // BroadcastChannel to the detached devlog window
var _hostDebugMode = false;      // non-host mirror of the host's dev-mode flag (from peer-list/heartbeat)

// --- WebRTC stats polling ---
var _statsIntervalId  = null;
var _statsTimerIntervalId = null;

// --- FPS overlay (dev mode) ---
var _videoFpsIntervalId  = null;  // polling timer for video viewer FPS
var _screenFpsIntervalId = null;  // polling timer for screen viewer FPS

/**
 * Start measuring and displaying FPS for a <video> element.
 * Returns an interval ID that the caller must store and clear later.
 *
 * Strategy: prefer requestVideoFrameCallback (frame-accurate); fall back
 * to getVideoPlaybackQuality (totalVideoFrames delta); last resort is a
 * simple "frames decoded" diff from the HTMLVideoElement.
 */
function _startFpsOverlay(videoElId, overlayElId) {
  if (!isDevModeEnabled()) return null;
  var overlayEl = document.getElementById(overlayElId);
  if (overlayEl) overlayEl.classList.remove('hidden');

  var vid = document.getElementById(videoElId);
  if (!vid) return null;

  // Helper: resolve resolution from multiple sources
  function resolveRes(v) {
    var w = v.videoWidth, h = v.videoHeight;
    if (w && h) return w + '\u00d7' + h;
    // Fallback: read from the MediaStreamTrack settings
    var stream = v.srcObject;
    if (stream) {
      var tracks = stream.getVideoTracks();
      if (tracks.length) {
        var s = tracks[0].getSettings();
        if (s.width && s.height) return s.width + '\u00d7' + s.height;
      }
    }
    return '';
  }

  // -- requestVideoFrameCallback path (Chrome 83+, Edge, Safari 15.4+) --
  if (typeof vid.requestVideoFrameCallback === 'function') {
    var rvfcFrames = 0;
    var rvfcLast   = performance.now();
    var rvfcHandle = null;
    var rvfcRes    = '';  // last resolution captured from metadata

    function onFrame(now, metadata) {
      rvfcFrames++;
      if (metadata && metadata.width && metadata.height) {
        rvfcRes = metadata.width + '\u00d7' + metadata.height;
      }
      rvfcHandle = vid.requestVideoFrameCallback(onFrame);
    }
    rvfcHandle = vid.requestVideoFrameCallback(onFrame);

    var id = setInterval(function() {
      var overlay = document.getElementById(overlayElId);
      var v = document.getElementById(videoElId);
      if (!overlay) return;
      var now = performance.now();
      var dt  = (now - rvfcLast) / 1000;
      var fps = dt > 0 ? Math.round(rvfcFrames / dt) : 0;
      var res = rvfcRes || (v ? resolveRes(v) : '');
      overlay.textContent = fps + ' fps' + (res ? '  ' + res : '');
      rvfcFrames = 0;
      rvfcLast   = now;
    }, 1000);

    // Stash cancel handle so we can clean up the rVFC callback
    id._rvfcCancel = function() {
      if (rvfcHandle != null) vid.cancelVideoFrameCallback(rvfcHandle);
    };
    return id;
  }

  // -- getVideoPlaybackQuality fallback (older browsers) --
  var prevFrames = 0;
  if (vid.getVideoPlaybackQuality) {
    prevFrames = vid.getVideoPlaybackQuality().totalVideoFrames || 0;
  }

  return setInterval(function() {
    var overlay = document.getElementById(overlayElId);
    var v = document.getElementById(videoElId);
    if (!overlay || !v) return;
    var frames = 0;
    if (v.getVideoPlaybackQuality) {
      frames = v.getVideoPlaybackQuality().totalVideoFrames || 0;
    }
    var fps = frames - prevFrames;
    prevFrames = frames;
    var res = resolveRes(v);
    overlay.textContent = fps + ' fps' + (res ? '  ' + res : '');
  }, 1000);
}

function _stopFpsOverlay(intervalId, overlayElId) {
  if (intervalId) {
    if (intervalId._rvfcCancel) intervalId._rvfcCancel();
    clearInterval(intervalId);
  }
  var overlay = document.getElementById(overlayElId);
  if (overlay) { overlay.classList.add('hidden'); overlay.textContent = ''; }
  return null;
}

// --- Anonymous room publish ---
var _publishSecret         = null;
var _publishedRoomId       = null;
var _publishedShareUrl     = null;
var _publishHeartbeatId    = null;
var _publishDebounceId     = null;
var _presenceDebounceId    = null;
var _lastPublishAt         = 0;
var PUBLISH_HEARTBEAT_MS   = 50 * 60 * 1000; // 50 min (TTL is 1h)
var PUBLISH_DEBOUNCE_MS    = 10000;
var PUBLISH_MIN_INTERVAL   = 30000; // never POST more often than every 30s

async function publishRoom(opts) {
  if (!isHost || !peer || !roomCode) return;
  var now = Date.now();
  var elapsed = now - _lastPublishAt;
  if (_lastPublishAt && elapsed < PUBLISH_MIN_INTERVAL) {
    // Too soon — schedule a retry after the cooldown
    schedulePublishRefresh();
    return;
  }
  _lastPublishAt = now;
  var peerCount = currentRoomPeerCount() || (connections.size + 1);
  var headers = { 'Content-Type': 'application/json' };
  if (_publishSecret) headers['x-room-secret'] = _publishSecret;
  var postBody = { room_id: roomCode, peer_count: peerCount };
  if (opts && opts.room_code) postBody.room_code = opts.room_code;
  var res = await tauriFetch(ANONYMOUS_ROOMS_BASE, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(postBody),
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
  clearTimeout(_presenceDebounceId);
  _publishHeartbeatId = null;
  _publishDebounceId = null;
  _presenceDebounceId = null;
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

function hostPresencePeerCount() {
  return 1 + hostConnectedPeerIds().length;
}

function currentRoomPeerCount() {
  return inRoom ? (1 + connections.size) : 0;
}

// The *public* identifier of the room we are in: a published lobby slug or the
// channel's own associated code. Deliberately not the PeerJS peer id — that is
// already carried by `peer_id`, and a session that advertises it as `room_id`
// gets it echoed straight back into activeChannelRoomId, replacing the channel
// name in the header with a random UUID (see publicAssociatedRoomId).
function currentPresenceRoomId() {
  return activeChannelRoomId || _publishedRoomId || '';
}

function buildPresenceSessionPayload(peerId) {
  var payload = {
    peer_count: currentRoomPeerCount() || hostPresencePeerCount(),
    deputy_peer_id: currentDeputyId() || null
  };
  var publicRoomId = currentPresenceRoomId();
  if (publicRoomId) payload.room_id = publicRoomId;
  return payload;
}

function syncPresenceChannelSession() {
  if (!isHost || !inRoom || !peer || !activeChannel || !presenceConfigured()) return;
  postSession(activeChannel, peer.id, buildPresenceSessionPayload(peer.id)).then(function(data) {
    var associated = publicAssociatedRoomId(associatedRoomIdFromSessionResponse(data));
    if (!associated || associated === activeChannelRoomId) return;
    activeChannelRoomId = associated;
    updateRoomHeader();
  }).catch(function(e) {
    console.warn('[Presence] session refresh failed:', e.message);
  });
}

function schedulePresenceRefresh() {
  if (!isHost || !activeChannel || !presenceConfigured()) return;
  clearTimeout(_presenceDebounceId);
  _presenceDebounceId = setTimeout(function() {
    _presenceDebounceId = null;
    syncPresenceChannelSession();
  }, 1200);
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
    // cache: 'no-store' — the service omits Cache-Control, so without it the
    // browser can replay a stale (even days-old) 404/410 and fork the room.
    var res = await tauriFetch(ANONYMOUS_ROOMS_BASE + '/' + encodeURIComponent(code), { cache: 'no-store' });
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

async function lookupRoomInfo(code) {
  if (!code || UUID_RE.test(code)) return null;
  try {
    var res = await tauriFetch(ANONYMOUS_ROOMS_BASE + '/' + encodeURIComponent(code), { cache: 'no-store' });
    if (!res.ok) return null;
    var data = await res.json();
    var rawCount = data && (data.peer_count || data.peerCount || (data.room && data.room.peer_count));
    var peerCount = parseInt(rawCount, 10);
    return {
      roomId: (data && data.room_id) || null,
      peerCount: Number.isFinite(peerCount) ? peerCount : null
    };
  } catch (_) {
    return null;
  }
}

function firstConnectedPeerId(item) {
  var connected = (item && Array.isArray(item.connected)) ? item.connected : [];
  var peerIds = connected
    .map(function(c) { return c && c.peer_id ? String(c.peer_id).trim() : ''; })
    .filter(Boolean)
    .sort();
  return peerIds[0] || null;
}

async function resolvePresenceChannelHost(code) {
  if (!presenceConfigured() || !code) return null;
  var target = String(code).trim().toLowerCase();
  if (!target) return null;

  function findFrom(list) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var channel = item.channel || {};
      var channelName = String(channel.name || '').trim();
      if (!channelName || channelName.toLowerCase() !== target) continue;
      var hostId = firstConnectedPeerId(item);
      if (!hostId) return { channelName: channelName, hostId: null };
      return { channelName: channelName, hostId: hostId };
    }
    return null;
  }

  var match = findFrom(presenceData);
  if (match) return match;

  try {
    presenceData = await fetchPresence();
  } catch (e) {
    console.warn('[Presence] channel host resolution failed:', e.message);
    return null;
  }
  return findFrom(presenceData);
}

let shortcutStr = localStorage.getItem('ptt-shortcut') || DEFAULT_SHORTCUT;

var ANON_COLOR_CHOICES = [
  { name: 'Crimson',  hex: '#ef4444' },
  { name: 'Amber',    hex: '#f59e0b' },
  { name: 'Emerald',  hex: '#22c55e' },
  { name: 'Teal',     hex: '#14b8a6' },
  { name: 'Azure',    hex: '#3b82f6' },
  { name: 'Indigo',   hex: '#6366f1' },
  { name: 'Violet',   hex: '#a855f7' },
  { name: 'Rose',     hex: '#f43f5e' },
];
var ANON_ANIMAL_CHOICES = [
  'Fox', 'Otter', 'Wolf', 'Falcon', 'Koala', 'Panda', 'Lynx', 'Tiger',
  'Dolphin', 'Raven', 'Eagle', 'Orca', 'Badger', 'Hawk', 'Stag', 'Leopard'
];
var _anonymousProfile = null;

function randomIndex(max) {
  if (max <= 0) return 0;
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      return arr[0] % max;
    }
  } catch (_) {}
  return Math.floor(Math.random() * max);
}

function ensureAnonymousProfile() {
  if (_anonymousProfile) return _anonymousProfile;
  var color = ANON_COLOR_CHOICES[randomIndex(ANON_COLOR_CHOICES.length)];
  var animal = ANON_ANIMAL_CHOICES[randomIndex(ANON_ANIMAL_CHOICES.length)];
  _anonymousProfile = {
    pseudo: color.name + ' ' + animal,
    pseudoColor: color.hex
  };
  return _anonymousProfile;
}

function selfPseudoProfile() {
  var presenceName = presenceDisplayNameForSelf();
  if (presenceName) return { pseudo: presenceName, pseudoColor: null, anonymous: false, presence: true };
  var manualPseudo = (myPseudo || '').trim();
  if (manualPseudo) return { pseudo: manualPseudo, pseudoColor: null, anonymous: false };
  var anon = ensureAnonymousProfile();
  return { pseudo: anon.pseudo, pseudoColor: anon.pseudoColor, anonymous: true };
}

function pseudoForHost() { return selfPseudoProfile().pseudo; }
function pseudoForPeer() { return selfPseudoProfile().pseudo; }

function pseudoColorForSelf() {
  return selfPseudoProfile().pseudoColor || null;
}

function displayPseudoForSelf() {
  return selfPseudoProfile().pseudo || 'You';
}

function normalizePseudoKey(name) {
  return String(name || '').trim().toLowerCase();
}

function collectTakenPseudoKeys(excludedPeerId) {
  var keys = new Set();
  var selfId = peer && peer.id ? peer.id : null;
  var selfPseudo = selfPseudoProfile().pseudo;
  if (selfPseudo && selfId !== excludedPeerId) keys.add(normalizePseudoKey(selfPseudo));
  connections.forEach(function(conn, peerId) {
    if (peerId === excludedPeerId) return;
    if (!conn || !conn.pseudo) return;
    keys.add(normalizePseudoKey(conn.pseudo));
  });
  keys.delete('');
  return keys;
}

function ensureUniquePseudoForRoom(basePseudo, excludedPeerId) {
  var base = String(basePseudo || '').trim() || 'Anonymous';
  var taken = collectTakenPseudoKeys(excludedPeerId);
  var candidate = base;
  var idx = 2;
  while (taken.has(normalizePseudoKey(candidate))) {
    candidate = base + ' ' + idx;
    idx++;
  }
  return candidate;
}

function applyAssignedSelfProfile(pseudo, pseudoColor) {
  var assignedPseudo = String(pseudo || '').trim();
  if (!assignedPseudo) return;
  var requestedManualPseudo = (myPseudo || '').trim();
  if (requestedManualPseudo) {
    if (assignedPseudo !== requestedManualPseudo) {
      showCopyToast('Name already used in this room. You were renamed to "' + assignedPseudo + '".');
      // Save original so we can restore it when leaving this room.
      if (_preRenameMyPseudo === null) _preRenameMyPseudo = requestedManualPseudo;
      setMyPseudo(assignedPseudo, { silentAnnounce: true });
    }
    return;
  }
  var anon = ensureAnonymousProfile();
  if (assignedPseudo !== anon.pseudo) {
    if (_preRenameAnonPseudo === null) _preRenameAnonPseudo = anon.pseudo;
    anon.pseudo = assignedPseudo;
  }
  if (pseudoColor) anon.pseudoColor = pseudoColor;
  updatePeerList();
}

// An anonymous profile is the "<Color> <Animal>" pattern produced by
// ensureAnonymousProfile: a known color hex plus a two-word pseudo whose words
// are a known color name and a known animal. Manual names carry no color.
function isAnonymousProfile(pseudo, color) {
  if (!color) return false;
  var hex = String(color).trim().toLowerCase();
  var colorMatch = ANON_COLOR_CHOICES.some(function(c) { return c.hex.toLowerCase() === hex; });
  if (!colorMatch) return false;
  var parts = String(pseudo || '').trim().split(/\s+/);
  if (parts.length !== 2) return false;
  var nameOk = ANON_COLOR_CHOICES.some(function(c) { return c.name.toLowerCase() === parts[0].toLowerCase(); });
  var animalOk = ANON_ANIMAL_CHOICES.some(function(a) { return a.toLowerCase() === parts[1].toLowerCase(); });
  return nameOk && animalOk;
}

// Collect the color names and animals already in use by anonymous peers in the
// room (self included), so a new joiner can be given a distinct pair.
function collectTakenAnonTraits(excludedPeerId) {
  var colors = new Set();
  var animals = new Set();
  function add(pseudo, color) {
    if (!isAnonymousProfile(pseudo, color)) return;
    var parts = String(pseudo).trim().split(/\s+/);
    colors.add(parts[0].toLowerCase());
    animals.add(parts[1].toLowerCase());
  }
  var selfId = peer && peer.id ? peer.id : null;
  var selfProfile = selfPseudoProfile();
  if (selfId !== excludedPeerId && selfProfile.anonymous) add(selfProfile.pseudo, selfProfile.pseudoColor);
  connections.forEach(function(conn, pid) {
    if (pid === excludedPeerId || !conn) return;
    add(conn.pseudo, conn.pseudoColor);
  });
  return { colors: colors, animals: animals };
}

// Assign a "<Color> <Animal>" profile that avoids reusing a color or animal
// already present in the room. Keeps the requested trait when it is still free;
// otherwise picks a random unused one. When a category is exhausted (more peers
// than choices) it falls back to reuse — full-pseudo dedup catches collisions.
function assignUniqueAnonProfile(requestedPseudo, excludedPeerId) {
  var taken = collectTakenAnonTraits(excludedPeerId);
  var parts = String(requestedPseudo).trim().split(/\s+/);
  var reqColorName = parts[0].toLowerCase();
  var reqAnimal = parts[1];

  var color = ANON_COLOR_CHOICES.filter(function(c) { return c.name.toLowerCase() === reqColorName; })[0];
  if (!color || taken.colors.has(reqColorName)) {
    var freeColors = ANON_COLOR_CHOICES.filter(function(c) { return !taken.colors.has(c.name.toLowerCase()); });
    if (freeColors.length) color = freeColors[randomIndex(freeColors.length)];
    else if (!color) color = ANON_COLOR_CHOICES[randomIndex(ANON_COLOR_CHOICES.length)];
  }

  var animal = reqAnimal;
  var animalKnown = ANON_ANIMAL_CHOICES.some(function(a) { return a.toLowerCase() === reqAnimal.toLowerCase(); });
  if (!animalKnown || taken.animals.has(reqAnimal.toLowerCase())) {
    var freeAnimals = ANON_ANIMAL_CHOICES.filter(function(a) { return !taken.animals.has(a.toLowerCase()); });
    if (freeAnimals.length) animal = freeAnimals[randomIndex(freeAnimals.length)];
    else if (!animalKnown) animal = ANON_ANIMAL_CHOICES[randomIndex(ANON_ANIMAL_CHOICES.length)];
  }

  return { pseudo: color.name + ' ' + animal, pseudoColor: color.hex };
}

function canonicalizePeerProfile(peerId, requestedPseudo, requestedColor) {
  if (isAnonymousProfile(requestedPseudo, requestedColor)) {
    var anon = assignUniqueAnonProfile(requestedPseudo, peerId);
    // Defensive: if every color+animal combination is taken, dedup the full name.
    anon.pseudo = ensureUniquePseudoForRoom(anon.pseudo, peerId);
    return anon;
  }
  var basePseudo = String(requestedPseudo || '').trim() || 'Anonymous';
  var uniquePseudo = ensureUniquePseudoForRoom(basePseudo, peerId);
  var color = String(requestedColor || '').trim() || null;
  return { pseudo: uniquePseudo, pseudoColor: color };
}

function announcePseudoChange() {
  if (!inRoom || !peer) return;
  if (isHost) {
    var hostProfile = selfPseudoProfile();
    var uniqueHostPseudo = ensureUniquePseudoForRoom(hostProfile.pseudo, peer.id);
    if (uniqueHostPseudo !== hostProfile.pseudo) {
      if ((myPseudo || '').trim()) {
        showCopyToast('Name already used in this room. You were renamed to "' + uniqueHostPseudo + '".');
        if (_preRenameMyPseudo === null) _preRenameMyPseudo = (myPseudo || '').trim();
        setMyPseudo(uniqueHostPseudo, { silentAnnounce: true });
      } else {
        var anon = ensureAnonymousProfile();
        if (_preRenameAnonPseudo === null) _preRenameAnonPseudo = anon.pseudo;
        anon.pseudo = uniqueHostPseudo;
      }
      hostProfile = selfPseudoProfile();
    }
    connections.forEach(function(c) {
      if (c.data) c.data.send({
        type: 'peer-renamed',
        peerId: peer.id,
        pseudo: hostProfile.pseudo,
        pseudoColor: hostProfile.pseudoColor || null
      });
    });
    updatePeerList();
    return;
  }
  const hostConn = connections.get(roomCode);
  var profile = selfPseudoProfile();
  if (hostConn && hostConn.data) hostConn.data.send({
    type: 'pseudo',
    pseudo: profile.pseudo,
    pseudoColor: profile.pseudoColor || null
  });
}

function setMyPseudo(nextPseudo, options) {
  options = options || {};
  myPseudo = (nextPseudo || '').trim();
  sessionStorage.setItem(PSEUDO_SESSION_KEY, myPseudo);
  if (shouldPersistPseudoGlobally()) localStorage.setItem(PSEUDO_KEY, myPseudo);
  // A voluntary name change supersedes any room-forced rename.
  if (!options.silentAnnounce) _preRenameMyPseudo = null;
  const homeInput = $('input-pseudo');
  const settingsInput = $('input-pseudo-settings');
  const inviteInput = $('input-pseudo-invite');
  if (homeInput && homeInput.value !== myPseudo) homeInput.value = myPseudo;
  if (settingsInput && settingsInput.value !== myPseudo) settingsInput.value = myPseudo;
  if (inviteInput && inviteInput.value !== myPseudo) inviteInput.value = myPseudo;
  if (inRoom) {
    updatePeerList();
    if (!options.silentAnnounce) announcePseudoChange();
  }
  updateHomeLoggedOutLayout();
}

function updateHomeLoggedOutLayout() {
  var connected = !!presenceToken();
  var afterConnect = $('divider-after-connect');
  if (afterConnect) afterConnect.style.display = connected ? 'none' : '';
}

// Presence state
let presenceData     = []; // last fetched [{channel,connected}]
let activeChannel    = null; // channel name for the current presence session
let activeChannelRoomId = null; // associated room code/id for current presence session (if provided)
let presenceInterval = null;

function updateRoomHeader() {
  $('room-code-display').textContent = roomDisplayCode();
  var publishBtn   = $('btn-publish-room');
  var unpublishBtn = $('btn-unpublish-room');
  var shareBtn     = $('btn-share-room');
  if (!publishBtn || !unpublishBtn) return;
  var hasChannelNameCode = !!(activeChannel && !activeChannelRoomId);
  var hasExternallyManagedPublicId = !!(
    activeChannelRoomId &&
    roomCode &&
    activeChannelRoomId !== roomCode &&
    !_publishSecret
  );
  if (!isHost) {
    publishBtn.classList.add('hidden');
    unpublishBtn.classList.add('hidden');
  } else if (hasChannelNameCode) {
    publishBtn.classList.add('hidden');
    unpublishBtn.classList.add('hidden');
  } else if (hasExternallyManagedPublicId) {
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

// peerId -> { data, media, pseudo, talking, ...,
//   videoTopology?: {mode:'p2p'|'sfu', reason}, screenTopology?: {mode, reason} }
// videoTopology/screenTopology are set only for video/screen tracks — audio has
// no topology field and no SFU path, ever. See selectVideoTopology().
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

function sendDataIfOpen(dataConn, msg) {
  if (!dataConn || !dataConn.open || dataConn.closed) return false;
  dataConn.send(msg);
  return true;
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
    debugMode: isDevModeEnabled(),
    deputyId: successorIds[0] || null,
    successorIds: successorIds
  };
  connections.forEach(function(conn) {
    if (conn && conn.data) sendDataIfOpen(conn.data, msg);
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
  if (!hostConn || !hostConn.data) return;
  sendDataIfOpen(hostConn.data, { type: 'heartbeat', at: Date.now() });
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
    if (other && other.data) sendDataIfOpen(other.data, { type: 'peer-left', peerId: peerId });
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

function nativePTTJoin() {
  if (!PTT) return;
  // Name shown in the iOS system Push-to-Talk UI (Lock Screen / Dynamic Island).
  // Use the friendly channel name when joining a named channel, else "Voxal".
  var roomName = activeChannel ? String(activeChannel) : 'Voxal';
  PTT.join({ roomName: roomName }).catch(function(e) { console.warn('[PTT join]', e); });
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
  var prev = document.querySelector('.screen.active');
  if (prev && prev.id) _prevScreen = prev.id.replace(/^screen-/, '');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  if (name === 'home') {
    startPresencePolling();
    if (window._updateRejoinBar) window._updateRejoinBar();
    if (window._updateRecentRooms) window._updateRecentRooms();
  }
  else                 stopPresencePolling();
  if (window._updateTinyPeersToggle) window._updateTinyPeersToggle();
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

function shareInviteLink(url) {
  if (!url) return;
  if (!navigator.share) {
    copyTextToClipboard(url, 'Invite link copied!');
    return;
  }
  navigator.share({ title: 'Join my Voxal room', url: url }).catch(function(err) {
    // AbortError is a user-cancelled share sheet; keep silent and avoid clipboard side effects.
    if (err && err.name === 'AbortError') return;
    // Common iframe/embed permission failures should gracefully fall back to copy.
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      copyTextToClipboard(url, 'Invite link copied!');
      return;
    }
    console.warn('[Share]', err);
    copyTextToClipboard(url, 'Invite link copied!');
  });
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
  return activeChannelRoomId || activeChannel || _publishedRoomId || roomCode || '';
}

// Full-window URL for the "pop out" action in a tiny embed: same room, same
// display name, but without the embed params so it opens as a standalone app.
function tinyPopoutUrl() {
  var code = roomDisplayCode() || roomCode;
  if (!code) return '';
  var url = new URL(roomInviteBaseUrl());
  url.searchParams.set('room', code);
  // Join straight away in this browser window instead of prompting to open the
  // native app (the whole point of popping out is to stay on the web).
  url.searchParams.set('forceWeb', '1');
  var profile = selfPseudoProfile();
  var name = profile.pseudo;
  if (name && name !== 'You') {
    url.searchParams.set('name', name);
    // Carry the color of an auto-assigned name so the popped-out window keeps
    // the colored dot and stays detectable as an anonymous identity (see
    // applyPopoutIdentityFromUrl).
    if (profile.anonymous && profile.pseudoColor) url.searchParams.set('color', profile.pseudoColor);
  }
  return url.toString();
}

// Pop-out target reads ?name= (and optional ?color=) to continue under the same
// identity. On web the pseudo lives in sessionStorage, which a freshly opened
// window does not inherit, so it must ride the URL. Runs from bootstrap (after
// top-level init) so ANON_COLOR_CHOICES / isAnonymousProfile are available.
function applyPopoutIdentityFromUrl() {
  var name, color;
  try {
    var params = new URLSearchParams(window.location.search || '');
    name = (params.get('name') || '').trim();
    color = (params.get('color') || '').trim();
  } catch (_) { return; }
  if (!name) return;

  if (color && isAnonymousProfile(name, color)) {
    // Restore the auto-assigned identity: colored dot + "anonymous" detection.
    _anonymousProfile = { pseudo: name, pseudoColor: color };
    myPseudo = '';
    sessionStorage.removeItem(PSEUDO_SESSION_KEY);
    return;
  }
  myPseudo = name;
  sessionStorage.setItem(PSEUDO_SESSION_KEY, name);
  if (shouldPersistPseudoGlobally()) localStorage.setItem(PSEUDO_KEY, name);
}

// Detach the tiny embed into a standalone window: open the full app on the same
// room, then leave here (WebRTC sessions can't be transferred between windows).
function popOutTinyEmbed() {
  var url = tinyPopoutUrl();
  if (!url) return;
  var win = window.open(url, 'voxal-popout', 'width=440,height=680');
  if (!win) {
    // Blocked — e.g. an iframe sandbox without allow-popups. Keep the session.
    iframeEmit({ type: 'popout-blocked', url: url });
    showCopyToast('Pop-out blocked by the browser');
    return;
  }
  iframeEmit({ type: 'popout', url: url });
  if (inRoom) leaveRoom();
}

function roomIdFromPayload(obj) {
  if (!obj || typeof obj !== 'object') return '';
  var candidate = obj.room_id || obj.roomId || obj.room_code || obj.roomCode || '';
  if (candidate === null || candidate === undefined) return '';
  var text = String(candidate).trim();
  return text || '';
}

function associatedRoomIdFromPresenceItem(item) {
  if (!item) return '';
  var fromChannel = roomIdFromPayload(item.channel || {});
  if (fromChannel) return fromChannel;
  var connected = Array.isArray(item.connected) ? item.connected : [];
  for (var i = 0; i < connected.length; i++) {
    var candidate = roomIdFromPayload(connected[i] || {});
    if (candidate) return candidate;
  }
  return '';
}

// Filter for room ids we are willing to *adopt* as the room's display code.
// A presence session's room_id is meant to be a named, shareable code (a lobby
// slug or a channel's own room code). A bare peer id is not: presence backends
// echo the posted session row back, and clients used to post their PeerJS id as
// room_id, so adopting it turned a named channel into a UUID in the room header
// the moment the session registered — the room looked like a fresh anonymous
// one. The rest of the app already treats UUID-valued codes as unshareable
// (saveRejoinSnapshot, recordRecentRoom).
function publicAssociatedRoomId(candidate) {
  var id = String(candidate || '').trim();
  if (!id) return '';
  if (UUID_RE.test(id)) return '';
  if (peer && peer.id && id === peer.id) return '';
  if (roomCode && id === roomCode) return '';
  return id;
}

function associatedRoomIdFromSessionResponse(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return (
    roomIdFromPayload(payload) ||
    roomIdFromPayload(payload.session) ||
    roomIdFromPayload(payload.channel) ||
    roomIdFromPayload(payload.channel && payload.channel.channel) ||
    roomIdFromPayload(payload.presence) ||
    roomIdFromPayload(payload.data) ||
    ''
  );
}

function activePresenceItem() {
  if (!presenceConfigured() || !activeChannel) return null;
  var channelName = String(activeChannel).trim().toLowerCase();
  if (!channelName) return null;
  var roomId = normalizeRoomCode(activeChannelRoomId || '').toLowerCase();
  var fallback = null;
  var list = Array.isArray(presenceData) ? presenceData : [];

  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var channel = item.channel || {};
    var name = String(channel.name || '').trim().toLowerCase();
    if (!name || name !== channelName) continue;

    if (roomId) {
      var associatedRoomId = normalizeRoomCode(associatedRoomIdFromPresenceItem(item) || roomIdFromPayload(channel)).toLowerCase();
      if (associatedRoomId && associatedRoomId === roomId) return item;
    }

    if (!fallback) fallback = item;
  }

  return fallback;
}

function presenceDisplayNameForSelf() {
  var item = activePresenceItem();
  if (!item || !peer || !peer.id) return '';
  var selfPeerId = String(peer.id).trim();
  var connected = Array.isArray(item.connected) ? item.connected : [];
  for (var i = 0; i < connected.length; i++) {
    var entry = connected[i] || {};
    if (String(entry.peer_id || '').trim() !== selfPeerId) continue;
    return String(entry.display_name || '').trim();
  }
  return '';
}

function syncMyPseudoFromPresence() {
  var presenceName = presenceDisplayNameForSelf();
  if (!presenceName) return;
  if ((myPseudo || '').trim() !== presenceName) {
    setMyPseudo(presenceName, { silentAnnounce: true });
  }
}

function consumeRoomInviteFromQuery() {
  try {
    var current = new URL(window.location.href);
    var roomId = normalizeRoomCode(current.searchParams.get('room') || '');
    if (!roomId) return '';
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

// PeerJS reports an unreachable peer as a 'peer-unavailable' error whose message
// is "Could not connect to peer <id>". Extract that id (or null).
function unavailablePeerIdFromError(err) {
  var message = (err && (err.message || String(err))) || '';
  var m = message.match(/Could not connect to peer\s+([^\s]+)/i);
  return m ? m[1] : null;
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
    // Fast-fail a dead migration target. If the broker says the host we are
    // currently migrating to is unavailable, it is gone (not merely slow to
    // promote), so skip the connect-retry budget: exclude it and re-elect the
    // next successor immediately. This keeps host+deputy (or deeper) simultaneous
    // failure fast while still being patient with a deputy that is just slow.
    if (roomState === ROOM_STATE_MIGRATING && _migrationCandidateId) {
      var unreachableId = unavailablePeerIdFromError(err);
      if (unreachableId && unreachableId === _migrationCandidateId) {
        console.warn('[migration] Broker reports elected host ' +
          migrationPeerLabel(_migrationCandidateId) + ' unavailable; re-electing next successor.');
        initiateHostMigration(_migrationCandidateId);
      }
    }
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
  var joinPromise = !UUID_RE.test(roomId)
    ? joinOrCreateByChannelName(roomId)
    : joinRoom(roomId);
  joinPromise.catch(function(err) {
    if (err && err.message === 'Connection cancelled.') return;
    showError(err.message);
  });
}

// On web: try to open the native Voxal app first (voxal:// scheme).
// If the page goes hidden the app launched → cancel the web join.
// If 800 ms pass with the page still visible → fall back to browser join.
function _tryNativeAppThenJoin(roomId) {
  if (IS_TINY_EMBED || FORCE_WEB_JOIN) {
    startInviteRoomJoin(roomId);
    return;
  }
  showInviteLoading(roomId, 'Opening Voxal…');

  var appLaunched = false;
  var WAIT_MS = 2000;
  var timeout = null;
  var cleanedUp = false;

  function markNativeLaunch() {
    appLaunched = true;
    clearTimeout(timeout);
    cleanupSignals();
    // Native app took over — keep a web fallback CTA if the user comes back.
    showInviteLoading(roomId, 'Redirected to the desktop app.');
    setInviteLoadingSpinnerVisible(false);
    _inviteWebFallbackRoomId = roomId;
    setInviteLoadingCtaMode('join-web');
  }

  function cleanupSignals() {
    if (cleanedUp) return;
    cleanedUp = true;
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pagehide', onPageHide);
  }

  var onVis = function() {
    if (document.hidden) markNativeLaunch();
  };
  var onBlur = function() {
    // Some desktop/browser combinations don't toggle document.hidden
    // immediately when handing off to a custom URL scheme.
    markNativeLaunch();
  };
  var onPageHide = function() {
    markNativeLaunch();
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);

  // Trigger the custom scheme via a hidden link (avoids page-navigation errors)
  var a = document.createElement('a');
  a.href = 'voxal://join?room=' + encodeURIComponent(roomId);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  timeout = setTimeout(function() {
    cleanupSignals();
    if (appLaunched) return;
    // App not installed or didn't respond — join in the browser
    showInviteLoading(roomId, 'Connecting…');
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    joinRoom(roomId).catch(function(err) { showError(err.message); });
  }, WAIT_MS);
}

function showInviteLoading(roomLabel, statusText) {
  if (IS_TINY_EMBED) {
    roomLabel = '';
    statusText = 'Connecting …';
    var tinyScreen = $('screen-invite-loading');
    if (tinyScreen) tinyScreen.classList.add('tiny-connecting');
  }
  var roomCodeEl = $('invite-room-code');
  if (roomCodeEl) roomCodeEl.textContent = roomLabel || '';
  var statusEl = $('invite-join-status');
  if (statusEl) statusEl.textContent = statusText || 'Connecting…';
  setInviteLoadingSpinnerVisible(true);
  _inviteWebFallbackRoomId = '';
  setInviteLoadingCtaMode((!IS_TINY_EMBED && _prevScreen) ? 'back' : 'cancel');
  showScreen('invite-loading');
}

var _inviteWebFallbackRoomId = '';
function setInviteLoadingSpinnerVisible(visible) {
  var spinner = $('invite-spinner') || document.querySelector('.invite-spinner');
  if (!spinner) return;
  spinner.classList.toggle('hidden', !visible);
}

function setInviteLoadingCtaMode(mode) {
  var btn = $('btn-cancel-invite-join');
  if (!btn) return;
  btn.classList.toggle('hidden', false);
  if (mode === 'join-web') {
    btn.dataset.action = 'join-web';
    btn.textContent = 'Join on web';
    return;
  }
  if (mode === 'connect') {
    btn.dataset.action = 'connect';
    btn.textContent = 'Start';
    return;
  }
  btn.dataset.action = mode === 'cancel' ? 'cancel' : 'back';
  btn.textContent = mode === 'cancel' ? 'Cancel' : 'Back';
}

function setTinyInvitePeerCount(peerCount) {
  _invitePendingPeerCount = Number.isFinite(peerCount) ? peerCount : null;
  var peerEl = $('invite-peer-count');
  if (!peerEl) return;
  if (_invitePendingPeerCount === null) {
    peerEl.textContent = '';
    peerEl.classList.add('hidden');
    return;
  }
  peerEl.textContent = _invitePendingPeerCount + ' peer' + (_invitePendingPeerCount !== 1 ? 's' : '') + ' connected';
  peerEl.classList.remove('hidden');
}

function showTinyInviteConnect(roomId, peerCount) {
  var normalized = normalizeRoomCode(roomId);
  if (!normalized) return;
  _invitePendingRoomId = normalized;
  var tinyScreen = $('screen-invite-loading');
  if (tinyScreen) tinyScreen.classList.remove('tiny-connecting');
  var roomCodeEl = $('invite-room-code');
  if (roomCodeEl) roomCodeEl.textContent = '';
  var statusEl = $('invite-join-status');
  if (statusEl) statusEl.textContent = 'Tap Start to join this room.';
  setInviteLoadingSpinnerVisible(false);
  setTinyInvitePeerCount(Number.isFinite(peerCount) ? peerCount : null);
  setInviteLoadingCtaMode('connect');
  // Prefill a manual name; leave the field empty for an auto-assigned name so a
  // no-op interaction can't commit it as a manual pseudo (and drop its color).
  var invitePseudoEl = $('input-pseudo-invite');
  if (invitePseudoEl) {
    var _prof = selfPseudoProfile();
    invitePseudoEl.value = _prof.anonymous ? '' : (_prof.pseudo || '');
    invitePseudoEl.placeholder = 'Your Name';
  }
  showScreen('invite-loading');
  lookupRoomInfo(normalized).then(function(info) {
    if (!_invitePendingRoomId || _invitePendingRoomId !== normalized || !info) return;
    // Don't replace a named code with its UUID — stale-host recovery in
    // joinOrCreateByChannelName needs the original slug.
    if (Number.isFinite(info.peerCount)) setTinyInvitePeerCount(info.peerCount);
  }).catch(function() {});
}

function syncTinyPeerLabelCrowding(othersWrap) {
  if (!othersWrap) return;
  var items = othersWrap.querySelectorAll('.peer-item-compact');
  var crowded = items.length > 4;
  if (!crowded && othersWrap.scrollWidth > othersWrap.clientWidth) crowded = true;
  othersWrap.classList.toggle('crowded', crowded);
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
  if (IS_TINY_EMBED) return false;
  return localStorage.getItem(DEV_MODE_KEY) === 'true';
}

// Device-info sharing is opt-in with explicit consent: nothing is transmitted
// until the user accepts. Consent is global (managed in Settings → Advanced):
// 'accepted' | 'declined' | 'unset'. ('true'/'false' are migrated from the old
// opt-out preference.)
function deviceInfoConsent() {
  var v = localStorage.getItem(DEBUG_INFO_SHARE_KEY);
  if (v === 'accepted' || v === 'true') return 'accepted';
  if (v === 'declined' || v === 'false') return 'declined';
  return 'unset';
}

function setDeviceInfoConsent(state) {
  localStorage.setItem(DEBUG_INFO_SHARE_KEY, state === 'accepted' ? 'accepted' : 'declined');
}

function isDeviceInfoSharingEnabled() {
  return deviceInfoConsent() === 'accepted';
}

// The "i" device-info button is shown only when local dev mode is on AND either
// we are the host (the debugger) or the host itself advertised debug mode — so
// the feature is active "only if the host is in debug mode".
function deviceInfoButtonVisible() {
  if (IS_TINY_EMBED) return false;
  if (!isDevModeEnabled()) return false;
  return isHost || _hostDebugMode;
}

// Show the consent warning to a participant when the host has debug mode on and
// they haven't decided yet. Nothing is shared while the choice is 'unset'.
function updateDebugConsentBanner() {
  var el = document.getElementById('debug-consent-banner');
  if (!el) return;
  var show = !IS_TINY_EMBED && inRoom && !isHost && _hostDebugMode && deviceInfoConsent() === 'unset';
  el.classList.toggle('hidden', !show);
}

// Reflect the current consent in the Settings → Advanced toggles (if present).
function syncDeviceShareToggles() {
  var on = isDeviceInfoSharingEnabled();
  var btn = document.getElementById('toggle-debug-share-modal');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'ON' : 'OFF';
  }
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
  // Prefer activeChannel (presence), then activeChannelRoomId, then _publishedRoomId —
  // whichever is a non-UUID named code worth re-resolving on rejoin.
  var channelName = activeChannel
    || (activeChannelRoomId && !UUID_RE.test(activeChannelRoomId) ? activeChannelRoomId : null)
    || (_publishedRoomId   && !UUID_RE.test(_publishedRoomId)     ? _publishedRoomId   : null)
    || null;
  var snapshot = {
    hostId:      roomCode,
    deputyId:    currentDeputyId() || null,
    peerIds:     peerIds,
    wasHost:     isHost,
    channelName: channelName,
    savedAt:     Date.now()
  };
  localStorage.setItem(REJOIN_SNAPSHOT_KEY, JSON.stringify(snapshot));
  // Track the named anonymous room code (not presence channel names — those
  // already live in the Channels panel).
  var anonCode = (activeChannelRoomId && !UUID_RE.test(activeChannelRoomId) ? activeChannelRoomId : null)
    || (_publishedRoomId && !UUID_RE.test(_publishedRoomId) ? _publishedRoomId : null);
  if (anonCode && !activeChannel) recordRecentRoom(anonCode);
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

// --- Recent rooms ---------------------------------------------------------
// Last few *named* anonymous room codes joined, newest first, for one-tap
// rejoin from the home screen. UUID codes are excluded — they are PeerJS peer
// IDs that die with the host's session, so they can't be re-resolved later.

function loadRecentRooms() {
  try {
    var list = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(function(c) { return typeof c === 'string' && c && !UUID_RE.test(c); });
  } catch (_) { return []; }
}

function recordRecentRoom(code) {
  code = String(code || '').trim();
  if (!code || UUID_RE.test(code)) return;
  var list = loadRecentRooms().filter(function(c) { return c !== code; });
  list.unshift(code);
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list.slice(0, RECENT_ROOMS_MAX)));
  if (window._updateRecentRooms) window._updateRecentRooms();
}

function removeRecentRoom(code) {
  var list = loadRecentRooms().filter(function(c) { return c !== code; });
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list));
  if (window._updateRecentRooms) window._updateRecentRooms();
}

// --- Audio quality tuning ----------------------------------------------------
//
// Voxal is a push-to-talk walkie-talkie over a full audio mesh, so a speaker
// uploads one Opus stream per listener and anonymous rooms have no org TURN —
// they fall back to a shared, rate-limited public relay. Both make the outgoing
// stream the fragile part, and untuned WebRTC defaults turn a lossy uplink into
// chopped ("robotic") audio on the *listener's* side. Three knobs fix that:
//
//   1. Opus fmtp: in-band FEC on, DTX off, mono, capped bitrate (below).
//   2. Sender: an explicit bitrate cap + high network priority (DSCP), so one
//      speaker's N uploads don't congest each other.
//   3. Receiver: a jitter-buffer floor via `playoutDelayHint`. Chromium's
//      default target delay is tiny; a few tens of ms of jitter then produce
//      audible chopping. Trading ~80 ms of latency for smoothness is the right
//      call for PTT, and lossy/relayed links get a bigger buffer still.

// Speech at 16 kHz mono is transparent well under this; the cap matters because
// the mesh multiplies it by the number of listeners.
const OPUS_MAX_BITRATE = 32000;

// Jitter-buffer targets (seconds). Base applies to every link; poor kicks in on
// measurable loss/jitter or a relayed path.
const AUDIO_PLAYOUT_DELAY_BASE = 0.08;
const AUDIO_PLAYOUT_DELAY_POOR = 0.20;
const AUDIO_POOR_LOSS_PERCENT  = 3;
const AUDIO_POOR_JITTER_MS     = 30;

// Opus parameters we force into every audio offer/answer. `useinbandfec=1`
// lets the decoder reconstruct isolated lost packets instead of dropping them;
// `usedtx=0` keeps packets flowing while PTT is released (the mic track is
// disabled, not removed) so the receiver's jitter buffer stays warm and the
// first word after a press isn't clipped.
const OPUS_FMTP_PARAMS = {
  stereo: '0',
  'sprop-stereo': '0',
  useinbandfec: '1',
  usedtx: '0',
  maxaveragebitrate: String(OPUS_MAX_BITRATE)
};

// PeerJS `sdpTransform` hook — rewrites (or adds) the Opus fmtp line.
function opusSdpTransform(sdp) {
  if (typeof sdp !== 'string' || !sdp) return sdp;
  try {
    var rtpmap = /^a=rtpmap:(\d+)[ \t]+opus\/48000[^\r\n]*/im.exec(sdp);
    if (!rtpmap) return sdp;
    var pt = rtpmap[1];
    var fmtpRe = new RegExp('^a=fmtp:' + pt + '[ \\t]+([^\\r\\n]*)', 'im');
    var existing = fmtpRe.exec(sdp);

    var params = {};
    if (existing) {
      existing[1].split(';').forEach(function(kv) {
        var eq = kv.indexOf('=');
        if (eq > 0) params[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
        else if (kv.trim()) params[kv.trim()] = null;
      });
    }
    Object.keys(OPUS_FMTP_PARAMS).forEach(function(k) { params[k] = OPUS_FMTP_PARAMS[k]; });

    var line = 'a=fmtp:' + pt + ' ' + Object.keys(params).map(function(k) {
      return params[k] === null ? k : k + '=' + params[k];
    }).join(';');

    return existing ? sdp.replace(fmtpRe, line) : sdp.replace(rtpmap[0], rtpmap[0] + '\r\n' + line);
  } catch (_) {
    return sdp; // never break call setup over a tuning nicety
  }
}

// Options passed to every audio `peer.call()` / `call.answer()`.
function audioCallOptions() {
  return { sdpTransform: opusSdpTransform };
}

// The two MediaConnections that can carry audio for a peer: the one we answered
// (`media`) and the one we opened (`audioMediaOut`).
function audioPeerConnections(conn) {
  if (!conn) return [];
  return [conn.media, conn.audioMediaOut]
    .filter(function(mc) { return mc && !mc.closed && mc.peerConnection; })
    .map(function(mc) { return mc.peerConnection; });
}

// The video/screen equivalents of audioPeerConnections(). Each of the three
// media kinds has its own independent MediaConnection set (see the topology note
// in CLAUDE.md), so which set a peer connection belongs to is what attributes
// its bytes to a kind. The SFU subscription shim exposes `.peerConnection` too,
// so one accessor covers both the mesh and the relay.
function videoPeerConnections(conn) {
  if (!conn) return [];
  return [conn.videoMedia, conn.videoMediaOut]
    .filter(function(mc) { return mc && !mc.closed && mc.peerConnection; })
    .map(function(mc) { return mc.peerConnection; });
}

function screenPeerConnections(conn) {
  if (!conn) return [];
  return [conn.screenMedia, conn.screenMediaOut]
    .filter(function(mc) { return mc && !mc.closed && mc.peerConnection; })
    .map(function(mc) { return mc.peerConnection; });
}

function tuneAudioSenders(pc) {
  if (!pc || typeof pc.getSenders !== 'function') return;
  pc.getSenders().forEach(function(sender) {
    if (!sender.track || sender.track.kind !== 'audio') return;
    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    try {
      var params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      var enc = params.encodings[0];
      if (enc.maxBitrate === OPUS_MAX_BITRATE && enc.networkPriority === 'high') return; // already tuned
      enc.maxBitrate = OPUS_MAX_BITRATE;
      enc.networkPriority = 'high';
      enc.priority = 'high';
      var res = sender.setParameters(params);
      if (res && typeof res.catch === 'function') res.catch(function() {});
    } catch (_) {}
  });
}

// Video senders got none of the tuning audio senders get, which mattered less
// while only one remote camera could be on screen at a time. A tile grid makes
// every stream live at once, and a sharer uploads one encode PER PEER, so the
// uplink is the ceiling — hence a bitrate cap plus a resolution scale that grows
// with the room.
var CAMERA_MAX_BITRATE = 600000;    // ~600 kbps per listener
var CAMERA_MAX_BITRATE_MOBILE = 300000;
var CAMERA_MAX_BITRATE_FRUGAL = 150000;  // save-data, or a 2g/3g link
var SCREEN_MAX_BITRATE = 1500000;   // screens need more; text must stay legible

// A phone uploads one encode per listener over a metered link, so it gets a
// tighter ceiling than a desktop, tighter still when the connection says so.
//
// `navigator.connection` is Chromium-only — WebKit (every iOS browser, and
// Safari) has no Network Information API at all. Its ABSENCE must therefore
// fall through to the plain mobile cap, never to the desktop one.
function cameraMaxBitrate() {
  if (!IS_MOBILE_DEVICE) return CAMERA_MAX_BITRATE;
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    if (conn.saveData) return CAMERA_MAX_BITRATE_FRUGAL;
    var effective = String(conn.effectiveType || '');
    if (effective === 'slow-2g' || effective === '2g' || effective === '3g') {
      return CAMERA_MAX_BITRATE_FRUGAL;
    }
  }
  return CAMERA_MAX_BITRATE_MOBILE;
}

function videoScaleForPeerCount(count) {
  if (count <= 2) return 1;
  if (count <= 4) return 1.5;
  return 2;
}

function tuneVideoSenders(pc, kind) {
  if (!pc || typeof pc.getSenders !== 'function') return;
  var isScreen = kind === 'screen';
  // Computed once, so the "already tuned" comparison below stays stable across
  // the senders of one call even if the network readings shift mid-loop.
  var maxBitrate = isScreen ? SCREEN_MAX_BITRATE : cameraMaxBitrate();
  // A screen share must keep its resolution — dropping it to save frames makes
  // text unreadable, which defeats the point of sharing a screen at all.
  var degradation = isScreen ? 'maintain-resolution' : 'balanced';
  var scale = isScreen ? 1 : videoScaleForPeerCount(connections.size + 1);

  pc.getSenders().forEach(function(sender) {
    if (!sender.track || sender.track.kind !== 'video') return;
    try { sender.track.contentHint = isScreen ? 'detail' : 'motion'; } catch (_) {}
    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    try {
      var params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      var enc = params.encodings[0];
      if (enc.maxBitrate === maxBitrate &&
          enc.scaleResolutionDownBy === scale &&
          params.degradationPreference === degradation) return;  // already tuned
      enc.maxBitrate = maxBitrate;
      if (scale > 1) enc.scaleResolutionDownBy = scale;
      else delete enc.scaleResolutionDownBy;
      params.degradationPreference = degradation;
      var res = sender.setParameters(params);
      if (res && typeof res.catch === 'function') res.catch(function() {});
    } catch (_) {}
  });
}

// PeerJS creates the RTCPeerConnection asynchronously, so the senders may not
// exist yet at call time. Tune on the next tick and again once negotiated.
function tuneVideoCall(call, kind) {
  if (!call) return;
  var apply = function() {
    if (call.peerConnection) tuneVideoSenders(call.peerConnection, kind);
  };
  setTimeout(apply, 0);
  call.on('stream', apply);
}

// --- Video/screen topology selection (P2P mesh vs Cloudflare SFU) ------------
//
// Applies ONLY to camera/screen-share tracks — audio is never passed through
// this function and is never routed through an SFU, under any preference. See
// docs/video-routing.md for the full privacy rationale.
//
// selectVideoTopology() is a pure function: no fetch, no DOM, no state
// mutation. Its single most important property, unit-tested explicitly, is
// that it can only ever return mode:'sfu' when preference === 'allow-sfu' — a
// 'prefer-p2p' user is never silently moved onto an SFU; a degraded mesh under
// that preference is reported back as a p2p decision with a reason the caller
// turns into an explicit "allow relay?" prompt instead.
var VIDEO_TOPOLOGY_REASON = {
  OK: 'ok',
  SFU_UNAVAILABLE: 'sfu-unavailable',
  P2P_FAILED_TEMPORARY: 'p2p-failed-temporary',
  P2P_UNSUITABLE: 'p2p-unsuitable',
  PREFERENCE_P2P_ONLY: 'preference-p2p-only',
  PREFERENCE_ALLOW_SFU: 'preference-allow-sfu'
};

// Video/screen is far heavier per participant than audio, so it gets its own,
// much lower capacity threshold than ROOM_SOFT_WARN_PEERS (main.js:5729, the
// audio-only room-size warning) — deliberately decoupled, not reused. Tuned
// down from an earlier reuse of ROOM_SOFT_WARN_PEERS (8) after testing showed
// that bar was too high: an 8-peer room with a camera on still read "Direct".
var VIDEO_SFU_THRESHOLD_PEERS = 2; // "overCapacity" once participantCount > this

/**
 * @param {'video'|'screen'} kind
 * @param {{preference?: string, participantCount?: number, meshHealthy?: boolean, sfuConfigured?: boolean}} opts
 * @returns {{mode: 'p2p'|'sfu', reason: string}}
 */
function selectVideoTopology(kind, opts) {
  opts = opts || {};
  var preference = opts.preference || VIDEO_ROUTING_DEFAULT;
  var participantCount = opts.participantCount || 0;
  var meshHealthy = opts.meshHealthy !== false;
  var sfuConfigured = !!opts.sfuConfigured;
  var overCapacity = participantCount > VIDEO_SFU_THRESHOLD_PEERS;

  if (preference === 'p2p-only') {
    // Never returns 'sfu' for this preference, full stop — regardless of
    // participant count or whether an SFU is configured.
    return { mode: 'p2p', reason: meshHealthy ? VIDEO_TOPOLOGY_REASON.OK : VIDEO_TOPOLOGY_REASON.P2P_FAILED_TEMPORARY };
  }
  if (!sfuConfigured) {
    // Even 'allow-sfu' can't use a backend that isn't configured/reachable.
    return { mode: 'p2p', reason: meshHealthy ? VIDEO_TOPOLOGY_REASON.OK : VIDEO_TOPOLOGY_REASON.SFU_UNAVAILABLE };
  }
  if (preference === 'prefer-p2p') {
    if (!overCapacity && meshHealthy) return { mode: 'p2p', reason: VIDEO_TOPOLOGY_REASON.OK };
    return {
      mode: 'p2p',
      reason: overCapacity ? VIDEO_TOPOLOGY_REASON.P2P_UNSUITABLE : VIDEO_TOPOLOGY_REASON.P2P_FAILED_TEMPORARY
    };
  }
  // preference === 'allow-sfu': still prefers P2P when it looks viable.
  if (!overCapacity && meshHealthy) return { mode: 'p2p', reason: VIDEO_TOPOLOGY_REASON.OK };
  return { mode: 'sfu', reason: VIDEO_TOPOLOGY_REASON.PREFERENCE_ALLOW_SFU };
}

function tuneAudioReceivers(pc, delaySeconds) {
  if (!pc || typeof pc.getReceivers !== 'function') return;
  pc.getReceivers().forEach(function(receiver) {
    if (!receiver.track || receiver.track.kind !== 'audio') return;
    // Chromium-only; absent on WebKit (Safari, Tauri's WKWebView) — skip there.
    if (!('playoutDelayHint' in receiver)) return;
    try { receiver.playoutDelayHint = delaySeconds; } catch (_) {}
  });
}

// A relayed path is the anonymous-room default (shared public TURN), so treat it
// as poor up front rather than waiting for loss to show up. This is the
// *adaptive* value; `effectivePlayoutDelay` layers the manual overrides on top.
function audioPlayoutDelayFor(stats) {
  if (!stats) return AUDIO_PLAYOUT_DELAY_BASE;
  var poor = stats.iceType === 'relay'
    || (typeof stats.lossPercent === 'number' && stats.lossPercent >= AUDIO_POOR_LOSS_PERCENT)
    || (typeof stats.outLossPercent === 'number' && stats.outLossPercent >= AUDIO_POOR_LOSS_PERCENT)
    || (typeof stats.jitterMs === 'number' && stats.jitterMs >= AUDIO_POOR_JITTER_MS);
  return poor ? AUDIO_PLAYOUT_DELAY_POOR : AUDIO_PLAYOUT_DELAY_BASE;
}

// --- Jitter buffer override (Settings → Advanced, + host push in dev mode) ---
//
// `playoutDelayHint` is a RECEIVER-side knob: it changes how much audio *we*
// buffer before playing what a peer sends. So a host wanting to smooth out a
// choppy room has to have the *listeners* widen their buffers — which is why the
// host can push a room-wide value (below) rather than only setting its own.

const JITTER_BUFFER_MAX_MS = 500;

// { mode: 'auto' | 'manual', ms: number }. Anything unparseable reads as auto,
// so a corrupt value can never wedge audio at a silly buffer size.
function jitterBufferSetting() {
  var raw = localStorage.getItem(JITTER_BUFFER_KEY);
  if (raw === null || raw === 'auto') return { mode: 'auto', ms: 0 };
  var ms = parseInt(raw, 10);
  if (!isFinite(ms) || ms < 0) return { mode: 'auto', ms: 0 };
  return { mode: 'manual', ms: Math.min(ms, JITTER_BUFFER_MAX_MS) };
}

function setJitterBufferSetting(mode, ms) {
  if (mode !== 'manual') { localStorage.removeItem(JITTER_BUFFER_KEY); }
  else {
    var n = Math.max(0, Math.min(parseInt(ms, 10) || 0, JITTER_BUFFER_MAX_MS));
    localStorage.setItem(JITTER_BUFFER_KEY, String(n));
  }
  reapplyAudioTuningToAllPeers();
}

// The host's room-wide value, mirrored from peer-list/heartbeat. Only set while
// the host has dev mode on; `null` means "no override in effect".
var _hostJitterMs = null;

// Treat it as untrusted input like every other host-supplied field: a peer drives
// this channel, so clamp before it reaches a live PeerConnection.
function sanitizeJitterMs(value) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, Math.min(Math.round(value), JITTER_BUFFER_MAX_MS));
}

// The value this host wants every listener in the room to use, or null. Gated on
// dev mode so a stale manual setting can't quietly govern other people's audio.
function hostJitterBroadcastMs() {
  if (!isHost || !isDevModeEnabled()) return null;
  var setting = jitterBufferSetting();
  return setting.mode === 'manual' ? setting.ms : null;
}

// Precedence: an explicit local choice wins, then the host's room-wide push,
// then the adaptive value. Local-first keeps the host from silently overriding
// someone who deliberately set their own buffer.
function effectivePlayoutDelay(stats) {
  var local = jitterBufferSetting();
  if (local.mode === 'manual') return local.ms / 1000;
  if (!isHost && typeof _hostJitterMs === 'number') return _hostJitterMs / 1000;
  return audioPlayoutDelayFor(stats);
}

// Which source is deciding the buffer right now — shown in the stats popover so
// "is my override actually applied?" is answerable.
function playoutDelaySource() {
  if (jitterBufferSetting().mode === 'manual') return 'manual';
  if (!isHost && typeof _hostJitterMs === 'number') return 'host';
  return 'auto';
}

// Idempotent — safe to call on every stats tick and whenever a stream arrives.
function applyAudioTuning(conn, delaySeconds) {
  var delay = typeof delaySeconds === 'number'
    ? delaySeconds
    : effectivePlayoutDelay(conn && conn.webrtcStats);
  audioPeerConnections(conn).forEach(function(pc) {
    tuneAudioSenders(pc);
    tuneAudioReceivers(pc, delay);
  });
}

function applyAudioTuningToPeer(peerId) {
  applyAudioTuning(connections.get(peerId));
}

// Push the current buffer choice to every live link at once — used when the
// setting changes locally and when the host's pushed value arrives.
function reapplyAudioTuningToAllPeers() {
  connections.forEach(function(conn) { applyAudioTuning(conn); });
  if (typeof _refreshOpenStatsPopover === 'function') _refreshOpenStatsPopover();
}

// --- WebRTC stats helpers ----------------------------------------------------

function _round1(n) { return Math.round(n * 10) / 10; }

// How many 5s samples of loss history to keep per peer (~5 minutes). A single
// percentage from the last window hides brief dropouts entirely, which is what
// made "it cut out for a second" impossible to confirm.
const LOSS_HISTORY_MAX = 60;

function _pushLossHistory(prevHistory, value) {
  var history = (prevHistory || []).slice();
  history.push(typeof value === 'number' ? value : 0);
  if (history.length > LOSS_HISTORY_MAX) history = history.slice(history.length - LOSS_HISTORY_MAX);
  return history;
}

async function _collectPeerStats(peerId, conn) {
  var pcs = audioPeerConnections(conn);
  if (!pcs.length) return;
  try {
    var stats = {};
    // Deltas are computed against the previous tick, so raw counters are summed
    // across every audio link to this peer (a mesh peer can have two).
    var inRaw  = { packetsLost: 0, packetsReceived: 0 };
    var outRaw = { packetsLost: 0, packetsSent: 0 };
    var rtts = [], jitters = [], iceTypes = [];

    for (var i = 0; i < pcs.length; i++) {
      var reports = await pcs[i].getStats();
      var selectedPairId = null;
      var pairs = {};
      var localCandidates = {};

      reports.forEach(function(report) {
        if (report.type === 'candidate-pair' && report.nominated) {
          pairs[report.id] = report;
          if (!selectedPairId || report.state === 'succeeded') selectedPairId = report.id;
        }
        if (report.type === 'local-candidate') localCandidates[report.id] = report;

        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          inRaw.packetsLost     += report.packetsLost || 0;
          inRaw.packetsReceived += report.packetsReceived || 0;
          if (typeof report.jitter === 'number') jitters.push(report.jitter * 1000);
        }
        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
          outRaw.packetsSent += report.packetsSent || 0;
        }
        // What the remote peer reports about the stream *we* send it. Without
        // this there is no way to see "they can't hear me" from our own side —
        // inbound-rtp only ever describes the direction we receive.
        if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
          outRaw.packetsLost += report.packetsLost || 0;
          if (typeof report.roundTripTime === 'number') rtts.push(report.roundTripTime * 1000);
        }
      });

      var pair = selectedPairId ? pairs[selectedPairId] : null;
      if (pair) {
        if (typeof pair.currentRoundTripTime === 'number') rtts.push(pair.currentRoundTripTime * 1000);
        var localCand = localCandidates[pair.localCandidateId];
        if (localCand && localCand.candidateType) iceTypes.push(localCand.candidateType);
      }
    }

    // Report the worst link to this peer — that is the one degrading the call.
    if (iceTypes.length) {
      stats.iceType = iceTypes.indexOf('relay') !== -1 ? 'relay'
        : iceTypes.indexOf('srflx') !== -1 ? 'srflx'
        : iceTypes[0]; // 'host', 'prflx', …
    }
    if (rtts.length)    stats.rttMs    = Math.round(Math.max.apply(null, rtts));
    if (jitters.length) stats.jitterMs = Math.round(Math.max.apply(null, jitters));

    var prev = conn.webrtcStats || {};

    var prevIn   = prev._inboundRaw || {};
    var lostDelta = Math.max(0, inRaw.packetsLost - (prevIn.packetsLost || 0));
    var recvDelta = Math.max(0, inRaw.packetsReceived - (prevIn.packetsReceived || 0));
    if (recvDelta + lostDelta > 0) {
      stats.lossPercent = _round1((lostDelta / (recvDelta + lostDelta)) * 100);
    } else if (typeof prev.lossPercent === 'number') {
      stats.lossPercent = prev.lossPercent; // carry forward
    }
    stats._inboundRaw = inRaw;

    var prevOut   = prev._outboundRaw || {};
    var outLostDelta = Math.max(0, outRaw.packetsLost - (prevOut.packetsLost || 0));
    var outSentDelta = Math.max(0, outRaw.packetsSent - (prevOut.packetsSent || 0));
    if (outSentDelta > 0) {
      stats.outLossPercent = _round1(Math.min(100, (outLostDelta / outSentDelta) * 100));
    } else if (typeof prev.outLossPercent === 'number') {
      stats.outLossPercent = prev.outLossPercent; // carry forward
    }
    stats._outboundRaw = outRaw;

    // Cumulative totals + peaks + a rolling window, so a brief dropout is still
    // visible minutes later instead of being averaged away by the next sample.
    stats.packetsLostTotal     = inRaw.packetsLost;
    stats.packetsReceivedTotal = inRaw.packetsReceived;
    stats.outPacketsLostTotal  = outRaw.packetsLost;
    stats.outPacketsSentTotal  = outRaw.packetsSent;
    stats.peakLossPercent = Math.max(prev.peakLossPercent || 0, stats.lossPercent || 0);
    stats.peakOutLossPercent = Math.max(prev.peakOutLossPercent || 0, stats.outLossPercent || 0);
    stats.lossHistory    = _pushLossHistory(prev.lossHistory, stats.lossPercent);
    stats.outLossHistory = _pushLossHistory(prev.outLossHistory, stats.outLossPercent);

    // The buffer actually in force on this link, for the popover readout.
    stats.playoutDelayMs = Math.round(effectivePlayoutDelay(stats) * 1000);
    stats.playoutDelaySource = playoutDelaySource();

    conn.webrtcStats = stats;

    // Re-apply tuning with the freshly measured quality — this is what widens
    // the jitter buffer once a link turns out to be lossy or relayed.
    applyAudioTuning(conn, effectivePlayoutDelay(stats));
  } catch (_) {}
}

// --- Network usage sampling --------------------------------------------------
//
// Bytes actually moved on the wire, split by media kind and direction, sampled
// on the same 5s tick as the loss stats. Surfaced in Settings → Advanced; the
// point of the breakdown is that switching camera/screen onto the SFU should
// show up as a visible step down in upload while audio stays flat.

// NET_USAGE_KINDS / NET_USAGE_HISTORY_MAX / formatBitrate / netUsageTotals come
// from net-usage.js, a plain classic script both this window and settings.html
// load — the rendering has to be identical in both and hand-duplicating it is
// how settings.html's constants drifted from main.js before.

// Byte counters are cumulative PER PEER CONNECTION. Summing the whole set and
// diffing that total would spike when a peer joins (their lifetime bytes land in
// one tick) and go negative when one leaves. Comparing each pc only against its
// own previous reading is immune to both, and a departed pc simply stops
// contributing. WeakMap so a closed pc is collectable.
var _pcByteCursors = new WeakMap();
var _bandwidthHistory = [];
var _bandwidthCurrent = null;

function _emptyBandwidthSample(at) {
  return {
    at: at,
    in:  { audio: 0, camera: 0, screen: 0 },
    out: { audio: 0, camera: 0, screen: 0 }
  };
}

// Bits/second moved by one peer connection since its previous reading, or null
// when there is no baseline yet — counting a pc's lifetime total as a single
// tick's worth would render as an enormous false spike the first time it is seen.
async function _pcByteDelta(pc, now) {
  if (!pc || typeof pc.getStats !== 'function') return null;
  var sent = 0, received = 0, found = false;
  try {
    var reports = await pc.getStats();
    reports.forEach(function(report) {
      // Transport level, not per-track: this includes RTP, RTCP, STUN and DTLS
      // overhead, which is what "network usage" means to someone watching a
      // data plan. Each pc carries exactly one kind, so nothing is lost by not
      // reading the individual rtp reports.
      if (report.type !== 'candidate-pair' || !report.nominated) return;
      if (report.state && report.state !== 'succeeded') return;
      sent     += report.bytesSent || 0;
      received += report.bytesReceived || 0;
      found = true;
    });
  } catch (_) { return null; }
  if (!found) return null;

  var prev = _pcByteCursors.get(pc);
  _pcByteCursors.set(pc, { sent: sent, received: received, at: now });
  if (!prev) return null;
  var elapsedSec = (now - prev.at) / 1000;
  if (elapsedSec <= 0) return null;
  return {
    inBits:  Math.max(0, received - prev.received) * 8 / elapsedSec,
    outBits: Math.max(0, sent - prev.sent) * 8 / elapsedSec
  };
}

async function _collectBandwidthSample() {
  var now = Date.now();
  var sample = _emptyBandwidthSample(now);
  var pending = [];

  function measure(pc, kind) {
    pending.push(_pcByteDelta(pc, now).then(function(delta) {
      if (!delta) return;
      sample.in[kind]  += delta.inBits;
      sample.out[kind] += delta.outBits;
    }));
  }

  connections.forEach(function(conn) {
    audioPeerConnections(conn).forEach(function(pc) { measure(pc, 'audio'); });
    videoPeerConnections(conn).forEach(function(pc) { measure(pc, 'camera'); });
    screenPeerConnections(conn).forEach(function(pc) { measure(pc, 'screen'); });
  });
  // Our own SFU publish legs belong to no peer — one per kind, not per peer,
  // which is the whole point of routing through a relay.
  if (_sfuPublishSessions.video && _sfuPublishSessions.video.pc) measure(_sfuPublishSessions.video.pc, 'camera');
  if (_sfuPublishSessions.screen && _sfuPublishSessions.screen.pc) measure(_sfuPublishSessions.screen.pc, 'screen');

  await Promise.all(pending);

  NET_USAGE_KINDS.forEach(function(kind) {
    sample.in[kind]  = Math.round(sample.in[kind]);
    sample.out[kind] = Math.round(sample.out[kind]);
  });

  _bandwidthCurrent = sample;
  _bandwidthHistory.push(sample);
  if (_bandwidthHistory.length > NET_USAGE_HISTORY_MAX) {
    _bandwidthHistory = _bandwidthHistory.slice(_bandwidthHistory.length - NET_USAGE_HISTORY_MAX);
  }
  publishNetworkUsage();
  renderNetUsagePanel();
  return sample;
}

function networkUsageSnapshot() {
  return {
    inRoom: !!inRoom,
    current: _bandwidthCurrent,
    history: _bandwidthHistory.slice(),
    at: Date.now()
  };
}

function resetBandwidthHistory() {
  _bandwidthHistory = [];
  _bandwidthCurrent = null;
  _pcByteCursors = new WeakMap();
}

// The in-page settings modal (web / mobile) reads the snapshot straight from
// here — no bridge needed, this window owns the data. settings.html receives the
// same shape over localStorage and renders it with the same net-usage.js
// helpers, so the two surfaces cannot drift.
var _netUsageExpanded = false;

function renderNetUsagePanel() {
  var inEl = document.getElementById('net-usage-in');
  if (!inEl) return; // this surface has no usage panel
  var snapshot = networkUsageSnapshot();
  renderNetUsageSummary(inEl, document.getElementById('net-usage-out'), snapshot);
  if (_netUsageExpanded) renderNetUsageDetail(document.getElementById('net-usage-detail'), snapshot);
}

function setNetUsageExpanded(expanded) {
  _netUsageExpanded = !!expanded;
  var detail = document.getElementById('net-usage-detail');
  var summary = document.getElementById('net-usage-summary');
  if (detail) detail.classList.toggle('hidden', !_netUsageExpanded);
  if (summary) summary.setAttribute('aria-expanded', String(_netUsageExpanded));
  renderNetUsagePanel();
}

function startStatsPolling() {
  stopStatsPolling();
  _statsIntervalId = setInterval(function() {
    if (!inRoom) { stopStatsPolling(); return; }
    connections.forEach(function(conn, peerId) { _collectPeerStats(peerId, conn); });
    // Recorded continuously, not only while the usage panel is open, so the
    // 10-minute graph is already populated the moment someone opens it.
    _collectBandwidthSample();
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

// The three ICE classes are plain `background` rules, so they compose onto any
// round element — the roster dot and the video-tile dot share them.
function iceDotClass(iceType) {
  return { host: 'peer-dot-direct', srflx: 'peer-dot-stun', relay: 'peer-dot-relay' }[iceType] || '';
}

function _setDotIceClass(dot, iceType) {
  if (!dot) return;
  ICE_DOT_CLASSES.forEach(function(c) { dot.classList.remove(c); });
  var cls = iceDotClass(iceType);
  if (cls) dot.classList.add(cls);
}

function _applyDotIceClass(el, iceType) {
  if (!el) return;
  _setDotIceClass(el.querySelector('.peer-dot'), iceType);
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
    loss.textContent = '↓ ' + stats.lossPercent.toFixed(1) + '% loss';
    wrap.appendChild(loss);
  }
  // Loss on the stream we send, as reported back by the peer — the only way to
  // see "they can't hear me" (a chopped uplink) from this side.
  if (typeof stats.outLossPercent === 'number') {
    var outLoss = document.createElement('span');
    outLoss.className = 'stat-badge ' + (stats.outLossPercent > 5 ? 'stat-warn' : 'stat-neutral');
    outLoss.textContent = '↑ ' + stats.outLossPercent.toFixed(1) + '% loss';
    wrap.appendChild(outLoss);
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
  body.appendChild(_buildLossDetail(conn.webrtcStats));
}

// A compact SVG sparkline of recent loss samples. Scaled to the worst sample in
// the window (min 5%) so a flat-but-nonzero line still reads as "some loss"
// rather than being squashed against the axis.
function _buildLossSparkline(history, className) {
  var W = 132, H = 22;
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'loss-spark ' + (className || ''));
  svg.setAttribute('preserveAspectRatio', 'none');
  var samples = history && history.length ? history : [0];
  var peak = Math.max(5, Math.max.apply(null, samples));
  var step = samples.length > 1 ? W / (samples.length - 1) : W;

  var points = samples.map(function(v, i) {
    var x = samples.length > 1 ? i * step : W / 2;
    var y = H - (Math.min(v, peak) / peak) * (H - 2) - 1;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  // Filled area under the line reads better at this size than a bare stroke.
  var area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  area.setAttribute('points', '0,' + H + ' ' + points + ' ' + W + ',' + H);
  area.setAttribute('class', 'loss-spark-area');
  svg.appendChild(area);

  var line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('class', 'loss-spark-line');
  svg.appendChild(line);
  return svg;
}

function _lossDetailRow(label, value) {
  var row = document.createElement('div');
  row.className = 'stats-row';
  var k = document.createElement('span');
  k.className = 'stats-row-key';
  k.textContent = label;
  var v = document.createElement('span');
  v.className = 'stats-row-val';
  v.textContent = value == null ? '—' : value;
  row.appendChild(k);
  row.appendChild(v);
  return row;
}

// Dropped packets in detail: totals since the link came up (a brief dropout
// stays on the record), the worst sample seen, and the recent trend.
function _buildLossDetail(stats) {
  var wrap = document.createElement('div');
  wrap.className = 'stats-detail';

  // `expected` is the denominator the percentage is taken against: packets we
  // should have received (received + lost) inbound, packets we sent outbound.
  function direction(title, cls, pct, peak, lost, expected, history) {
    if (typeof pct !== 'number' && !lost) return;
    var head = document.createElement('div');
    head.className = 'stats-detail-head';
    head.textContent = title;
    wrap.appendChild(head);
    wrap.appendChild(_buildLossSparkline(history, cls));
    wrap.appendChild(_lossDetailRow('Now / peak',
      (typeof pct === 'number' ? pct.toFixed(1) : '—') + '% / ' +
      (typeof peak === 'number' ? peak.toFixed(1) : '—') + '%'));
    wrap.appendChild(_lossDetailRow('Dropped',
      (lost || 0).toLocaleString() + ' of ' + (expected || 0).toLocaleString()));
  }

  direction('↓ Incoming', 'loss-spark-in', stats.lossPercent, stats.peakLossPercent,
    stats.packetsLostTotal, (stats.packetsReceivedTotal || 0) + (stats.packetsLostTotal || 0),
    stats.lossHistory);
  direction('↑ Outgoing (reported by peer)', 'loss-spark-out', stats.outLossPercent, stats.peakOutLossPercent,
    stats.outPacketsLostTotal, stats.outPacketsSentTotal, stats.outLossHistory);

  if (typeof stats.playoutDelayMs === 'number') {
    var srcLabel = { manual: 'manual', host: 'set by host', auto: 'auto' }[stats.playoutDelaySource] || 'auto';
    var head = document.createElement('div');
    head.className = 'stats-detail-head';
    head.textContent = 'Jitter buffer';
    wrap.appendChild(head);
    wrap.appendChild(_lossDetailRow('Target', stats.playoutDelayMs + ' ms (' + srcLabel + ')'));
  }
  return wrap;
}

// Place a body-appended popover against its anchor without ever running off the
// screen. Both popovers are `position: fixed`, so getBoundingClientRect's
// viewport coordinates are used as-is — adding scrollY (as this once did) pushes
// them off by the scroll offset.
//
// The height cap is computed from the space actually available on the chosen
// side rather than a flat `Nvh`, which is what made the device panel overflow on
// a phone: the content grew past what fits below a roster row near the bottom of
// the screen, and a 70vh cap knows nothing about where the anchor is. Anchoring
// the *bottom* edge when opening upwards means async content grows away from the
// anchor, so a panel that fills in later still cannot escape the viewport — it
// scrolls instead.
function _positionAnchoredPopover(popover, anchorEl, width) {
  var MARGIN = 8;   // keep clear of the viewport edges
  var GAP    = 4;   // between the anchor and the panel
  var MIN_H  = 120; // below this a panel is useless, so allow it to overlap a little
  var rect = anchorEl.getBoundingClientRect();

  var left = rect.left;
  if (left + width > window.innerWidth - MARGIN) left = window.innerWidth - width - MARGIN;
  if (left < MARGIN) left = MARGIN;
  popover.style.left = left + 'px';

  var below = window.innerHeight - rect.bottom - GAP - MARGIN;
  var above = rect.top - GAP - MARGIN;
  // Open downwards by default; flip up only when below is genuinely cramped and
  // above is roomier — not merely because the content happens to be tall.
  var useAbove = below < 200 && above > below;

  if (useAbove) {
    popover.style.top    = 'auto';
    popover.style.bottom = (window.innerHeight - rect.top + GAP) + 'px';
    popover.style.maxHeight = Math.max(MIN_H, above) + 'px';
  } else {
    popover.style.bottom = 'auto';
    popover.style.top    = (rect.bottom + GAP) + 'px';
    popover.style.maxHeight = Math.max(MIN_H, below) + 'px';
  }
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

  // Position near the anchor dot (200px = min-width from CSS).
  _positionAnchoredPopover(popover, anchorEl, 200);

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

// --- Device info diagnostics (dev mode) --------------------------------------
//
// Collected strictly on demand (only when a device-info panel is opened and,
// for remote peers, only after the host asks). Nothing is polled or sent in the
// steady state, so this has no effect on runtime performance. All probes are
// best-effort and wrapped in try/catch — anything the platform can't expose is
// rendered as "—" rather than failing.

var _uaHighEntropy = null; // cached getHighEntropyValues() result (immutable per session)

function _getUAHighEntropy() {
  if (_uaHighEntropy) return Promise.resolve(_uaHighEntropy);
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      return navigator.userAgentData
        .getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion'])
        .then(function(v) { _uaHighEntropy = v || {}; return _uaHighEntropy; })
        .catch(function() { return {}; });
    }
  } catch (_) {}
  return Promise.resolve({});
}

function _detectDeviceType() {
  var ua = navigator.userAgent || '';
  var uaData = navigator.userAgentData;
  var isTablet = /iPad/.test(ua) ||
                 (/Android/.test(ua) && !/Mobile/.test(ua)) ||
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS desktop UA
  if (isTablet) return 'Tablet';
  var mobile = uaData ? !!uaData.mobile : /Mobi|Android|iPhone|iPod/i.test(ua);
  if (mobile) return 'Phone';
  return 'Desktop';
}

function _detectOS() {
  var ua = navigator.userAgent || '';
  var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/iPhone|iPad|iPod/.test(ua) || (p === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iOS';
  if (/Android/.test(ua) || /Android/i.test(p)) return 'Android';
  if (/Mac/i.test(p) || /Mac OS X/.test(ua)) return 'macOS';
  if (/Win/i.test(p) || /Windows/.test(ua)) return 'Windows';
  if (/Linux|X11|CrOS/i.test(p) || /Linux|CrOS/.test(ua)) return 'Linux';
  return p || 'Unknown';
}

function _archLabel(he) {
  if (!he || !he.architecture) return null;
  var a = he.architecture, bits = he.bitness;
  if (a === 'arm') return bits === '64' ? 'arm64' : 'arm';
  if (a === 'x86') return bits === '64' ? 'x64' : 'x86';
  return a + (bits ? bits : '');
}

function _detectAppSetup() {
  if (window.__TAURI__) return 'Desktop app (Tauri)';
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    var plat = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : '';
    if (plat === 'ios') return 'iOS app (native)';
    if (plat === 'android') return 'Android app (native)';
    return 'Native app';
  }
  return 'Web browser';
}

function _guessMicConnection(label) {
  if (!label) return null;
  var l = label.toLowerCase();
  if (/bluetooth|airpod|buds|wireless|hands-?free/.test(l)) return 'Bluetooth';
  if (/\busb\b/.test(l)) return 'USB';
  if (/built-?in|internal|macbook|default|iphone|ipad/.test(l)) return 'Built-in';
  return 'Wired / other';
}

function _collectAudioInfo() {
  var info = { micName: null, micConnection: null, sampleRate: null, channels: null, volume: null };
  try {
    var track = audioTrack || (stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null);
    if (track) {
      info.micName = track.label || null;
      info.micConnection = _guessMicConnection(track.label);
      var s = track.getSettings ? track.getSettings() : {};
      if (s.sampleRate) info.sampleRate = s.sampleRate;
      if (s.channelCount) info.channels = s.channelCount;
      if (typeof s.volume === 'number') info.volume = s.volume;
    }
    if (!info.sampleRate && _audioCtx && _audioCtx.sampleRate) info.sampleRate = _audioCtx.sampleRate;
  } catch (_) {}
  return info;
}

function _detectHeadset() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve(null);
    return navigator.mediaDevices.enumerateDevices().then(function(devs) {
      var re = /head(set|phone)|airpod|buds|bluetooth|hands-?free/i;
      var outputs = devs.filter(function(d) { return d.kind === 'audiooutput'; });
      if (!outputs.length || !outputs.some(function(d) { return d.label; })) return null; // no label permission
      return outputs.some(function(d) { return re.test(d.label || ''); });
    }).catch(function() { return null; });
  } catch (_) { return Promise.resolve(null); }
}

function _labelConnType(c) {
  if (!c) return null;
  if (c.type === 'wifi') return 'Wi-Fi';
  if (c.type === 'ethernet') return 'Ethernet';
  if (c.type === 'cellular') return 'Cellular' + (c.effectiveType ? ' (' + c.effectiveType.toUpperCase() + ')' : '');
  if (c.type === 'bluetooth') return 'Bluetooth';
  if (c.type === 'none') return 'Offline';
  if (c.effectiveType) return c.effectiveType.toUpperCase(); // desktop Chrome exposes only effectiveType
  return null;
}

function _deriveSignal(c) {
  if (!c) return null;
  var et = c.effectiveType, dl = c.downlink;
  if (et === '4g' || (typeof dl === 'number' && dl >= 5)) return 'Excellent';
  if (et === '3g' || (typeof dl === 'number' && dl >= 1.5)) return 'Good';
  if (et) return 'Poor';
  return null;
}

function _collectNetworkInfo() {
  var info = { connType: null, signal: null, downlink: null, rttMs: null };
  try {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      info.connType = _labelConnType(c);
      info.signal = _deriveSignal(c);
      if (typeof c.downlink === 'number') info.downlink = c.downlink;
      if (typeof c.rtt === 'number') info.rttMs = c.rtt;
    }
  } catch (_) {}
  return info;
}

function _collectBatteryInfo() {
  try {
    if (navigator.getBattery) {
      return navigator.getBattery().then(function(b) {
        return { present: true, level: Math.round(b.level * 100), charging: !!b.charging };
      }).catch(function() { return { present: false }; });
    }
  } catch (_) {}
  return Promise.resolve({ present: false });
}

// On Tauri desktop the WebView (WKWebView on macOS) exposes none of
// performance.memory / navigator.getBattery / per-process CPU, so we read them
// from the native side via the `get_device_stats` command. Returns null off Tauri
// or on any error. Values: bytes for memory, percent for CPU, 0..100 for battery.
function _getNativeDeviceStats() {
  try {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke('get_device_stats').catch(function() { return null; });
    }
  } catch (_) {}
  return Promise.resolve(null);
}

// Gather the full device snapshot. Always resolves (never rejects).
async function collectDeviceInfo() {
  var he = {}, battery = { present: false }, headset = null, native = null;
  try { he = await _getUAHighEntropy(); } catch (_) {}
  try { battery = await _collectBatteryInfo(); } catch (_) {}
  try { headset = await _detectHeadset(); } catch (_) {}
  try { native = await _getNativeDeviceStats(); } catch (_) {}

  // Memory + CPU (bytes / percent). Web APIs first, native overrides when present.
  var memApp = null, memTotal = null, cpuApp = null, cpuTotal = null;
  try { if (window.performance && performance.memory) memApp = performance.memory.usedJSHeapSize; } catch (_) {} // JS heap (Chromium only)
  try { if (navigator.deviceMemory) memTotal = navigator.deviceMemory * 1024 * 1024 * 1024; } catch (_) {} // GB → bytes, coarse
  if (native) {
    if (native.mem_app != null)   memApp   = native.mem_app;   // real process RSS
    if (native.mem_total != null) memTotal = native.mem_total;
    if (native.cpu_app != null)   cpuApp   = Math.round(native.cpu_app * 10) / 10;
    if (native.cpu_total != null) cpuTotal = Math.round(native.cpu_total * 10) / 10;
  }

  // Battery: web getBattery() first (Chromium/Android), native fallback (desktop).
  var batLevel   = battery && battery.present ? battery.level : null;
  var batCharging = battery && battery.present ? battery.charging : null;
  if (native) {
    if (native.battery_level != null)    batLevel = native.battery_level;
    if (native.battery_charging != null) batCharging = native.battery_charging;
  }

  var type = _detectDeviceType();
  // A device running on battery power (not charging) is a portable — call it a laptop.
  if (type === 'Desktop' && batCharging === false) type = 'Laptop';

  var audio = _collectAudioInfo();
  audio.headset = headset;

  var net = _collectNetworkInfo();
  if (native && native.net_type) net.connType = native.net_type; // desktop: fills what navigator.connection can't
  net.battery = {
    present: batLevel != null,
    level: batLevel,
    charging: batCharging,
    lowPower: (native && native.low_power != null) ? native.low_power : null, // native only; not web-exposed
    background: (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  };

  return {
    ts: Date.now(),
    device: {
      type: type,
      arch: _archLabel(he),
      os: _detectOS(),
      osVersion: he.platformVersion || null,
      setup: _detectAppSetup(),
      appVersion: (typeof VOXAL_VERSION !== 'undefined' ? VOXAL_VERSION : null),
      timezone: (function() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return null; } })(),
      cores: (typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null),
      cpuApp: cpuApp,
      cpuTotal: cpuTotal,
      memApp: memApp,
      memTotal: memTotal   // bytes
    },
    audio: audio,
    network: net
  };
}

// --- Device info panel (host-side viewer) ------------------------------------

var _deviceInfoPeerId = null; // id currently shown ('self' sentinel for own row)

function _sendToHostData(msg) {
  if (isHost || !roomCode) return false;
  var hc = connections.get(roomCode);
  if (hc && hc.data) { sendDataIfOpen(hc.data, msg); return true; }
  return false;
}

// A non-host peer answers a device-info request relayed by the host. Honors the
// per-peer sharing preference; if disabled, replies with a "declined" marker.
function respondToDeviceInfoRequest(from) {
  if (!isDeviceInfoSharingEnabled()) {
    _sendToHostData({ type: 'device-info-response', peerId: peer && peer.id, info: null, declined: true, from: from || null });
    return;
  }
  collectDeviceInfo().then(function(info) {
    _sendToHostData({ type: 'device-info-response', peerId: peer && peer.id, info: info, declined: false, from: from || null });
  }).catch(function() {
    _sendToHostData({ type: 'device-info-response', peerId: peer && peer.id, info: null, declined: false, from: from || null });
  });
}

// Host receives a request from `requesterId` about `targetId`. Answers directly
// if it's about the host itself, otherwise relays to the target peer.
function handleDeviceInfoRequestAtHost(requesterId, targetId) {
  if (!targetId || targetId === (peer && peer.id)) {
    var reply = function(info, declined) {
      var rc = connections.get(requesterId);
      if (rc && rc.data) sendDataIfOpen(rc.data, { type: 'device-info-response', peerId: peer && peer.id, info: info, declined: declined });
    };
    if (!isDeviceInfoSharingEnabled()) { reply(null, true); return; }
    collectDeviceInfo().then(function(info) { reply(info, false); }).catch(function() { reply(null, false); });
    return;
  }
  var tc = connections.get(targetId);
  if (tc && tc.data) sendDataIfOpen(tc.data, { type: 'device-info-request', peerId: targetId, from: requesterId });
}

function updatePeerDeviceInfo(peerId, info, declined) {
  var c = connections.get(peerId);
  if (!c) return;
  c.deviceInfo = { info: info || null, declined: !!declined, at: Date.now() };
}

function onDeviceInfoResponse(peerId, info, declined) {
  updatePeerDeviceInfo(peerId, info, declined);
  if (_deviceInfoPeerId && _deviceInfoPeerId === peerId) _refreshDeviceInfoPopover();
}

// --- Audio check plumbing (mirrors the device-info relay) --------------------

// A peer answers an audio check: sample, wait out the window, sample again.
// Gated on the same sharing consent as device info — it reports on this
// device's playback state, so it is the same promise to the user.
function respondToAudioCheckRequest(from, durationMs) {
  var requesterId = from || roomCode;
  var reply = function(report, declined) {
    var msg = { type: 'audio-check-response', peerId: peer && peer.id, report: report,
                declined: !!declined, from: from || null };
    if (isHost) {
      var rc = connections.get(requesterId);
      if (rc && rc.data) sendDataIfOpen(rc.data, msg);
    } else {
      _sendToHostData(msg);
    }
  };
  if (!isDeviceInfoSharingEnabled()) { reply(null, true); return; }

  var window = Math.max(500, Math.min(Number(durationMs) || AUDIO_CHECK_WINDOW_MS, 10000));
  sampleInboundAudio(requesterId).then(function(before) {
    setTimeout(function() {
      sampleInboundAudio(requesterId).then(function(after) {
        reply(buildAudioCheckReport(before, after), false);
      }).catch(function() { reply({ ok: false, reason: 'sample-failed' }, false); });
    }, window);
  }).catch(function() { reply({ ok: false, reason: 'sample-failed' }, false); });
}

// Host receives an audio-check request from `requesterId` about `targetId`.
function handleAudioCheckRequestAtHost(requesterId, targetId, durationMs) {
  if (!targetId || targetId === (peer && peer.id)) {
    respondToAudioCheckRequest(requesterId, durationMs);
    return;
  }
  var tc = connections.get(targetId);
  if (tc && tc.data) {
    sendDataIfOpen(tc.data, { type: 'audio-check-request', peerId: targetId, from: requesterId, durationMs: durationMs });
  }
}

// Kick off a check against one peer: ask them to measure, and transmit for the
// same window so there is something to measure.
function startAudioCheck(peerId) {
  if (!inRoom || !peerId || (_audioCheck && _audioCheck.peerId === peerId)) return;
  cancelAudioCheck();

  _audioCheck = { peerId: peerId, startedAt: Date.now(), localEnergyStart: null, timer: null };

  if (isHost) {
    var c = connections.get(peerId);
    if (c && c.data) sendDataIfOpen(c.data, { type: 'audio-check-request', durationMs: AUDIO_CHECK_WINDOW_MS });
  } else {
    _sendToHostData({ type: 'audio-check-request', peerId: peerId, durationMs: AUDIO_CHECK_WINDOW_MS });
  }

  // Transmit through the normal talking path so the mic is acquired exactly as a
  // real press would, and measure our own energy across the same window. The
  // peer's reply cannot be scored until this resolves, so hold it as a promise
  // rather than a field the response might race.
  var check = _audioCheck;
  check.localEnergyPromise = new Promise(function(resolve) {
    sampleLocalMicEnergy().then(function(start) {
      setTalking(true);
      setTimeout(function() {
        setTalking(false);
        sampleLocalMicEnergy().then(function(end) {
          resolve((typeof end === 'number' && typeof start === 'number') ? Math.max(0, end - start) : null);
        }).catch(function() { resolve(null); });
      }, AUDIO_CHECK_WINDOW_MS);
    }).catch(function() { resolve(null); });
  });

  _audioCheck.timer = setTimeout(function() {
    if (!_audioCheck) return;
    _audioCheck.result = { status: 'error', headline: 'No response',
                           detail: 'That peer did not answer the check.' };
    _refreshDeviceInfoPopover();
  }, AUDIO_CHECK_TIMEOUT_MS);

  _refreshDeviceInfoPopover();
}

function cancelAudioCheck() {
  if (_audioCheck && _audioCheck.timer) clearTimeout(_audioCheck.timer);
  _audioCheck = null;
}

function onAudioCheckResponse(peerId, report, declined) {
  var check = _audioCheck;
  if (!check || check.peerId !== peerId) return;
  if (check.timer) clearTimeout(check.timer);
  check.report = report || null;

  if (declined) {
    check.result = { status: 'error', headline: 'Declined',
                     detail: 'That peer has diagnostics sharing turned off.' };
    _refreshDeviceInfoPopover();
    return;
  }
  // Score only once our own mic energy for the window is known.
  Promise.resolve(check.localEnergyPromise).then(function(localEnergy) {
    if (_audioCheck !== check) return; // superseded or cancelled
    check.localEnergy = localEnergy;
    check.result = summarizeAudioCheck(report, localEnergy);
    _refreshDeviceInfoPopover();
  });
}

// Ask a remote peer for its device info. Host asks the peer directly; a non-host
// viewer routes the request through the host (which answers or relays).
function requestDeviceInfo(peerId) {
  if (isHost) {
    var c = connections.get(peerId);
    if (c && c.data) sendDataIfOpen(c.data, { type: 'device-info-request' });
  } else {
    _sendToHostData({ type: 'device-info-request', peerId: peerId });
  }
}

// --- "Can you hear me?" audio check (dev mode) -------------------------------
//
// `remote-inbound-rtp` proves our packets ARRIVED at a peer; it cannot prove the
// peer HEARD them. Whether audio was decoded, whether their <audio> element is
// actually playing, and how much of it NetEq had to fabricate are all
// receiver-side facts, so the peer has to measure and report them.
//
// The check: we transmit for a fixed window while the peer samples its own
// inbound stats across the same window and sends back the deltas. Deltas (not
// absolutes) because the link may have been up for minutes.

const AUDIO_CHECK_WINDOW_MS = 2500;
const AUDIO_CHECK_TIMEOUT_MS = 8000;
// Energy is Σ(sample²)·duration; even quiet speech clears this comfortably,
// while a muted or disconnected mic sits at ~0.
const AUDIO_CHECK_MIN_ENERGY = 0.0005;
// Fraction of samples NetEq had to invent. This is measured AFTER FEC recovery
// and jitter-buffer success, so it tracks what was actually heard far better
// than packet loss does.
const AUDIO_CHECK_CONCEAL_GOOD = 0.02;
const AUDIO_CHECK_CONCEAL_POOR = 0.10;

var _audioCheck = null; // { peerId, startedAt, timer, localEnergyStart }

// Read the inbound audio counters for one peer, plus how its playback element is
// configured. `null` when there is no audio link to sample.
async function sampleInboundAudio(peerId) {
  var conn = connections.get(peerId);
  var pcs = audioPeerConnections(conn);
  if (!pcs.length) return null;
  return sampleInboundFromPeerConnections(pcs, document.getElementById('audio-' + peerId));
}

// The stats walk itself, over an arbitrary set of PeerConnections — shared by
// the per-peer audio check and the loopback echo test, which measure the same
// things over different plumbing.
async function sampleInboundFromPeerConnections(pcs, audioEl) {
  if (!pcs || !pcs.length) return null;

  var sample = {
    at: Date.now(),
    energy: 0, samples: 0, concealed: 0, silentConcealed: 0, concealmentEvents: 0,
    packets: 0, packetsLost: 0, jbDelay: 0, jbEmitted: 0,
    synthesizedMs: 0, playoutSamples: 0
  };
  var sawInbound = false;

  for (var i = 0; i < pcs.length; i++) {
    var reports = await pcs[i].getStats();
    reports.forEach(function(r) {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        sawInbound = true;
        sample.energy            += r.totalAudioEnergy || 0;
        sample.samples           += r.totalSamplesReceived || 0;
        sample.concealed         += r.concealedSamples || 0;
        sample.silentConcealed   += r.silentConcealedSamples || 0;
        sample.concealmentEvents += r.concealmentEvents || 0;
        sample.packets           += r.packetsReceived || 0;
        sample.packetsLost       += r.packetsLost || 0;
        sample.jbDelay           += r.jitterBufferDelay || 0;
        sample.jbEmitted         += r.jitterBufferEmittedCount || 0;
      }
      // What the speaker actually rendered — one step past decode.
      if (r.type === 'media-playout') {
        sample.synthesizedMs  += (r.synthesizedSamplesDuration || 0) * 1000;
        sample.playoutSamples += r.totalSamplesCount || 0;
      }
    });
  }
  if (!sawInbound) return null;

  // Element state catches autoplay blocks and a dead output device, which no RTP
  // statistic can see. The sink id itself is a device identifier, so only report
  // whether one is set — never the value.
  var el = audioEl;
  sample.playback = el
    ? { present: true, paused: !!el.paused, muted: !!el.muted, volume: typeof el.volume === 'number' ? el.volume : 1,
        customSink: !!selectedSpeakerDeviceId() }
    : { present: false };
  return sample;
}

// Our own microphone energy over the window, so "you were silent" is
// distinguishable from "your audio never arrived".
async function sampleLocalMicEnergy() {
  var conn = null;
  var pcs = [];
  connections.forEach(function(c) { pcs = pcs.concat(audioPeerConnections(c)); });
  for (var i = 0; i < pcs.length; i++) {
    var reports = await pcs[i].getStats();
    var energy = null;
    reports.forEach(function(r) {
      if (r.type === 'media-source' && r.kind === 'audio' && typeof r.totalAudioEnergy === 'number') {
        energy = r.totalAudioEnergy;
      }
    });
    if (energy !== null) return energy;
  }
  return null;
}

function _delta(b, a, key) { return Math.max(0, (b[key] || 0) - (a[key] || 0)); }

// Turn two samples into the report we send back to the requester.
//
// A null `before` with a live `after` means the audio link came up *during* the
// window — which is normal, since the requester starts transmitting as it asks,
// and that may be what creates the connection. Everything `after` counted
// accumulated inside the window, so a zero baseline is exactly right; treating
// it as "no link" would report a false negative on a perfectly healthy peer.
function buildAudioCheckReport(before, after) {
  if (!after) return { ok: false, reason: 'no-audio-link' };
  if (!before) before = { at: after.at - AUDIO_CHECK_WINDOW_MS };
  var samples = _delta(after, before, 'samples');
  var jbEmitted = _delta(after, before, 'jbEmitted');
  var jbDelay = _delta(after, before, 'jbDelay');
  return {
    ok: true,
    windowMs: Math.max(0, after.at - before.at),
    energy: _delta(after, before, 'energy'),
    samples: samples,
    concealed: _delta(after, before, 'concealed'),
    silentConcealed: _delta(after, before, 'silentConcealed'),
    concealmentEvents: _delta(after, before, 'concealmentEvents'),
    packets: _delta(after, before, 'packets'),
    packetsLost: _delta(after, before, 'packetsLost'),
    jitterBufferMs: jbEmitted > 0 ? Math.round((jbDelay / jbEmitted) * 1000) : null,
    synthesizedMs: Math.round(_delta(after, before, 'synthesizedMs')),
    playback: after.playback || null
  };
}

// Verdict, computed by the requester. `localEnergy` is our own mic energy over
// the same window — without it, "nothing arrived" and "you said nothing" look
// identical from the peer's report.
//
// Returns { status: 'good'|'choppy'|'bad'|'silent'|'unheard'|'error', … }.
function summarizeAudioCheck(report, localEnergy) {
  if (!report || !report.ok) {
    return { status: 'error', headline: 'No audio link to that peer',
             detail: 'They have no audio connection from you to measure.' };
  }
  var pb = report.playback || {};
  if (pb.present === false) {
    return { status: 'unheard', headline: 'Not being played',
             detail: 'Your stream reached them but is not attached to any audio output.' };
  }
  if (pb.paused || pb.muted || pb.volume === 0) {
    var why = pb.muted ? 'muted' : pb.paused ? 'paused' : 'at zero volume';
    return { status: 'unheard', headline: 'Their playback is ' + why,
             detail: 'Audio is arriving, but their end is not playing it' +
                     (pb.paused ? ' — often a blocked autoplay.' : '.') };
  }
  var weSpoke = typeof localEnergy !== 'number' || localEnergy > AUDIO_CHECK_MIN_ENERGY;
  if (report.energy <= AUDIO_CHECK_MIN_ENERGY) {
    if (!weSpoke) {
      return { status: 'silent', headline: 'No sound was sent',
               detail: 'Your microphone picked up nothing — try again and speak during the test.' };
    }
    return { status: 'unheard', headline: 'They received silence',
             detail: 'You were speaking, but no audio energy reached them.' };
  }
  var conceal = report.samples > 0 ? report.concealed / report.samples : 0;
  var pct = (conceal * 100).toFixed(1);
  if (conceal < AUDIO_CHECK_CONCEAL_GOOD) {
    return { status: 'good', headline: 'They hear you clearly',
             detail: 'Only ' + pct + '% of audio needed filling in.', concealPercent: conceal * 100 };
  }
  if (conceal < AUDIO_CHECK_CONCEAL_POOR) {
    return { status: 'choppy', headline: 'They hear you, but it is choppy',
             detail: pct + '% of audio had to be filled in across ' + report.concealmentEvents + ' dropout(s).',
             concealPercent: conceal * 100 };
  }
  return { status: 'bad', headline: 'They hear you badly',
           detail: pct + '% of audio had to be filled in across ' + report.concealmentEvents + ' dropout(s).',
           concealPercent: conceal * 100 };
}

// --- Remote debug logs (dev mode) --------------------------------------------
//
// A device-info snapshot answers "what is that device?"; it cannot answer "what
// happened on it". That needs the peer's own log stream — every console line,
// uncaught error and rejection the app produced — which only that device can
// see. So a debugging viewer asks, the peer's device raises an explicit
// authorization prompt, and nothing is captured or sent until the person there
// allows it.
//
// Consent is per session and deliberately NOT the global device-info
// preference: a snapshot is one bounded payload, a log stream is open-ended and
// carries whatever the app happens to print. So it is re-authorized every time,
// auto-expires, and the sharing device keeps a visible banner with a Stop
// button for as long as it runs. An explicit global "declined" still wins —
// someone who refused diagnostics outright is never prompted again.

const REMOTE_LOG_MAX_MS       = 10 * 60 * 1000; // a session stops itself after this
const REMOTE_LOG_FLUSH_MS     = 400;            // batching interval on the sharing device
const REMOTE_LOG_BATCH_MAX    = 40;             // entries per `log-entries` message
const REMOTE_LOG_QUEUE_MAX    = 200;            // unsent entries held before dropping the oldest
const REMOTE_LOG_MSG_MAX      = 400;            // characters per line
const REMOTE_LOG_VIEW_MAX     = 1000;           // entries the viewer keeps per peer
const REMOTE_LOG_REQUEST_TIMEOUT_MS = 60000;    // give the person time to answer the prompt
const REMOTE_LOG_DECLINE_COOLDOWN_MS = 2 * 60 * 1000; // a refusal is not re-askable straight away

// Sharing device (the one being debugged).
var _logShare        = null; // { requesterId, startedAt, queue, dropped, flushTimer, expiryTimer, sent }
var _logSharePrompt  = null; // { requesterId, pseudo, at } — pending authorization
var _logCaptureRestore = null;
var _logCaptureBusy  = false; // re-entrancy guard: sending can itself log
var _logDeclineCooldown = new Map(); // peerId -> "do not ask again before" timestamp

// Viewer device (the one debugging).
var _remoteLogSessions   = new Map(); // peerId -> { state, entries, startedAt, note, timer }
var _remoteLogViewPeerId = null;      // peer whose log panel is open

function logTimestamp() {
  var now = new Date();
  return now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
}

function truncateLogMessage(msg) {
  var s = String(msg == null ? '' : msg);
  return s.length > REMOTE_LOG_MSG_MAX ? s.slice(0, REMOTE_LOG_MSG_MAX) + '…' : s;
}

// Peer-supplied text is untrusted: bound it here, and render it with
// textContent everywhere so it can never be markup.
function sanitizeLogPseudo(name) {
  if (typeof name !== 'string') return null;
  var s = name.trim().slice(0, 40);
  return s || null;
}

function peerDisplayName(peerId) {
  var c = peerId ? connections.get(peerId) : null;
  return (c && c.pseudo) || (peerId ? shortId(peerId) : 'a peer');
}

// One console argument as a line of text. Errors keep the head of their stack —
// that is usually the whole point of asking for the log.
function formatLogArg(a) {
  if (typeof a === 'string') return a;
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (a instanceof Error) {
    var head = (a.name || 'Error') + ': ' + a.message;
    var frames = a.stack ? String(a.stack).split('\n').slice(1, 4).map(function(l) { return l.trim(); }) : [];
    return frames.length ? head + ' | ' + frames.join(' ⏎ ') : head;
  }
  if (typeof a === 'object') {
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }
  return String(a);
}

// --- Sharing side ------------------------------------------------------------

function logSharingActive() { return !!_logShare; }

// Route a reply (response / entries / end) back to the requester: the host
// answers it directly, a non-host hands it to the host to relay — the same path
// the device-info round trip uses.
function sendLogReply(requesterId, msg) {
  var full = Object.assign({ peerId: peer && peer.id, from: requesterId || null }, msg);
  if (isHost) {
    var rc = requesterId ? connections.get(requesterId) : null;
    return !!(rc && rc.data && sendDataIfOpen(rc.data, full));
  }
  return _sendToHostData(full);
}

function sendLogBatches(requesterId, entries) {
  var ok = true;
  for (var i = 0; i < entries.length; i += REMOTE_LOG_BATCH_MAX) {
    ok = sendLogReply(requesterId, { type: 'log-entries', entries: entries.slice(i, i + REMOTE_LOG_BATCH_MAX) }) && ok;
  }
  return ok;
}

// A viewer wants this device's logs. Never starts anything on its own: it either
// refuses outright or raises the authorization prompt.
function handleLogSessionRequest(requesterId, requesterPseudo) {
  var from = requesterId || roomCode;
  if (!from) return;
  if (IS_TINY_EMBED || !inRoom || deviceInfoConsent() === 'declined') {
    sendLogReply(from, { type: 'log-session-response', granted: false, reason: 'declined' });
    return;
  }
  // Saying no sticks for a while: without this, a peer can re-raise the prompt
  // the instant it is dismissed and badger someone into accepting.
  var declinedUntil = _logDeclineCooldown.get(from) || 0;
  if (Date.now() < declinedUntil) {
    sendLogReply(from, { type: 'log-session-response', granted: false, reason: 'declined' });
    return;
  }
  if (_logShare) {
    // Already streaming: same viewer is a no-op, a second one is refused rather
    // than silently fanning this device's log out to two places.
    if (_logShare.requesterId !== from) {
      sendLogReply(from, { type: 'log-session-response', granted: false, reason: 'busy' });
    }
    return;
  }
  if (_logSharePrompt) {
    // One prompt at a time — a second request must not swap out the name the
    // person is deciding about.
    if (_logSharePrompt.requesterId !== from) {
      sendLogReply(from, { type: 'log-session-response', granted: false, reason: 'busy' });
    }
    return;
  }
  _logSharePrompt = {
    requesterId: from,
    pseudo: sanitizeLogPseudo(requesterPseudo) || peerDisplayName(from),
    at: Date.now()
  };
  renderLogConsentPrompt();
}

function acceptLogSessionRequest() {
  var p = _logSharePrompt;
  if (!p) return;
  _logSharePrompt = null;
  renderLogConsentPrompt();
  startLogSharing(p.requesterId);
}

function declineLogSessionRequest() {
  var p = _logSharePrompt;
  if (!p) return;
  _logSharePrompt = null;
  _logDeclineCooldown.set(p.requesterId, Date.now() + REMOTE_LOG_DECLINE_COOLDOWN_MS);
  renderLogConsentPrompt();
  sendLogReply(p.requesterId, { type: 'log-session-response', granted: false, reason: 'declined' });
}

function dismissLogConsentPrompt() {
  if (!_logSharePrompt) return;
  _logSharePrompt = null;
  renderLogConsentPrompt();
}

function startLogSharing(requesterId) {
  if (_logShare) stopLogSharing('superseded');
  _logShare = {
    requesterId: requesterId,
    startedAt: Date.now(),
    queue: [], dropped: 0, failures: 0,
    flushTimer: null, expiryTimer: null
  };
  sendLogReply(requesterId, { type: 'log-session-response', granted: true, expiresInMs: REMOTE_LOG_MAX_MS });

  // Ship what already happened, not just what happens next — the interesting
  // failure is usually already in the ring buffer by the time anyone asks.
  var backfill = [logContextEntry()].concat(_devLogBuffer.slice(-REMOTE_LOG_QUEUE_MAX).map(function(e) {
    return { t: e.t, msg: truncateLogMessage(e.msg), lvl: e.lvl };
  }));
  sendLogBatches(requesterId, backfill);

  installLogCapture();
  _logShare.flushTimer  = setInterval(flushLogShareQueue, REMOTE_LOG_FLUSH_MS);
  _logShare.expiryTimer = setTimeout(function() { stopLogSharing('expired'); }, REMOTE_LOG_MAX_MS);
  updateLogShareIndicator();
}

// What the log is FROM — a stream of lines with no idea which build or platform
// produced them is a lot less useful.
function logContextEntry() {
  var bits = [
    'remote log started',
    'v' + (typeof VOXAL_VERSION !== 'undefined' ? VOXAL_VERSION : '?'),
    _detectAppSetup(),
    isHost ? 'host' : 'peer'
  ];
  return { t: logTimestamp(), msg: '— ' + bits.join(' · ') + ' —', lvl: 'info' };
}

// `reason` is reported to the viewer so an ended session says why it ended.
function stopLogSharing(reason) {
  var s = _logShare;
  if (!s) return;
  _logShare = null;
  if (s.flushTimer)  clearInterval(s.flushTimer);
  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  removeLogCapture();
  if (reason !== 'peer-gone') {
    if (s.queue.length) sendLogBatches(s.requesterId, s.queue.splice(0, s.queue.length));
    sendLogReply(s.requesterId, { type: 'log-session-end', reason: reason || 'stopped' });
  }
  updateLogShareIndicator();
}

// The viewer asked to stop (or cancelled a pending request).
function handleLogSessionStop(requesterId) {
  var from = requesterId || roomCode;
  if (_logSharePrompt && _logSharePrompt.requesterId === from) dismissLogConsentPrompt();
  if (_logShare && _logShare.requesterId === from) stopLogSharing('stopped-by-viewer');
}

function captureLogLine(lvl, args) {
  var s = _logShare;
  if (!s || _logCaptureBusy) return;
  var msg;
  try { msg = args.map(formatLogArg).join(' '); } catch (_) { return; }
  if (!msg) return;
  if (s.queue.length >= REMOTE_LOG_QUEUE_MAX) { s.queue.shift(); s.dropped++; }
  s.queue.push({ t: logTimestamp(), msg: truncateLogMessage(msg), lvl: lvl });
}

function flushLogShareQueue() {
  var s = _logShare;
  if (!s || !s.queue.length) return;
  var batch = s.queue.splice(0, REMOTE_LOG_BATCH_MAX);
  if (s.dropped) {
    batch.unshift({ t: logTimestamp(), msg: '… ' + s.dropped + ' line(s) dropped (logging faster than the link)', lvl: 'warn' });
    s.dropped = 0;
  }
  // Sending can itself log (PeerJS warns on a closed channel), which would feed
  // the capture that produced this batch and never settle. Hold the hook off.
  _logCaptureBusy = true;
  var ok;
  try { ok = sendLogReply(s.requesterId, { type: 'log-entries', entries: batch }); }
  finally { _logCaptureBusy = false; }
  if (ok) { s.failures = 0; return; }
  // The link to the viewer is gone; give it a couple of ticks, then give up
  // rather than capturing into a queue nobody will ever read.
  if (++s.failures >= 3) stopLogSharing('peer-gone');
}

// Capture everything the page prints, not just devLog(): third-party warnings
// (PeerJS, the browser) and uncaught errors are exactly what is missing when
// someone says "it just stopped working". devLog also goes to the console, so
// hooking the console alone captures it without duplicating it.
function installLogCapture() {
  if (_logCaptureRestore) return;
  var methods = ['log', 'info', 'warn', 'error', 'debug'];
  var saved = {};
  methods.forEach(function(m) {
    if (typeof console[m] !== 'function') return;
    saved[m] = console[m];
    console[m] = function() {
      try { captureLogLine(m === 'debug' || m === 'log' ? 'info' : m, Array.prototype.slice.call(arguments)); } catch (_) {}
      return saved[m].apply(console, arguments);
    };
  });
  var onError = function(e) {
    captureLogLine('error', ['Uncaught ' + (e && e.message ? e.message : 'error')
      + (e && e.filename ? ' @ ' + e.filename + ':' + (e.lineno || 0) : '')]);
  };
  var onRejection = function(e) { captureLogLine('error', ['Unhandled rejection:', e && e.reason]); };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  _logCaptureRestore = function() {
    methods.forEach(function(m) { if (saved[m]) console[m] = saved[m]; });
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

function removeLogCapture() {
  if (!_logCaptureRestore) return;
  var restore = _logCaptureRestore;
  _logCaptureRestore = null;
  try { restore(); } catch (_) {}
}

function renderLogConsentPrompt() {
  var el = document.getElementById('log-consent-prompt');
  if (!el) return;
  var p = _logSharePrompt;
  el.classList.toggle('hidden', !p);
  if (!p) return;
  var who = document.getElementById('log-consent-who');
  if (who) who.textContent = p.pseudo;
}

function updateLogShareIndicator() {
  var el = document.getElementById('log-share-indicator');
  if (!el) return;
  el.classList.toggle('hidden', !_logShare);
  if (!_logShare) return;
  var who = document.getElementById('log-share-with');
  if (who) who.textContent = peerDisplayName(_logShare.requesterId);
}

// --- Viewer side -------------------------------------------------------------

// Route a control message (request / stop) to the target: the host talks to it
// directly, a non-host addresses it through the host.
function sendLogControlMessage(targetId, msg) {
  var full = Object.assign({ fromPseudo: displayPseudoForSelf() }, msg);
  if (isHost) {
    var c = targetId ? connections.get(targetId) : null;
    return !!(c && c.data && sendDataIfOpen(c.data, full));
  }
  if (!targetId || targetId === roomCode) return _sendToHostData(full);
  return _sendToHostData(Object.assign({ peerId: targetId }, full));
}

function remoteLogSession(peerId) { return _remoteLogSessions.get(peerId) || null; }

function requestRemoteLogs(peerId) {
  if (!inRoom || !peerId || peerId === 'self' || peerId === (peer && peer.id)) return;
  var existing = _remoteLogSessions.get(peerId);
  if (existing && (existing.state === 'requesting' || existing.state === 'active')) return;

  // A new session replays the peer's ring buffer, so keeping the previous
  // entries would show that overlap twice. Start clean.
  var session = existing || { entries: [] };
  session.entries = [];
  session.state = 'requesting';
  session.note = null;
  session.startedAt = Date.now();
  if (session.timer) clearTimeout(session.timer);
  _remoteLogSessions.set(peerId, session);

  if (!sendLogControlMessage(peerId, { type: 'log-session-request' })) {
    session.state = 'ended';
    session.note = 'Could not reach that peer.';
  } else {
    session.timer = setTimeout(function() {
      var s = _remoteLogSessions.get(peerId);
      if (!s || s.state !== 'requesting') return;
      s.state = 'ended';
      s.note = 'No answer — nobody responded to the prompt.';
      _refreshRemoteLogUi(peerId);
    }, REMOTE_LOG_REQUEST_TIMEOUT_MS);
  }
  _refreshRemoteLogUi(peerId);
}

function stopRemoteLogs(peerId) {
  var session = _remoteLogSessions.get(peerId);
  sendLogControlMessage(peerId, { type: 'log-session-stop' });
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.state = 'ended';
  session.note = 'Stopped.';
  _refreshRemoteLogUi(peerId);
}

function onRemoteLogResponse(peerId, granted, reason) {
  var session = _remoteLogSessions.get(peerId);
  if (!session) return;
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  if (granted) {
    session.state = 'active';
    session.note = null;
    _refreshRemoteLogUi(peerId);
    return;
  }
  session.state = 'denied';
  session.note = reason === 'busy'
    ? 'That device is already sharing its log with someone else.'
    : 'They declined.';
  _refreshRemoteLogUi(peerId);
}

function onRemoteLogEntries(peerId, entries) {
  var session = _remoteLogSessions.get(peerId);
  // Never requested, already stopped, or malformed — a peer cannot push its log
  // at us just by sending the message.
  if (!session || session.state !== 'active' || !Array.isArray(entries)) return;
  var clean = entries.filter(function(e) { return e && typeof e === 'object'; }).map(function(e) {
    return {
      t:   typeof e.t === 'string' ? e.t.slice(0, 16) : logTimestamp(),
      msg: truncateLogMessage(e.msg),
      lvl: (e.lvl === 'warn' || e.lvl === 'error') ? e.lvl : 'info'
    };
  });
  if (!clean.length) return;
  session.entries = session.entries.concat(clean);
  if (session.entries.length > REMOTE_LOG_VIEW_MAX) {
    session.entries = session.entries.slice(-REMOTE_LOG_VIEW_MAX);
  }
  if (_remoteLogViewPeerId === peerId) _appendRemoteLogEntries(clean);
  _refreshRemoteLogUi(peerId, true);
}

function onRemoteLogEnd(peerId, reason) {
  var session = _remoteLogSessions.get(peerId);
  if (!session) return;
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  session.state = 'ended';
  session.note = reason === 'expired' ? 'Session expired on their device.'
    : reason === 'left' ? 'They left the room.'
    : reason === 'peer-gone' ? 'The link to that peer dropped.'
    : 'They stopped sharing.';
  _refreshRemoteLogUi(peerId);
}

// Host receives a viewer's control message about `targetId`: answer for itself,
// otherwise relay to the target.
function handleLogControlAtHost(requesterId, targetId, type, fromPseudo) {
  var self = peer && peer.id;
  if (!targetId || targetId === self) {
    if (type === 'log-session-request') handleLogSessionRequest(requesterId, fromPseudo);
    else handleLogSessionStop(requesterId);
    return;
  }
  var tc = connections.get(targetId);
  if (!tc || !tc.data) return;
  var rc = connections.get(requesterId);
  sendDataIfOpen(tc.data, {
    type: type,
    peerId: targetId,
    from: requesterId,
    // Prefer the roster's name for the requester over their own claim.
    fromPseudo: (rc && rc.pseudo) || sanitizeLogPseudo(fromPseudo) || null
  });
}

// Target -> viewer, seen by the host: relay when the request came from another
// peer, otherwise the host is the viewer and handles it itself.
function handleLogReplyAtHost(targetId, msg) {
  if (msg.from && msg.from !== (peer && peer.id)) {
    var rc = connections.get(msg.from);
    if (rc && rc.data) sendDataIfOpen(rc.data, Object.assign({}, msg, { peerId: targetId }));
    return;
  }
  handleLogReplyMessage(targetId, msg);
}

// Dispatch a target's reply (response / entries / end) arriving at the viewer.
function handleLogReplyMessage(peerId, msg) {
  if (msg.type === 'log-session-response') onRemoteLogResponse(peerId, !!msg.granted, msg.reason);
  else if (msg.type === 'log-session-end')  onRemoteLogEnd(peerId, msg.reason);
  else if (msg.type === 'log-entries')      onRemoteLogEntries(peerId, msg.entries);
}

// A peer disappeared: end anything pointed at it in both directions.
function noteLogPeerGone(peerId) {
  if (!peerId) return;
  if (_logSharePrompt && _logSharePrompt.requesterId === peerId) dismissLogConsentPrompt();
  if (_logShare && _logShare.requesterId === peerId) stopLogSharing('peer-gone');
  var session = _remoteLogSessions.get(peerId);
  if (session && (session.state === 'requesting' || session.state === 'active')) {
    onRemoteLogEnd(peerId, 'peer-gone');
  }
}

function resetRemoteLogState() {
  dismissLogConsentPrompt();
  stopLogSharing('left');
  _logDeclineCooldown.clear();
  _remoteLogSessions.forEach(function(s) { if (s.timer) clearTimeout(s.timer); });
  _remoteLogSessions.clear();
  closeRemoteLogPanel();
}

// --- Viewer UI ---------------------------------------------------------------

function _remoteLogButton(label, onClick) {
  var btn = document.createElement('button');
  btn.className = 'audio-check-btn remote-log-btn';
  btn.textContent = label;
  btn.addEventListener('click', function(e) { e.stopPropagation(); onClick(); });
  return btn;
}

// The device-info popover's log section. Sessions live outside the popover, so
// closing it (which updatePeerList does routinely) never stops a stream.
function _buildRemoteLogSection(peerId) {
  var wrap = document.createElement('div');
  wrap.className = 'remote-log';

  var head = document.createElement('div');
  head.className = 'di-section';
  head.textContent = '🪵 Debug logs';
  wrap.appendChild(head);

  var session = _remoteLogSessions.get(peerId);
  var state = session ? session.state : 'idle';
  var count = session ? session.entries.length : 0;

  if (state === 'requesting') {
    var pending = document.createElement('div');
    pending.className = 'audio-check-pending';
    pending.textContent = 'Waiting for them to allow it…';
    wrap.appendChild(pending);
    wrap.appendChild(_remoteLogButton('Cancel', function() { stopRemoteLogs(peerId); }));
    return wrap;
  }

  if (state === 'active') {
    var live = document.createElement('div');
    live.className = 'remote-log-live';
    live.textContent = '● Streaming — ' + count + ' line' + (count === 1 ? '' : 's');
    wrap.appendChild(live);
    wrap.appendChild(_remoteLogButton('Open log', function() { showRemoteLogPanel(peerId); }));
    wrap.appendChild(_remoteLogButton('Stop', function() { stopRemoteLogs(peerId); }));
    return wrap;
  }

  wrap.appendChild(_remoteLogButton(count ? 'Request again' : 'Request debug logs', function() {
    requestRemoteLogs(peerId);
  }));
  if (count) {
    wrap.appendChild(_remoteLogButton('Open log (' + count + ')', function() { showRemoteLogPanel(peerId); }));
  }
  var note = document.createElement('div');
  note.className = 'remote-log-hint';
  note.textContent = (session && session.note)
    ? session.note + ' They must allow it on their device.'
    : 'They must allow it on their device first.';
  wrap.appendChild(note);
  return wrap;
}

function _refreshRemoteLogUi(peerId, entriesOnly) {
  if (_remoteLogViewPeerId === peerId) _updateRemoteLogPanelStatus();
  if (entriesOnly) return;
  if (_deviceInfoPeerId && _deviceInfoPeerId === peerId) _refreshDeviceInfoPopover();
}

function showRemoteLogPanel(peerId) {
  var panel = document.getElementById('remote-log-panel');
  if (!panel) return;
  _remoteLogViewPeerId = peerId;
  var title = document.getElementById('remote-log-title');
  if (title) title.textContent = '🪵 ' + peerDisplayName(peerId);
  var entries = document.getElementById('remote-log-entries');
  if (entries) {
    entries.innerHTML = '';
    var session = _remoteLogSessions.get(peerId);
    (session ? session.entries : []).slice(-REMOTE_LOG_VIEW_MAX).forEach(function(e) {
      appendDevLogEntryToContainer(entries, e);
    });
  }
  panel.classList.remove('hidden');
  _updateRemoteLogPanelStatus();
}

function closeRemoteLogPanel() {
  var panel = document.getElementById('remote-log-panel');
  if (panel) panel.classList.add('hidden');
  _remoteLogViewPeerId = null;
}

function _appendRemoteLogEntries(entries) {
  var container = document.getElementById('remote-log-entries');
  if (!container) return;
  entries.forEach(function(e) { appendDevLogEntryToContainer(container, e); });
}

function _updateRemoteLogPanelStatus() {
  var status = document.getElementById('remote-log-status');
  if (!status) return;
  var session = _remoteLogViewPeerId ? _remoteLogSessions.get(_remoteLogViewPeerId) : null;
  if (!session) { status.textContent = ''; return; }
  var count = session.entries.length;
  status.textContent = (session.state === 'active' ? '● live' : session.state === 'requesting' ? 'waiting' : 'ended')
    + ' · ' + count + ' line' + (count === 1 ? '' : 's');
  status.classList.toggle('live', session.state === 'active');
}

function remoteLogAsText(peerId) {
  var session = _remoteLogSessions.get(peerId);
  if (!session) return '';
  return session.entries.map(function(e) {
    return e.t + '  ' + (e.lvl === 'info' ? '' : e.lvl.toUpperCase() + ' ') + e.msg;
  }).join('\n');
}

// The self row has no single peer link, so summarize the WebRTC link stats
// across all current connections (mean RTT, worst packet loss) — this is what
// lets the Network section show latency/loss on your own row too.
function _aggregateLinkStats() {
  var rtts = [], losses = [], outLosses = [];
  connections.forEach(function(c) {
    if (!c || !c.webrtcStats) return;
    if (typeof c.webrtcStats.rttMs === 'number') rtts.push(c.webrtcStats.rttMs);
    if (typeof c.webrtcStats.lossPercent === 'number') losses.push(c.webrtcStats.lossPercent);
    if (typeof c.webrtcStats.outLossPercent === 'number') outLosses.push(c.webrtcStats.outLossPercent);
  });
  if (!rtts.length && !losses.length && !outLosses.length) return null;
  var stats = {};
  if (rtts.length) stats.rttMs = Math.round(rtts.reduce(function(a, b) { return a + b; }, 0) / rtts.length);
  if (losses.length) stats.lossPercent = Math.max.apply(null, losses);
  if (outLosses.length) stats.outLossPercent = Math.max.apply(null, outLosses);
  return stats;
}

function _fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _diRow(label, value) {
  var row = document.createElement('div');
  row.className = 'di-row';
  var k = document.createElement('span');
  k.className = 'di-key';
  k.textContent = label;
  var v = document.createElement('span');
  v.className = 'di-val';
  v.textContent = (value === null || value === undefined || value === '') ? '—' : String(value);
  row.appendChild(k);
  row.appendChild(v);
  return row;
}

function _diSection(icon, title) {
  var h = document.createElement('div');
  h.className = 'di-section';
  h.textContent = icon + ' ' + title;
  return h;
}

// Build the panel body from a self-reported snapshot merged with locally-known
// WebRTC link stats (rtt / packet loss) the viewer measured for that peer.
function _renderDeviceInfo(container, info, wstats) {
  container.innerHTML = '';
  var d = (info && info.device) || {};
  var a = (info && info.audio) || {};
  var n = (info && info.network) || {};
  var bat = n.battery || {};

  container.appendChild(_diSection('📱', 'Device'));
  var deviceLine = d.type || null;
  if (d.type && d.arch) deviceLine = d.type + ' · ' + d.arch;
  container.appendChild(_diRow('Type', deviceLine));
  container.appendChild(_diRow('OS', d.os ? (d.os + (d.osVersion ? ' ' + d.osVersion : '')) : null));
  container.appendChild(_diRow('App', d.setup ? (d.setup + (d.appVersion ? ' · v' + d.appVersion : '')) : null));
  container.appendChild(_diRow('Timezone', d.timezone));
  container.appendChild(_diRow('CPU', d.cpuApp != null ? (d.cpuApp + '% / ' + d.cpuTotal + '%')
    : (d.cores != null ? d.cores + ' cores (usage N/A)' : 'N/A')));
  var memStr = null;
  if (d.memApp != null || d.memTotal != null) {
    memStr = (d.memApp != null ? _fmtBytes(d.memApp) : '—') + ' / ' + (d.memTotal != null ? _fmtBytes(d.memTotal) : '—');
  }
  container.appendChild(_diRow('Memory', memStr));

  container.appendChild(_diSection('🎤', 'Audio'));
  container.appendChild(_diRow('Microphone', a.micName ? (a.micName + (a.micConnection ? ' · ' + a.micConnection : '')) : (a.micName === null ? 'Not acquired' : null)));
  container.appendChild(_diRow('Headset', a.headset === true ? 'Yes' : a.headset === false ? 'No' : null));
  container.appendChild(_diRow('Sample rate', a.sampleRate ? (a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0) + ' kHz' : null));
  container.appendChild(_diRow('Channels', a.channels === 1 ? 'Mono' : a.channels === 2 ? 'Stereo' : a.channels ? a.channels + ' ch' : null));
  container.appendChild(_diRow('Volume', typeof a.volume === 'number' ? Math.round(a.volume * 100) + '%' : null));

  container.appendChild(_diSection('🌐', 'Network'));
  container.appendChild(_diRow('Connection', n.connType));
  container.appendChild(_diRow('Signal', n.signal));
  var latency = (wstats && typeof wstats.rttMs === 'number') ? wstats.rttMs + ' ms (link)'
    : (typeof n.rttMs === 'number' ? n.rttMs + ' ms' : null);
  container.appendChild(_diRow('Latency', latency));
  // Both directions: "in" is what we fail to receive, "out" is what the peer
  // reports missing from the stream we send it (i.e. why they can't hear us).
  var lossParts = [];
  if (wstats && typeof wstats.lossPercent === 'number') lossParts.push('↓ ' + wstats.lossPercent.toFixed(1) + '%');
  if (wstats && typeof wstats.outLossPercent === 'number') lossParts.push('↑ ' + wstats.outLossPercent.toFixed(1) + '%');
  container.appendChild(_diRow('Packet loss', lossParts.length ? lossParts.join(' · ') : null));
  var batStr = null;
  if (bat.present) {
    batStr = bat.level + '%' + (bat.charging ? ' ⚡ charging' : '')
      + (bat.lowPower ? ' · low power' : '')
      + (bat.background ? ' · background' : '');
  } else if (bat.lowPower) {
    batStr = 'Low power mode';
  }
  container.appendChild(_diRow('Battery', batStr));
}

function _refreshDeviceInfoPopover() {
  var popover = document.getElementById('device-info-popover');
  if (!popover) return;
  var body = popover.querySelector('.di-body');
  if (!body) return;
  var isSelf = _deviceInfoPeerId === 'self';

  if (isSelf) {
    // The sharing preference gates our own device too — when off, this device
    // neither collects nor shows diagnostics, so the toggle has a visible effect.
    if (!isDeviceInfoSharingEnabled()) {
      body.innerHTML = '';
      var off = document.createElement('div');
      off.className = 'di-empty';
      off.textContent = 'Device sharing is off. Turn on “Share device info in dev mode” in Settings → Advanced to collect diagnostics.';
      body.appendChild(off);
      return;
    }
    collectDeviceInfo().then(function(info) {
      if (_deviceInfoPeerId !== 'self') return;
      _renderDeviceInfo(body, info, _aggregateLinkStats());
    });
    return;
  }

  var conn = connections.get(_deviceInfoPeerId);
  var stored = conn && conn.deviceInfo;
  var wstats = conn && conn.webrtcStats;
  var info = stored && stored.info ? stored.info : null;

  // Always render — even before the peer's self-report arrives or when it's
  // declined — so the viewer still sees the link stats (latency/packet loss) it
  // measured locally for this peer, rather than a blank "requesting" panel.
  _renderDeviceInfo(body, info, wstats);

  var note = null;
  if (stored && stored.declined) {
    note = 'This peer has device sharing turned off — showing link stats only.';
  } else if (!info) {
    note = 'Requesting device info…';
  }
  if (note) {
    var el = document.createElement('div');
    el.className = 'di-empty';
    el.style.marginTop = '8px';
    el.textContent = note;
    body.appendChild(el);
  }

  body.appendChild(_buildAudioCheckSection(_deviceInfoPeerId));
  body.appendChild(_buildRemoteLogSection(_deviceInfoPeerId));
}

// "Can you hear me?" — the one thing local stats can never answer.
function _buildAudioCheckSection(peerId) {
  var wrap = document.createElement('div');
  wrap.className = 'audio-check';

  var head = document.createElement('div');
  head.className = 'di-section';
  head.textContent = '🔊 Can they hear me?';
  wrap.appendChild(head);

  var active = _audioCheck && _audioCheck.peerId === peerId;
  var result = active ? _audioCheck.result : null;

  if (active && !result) {
    var pending = document.createElement('div');
    pending.className = 'audio-check-pending';
    pending.textContent = 'Speak now — testing…';
    wrap.appendChild(pending);
    return wrap;
  }

  var btn = document.createElement('button');
  btn.className = 'audio-check-btn';
  btn.textContent = result ? 'Test again' : 'Run check';
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    startAudioCheck(peerId);
  });
  wrap.appendChild(btn);

  if (result) {
    var verdict = document.createElement('div');
    verdict.className = 'audio-check-verdict ac-' + result.status;
    var icon = { good: '✓', choppy: '⚠', bad: '✕', unheard: '✕', silent: '⚠', error: '—' }[result.status] || '—';
    verdict.textContent = icon + ' ' + result.headline;
    wrap.appendChild(verdict);

    var detail = document.createElement('div');
    detail.className = 'audio-check-detail';
    detail.textContent = result.detail;
    wrap.appendChild(detail);

    // The raw numbers behind the verdict, so it can be second-guessed.
    var r = _audioCheck && _audioCheck.report;
    if (r && r.ok) {
      wrap.appendChild(_diRow('Filled in', r.samples ? (r.concealed / r.samples * 100).toFixed(1) + '%' : null));
      wrap.appendChild(_diRow('Dropouts', r.concealmentEvents != null ? String(r.concealmentEvents) : null));
      wrap.appendChild(_diRow('Their buffer', r.jitterBufferMs != null ? r.jitterBufferMs + ' ms' : null));
      wrap.appendChild(_diRow('Packets', r.packets != null ? r.packets + ' (' + (r.packetsLost || 0) + ' lost)' : null));
    }
  }
  return wrap;
}

function showDeviceInfoPopover(peerId, anchorEl, isSelf) {
  closeDeviceInfoPopover();
  closeStatsPopover();
  _deviceInfoPeerId = isSelf ? 'self' : peerId;

  var popover = document.createElement('div');
  popover.id = 'device-info-popover';
  popover.className = 'device-info-popover';

  var title = document.createElement('div');
  title.className = 'di-title';
  if (isSelf) {
    title.textContent = displayPseudoForSelf() + ' (you)';
  } else {
    var conn = connections.get(peerId);
    title.textContent = (conn && conn.pseudo) || shortId(peerId);
  }
  popover.appendChild(title);

  var body = document.createElement('div');
  body.className = 'di-body';
  popover.appendChild(body);

  document.body.appendChild(popover);

  // Position against the anchor, capped to the space actually available there
  // (260px = width from CSS). This panel keeps growing — device + audio +
  // network + audio check + debug logs — so it must scroll inside the viewport
  // rather than run off the bottom of a phone screen.
  _positionAnchoredPopover(popover, anchorEl, 260);

  _refreshDeviceInfoPopover();
  if (!isSelf) {
    requestDeviceInfo(peerId);
    // Collect fresh WebRTC link stats immediately (getStats works on every
    // engine, incl. WebKit) so latency/packet loss show without waiting for the
    // 5s poll — this is what fills the Network section on Safari/WKWebView peers.
    var lc = connections.get(peerId);
    if (lc) {
      try {
        _collectPeerStats(peerId, lc).then(function() {
          if (_deviceInfoPeerId === peerId) _refreshDeviceInfoPopover();
        });
      } catch (_) {}
    }
  }

  setTimeout(function() {
    document.addEventListener('click', _onDocClickDismissDeviceInfo, { capture: true, once: true });
  }, 0);
}

function _onDocClickDismissDeviceInfo(e) {
  var popover = document.getElementById('device-info-popover');
  if (popover && popover.contains(e.target)) {
    setTimeout(function() {
      document.addEventListener('click', _onDocClickDismissDeviceInfo, { capture: true, once: true });
    }, 0);
    return;
  }
  closeDeviceInfoPopover();
}

function closeDeviceInfoPopover() {
  var existing = document.getElementById('device-info-popover');
  if (existing) existing.remove();
  _deviceInfoPeerId = null;
  document.removeEventListener('click', _onDocClickDismissDeviceInfo, { capture: true });
}


function updatePeerList() {
  closeStatsPopover();
  closeDeviceInfoPopover();
  // Every membership change already funnels through here (join, leave, host
  // migration), and this is a memoized no-op unless the count actually moved.
  reconcileVideoTopologyForRoster();
  const list = $('peers-list');
  list.innerHTML = '';
  const deputyPeerId = roomCode ? currentDeputyId() : null;
  const showPeerUuids = isDevModeEnabled();
  const showDeviceInfo = deviceInfoButtonVisible();

  if (IS_TINY_EMBED) {
    // Singleton tooltip shown on click/touch for all peer chips
    var _tinyTooltipEl = null;
    var _tinyTooltipTimer = null;
    function showTinyTooltip(anchor, text) {
      if (!_tinyTooltipEl) {
        _tinyTooltipEl = document.createElement('div');
        _tinyTooltipEl.className = 'tiny-tooltip';
        document.body.appendChild(_tinyTooltipEl);
        document.addEventListener('click', function() {
          if (_tinyTooltipEl) _tinyTooltipEl.style.display = 'none';
          clearTimeout(_tinyTooltipTimer);
        });
      }
      clearTimeout(_tinyTooltipTimer);
      _tinyTooltipEl.textContent = text;
      _tinyTooltipEl.style.display = 'block';
      // position above the chip, horizontally centered
      var rect = anchor.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top - 6;
      _tinyTooltipEl.style.left = x + 'px';
      _tinyTooltipEl.style.top = y + 'px';
      _tinyTooltipEl.style.transform = 'translateX(-50%) translateY(-100%)';
      _tinyTooltipTimer = setTimeout(function() {
        if (_tinyTooltipEl) _tinyTooltipEl.style.display = 'none';
      }, 2500);
    }

    var addTinyItem = function(id, label, self, talking, labelColor) {
      var div = document.createElement('div');
      div.id = 'peer-item-' + id;
      div.className = 'peer-item peer-item-compact' + (self ? ' peer-self' : '') + (talking ? ' talking' : '');

      if (self) {
        var micIcon = document.createElement('span');
        micIcon.className = 'peer-mic-icon';
        micIcon.setAttribute('aria-hidden', 'true');
        micIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg><span class="ptt-emoji" aria-hidden="true">🎙️</span>';
        
        // Wrap mic icon and add loading spinner for tiny mode
        var micWrapper = document.createElement('div');
        micWrapper.className = 'peer-mic-wrapper';
        micWrapper.appendChild(micIcon);
        
        if (IS_TINY_EMBED) {
          var spinner = document.createElement('div');
          spinner.className = 'peer-mic-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          micWrapper.appendChild(spinner);
        }
        
        div.appendChild(micWrapper);
        var acquiringLabel = document.createElement('span');
        acquiringLabel.className = 'acquiring-mic-label';
        acquiringLabel.textContent = 'Acquiring mic…';
        div.appendChild(acquiringLabel);
        div.addEventListener('pointerdown', function(e) {
          if (e.button !== undefined && e.button !== 0) return;
          if (editingSelfPseudo) return;
          e.preventDefault();
          e.stopPropagation();
          setTalking(true);
        });
        div.addEventListener('pointerup', function(e) {
          if (editingSelfPseudo) return;
          e.preventDefault();
          e.stopPropagation();
          setTalking(false);
        });
        div.addEventListener('pointercancel', function(e) {
          if (editingSelfPseudo) return;
          e.preventDefault();
          e.stopPropagation();
          setTalking(false);
        });
      } else {
        div.addEventListener('click', function(e) {
          e.stopPropagation();
          showTinyTooltip(div, label);
        });
      }

      if (self && editingSelfPseudo) {
        var input = document.createElement('textarea');
        input.rows = 2;
        input.maxLength = 20;
        input.className = 'peer-name-inline';
        input.placeholder = 'Your name…';
        input.value = myPseudo;
        input.addEventListener('click', function(e) { e.stopPropagation(); });
        input.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            editingSelfPseudo = false;
            setMyPseudo(input.value.replace(/\s+/g, ' ').trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            editingSelfPseudo = false;
            updatePeerList();
          }
        });
        input.addEventListener('blur', function() {
          editingSelfPseudo = false;
          setMyPseudo(input.value.replace(/\s+/g, ' ').trim());
        });
        div.appendChild(input);
        setTimeout(function() { input.focus(); input.select(); }, 0);
      } else {
        var txt = document.createElement('span');
        txt.className = 'peer-compact-label';
        txt.textContent = label;
        txt.title = label;
        if (labelColor) txt.style.color = labelColor;
        div.appendChild(txt);
        if (self) {
          var editBtn = document.createElement('button');
          editBtn.className = 'btn-icon peer-edit-btn';
          editBtn.title = 'Edit name';
          editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
          editBtn.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
          editBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            editingSelfPseudo = true;
            updatePeerList();
          });
          div.appendChild(editBtn);
        }
      }

      return div;
    };

    list.classList.add('tiny-peers-list');
    var selfChip = addTinyItem('self', displayPseudoForSelf(), true, isTalking || freeHandMode, pseudoColorForSelf());
    if (selfChip) list.appendChild(selfChip);
    var othersWrap = document.createElement('div');
    othersWrap.className = 'tiny-peers-others';
    connections.forEach(function(conn, id) {
      var peerChip = addTinyItem(id, conn.pseudo || shortId(id), false, conn.talking || false, conn.pseudoColor || null);
      if (peerChip) othersWrap.appendChild(peerChip);
    });
    list.appendChild(othersWrap);
    if (IS_TINY_EMBED) {
      requestAnimationFrame(function() { syncTinyPeerLabelCrowding(othersWrap); });
    }

    // ── Compact mode extras ────────────────────────────────────────────
    // Peer count — appended to the list as a flex sibling right of the self chip.
    // List is rebuilt each call so we create fresh every time.
    if (connections.size > 0) {
      var tinyCountEl = document.createElement('div');
      tinyCountEl.className = 'tiny-peer-count';
      var _peerWord = connections.size === 1 ? 'peer' : 'peers';
      tinyCountEl.innerHTML = connections.size + ' ' + _peerWord + '<br>connected';
      list.appendChild(tinyCountEl);
    }

    // Current-speaker status — persistent in the panel (below the chip row).
    var tinyStatusEl = $('tiny-compact-status');
    if (!tinyStatusEl) {
      tinyStatusEl = document.createElement('div');
      tinyStatusEl.id = 'tiny-compact-status';
      tinyStatusEl.className = 'tiny-compact-status';
      tinyStatusEl.setAttribute('aria-live', 'polite');
      var _panel = $('room-peers-panel');
      if (_panel) _panel.appendChild(tinyStatusEl);
    }
    updateTinyCompactStatus();

    if (window._updateTinyPeersToggle) window._updateTinyPeersToggle();
    if (_isIframe && inRoom) {
      var peers = [{
        id: peer ? peer.id : 'self',
        pseudo: displayPseudoForSelf(),
        pseudoColor: pseudoColorForSelf(),
        self: true,
        talking: isTalking || freeHandMode
      }];
      connections.forEach(function(conn, id) {
        peers.push({
          id: id,
          pseudo: conn.pseudo || shortId(id),
          pseudoColor: conn.pseudoColor || null,
          self: false,
          talking: conn.talking || false
        });
      });
      iframeEmit({ type: 'peers', peers: peers });
    }
    return;
  }

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

  const appendDeviceInfoButton = function(parent, peerId, isSelf) {
    if (!showDeviceInfo) return;
    const btn = document.createElement('button');
    btn.className = 'btn-icon peer-info-btn';
    btn.title = 'Device diagnostics';
    btn.setAttribute('aria-label', 'Show device info');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var key = isSelf ? 'self' : peerId;
      if (_deviceInfoPeerId === key) { closeDeviceInfoPopover(); return; }
      showDeviceInfoPopover(peerId, btn, isSelf);
    });
    parent.appendChild(btn);
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

  const addItem = (id, label, self, talking, editable, actualPeerId, labelColor) => {
    const div = document.createElement('div');
    div.id = 'peer-item-' + id;
    div.className = 'peer-item' + (self ? ' peer-self' : '') + (talking ? ' talking' : '');
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
      const nameEl = document.createElement('span');
      nameEl.textContent = label;
      if (labelColor) nameEl.style.color = labelColor;
      nameWrap.appendChild(nameEl);
      appendPeerRole(nameWrap, actualPeerId);
      peerMain.appendChild(nameWrap);
      appendPeerUuid(peerMain, actualPeerId);
      div.appendChild(peerMain);
      appendCopyPeerButton(div, actualPeerId, label);
      appendDeviceInfoButton(div, actualPeerId, false);
      appendPeerVideoButtons(div, actualPeerId, false);
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
    name.textContent = displayPseudoForSelf();
    if (labelColor) name.style.color = labelColor;
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
    appendDeviceInfoButton(div, peer && peer.id, true);
    appendPeerVideoButtons(div, peer && peer.id, true);
    list.appendChild(div);
  };

  addItem('self', displayPseudoForSelf(), true, isTalking || freeHandMode, true, peer && peer.id, pseudoColorForSelf());
  connections.forEach((conn, id) => addItem(
    id,
    conn.pseudo || shortId(id),
    false,
    conn.talking || false,
    false,
    id,
    conn.pseudoColor || null
  ));

  // Invite nudge — shown when no other peers are in the room yet
  if (connections.size === 0 && !IS_TINY_EMBED) {
    var nudge = document.createElement('div');
    nudge.className = 'room-invite-nudge';
    var nudgeText = document.createElement('span');
    nudgeText.className = 'room-invite-nudge-text';
    nudgeText.textContent = 'Share your invite link to invite others';
    nudge.appendChild(nudgeText);

    var inviteUrl = roomInviteUrl(roomDisplayCode() || roomCode);
    if (navigator.share && IS_NATIVE_MOBILE) {
      var shareBtn = document.createElement('button');
      shareBtn.className = 'btn btn-secondary btn-sm';
      shareBtn.textContent = 'Share invite';
      shareBtn.addEventListener('click', function() {
        shareInviteLink(inviteUrl);
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

  appendMicPermissionHint(list);

  // Notify the parent iframe of the current peer list
  if (_isIframe && inRoom) {
    var peers = [{
      id: peer ? peer.id : 'self',
      pseudo: displayPseudoForSelf(),
      pseudoColor: pseudoColorForSelf(),
      self: true,
      talking: isTalking || freeHandMode
    }];
    connections.forEach(function(conn, id) {
      peers.push({
        id: id,
        pseudo: conn.pseudo || shortId(id),
        pseudoColor: conn.pseudoColor || null,
        self: false,
        talking: conn.talking || false
      });
    });
    iframeEmit({ type: 'peers', peers: peers });
  }

  if (window._updateTinyPeersToggle) window._updateTinyPeersToggle();
  updateRoomSizeWarning();
  // Single wiring point for the stage: every video/screen state change already
  // refreshes the roster, so hanging the stage off the same tick keeps the two
  // from ever drifting. updateVideoStage() never calls back into this, and it
  // reconciles rather than rebuilds, so the frequent calls are cheap.
  updateVideoStage();
}

// Voxal audio is a full WebRTC mesh, so connections grow ~O(n²) and a single
// speaker uploads one stream per listener. Warn as a room gets large: a soft
// notice at ROOM_SOFT_WARN_PEERS, a stronger one at ROOM_HARD_WARN_PEERS. These
// are advisory only — joining is never blocked.
var ROOM_SOFT_WARN_PEERS = 8;
var ROOM_HARD_WARN_PEERS = 12;

function updateRoomSizeWarning() {
  var el = document.getElementById('room-size-warning');
  if (!el) return;
  // Count what the user actually sees in the roster (self + others).
  var count = document.querySelectorAll('#peers-list .peer-item').length;
  if (IS_TINY_EMBED || !inRoom || count < ROOM_SOFT_WARN_PEERS) {
    el.classList.add('hidden');
    el.classList.remove('hard');
    return;
  }
  if (count >= ROOM_HARD_WARN_PEERS) {
    el.textContent = '⚠ ' + count + ' people connected. Voxal is peer-to-peer — at this size audio may break up or drop. Consider splitting into smaller rooms.';
    el.classList.add('hard');
  } else {
    el.textContent = '⚠ ' + count + ' people connected. Audio may start to degrade beyond ' + ROOM_HARD_WARN_PEERS + ' on a peer-to-peer mesh.';
    el.classList.remove('hard');
  }
  el.classList.remove('hidden');
}

function updateTinyCompactStatus() {
  if (!IS_TINY_EMBED) return;
  var statusEl = $('tiny-compact-status');
  if (!statusEl) return;
  var speaker = '';
  // DOM .talking class is set synchronously and is the authoritative source
  var talkingChip = document.querySelector('#peers-list .peer-item-compact.talking:not(.peer-self)');
  if (talkingChip) {
    var labelEl = talkingChip.querySelector('.peer-compact-label');
    speaker = labelEl ? labelEl.textContent.trim() : '';
  }
  // Fallback: check connection map
  if (!speaker) {
    connections.forEach(function(conn, id) {
      if (!speaker && conn.talking) {
        speaker = conn.pseudo || shortId(id);
      }
    });
  }
  if (speaker) {
    clearTimeout(statusEl._hideTimer);
    statusEl._hideTimer = null;
    statusEl.textContent = speaker + ' is speaking';
  } else {
    clearTimeout(statusEl._hideTimer);
    statusEl._hideTimer = setTimeout(function() {
      statusEl.textContent = '';
    }, 1500);
  }
}

// Both talking setters deliberately avoid a full updatePeerList() — they run on
// every press/release. The video tile is toggled the same targeted way, so the
// speaking ring costs one classList call rather than a roster rebuild.
function setStageTileTalking(tileKey, active) {
  const tile = document.querySelector('#video-stage [data-key="' + cssEscapeAttr(tileKey) + '"]');
  if (tile) tile.classList.toggle('talking', active);
}

function updatePeerTalking(peerId, active) {
  const conn = connections.get(peerId);
  if (conn) conn.talking = active;
  const el = document.getElementById('peer-item-' + peerId);
  if (el) el.classList.toggle('talking', active);
  setStageTileTalking('camera:' + peerId, active);
  // Speaking order is what decides who holds a grid slot once the room outgrows
  // the stage, so it is recorded here rather than on the next roster tick.
  noteStageSpeaker(peerId, active);
  updateTinyCompactStatus();
}

function updateSelfTalking(active) {
  const el = document.getElementById('peer-item-self');
  if (el) el.classList.toggle('talking', active);
  setStageTileTalking('camera:self', active);
  noteStageSpeaker((peer && peer.id) || 'self', active);
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

      // Fetch the raw WASM bytes rather than a pre-compiled WebAssembly.Module:
      // structured-cloning a compiled Module across a MessagePort into an
      // AudioWorkletGlobalScope is not reliably supported everywhere (notably
      // WebKitGTK) — the postMessage below doesn't throw, but the worklet never
      // receives it, so initRNNoise() always hits its timeout. A transferable
      // ArrayBuffer has none of that risk, and WebAssembly.instantiate() can
      // compile it directly inside the worklet.
      const wasmBytes = await fetch('assets/rnnoise.wasm').then((r) => r.arrayBuffer());

      // Create the worklet node
      // channelCount/-Mode pinned explicitly: the default 'max' mode would let a
      // stereo microphone through as two channels, and the worklet only ever
      // reads input[0] — the right channel would be dropped silently. 'explicit'
      // downmixes to mono first, so nothing is lost.
      _rnnoiseNode = new AudioWorkletNode(_rnnoiseCtx, 'rnnoise-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      });

      // Send compiled WASM module to the worklet thread
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('RNNoise init timeout')), 5000);
        _rnnoiseNode.port.onmessage = (e) => {
          if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
          else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
        };
        _rnnoiseNode.port.postMessage({ type: 'wasm-bytes', bytes: wasmBytes }, [wasmBytes]);
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
  // Defaults to 2 channels, which would upmix the worklet's mono output back to
  // stereo for no benefit — opusSdpTransform forces stereo=0 downstream anyway.
  const dest = _rnnoiseCtx.createMediaStreamDestination({ channelCount: 1 });
  dest.channelCount = 1;

  source.connect(_rnnoiseNode);
  _rnnoiseNode.connect(dest);

  // Read back by stopMicStreamFully() — the graph shares one _rnnoiseNode, so a
  // stream discarded without that teardown leaves its source summed into the
  // node and its raw mic track running.
  dest.stream._rnnoiseSource = source;
  dest.stream._rnnoiseDest = dest;
  dest.stream._rnnoiseOriginal = stream;

  return dest.stream;
}

// Release a stream returned by getMicStream(), whichever path produced it.
//
// A raw stream is just its tracks. An RNNoise stream is the DESTINATION of a
// three-node graph whose source is a *separate* getUserMedia stream, so stopping
// only the tracks you can see leaves the real microphone running (indicator lit,
// device held) and leaves the source permanently summed into the shared worklet
// node — two mic acquisitions would otherwise mix into one RNNoise instance.
function stopMicStreamFully(s) {
  if (!s) return;
  if (s._rnnoiseSource) {
    try { s._rnnoiseSource.disconnect(); } catch (_) {}
  }
  if (s._rnnoiseDest && _rnnoiseNode) {
    // One-argument form: a bare _rnnoiseNode.disconnect() would sever every
    // other consumer of the shared node.
    try { _rnnoiseNode.disconnect(s._rnnoiseDest); } catch (_) {}
  }
  if (s._rnnoiseOriginal) {
    s._rnnoiseOriginal.getTracks().forEach(function(t) { t.stop(); });
  }
  s.getTracks().forEach(function(t) { t.stop(); });
  s._rnnoiseSource = null;
  s._rnnoiseDest = null;
  s._rnnoiseOriginal = null;
}

// --- Camera background effects ------------------------------------------------
//
// The video counterpart to applyRNNoise() above, and it obeys the same
// contract: the stream we hand back is a *processed* stream that wraps the real
// capture, and it carries the original on itself so teardown can find it. The
// whole pipeline lives in video-effects.js, which index.html loads before this
// file; everything here is the glue.
//
// With the effect off nothing is constructed and localVideoStream stays the raw
// getUserMedia stream, so a user who never turns this on pays nothing for it —
// not a canvas, not a fetch, not a frame of work.

// The key itself is declared in video-effects.js and nowhere else — see the
// note in CLAUDE.md. Mirror the reference rather than the literal so the two
// can never drift, and tolerate the script being absent.
var VIDEO_BACKGROUND_STORAGE_KEY =
  (typeof VideoEffects === 'undefined') ? null : VideoEffects.STORAGE_KEY;

function videoBackgroundMode() {
  return (typeof VideoEffects === 'undefined') ? 'off' : VideoEffects.readMode();
}

function videoEffectsAvailable() {
  return typeof VideoEffects !== 'undefined' && VideoEffects.isSupported();
}

// Wrap a freshly acquired camera stream if a background is selected. Falls back
// to the raw stream on any failure — a background effect is a nicety, and it
// must never be the reason a camera fails to share.
async function maybeApplyVideoEffects(rawStream) {
  var mode = videoBackgroundMode();
  if (mode === 'off' || !videoEffectsAvailable()) return rawStream;
  try {
    return await VideoEffects.wrap(rawStream, mode);
  } catch (e) {
    if (VideoEffects.isAbort(e)) {
      devLog('[Video] Background effect download cancelled', 'info');
      VideoEffects.writeMode('off');
      syncVideoBackgroundControls();
      return rawStream;
    }
    devLog('[Video] Background effect failed to start: ' + (e && e.message ? e.message : String(e)), 'warn');
    showCopyToast('Background effect unavailable — sharing without it');
    return rawStream;
  }
}

// The real capture behind a stream, whether or not it is wrapped. Anything that
// wants the camera itself — to stop it, to disable it, to read its settings —
// must go through here rather than assuming localVideoStream is the device.
function rawCameraStream(stream) {
  return (stream && stream._effectsOriginal) || stream;
}

function getNoiseSuppressionMode() {
  var stored = localStorage.getItem(NOISE_SUPPRESSION_KEY);
  if (stored) return stored;
  // RNNoise's real-time 48kHz AudioWorklet underruns on phones/tablets — in
  // native WebViews and mobile browsers alike — and crackles the outgoing
  // audio. The OS voice-processing (echoCancellation) handles suppression
  // cleanly there, so default mobile to 'browser'.
  return IS_MOBILE_DEVICE ? 'browser' : 'rnnoise';
}

function syncNoiseSuppressionControls() {
  var mode = getNoiseSuppressionMode();
  document.querySelectorAll('input[name="noise-suppression-mode"]').forEach(function(input) {
    input.checked = (input.value === mode);
  });
  applyNoiseSuppressionRecommendation();
}

// The "(Recommended)" badge lives on RNNoise (best quality) in the static HTML,
// which is right for desktop. On mobile (native or browser) RNNoise sizzles, so
// move the badge to the Standard (system) option instead. Idempotent.
function applyNoiseSuppressionRecommendation() {
  var recommended = IS_MOBILE_DEVICE ? 'browser' : 'rnnoise';
  document.querySelectorAll('input[name="noise-suppression-mode"]').forEach(function(input) {
    var title = input.closest('.noise-card') && input.closest('.noise-card').querySelector('.noise-card-title');
    if (!title) return;
    var wantBadge = (input.value === recommended);
    var hasBadge = !!title.querySelector('em');
    if (wantBadge === hasBadge) return;
    var base = title.textContent.replace(/\s*\(Recommended\)\s*$/, '').trim();
    if (wantBadge) {
      title.textContent = base + ' ';
      var em = document.createElement('em');
      em.textContent = '(Recommended)';
      title.appendChild(em);
    } else {
      title.textContent = base;
    }
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

// Capture was previously uncapped, so a 1080p/60 camera was encoded once per
// peer. `ideal`/`max` only — never `exact`: KNOWLEDGE/learning.md records that
// forcing fixed dimensions renders a split frame on Desk View / virtual cameras,
// so the OS must stay free to pick its native profile and merely be asked to
// stay at or below 720p30.
var CAMERA_CAPTURE_CAP = {
  width:     { ideal: 1280, max: 1280 },
  height:    { ideal: 720,  max: 720  },
  frameRate: { ideal: 30,   max: 30   }
};

// A phone pays for capture twice — battery to encode, and data to send one
// encode per peer — so it captures smaller. Same `ideal`/`max` rule as above.
var CAMERA_CAPTURE_CAP_MOBILE = {
  width:     { ideal: 640, max: 640 },
  height:    { ideal: 360, max: 360 },
  frameRate: { ideal: 24,  max: 24  }
};

function cameraCaptureCap() {
  return IS_MOBILE_DEVICE ? CAMERA_CAPTURE_CAP_MOBILE : CAMERA_CAPTURE_CAP;
}

// Which way the phone's camera is pointing. Session state, never persisted —
// like the audio route, every call starts on the front camera.
var _cameraFacing = 'user';

function selectedCameraConstraints() {
  var cameraId = selectedCameraDeviceId();
  var base;
  if (IS_MOBILE_DEVICE) {
    // A phone's device list is not stable enough for a pinned deviceId to mean
    // anything across sessions, and the flip button is expressed as a facing
    // mode — so on mobile the facing mode wins over any stored camera id.
    base = { facingMode: _cameraFacing };
  } else {
    base = cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'user' };
  }
  return Object.assign({}, base, cameraCaptureCap());
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

// --- Microphone permission persistence hint ----------------------------------
//
// A web page CANNOT persist a getUserMedia grant: the browser owns it, keyed by
// origin, and there is no API to extend or restore it. All we can usefully do is
// name the exact control that makes it stick — "check your browser settings" is
// what the user already tried.
//
// iOS is the sharp case and the one this was reported on. WebKit scopes the
// grant to the DOCUMENT, so a reload always re-prompts regardless of what was
// chosen; the per-site Website Settings toggle is the only thing that survives.

// Last-resort signal only — see micPermissionState() for the real ones. A grant
// the browser already remembered resolves in milliseconds; one that needed a
// human to find and tap "Allow" cannot. Threshold set deliberately high:
// nagging someone whose browser IS remembering is the bad failure.
const MIC_PROMPT_MIN_MS = 800;

// Will the next getUserMedia() put a prompt on screen, or be granted silently?
//
// Two signals, best first:
//
//  1. navigator.permissions.query({name:'microphone'}) — exact, but Chromium
//     only. WebKit and Firefox both reject the descriptor, and WebKit is where
//     this actually matters.
//
//  2. Device LABELS. enumerateDevices() only exposes a label when the document
//     holds a capture permission, so an unlabelled microphone means no grant yet
//     and therefore a prompt. This works on Safari — and on iOS the labels go
//     back to empty after every reload, exactly mirroring the document-scoped
//     grant that causes the re-prompting in the first place.
//
// Returns 'granted' | 'prompt' | 'denied' | 'unknown'. Never throws: this runs
// on the critical path of acquiring the mic and must not be able to break it.
async function micPermissionState() {
  try {
    var status = await navigator.permissions.query({ name: 'microphone' });
    if (status && status.state) return status.state;
  } catch (_) { /* not supported here — fall through to the label probe */ }
  try {
    var devices = await navigator.mediaDevices.enumerateDevices();
    var mics = devices.filter(function(d) { return d.kind === 'audioinput'; });
    // No microphone at all says nothing about permission.
    if (!mics.length) return 'unknown';
    return mics.some(function(d) { return !!d.label; }) ? 'granted' : 'prompt';
  } catch (_) {}
  return 'unknown';
}

function micPermissionHint() {
  // Native builds hold an OS-level permission that already persists. Pointing
  // at browser settings there would be advice about a browser not in use.
  if (!IS_PLAIN_WEB) return null;

  var ua = navigator.userAgent || '';
  // The Mac+touch test catches iPadOS Safari, whose default UA claims macOS.
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (/Mac/.test(navigator.platform || '') && (navigator.maxTouchPoints || 0) > 1);

  // Every browser on iOS is WebKit underneath, so they all behave like Safari
  // and all expose the same control. Check this before the Safari branch.
  if (isIOS) {
    return {
      platform: 'ios',
      html: 'Tap <strong>aA</strong> in the address bar → <strong>Website Settings</strong> → ' +
            '<strong>Microphone</strong> → <strong>Allow</strong>.',
    };
  }
  if (/Firefox\//.test(ua)) {
    return {
      platform: 'firefox',
      html: 'Tick <strong>Remember this decision</strong> in the permission prompt.',
    };
  }
  // Chromium browsers put "Safari" in their UA too, so desktop Safari can only
  // be identified by the ABSENCE of the Chromium markers.
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) {
    return {
      platform: 'safari',
      html: 'Safari menu → <strong>Settings for This Website…</strong> → ' +
            '<strong>Microphone</strong> → <strong>Allow</strong>.',
    };
  }
  if (/Chrome|Chromium|Edg\//.test(ua)) {
    if (/Android/.test(ua)) {
      return {
        platform: 'chromium-android',
        html: 'Tap the icon left of the address bar → <strong>Permissions</strong> → ' +
              '<strong>Microphone</strong> → <strong>Allow</strong>.',
      };
    }
    return {
      platform: 'chromium',
      html: 'Choose <strong>Allow on every visit</strong> in the prompt, or click the icon left ' +
            'of the address bar → <strong>Microphone</strong> → <strong>Allow</strong>.',
    };
  }
  return {
    platform: 'unknown',
    html: 'Look for a “remember” or “always allow” option in your browser’s microphone prompt, ' +
          'or in its site settings for this page.',
  };
}

function micPromptCount() {
  return parseInt(localStorage.getItem(MIC_PROMPT_COUNT_KEY), 10) || 0;
}

// Was the microphone actually REQUESTED during this page load, or was it already
// granted when we asked? That is the difference between "your browser keeps
// forgetting" and "your browser is doing its job", and it gates the hint
// entirely: someone whose grant is now remembered must not be told how to make
// it stick, however many times they were prompted in the past.
//
// Per page load on purpose — it is exactly the question the user asked, and on
// iOS the answer legitimately changes between one reload and the next.
var _micPromptedThisSession = false;

function shouldShowMicPermissionHint() {
  if (!micPermissionHint()) return false;
  if (IS_TINY_EMBED) return false; // nowhere to put it, and not the embedder's problem
  if (localStorage.getItem(MIC_HINT_DISMISSED_KEY)) return false;
  // Granted without asking — there is nothing to fix, so say nothing. This is
  // what stops the hint outliving the setting change that solved it.
  if (!_micPromptedThisSession) return false;
  // One prompt is just a first visit working as designed. Two separate ones mean
  // the browser is not keeping the grant, which is the only case worth a word.
  return micPromptCount() >= 2;
}

// Called after every successful acquisition, with how long it took and what the
// permission state was BEFORE the call. Only a real prompt counts — a silent
// re-grant means the browser is doing its job and there is nothing to advise.
function noteMicAcquisition(elapsedMs, stateBefore) {
  if (!IS_PLAIN_WEB) return;

  var prompted;
  if (stateBefore === 'granted')     prompted = false; // no prompt was possible
  else if (stateBefore === 'prompt') prompted = true;  // it had to ask
  else prompted = elapsedMs >= MIC_PROMPT_MIN_MS;      // 'unknown' → guess from timing

  if (!prompted) return;
  _micPromptedThisSession = true;
  localStorage.setItem(MIC_PROMPT_COUNT_KEY, String(micPromptCount() + 1));
  renderMicPermissionHint();
}

// Appended to the peer list, next to the invite nudge — the room's existing home
// for a line of advice. It started life in the PTT column, where it pushed the
// talk button out of place; the peer list has room and is already where
// transient guidance lives.
function appendMicPermissionHint(list) {
  if (!shouldShowMicPermissionHint()) return;

  var row = document.createElement('div');
  row.id = 'mic-hint-banner';
  row.className = 'room-invite-nudge mic-hint-row';
  row.setAttribute('role', 'status');

  var text = document.createElement('span');
  text.className = 'room-invite-nudge-text mic-hint-text';
  // Every string in micPermissionHint() is a literal authored above — no user
  // input is interpolated, so the markup is safe to assign.
  text.innerHTML = '<span class="mic-hint-lead">💡always allow microphone:</span> ' +
                   micPermissionHint().html;
  row.appendChild(text);

  var close = document.createElement('button');
  close.id = 'btn-dismiss-mic-hint';
  close.className = 'btn-icon mic-hint-close';
  close.textContent = '✕';
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', dismissMicPermissionHint);
  row.appendChild(close);

  list.appendChild(row);
}

// The hint is rebuilt as part of the peer list, so refreshing it means
// re-rendering that list rather than toggling a static element.
function renderMicPermissionHint() {
  if (inRoom) updatePeerList();
}

// The ✕ on the hint and the Advanced toggle are the same preference, so both go
// through here rather than each writing the key themselves.
function micHintEnabled() { return !localStorage.getItem(MIC_HINT_DISMISSED_KEY); }

function setMicHintEnabled(on) {
  if (on) localStorage.removeItem(MIC_HINT_DISMISSED_KEY);
  else localStorage.setItem(MIC_HINT_DISMISSED_KEY, '1');
  syncMicHintToggle();
  renderMicPermissionHint();
}

function syncMicHintToggle() {
  // No hint for this platform means no preference worth offering — a native
  // build's OS permission persists, so there is nothing to advise about.
  var applicable = !!micPermissionHint();
  var row  = document.getElementById('mic-hint-toggle-row');
  var note = document.getElementById('mic-hint-toggle-note');
  if (row)  row.classList.toggle('hidden', !applicable);
  if (note) note.classList.toggle('hidden', !applicable);

  var btn = document.getElementById('toggle-mic-hint-modal');
  if (!btn) return;
  var on = micHintEnabled();
  btn.setAttribute('aria-checked', String(on));
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'ON' : 'OFF';
}

function dismissMicPermissionHint() {
  setMicHintEnabled(false);
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

  // Has to be sampled BEFORE the call — afterwards the state is 'granted' either
  // way and the distinction is gone.
  const stateBefore = await micPermissionState();
  const askedAt = Date.now();
  const rawStream = await getUserMedia({
    audio: audioConstraints,
    video: false,
  });
  noteMicAcquisition(Date.now() - askedAt, stateBefore);

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

// --- Audio output routing: loudspeaker vs earpiece (mobile) ------------------
//
// `setSinkId` above cannot do this: it is unimplemented on Android (browser and
// WebView alike — a platform limitation, not a Chrome gap) and WebKit never
// shipped it, so on mobile it is not an option at all. The two mechanisms that
// do work are probed once per page load:
//
//   'native'           — the Capacitor `AudioRoute` plugin (iOS AVAudioSession /
//                        Android AudioManager). Only present in a store build.
//   'web-audiosession' — `navigator.audioSession` (WebKit). Setting the type to
//                        'play-and-record' declares the page a call, which is
//                        what moves output to the receiver; 'auto' hands routing
//                        back to the platform and lands on the loudspeaker.
//   null               — no way to switch (Android web, desktop). The button
//                        stays hidden rather than offering a control that cannot
//                        work.
const AUDIO_ROUTE_SPEAKER  = 'speaker';
const AUDIO_ROUTE_EARPIECE = 'earpiece';

// Session state, deliberately never persisted: every room starts on the speaker.
var _audioRoute = AUDIO_ROUTE_SPEAKER;
var _audioRouteBackend;              // undefined = unprobed, null = unsupported
var _audioRouteProbe = null;

function nativeAudioRoutePlugin() {
  var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioRoute;
  return (plugin && typeof plugin.setRoute === 'function') ? plugin : null;
}

function webAudioSessionSupported() {
  try {
    return !!(navigator.audioSession && 'type' in navigator.audioSession);
  } catch (_) {
    return false;
  }
}

function normalizeAudioRoute(route) {
  return route === AUDIO_ROUTE_EARPIECE ? AUDIO_ROUTE_EARPIECE : AUDIO_ROUTE_SPEAKER;
}

function probeAudioRouteBackend() {
  if (_audioRouteBackend !== undefined) return Promise.resolve(_audioRouteBackend);
  if (_audioRouteProbe) return _audioRouteProbe;
  _audioRouteProbe = (async function() {
    // Capgo ships this JS over the air, so a native binary older than the bundle
    // exposes `Capacitor.Plugins` without these methods. Only the method actually
    // answering proves the native side is there — a presence check would not.
    var plugin = IS_NATIVE_MOBILE ? nativeAudioRoutePlugin() : null;
    if (plugin) {
      try {
        await plugin.getRoute();
        _audioRouteBackend = 'native';
        return _audioRouteBackend;
      } catch (e) {
        console.warn('[Audio route] native plugin unavailable:', e && e.message);
      }
    }
    // Desktop Safari also exposes navigator.audioSession, where an "Earpiece"
    // button would be nonsense — gate on the device, not just the API.
    _audioRouteBackend = (IS_MOBILE_DEVICE && webAudioSessionSupported()) ? 'web-audiosession' : null;
    return _audioRouteBackend;
  })();
  return _audioRouteProbe;
}

async function applyAudioRouteToBackend(route) {
  var backend = await probeAudioRouteBackend();
  if (!backend) return false;
  if (backend === 'native') {
    var plugin = nativeAudioRoutePlugin();
    if (!plugin) return false;
    await plugin.setRoute({ route: route });
    return true;
  }
  navigator.audioSession.type = (route === AUDIO_ROUTE_EARPIECE) ? 'play-and-record' : 'auto';
  return true;
}

// Only commits `_audioRoute` once the platform actually accepted the switch, so a
// rejected call leaves the button telling the truth about where the audio is.
async function setAudioRoute(route) {
  var next = normalizeAudioRoute(route);
  try {
    if (!(await applyAudioRouteToBackend(next))) return false;
  } catch (e) {
    console.warn('[Audio route] failed to switch to ' + next + ':', e && e.message);
    updateAudioRouteUI();
    return false;
  }
  _audioRoute = next;
  updateAudioRouteUI();
  return true;
}

function toggleAudioRoute() {
  return setAudioRoute(_audioRoute === AUDIO_ROUTE_EARPIECE ? AUDIO_ROUTE_SPEAKER : AUDIO_ROUTE_EARPIECE);
}

function updateAudioRouteUI() {
  var btn = document.getElementById('btn-audio-route');
  if (!btn) return;
  btn.classList.toggle('hidden', !_audioRouteBackend);
  if (!_audioRouteBackend) return;
  var onEarpiece = _audioRoute === AUDIO_ROUTE_EARPIECE;
  btn.classList.toggle('active', onEarpiece);
  btn.setAttribute('aria-pressed', String(onEarpiece));
  // The label names where the audio *is*; the title names what a tap would do.
  btn.title = onEarpiece ? 'Switch to speaker' : 'Switch to earpiece';
  var label = btn.querySelector('.audio-route-label');
  if (label) label.textContent = onEarpiece ? 'Earpiece' : 'Speaker';
  var speakerIcon = btn.querySelector('.audio-route-icon-speaker');
  if (speakerIcon) speakerIcon.classList.toggle('hidden', onEarpiece);
  var earpieceIcon = btn.querySelector('.audio-route-icon-earpiece');
  if (earpieceIcon) earpieceIcon.classList.toggle('hidden', !onEarpiece);
}

// Every room starts on the loudspeaker. Call this from the two real join paths
// only — NOT from the host-migration `publishRoomActive(true)` sites, which fire
// mid-call and would yank a user back to the speaker because the host died.
async function initAudioRouteForRoom() {
  _audioRoute = AUDIO_ROUTE_SPEAKER;
  updateAudioRouteUI();
  var backend = await probeAudioRouteBackend();
  updateAudioRouteUI();
  if (!backend) return;
  await setAudioRoute(AUDIO_ROUTE_SPEAKER);
}

// WebKit reconfigures its audio session around getUserMedia, so acquiring or
// swapping the microphone can silently reset the output route. Re-assert
// whatever the user chose rather than letting the platform quietly win.
function reassertAudioRoute() {
  if (!_audioRouteBackend) return;
  Promise.resolve(applyAudioRouteToBackend(_audioRoute)).catch(function(e) {
    console.warn('[Audio route] re-assert failed:', e && e.message);
  });
}

// Hand the device back to the loudspeaker on the way out, so the next sound the
// user plays in any app isn't stuck on the receiver.
function resetAudioRouteOnLeave() {
  var wasEarpiece = _audioRoute === AUDIO_ROUTE_EARPIECE;
  _audioRoute = AUDIO_ROUTE_SPEAKER;
  updateAudioRouteUI();
  if (!wasEarpiece) return;
  Promise.resolve(applyAudioRouteToBackend(AUDIO_ROUTE_SPEAKER)).catch(function(e) {
    console.warn('[Audio route] failed to restore the speaker on leave:', e && e.message);
  });
}

var _modalSettingsSidebarInit = false;
function initModalSettingsSidebar() {
  var sidebar = document.getElementById('modal-settings-sidebar');
  var scrollRoot = document.querySelector('#modal-settings .modal-settings-scrollable');
  if (!sidebar || !scrollRoot) return;

  var buttons = Array.from(sidebar.querySelectorAll('.prefs-nav-btn[data-target]'));
  if (!buttons.length) return;

  var cards = Array.from(scrollRoot.querySelectorAll('.settings-card[id]'));
  var advancedDetails = document.getElementById('turn-details');
  var mq = window.matchMedia('(min-width: 861px)');
  var activeId = buttons[0].dataset.target || (cards[0] && cards[0].id) || '';
  var lastAccordionExpandedId = activeId;
  var wasSidebarVisible = mq.matches;

  function setActive(id) {
    buttons.forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.target === id);
    });
  }

  function getCardToggle(card) {
    return card.querySelector(':scope > .settings-card-toggle');
  }

  function ensureCardToggle(card) {
    var toggle = getCardToggle(card);
    if (toggle) return toggle;
    var title = card.querySelector(':scope > .settings-group-title');
    if (!title) return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-card-toggle';
    btn.textContent = title.textContent;
    btn.setAttribute('aria-expanded', 'false');
    title.replaceWith(btn);
    return btn;
  }

  function setCardCollapsed(card, collapsed) {
    card.classList.toggle('is-collapsed', !!collapsed);
    var toggle = getCardToggle(card);
    if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function collapseNonAdvancedCards(exceptId) {
    cards.forEach(function(card) {
      if (card.id === 'settings-advanced') return;
      setCardCollapsed(card, card.id !== exceptId);
    });
    if (exceptId) lastAccordionExpandedId = exceptId;
  }

  function bindAccordionIfNeeded() {
    if (sidebar.dataset.accordionBound === '1') return;
    cards.forEach(function(card) {
      if (card.id === 'settings-advanced') return;
      var toggle = ensureCardToggle(card);
      if (!toggle) return;
      toggle.addEventListener('click', function() {
        var isOpen = !card.classList.contains('is-collapsed');
        if (isOpen) {
          setCardCollapsed(card, true);
          activeId = '';
          setActive(activeId);
          return;
        }
        activeId = card.id;
        setActive(activeId);
        collapseNonAdvancedCards(activeId);
        if (advancedDetails) advancedDetails.open = false;
      });
    });
    if (advancedDetails) {
      advancedDetails.addEventListener('toggle', function() {
        if (mq.matches) return;
        if (!advancedDetails.open) return;
        activeId = 'settings-advanced';
        lastAccordionExpandedId = activeId;
        setActive(activeId);
        collapseNonAdvancedCards('');
      });
    }
    sidebar.dataset.accordionBound = '1';
  }

  function applyVisibility() {
    document.body.classList.toggle('modal-sidebar-visible', mq.matches);
    if (!mq.matches) {
      bindAccordionIfNeeded();
      cards.forEach(function(card) {
        card.classList.remove('hidden-by-sidebar');
        if (card.id !== 'settings-advanced') ensureCardToggle(card);
      });
      if (activeId === 'settings-advanced') {
        collapseNonAdvancedCards('');
        if (advancedDetails) advancedDetails.open = true;
        lastAccordionExpandedId = activeId;
      } else {
        collapseNonAdvancedCards(activeId);
        if (advancedDetails) advancedDetails.open = false;
      }
      wasSidebarVisible = false;
      return;
    }

    if (!wasSidebarVisible) {
      if (lastAccordionExpandedId) {
        activeId = lastAccordionExpandedId;
      } else {
        var expanded = cards.find(function(card) {
          return card.id !== 'settings-advanced' && !card.classList.contains('is-collapsed');
        });
        if (expanded) activeId = expanded.id;
        else if (advancedDetails && advancedDetails.open) activeId = 'settings-advanced';
      }
    }

    cards.forEach(function(card) {
      setCardCollapsed(card, false);
      card.classList.toggle('hidden-by-sidebar', card.id !== activeId);
    });
    setActive(activeId);
    if (advancedDetails && activeId !== 'settings-advanced') advancedDetails.open = false;
    wasSidebarVisible = true;
  }

  if (!_modalSettingsSidebarInit) {
    buttons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var targetId = btn.dataset.target;
        if (!targetId) return;
        activeId = targetId;
        setActive(activeId);
        if (mq.matches) {
          cards.forEach(function(card) {
            setCardCollapsed(card, false);
            card.classList.toggle('hidden-by-sidebar', card.id !== activeId);
          });
          if (advancedDetails) advancedDetails.open = (activeId === 'settings-advanced');
        } else {
          if (activeId === 'settings-advanced') {
            if (advancedDetails) advancedDetails.open = true;
            collapseNonAdvancedCards('');
          } else {
            collapseNonAdvancedCards(activeId);
            if (advancedDetails) advancedDetails.open = false;
          }
        }
      });
    });

    if (mq.addEventListener) mq.addEventListener('change', applyVisibility);
    else if (mq.addListener) mq.addListener(applyVisibility);
    _modalSettingsSidebarInit = true;
  }

  applyVisibility();
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
    await stopEchoTest();  // the two tests share the mic and the playback element
    try { await startMicTest(); }
    catch (e) { showCopyToast('Microphone test failed'); console.warn('[Mic test]', e.message); }
  }
}

// --- Network echo test -------------------------------------------------------
//
// The mic test above records the RAW microphone, so it proves capture works and
// nothing else. This one sends the audio out over the real network and records
// what comes BACK: mic -> Opus -> NAT -> TURN relay -> decode. That round trip is
// what a remote listener actually hears, so replaying it answers "what do I
// sound like to other people?" without needing a second person.
//
// Both PeerConnections are forced to `relay`, so ICE cannot shortcut through
// host candidates and quietly test nothing. That also makes the test a genuine
// probe of the relay path anonymous rooms fall back to.

const ECHO_MAX_RECORD_MS = 15000;
const ECHO_RELAY_TIMEOUT_MS = 8000;
// RMS below this in the returned audio means nothing audible came back.
const ECHO_MIN_RMS = 0.005;

var _echo = null; // { pcs, stream, recorder, chunks, ctx, analyser, raf, audioEl, … }

// --- Network-test bridge (desktop preferences window) -------------------------
//
// On Tauri, settings are a SEPARATE WebviewWindow loading settings.html, and the
// main window's settings modal is unreachable — so "Test over network" simply
// did not exist on desktop. settings.html cannot run the test itself: it has no
// module system, so fetchIceServers(), opusSdpTransform() and the RNNoise
// capture path would all have to be duplicated by hand (~400 lines plus a WASM
// worklet), and the duplicated copies are exactly how settings.html's constants
// drifted from main.js before.
//
// Instead the preferences window asks THIS window to run the real thing, over
// the localStorage + `storage` event channel already used to sync settings
// between the two. Request in, state out; one implementation.
const ECHO_BRIDGE_REQUEST_KEY = 'echo-test-request'; // {action:'start'|'stop', at}
const ECHO_BRIDGE_STATE_KEY   = 'echo-test-state';   // {running, text, kind, at}

// Only desktop has a second window to talk to; everywhere else this would be
// writes nobody reads.
function echoBridgeActive() { return !!window.__TAURI__; }

// --- Network-usage bridge (desktop preferences window) ------------------------
//
// Same shape and same reason as the echo bridge above: settings.html has no
// access to `connections` or any RTCPeerConnection, so it cannot measure
// anything. This window samples (see _collectBandwidthSample) and publishes; the
// preferences window subscribes and renders.
//
// Publishing is gated on an explicit request so a closed panel costs nothing —
// but SAMPLING is not, so the history is already 10 minutes deep when the panel
// opens rather than starting from empty.
const NETWORK_USAGE_REQUEST_KEY = 'net-usage-request'; // {watching:boolean, at}
const NETWORK_USAGE_STATE_KEY   = 'net-usage-state';   // {inRoom, current, history, at}

var _networkUsageWatchers = false;

function setNetworkUsageWatching(on) {
  _networkUsageWatchers = !!on;
  if (_networkUsageWatchers) publishNetworkUsage();
}

function publishNetworkUsage() {
  if (!_networkUsageWatchers || !echoBridgeActive()) return;
  try {
    // `at` keeps consecutive writes distinct — an identical value fires no
    // storage event at all, and two quiet ticks in a row are identical.
    localStorage.setItem(NETWORK_USAGE_STATE_KEY, JSON.stringify(networkUsageSnapshot()));
  } catch (_) {}
}

function publishEchoBridgeState(text, kind) {
  if (!echoBridgeActive()) return;
  try {
    localStorage.setItem(ECHO_BRIDGE_STATE_KEY, JSON.stringify({
      running: echoTestRunning(),
      text: text || '',
      kind: kind || '',
      at: Date.now(),
    }));
  } catch (_) {}
}

function echoStatus(text, kind) {
  publishEchoBridgeState(text, kind);
  var el = document.getElementById('echo-test-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'echo-test-status' + (kind ? ' ac-' + kind : '');
  el.classList.toggle('hidden', !text);
}

function echoTestRunning() { return !!_echo; }

function countRelayServers(iceServers) {
  return (iceServers || []).filter(function(s) {
    var urls = s && s.urls;
    if (Array.isArray(urls)) return urls.some(function(u) { return /^turns?:/.test(u); });
    return typeof urls === 'string' && /^turns?:/.test(urls);
  }).length;
}

// "No relay" has several very different causes, and telling them apart is the
// difference between "change a setting" and "the relay is gone". The STUN/TURN
// error code from `onicecandidateerror` is what distinguishes them:
//   401/403 — the relay answered and REJECTED us: credentials dead or revoked.
//   701     — could not even establish the connection: server down or blocked.
//   nothing — packets vanished with no reply, which is what a UDP block looks like.
function diagnoseRelayFailure(relayServerCount, iceErrors, usingDefaultRelay) {
  if (!relayServerCount) {
    return 'No relay server is configured. Set Fallback relay to Automatic or Custom in Settings → Advanced.';
  }
  var errors = iceErrors || [];
  var codes = errors.map(function(e) { return e.code; });
  var plural = relayServerCount === 1 ? '1 relay server' : relayServerCount + ' relay servers';

  // If we fell through to the built-in relay because our own credential endpoint
  // failed, that is the actual fault and the actual fix — say that first.
  if (usingDefaultRelay && _anonTurnError) {
    return 'Could not reach the TURN credential service (' + _anonTurnError + '), so the ' +
      'app fell back to the retired public relay. If you self-host, check that ' +
      '/api/ice-servers is deployed and CF_TURN_TOKEN_ID / CF_TURN_TOKEN_SECRET are set.';
  }
  // The built-in fallback is Open Relay's shared `openrelayproject` credentials,
  // which metered.ca has RETIRED in favour of per-account API keys. That is a
  // known-dead default, so say so outright instead of blaming the network.
  if (usingDefaultRelay) {
    return 'The built-in public relay no longer works — its shared credentials have been ' +
      'retired. Add free metered.ca credentials (20 GB/month) or your own relay under ' +
      'Settings → Advanced.';
  }
  if (codes.indexOf(401) !== -1 || codes.indexOf(403) !== -1) {
    return 'Tried ' + plural + '; the relay rejected our credentials (error ' +
      (codes.indexOf(401) !== -1 ? '401' : '403') + '). Check the username and password ' +
      'under Settings → Advanced → Fallback relay.';
  }
  if (codes.indexOf(701) !== -1) {
    return 'Tried ' + plural + '; could not connect to the relay (error 701). It may be ' +
      'down, or your network blocks it. A relay on TCP/443 or TLS usually gets through.';
  }
  if (errors.length) {
    var first = errors[0];
    return 'Tried ' + plural + '; the relay returned error ' + first.code +
      (first.text ? ' (' + first.text + ')' : '') + '.';
  }
  return 'Tried ' + plural + ' with no reply at all — UDP is most likely blocked on ' +
    'this network. A relay reachable over TCP/443 or TLS is needed.';
}

// True when the relays in play are the built-in (retired) public ones rather
// than anything the user or their org configured.
function usingDefaultFallbackRelay(iceServers) {
  var configured = (iceServers || []).filter(function(s) {
    var u = s && s.urls;
    return typeof u === 'string' && /^turns?:/.test(u);
  }).map(function(s) { return s.urls; });
  if (!configured.length) return false;
  var defaults = DEFAULT_FALLBACK_TURN.map(function(s) { return s.urls; });
  return configured.every(function(u) { return defaults.indexOf(u) !== -1; });
}

// Verdict for the loopback. Shares the peer check's concealment thresholds — the
// same measurement means the same thing — but not its wording, since here the
// listener is you. The playback branch is skipped: it is meaningless on a sink
// we muted ourselves.
function summarizeEchoTest(report, rms) {
  if (!report || !report.ok) {
    return { status: 'error', headline: 'No audio came back',
             detail: 'The loopback connected but no audio was received.' };
  }
  if (typeof rms === 'number' && rms < ECHO_MIN_RMS) {
    return { status: 'silent', headline: 'Nothing was heard',
             detail: 'The round trip worked but carried silence — check your microphone and speak during the test.' };
  }
  var conceal = report.samples > 0 ? report.concealed / report.samples : 0;
  var pct = (conceal * 100).toFixed(1);
  if (conceal < AUDIO_CHECK_CONCEAL_GOOD) {
    return { status: 'good', headline: 'You would sound clear',
             detail: 'Only ' + pct + '% of audio needed filling in.', concealPercent: conceal * 100 };
  }
  if (conceal < AUDIO_CHECK_CONCEAL_POOR) {
    return { status: 'choppy', headline: 'You would sound choppy',
             detail: pct + '% of audio had to be filled in across ' + report.concealmentEvents + ' dropout(s).',
             concealPercent: conceal * 100 };
  }
  return { status: 'bad', headline: 'You would sound badly broken',
           detail: pct + '% of audio had to be filled in across ' + report.concealmentEvents + ' dropout(s).',
           concealPercent: conceal * 100 };
}

// Which ICE path the loopback actually took, so the verdict can say whether this
// really exercised the relay.
async function echoSelectedIceType(pc) {
  try {
    var reports = await pc.getStats();
    var pairs = {}, locals = {}, chosen = null;
    reports.forEach(function(r) {
      if (r.type === 'candidate-pair' && r.nominated) {
        pairs[r.id] = r;
        if (!chosen || r.state === 'succeeded') chosen = r.id;
      }
      if (r.type === 'local-candidate') locals[r.id] = r;
    });
    var pair = chosen ? pairs[chosen] : null;
    var cand = pair ? locals[pair.localCandidateId] : null;
    return cand ? cand.candidateType : null;
  } catch (_) { return null; }
}

async function startEchoTest(options) {
  options = options || {};
  if (_echo) return;
  if (inRoom) {
    // applyRNNoise shares one AudioContext + worklet node, so a second mic
    // source would mix into the live call. Use the per-peer audio check instead.
    echoStatus('Leave the room first — use the “Can they hear me?” check while in a call.', 'error');
    return;
  }
  await stopMicTest();
  clearMicTestPlayback();
  echoStatus('Connecting…');

  var iceServers = await fetchIceServers();
  // 'relay' in production; tests drive the same code path with 'all' because CI
  // has no TURN server.
  var policy = options.iceTransportPolicy || 'relay';
  var cfg = { iceServers: iceServers, iceTransportPolicy: policy };
  var sender = new RTCPeerConnection(cfg);
  var receiver = new RTCPeerConnection(cfg);

  _echo = { sender: sender, receiver: receiver, chunks: [], relayCandidates: 0,
            relayServers: countRelayServers(iceServers),
            usingDefaultRelay: usingDefaultFallbackRelay(iceServers), iceErrors: [] };
  var echo = _echo;
  // Re-announce now that _echo exists: the 'Connecting…' above was published
  // with running:false, which would leave the remote button labelled "Test over
  // network" while a test was in fact starting.
  publishEchoBridgeState('Connecting…');

  // The STUN/TURN error code is the only thing that says WHY no relay appeared;
  // without it "no relay reachable" is unactionable. Chromium-only, so guard.
  var noteIceError = function(e) {
    if (!e || typeof e.errorCode !== 'number') return;
    var already = echo.iceErrors.some(function(x) { return x.code === e.errorCode && x.url === e.url; });
    if (!already) echo.iceErrors.push({ url: e.url, code: e.errorCode, text: e.errorText || '' });
  };
  sender.onicecandidateerror = noteIceError;
  receiver.onicecandidateerror = noteIceError;

  sender.onicecandidate = function(e) {
    if (!e.candidate) return;
    if (e.candidate.candidate.indexOf('typ relay') !== -1) echo.relayCandidates++;
    receiver.addIceCandidate(e.candidate).catch(function() {});
  };
  receiver.onicecandidate = function(e) {
    if (e.candidate) sender.addIceCandidate(e.candidate).catch(function() {});
  };

  var returned = new Promise(function(resolve) { receiver.ontrack = function(e) { resolve(e.streams[0]); }; });

  try {
    echo.stream = await getMicStream();
    echo.stream.getAudioTracks().forEach(function(t) { sender.addTrack(t, echo.stream); });

    var offer = await sender.createOffer();
    offer.sdp = opusSdpTransform(offer.sdp);
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    var answer = await receiver.createAnswer();
    answer.sdp = opusSdpTransform(answer.sdp);
    await receiver.setLocalDescription(answer);
    await sender.setRemoteDescription(answer);
  } catch (err) {
    await stopEchoTest();
    echoStatus('Could not start the test: ' + err.message, 'error');
    return;
  }

  // `ontrack` fires on NEGOTIATION, not on media flow — it resolves even when
  // ICE never connects and not one packet is ever exchanged. So the stream alone
  // proves nothing; wait until packets actually arrive. That also covers the
  // relay-only-with-no-relay case, which gathers zero candidates and sits in
  // 'new' forever without ever firing 'failed'.
  var stream = await Promise.race([
    returned,
    new Promise(function(resolve) { setTimeout(function() { resolve(null); }, ECHO_RELAY_TIMEOUT_MS); })
  ]);
  if (_echo !== echo) return; // cancelled while connecting

  var flowing = false;
  if (stream) {
    var deadline = Date.now() + ECHO_RELAY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      var probe = await sampleInboundFromPeerConnections([receiver], null);
      if (_echo !== echo) return;
      if (probe && probe.packets > 0) { flowing = true; break; }
      await new Promise(function(r) { setTimeout(r, 250); });
    }
  }

  if (!flowing) {
    var noRelay = policy === 'relay' && echo.relayCandidates === 0;
    var diagnosis = noRelay
      ? diagnoseRelayFailure(echo.relayServers, echo.iceErrors, echo.usingDefaultRelay) : '';
    await stopEchoTest();
    echoStatus(noRelay
      ? 'No TURN relay reachable — audio never left the device. ' + diagnosis +
        ' Peers behind strict firewalls cannot reach you either.'
      : 'The test connected but no audio came back.', 'error');
    return;
  }

  // A muted sink still drives decoding (so inbound-rtp fills) without feeding
  // the speakers back into the mic. It does zero totalAudioEnergy, though, so
  // loudness is measured from an AnalyserNode below instead.
  var audioEl = new Audio();
  audioEl.srcObject = stream;
  audioEl.muted = true;
  audioEl.autoplay = true;
  echo.audioEl = audioEl;

  echo.ctx = new (window.AudioContext || window.webkitAudioContext)();
  var source = echo.ctx.createMediaStreamSource(stream);
  echo.analyser = echo.ctx.createAnalyser();
  echo.analyser.fftSize = 1024;
  source.connect(echo.analyser); // analyser only — never to destination, or it howls
  echo.peakRms = 0;

  echo.before = await sampleInboundFromPeerConnections([receiver], null);

  if (typeof window.MediaRecorder === 'function') {
    try {
      echo.recorder = new MediaRecorder(stream);
      echo.recorder.ondataavailable = function(ev) { if (ev.data && ev.data.size) echo.chunks.push(ev.data); };
      echo.recorder.start();
    } catch (e) {
      echo.recorder = null;
      console.warn('[Echo test] recorder unavailable:', e.message);
    }
  }

  echoStatus('Speak now — recording…');
  var btn = document.getElementById('btn-test-echo');
  if (btn) btn.textContent = 'Stop & Replay';
  var meter = document.getElementById('echo-test-level-fill');
  if (meter && meter.closest('.media-level')) meter.closest('.media-level').classList.remove('hidden');

  var data = new Uint8Array(echo.analyser.fftSize);
  var tick = function() {
    if (_echo !== echo || !echo.analyser) return;
    echo.analyser.getByteTimeDomainData(data);
    var sum = 0;
    for (var i = 0; i < data.length; i++) {
      var centered = (data[i] - 128) / 128;
      sum += centered * centered;
    }
    var rms = Math.sqrt(sum / data.length);
    if (rms > echo.peakRms) echo.peakRms = rms;
    if (meter) meter.style.width = Math.max(0, Math.min(100, Math.round(rms * 220))) + '%';
    echo.raf = requestAnimationFrame(tick);
  };
  tick();

  echo.autoStop = setTimeout(function() { if (_echo === echo) stopEchoTest({ replay: true }); }, ECHO_MAX_RECORD_MS);
}

async function stopEchoTest(options) {
  options = options || {};
  var echo = _echo;
  if (!echo) return;
  _echo = null;

  if (echo.autoStop) clearTimeout(echo.autoStop);
  if (echo.raf) cancelAnimationFrame(echo.raf);

  var blob = null;
  if (echo.recorder && echo.recorder.state !== 'inactive') {
    blob = await new Promise(function(resolve) {
      echo.recorder.onstop = function() {
        resolve(echo.chunks.length ? new Blob(echo.chunks, { type: echo.recorder.mimeType || 'audio/webm' }) : null);
      };
      echo.recorder.stop();
    });
  }

  var verdict = null;
  if (options.replay) {
    var after = await sampleInboundFromPeerConnections([echo.receiver], null);
    var report = buildAudioCheckReport(echo.before, after);
    verdict = summarizeEchoTest(report, echo.peakRms);
    verdict.iceType = await echoSelectedIceType(echo.receiver);
    echo.report = report;
  }

  try { echo.sender.close(); } catch (_) {}
  try { echo.receiver.close(); } catch (_) {}
  stopMicStreamFully(echo.stream);   // came from getMicStream(), so may be RNNoise-wrapped
  if (echo.ctx) echo.ctx.close().catch(function() {});
  if (echo.audioEl) { echo.audioEl.srcObject = null; }

  var btn = document.getElementById('btn-test-echo');
  if (btn) btn.textContent = 'Test over network';
  var meter = document.getElementById('echo-test-level-fill');
  if (meter) {
    meter.style.width = '0%';
    if (meter.closest('.media-level')) meter.closest('.media-level').classList.add('hidden');
  }

  if (options.replay) {
    if (verdict && verdict.iceType === 'relay') {
      _relayVerifiedAt = Date.now();
      if (typeof updateTurnBadge === 'function') updateTurnBadge();
    }
    renderEchoVerdict(verdict, echo.report);
    if (blob) renderMicTestPlayback(blob);
  } else {
    echoStatus('');
  }
}

function renderEchoVerdict(verdict, report) {
  if (!verdict) { echoStatus(''); return; }
  var suffix = '';
  if (verdict.iceType === 'relay') suffix = ' · via TURN relay';
  else if (verdict.iceType) suffix = ' · direct (' + verdict.iceType + '), not relayed';
  if (report && report.ok && report.jitterBufferMs != null) suffix += ' · ' + report.jitterBufferMs + ' ms buffer';
  echoStatus(verdict.headline + ' — ' + verdict.detail + suffix, verdict.status);
}

async function toggleEchoTest() {
  if (_echo) await stopEchoTest({ replay: true });
  else {
    try { await startEchoTest(); }
    catch (e) {
      await stopEchoTest();
      echoStatus('Network test failed: ' + e.message, 'error');
      console.warn('[Echo test]', e.message);
    }
  }
}

function stopCameraPreview() {
  if (_cameraPreviewStream) {
    stopStreamTracks(_cameraPreviewStream);
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
  var rawPreview = await navigator.mediaDevices.getUserMedia({
    video: selectedCameraConstraints(),
    audio: false
  });
  // Show the preview through the chosen background, so the picker in Settings
  // means something outside a call. Not while sharing, though: there is one
  // pipeline, and stealing it would blank the call's outgoing video.
  _cameraPreviewStream = localVideoActive ? rawPreview : await maybeApplyVideoEffects(rawPreview);
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

// True when the MediaConnection this peer opened to us is already carrying our
// current mic track, because `handleIncomingCall` answered it with a live
// `stream`. That connection is full duplex, so opening a second one would make
// us upload the same mic twice to the same peer — the speaker's uplink is the
// mesh's real ceiling, so that alone can chop the audio the peer hears.
function peerAlreadyReceivesOurAudio(conn) {
  var mc = conn && conn.media;
  var pc = mc && !mc.closed ? mc.peerConnection : null;
  if (!pc || typeof pc.getSenders !== 'function') return false;
  var track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
  if (!track || track.readyState !== 'live') return false;
  return pc.getSenders().some(function(sender) { return sender.track === track; });
}

function connectOutgoingAudioToPeers() {
  if (!inRoom || !peer || !stream) return;
  connections.forEach(function(conn, peerId) {
    if (!peerId || peerId === peer.id) return;
    if (conn && conn.audioMediaOut && !conn.audioMediaOut.closed) return;
    if (peerAlreadyReceivesOurAudio(conn)) { applyAudioTuning(conn); return; }
    var call = peer.call(peerId, stream, audioCallOptions());
    if (!call) return;
    call.on('stream', function(remote) {
      attachAudio(peerId, remote);
      applyAudioTuningToPeer(peerId);
    });
    call.on('close', function() {
      var current = connections.get(peerId);
      if (current && current.audioMediaOut === call) {
        current.audioMediaOut = null;
      }
    });
    call.on('error', function(err) { console.warn('[audio-call]', err); });
    var current = connections.get(peerId) || conn;
    connections.set(peerId, Object.assign({}, current, { audioMediaOut: call }));
  });
}

// Swap the microphone track on every live link WITHOUT renegotiating.
//
// A peer can be fed by two MediaConnections — `conn.media` (the call we
// answered, which is full duplex when we had a mic to answer with) and
// `conn.audioMediaOut` (the call we opened) — so both have to be walked, the
// same pair `_collectPeerStats` samples. `replaceTrack` is the right primitive
// here: tearing the calls down and re-running connectOutgoingAudioToPeers()
// would drop audio for the length of a renegotiation and re-open the glare
// window where two peers call each other simultaneously and neither has
// answered yet.
//
// Returns the number of senders actually swapped, so the caller can tell a
// genuine no-op from a silent failure.
async function replaceOutgoingAudioTrack(track) {
  var pcs = [];
  connections.forEach(function(conn) {
    [conn && conn.media, conn && conn.audioMediaOut].forEach(function(mc) {
      if (mc && !mc.closed && mc.peerConnection) pcs.push(mc.peerConnection);
    });
  });

  var swapped = 0;
  for (var i = 0; i < pcs.length; i++) {
    var pc = pcs[i];
    if (typeof pc.getSenders !== 'function') continue;
    var senders = pc.getSenders().filter(function(s) {
      return s.track ? s.track.kind === 'audio' : false;
    });
    for (var j = 0; j < senders.length; j++) {
      if (typeof senders[j].replaceTrack !== 'function') continue;
      try {
        await senders[j].replaceTrack(track);
        swapped++;
      } catch (e) {
        console.warn('[mic-swap] replaceTrack failed:', e.message);
      }
    }
  }
  return swapped;
}

// Re-acquire the microphone with the CURRENT settings and hand it to the live
// call. Without this, `getNoiseSuppressionMode()` and the selected mic device
// are only ever read inside getMicStream(), which runs once per room join — so
// changing either mid-call appeared to do nothing until the next session.
//
// Serialised through `_micAcquirePromise`, the same guard the join-time and
// first-press acquisitions share, so a settings change landing during an
// in-flight acquisition cannot leave the room with two live capture tracks.
// That case needs no swap anyway: the acquisition already in flight has not
// called getMicStream() yet, or is about to read the value we just stored.
var _micReacquirePromise = null;
function reacquireMicForRoom() {
  if (!inRoom || !stream) return Promise.resolve(false);
  if (_micAcquirePromise) return Promise.resolve(false);
  if (_micReacquirePromise) return _micReacquirePromise;

  var previous = stream;
  // PTT gates the mic with `enabled`, not by removing the track, so the new
  // track has to inherit that state or a swap mid-press would mute the speaker
  // (or, worse, unmute a released one).
  var wasEnabled = !!(audioTrack && audioTrack.enabled);

  _micReacquirePromise = (async function() {
    var fresh = await getMicStream();
    // Re-checked after the await: the user may have left the room while the
    // device was starting up.
    if (!inRoom || stream !== previous) {
      stopMicStreamFully(fresh);
      return false;
    }
    var freshTrack = fresh.getAudioTracks()[0];
    if (!freshTrack) {
      stopMicStreamFully(fresh);
      return false;
    }
    freshTrack.enabled = wasEnabled;

    stream = fresh;
    audioTrack = freshTrack;
    var swapped = await replaceOutgoingAudioTrack(freshTrack);
    // No sender to swap means no outgoing audio was wired up yet (a peer joined
    // while we had no mic, say) — fall back to opening the calls normally.
    if (!swapped) connectOutgoingAudioToPeers();
    // Best-effort watchdog only. The swap has already succeeded by this point,
    // so it must not be able to fail it — throwing here would land in the catch
    // below and report a working microphone as broken.
    try { watchMicTrackEnded(fresh); } catch (e) { console.warn('[mic-swap] watchdog:', e.message); }

    stopMicStreamFully(previous);
    devLog('[mic-swap] re-acquired (' + getNoiseSuppressionMode() + '), ' + swapped + ' sender(s) swapped');
    return true;
  })().then(function(ok) {
    _micReacquirePromise = null;
    if (ok && inRoom) reassertAudioRoute();
    return ok;
  }).catch(function(err) {
    _micReacquirePromise = null;
    // The old stream is still live and still wired up — a failed re-acquire
    // must never leave the call mute, so keep using it and just report.
    console.warn('[mic-swap] failed, keeping the previous microphone:', err.message);
    showCopyToast('Could not switch microphone — keeping the current one');
    return false;
  });

  return _micReacquirePromise;
}

// A capture track can die under us without the call ending — most often when
// something else on the machine grabs the device and reconfigures it. Left
// unhandled the room stays "connected" while transmitting nothing, which reads
// to the user as a dead call. Re-acquiring turns that into a blip.
function watchMicTrackEnded(s) {
  var t = s && s._rnnoiseOriginal
    ? s._rnnoiseOriginal.getAudioTracks()[0]
    : (s && s.getAudioTracks ? s.getAudioTracks()[0] : null);
  if (!t) return;
  t.addEventListener('ended', function() {
    if (!inRoom || stream !== s) return;
    devLog('[mic-swap] capture track ended unexpectedly — re-acquiring');
    reacquireMicForRoom();
  }, { once: true });
}

// The tiny embed shows the mic spinner on the self chip rather than in the PTT
// column, which it does not render.
function setTinyMicAcquiring(on) {
  if (!IS_TINY_EMBED) return;
  var selfChip = document.getElementById('peer-item-self');
  if (selfChip) selfChip.classList.toggle('acquiring-mic', !!on);
}

// The ONE place the room's microphone is acquired — both the first PTT press and
// the join-time auto-acquire go through here. They must share
// `_micAcquirePromise`: a press landing while a join-time acquisition is still
// in flight would otherwise start a second getUserMedia and leave the room with
// two live capture tracks.
//
// `reason` is 'press' when the user is waiting on the mic and 'join' when we
// went and got it on their behalf. It only governs how failure is reported: a
// press that fails owes the user an explanation, while a background acquisition
// that fails simply falls back to acquiring on the next press.
//
// A press arriving mid-flight is still honoured — setTalking() has already set
// `_pendingTalkingStart`, and the completion below reads it whichever path
// started the acquisition.
function acquireMicForRoom(reason) {
  if (_micAcquirePromise) return _micAcquirePromise;

  $('ptt-status').textContent = '\u25cf Requesting microphone…';
  if (reason === 'press') setTinyMicAcquiring(true);

  _micAcquirePromise = (async function() {
    var micStream = await getMicStream();
    if (!inRoom || stream) {
      stopMicStreamFully(micStream);
      return false;
    }
    stream = micStream;
    audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = false;
    connectOutgoingAudioToPeers();
    try { watchMicTrackEnded(stream); } catch (e) { console.warn('[mic-swap] watchdog:', e.message); }
    return true;
  })().then(function(ok) {
    _micAcquirePromise = null;
    setTinyMicAcquiring(false);
    // Cleared unconditionally: a press released before the mic arrived would
    // otherwise leave "Requesting microphone…" on screen for good.
    $('ptt-status').textContent = '';
    if (ok && inRoom) reassertAudioRoute();
    if (!ok || !_pendingTalkingStart || !inRoom || freeHandMode) return false;
    applyTalkingState(true);
    return true;
  }).catch(function(err) {
    _micAcquirePromise = null;
    var wanted = _pendingTalkingStart;
    _pendingTalkingStart = false;
    setTinyMicAcquiring(false);
    $('ptt-status').textContent = '';
    // Nobody asked for this one, so nobody gets an error dialog about it; the
    // next press will try again and report properly if it fails too.
    if (!wanted) {
      console.warn('[auto-mic] Failed to acquire mic: ' + err.message);
      return false;
    }
    if (isMicDeniedError(err)) {
      showMicDeniedError(function() { setTalking(true); });
    } else {
      showError(err.message);
    }
    return false;
  });

  return _micAcquirePromise;
}

// Should we go and get the microphone as soon as we are in the room?
//
// Full-size Voxal always does: the user opened the app themselves, so a prompt
// is expected, and holding the track means the first press transmits from its
// first syllable instead of losing a word to device start-up.
//
// A tiny embed deliberately does not — an iframe the user never interacted with
// throwing a permission prompt at them is hostile, so it waits for the first
// press. But that trade only buys something while a prompt is actually
// possible. Once the browser holds a persisted grant ("Allow on every visit",
// or iOS's per-site Website Settings toggle), getUserMedia() resolves silently
// and staying lazy costs the start of the first press for nothing. So ask what
// the next call would do, and acquire eagerly when nothing would be shown.
//
// Only a definite 'granted' qualifies: 'unknown' (no Permissions API and no
// labelled device to probe) must stay lazy, because guessing wrong there
// produces exactly the unprompted prompt this is avoiding.
async function shouldAcquireMicOnJoin() {
  if (!IS_TINY_EMBED) return true;
  return (await micPermissionState()) === 'granted';
}

// Called from both join paths (create and join). Fire-and-forget: nothing in the
// room waits on the microphone.
function autoAcquireMicOnJoin() {
  if (stream || _micAcquirePromise) return;
  shouldAcquireMicOnJoin().then(function(eager) {
    // Re-checked after the await: the user may have left, or pressed the talk
    // button and started the acquisition themselves, while we were probing.
    if (!eager || !inRoom || stream || _micAcquirePromise) return;
    acquireMicForRoom('join');
  });
}

function setTalking(active) {
  if (!inRoom || freeHandMode) return;
  _pendingTalkingStart = !!active;
  if (!active) {
    if (!audioTrack) {
      isTalking = false;
      $('ptt-btn').classList.remove('active');
      $('ptt-status').textContent = '';
      updateSelfTalking(false);
      iframeEmit({ type: 'talking', active: false });
      releaseAudioFocus();
      nativePTTStop();
      return;
    }
    applyTalkingState(false);
    return;
  }
  if (audioTrack) {
    applyTalkingState(true);
    return;
  }
  // Already in flight (a join-time acquire, or an earlier press) — that promise
  // reads `_pendingTalkingStart` when it settles, so this press is not lost.
  if (_micAcquirePromise) {
    setTinyMicAcquiring(true);
    return;
  }
  acquireMicForRoom('press');
}

function applyTalkingState(active) {
  if (!audioTrack || active === isTalking) return;
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
  noteLogPeerGone(peerId);
  if (conn.data) conn.data.close();
  if (conn.media) conn.media.close();
  if (conn.audioMediaOut) conn.audioMediaOut.close();
  // Close any SFU subscribe session for this peer's video/screen so a leaving
  // peer doesn't leak an open Cloudflare downlink RTCPeerConnection.
  if (conn.videoTopology && conn.videoTopology.mode === 'sfu') sfuUnsubscribeTrack('video', peerId);
  if (conn.screenTopology && conn.screenTopology.mode === 'sfu') sfuUnsubscribeTrack('screen', peerId);
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

// --- Video / screen sharing helpers ------------------------------------------

// Video is on by default. An absent key means "never chosen", not "off" — only an
// explicit 'false' disables it, so shipping the feature doesn't require a migration.
function readVideoModeEnabled() {
  try {
    return localStorage.getItem(VIDEO_MODE_KEY) !== 'false';
  } catch (_) {
    return true;
  }
}

// --- Video stage --------------------------------------------------------------
//
// The room is a voice UI first: an audio-only room must render exactly as it did
// before this feature existed. So the stage is additive — `body.video-stage` is
// set only while at least one camera or screen is genuinely live, and the CSS
// grid that moves the roster and the PTT column into a right-hand rail hangs off
// that class. Everything else (roster markup, PTT, controls) is untouched.

// Pure: the ordered list of tiles the stage should be showing, derived from the
// same connection state the roster reads. Kept free of DOM so it can be unit
// tested directly (main.js is a flat classic script — see KNOWLEDGE/learning.md).
function videoStageTiles() {
  var tiles = [];
  if (!videoModeEnabled) return tiles;

  var selfId = (peer && peer.id) || 'self';

  // Screen shares come first: they are the focus candidates.
  connections.forEach(function(conn, peerId) {
    if (!conn || !conn.screenActive) return;
    tiles.push({
      key: 'screen:' + peerId,
      peerId: peerId,
      kind: 'screen',
      self: false,
      label: (conn.pseudo || shortId(peerId)) + ' — screen',
      color: conn.pseudoColor || null,
      stream: conn.remoteScreenStream || null,
      talking: false,
      iceType: (conn.webrtcStats && conn.webrtcStats.iceType) || null,
      topology: (conn.screenTopology && conn.screenTopology.mode) || 'p2p',
      trackState: remoteTrackState(peerId, 'screen')
    });
  });
  if (localScreenActive) {
    tiles.push({
      key: 'screen:self',
      peerId: selfId,
      kind: 'screen',
      self: true,
      label: 'Your screen',
      color: null,
      stream: localScreenStream,
      talking: false,
      iceType: null,
      topology: (_localVideoTopology.screen && _localVideoTopology.screen.mode) || 'p2p'
    });
  }

  // Then remote cameras.
  connections.forEach(function(conn, peerId) {
    if (!conn || !conn.videoActive) return;
    tiles.push({
      key: 'camera:' + peerId,
      peerId: peerId,
      kind: 'camera',
      self: false,
      label: conn.pseudo || shortId(peerId),
      color: conn.pseudoColor || null,
      stream: conn.remoteVideoStream || null,
      talking: !!conn.talking,
      iceType: (conn.webrtcStats && conn.webrtcStats.iceType) || null,
      topology: (conn.videoTopology && conn.videoTopology.mode) || 'p2p',
      trackState: remoteTrackState(peerId, 'video')
    });
  });

  // Self camera last, so your own face doesn't push everyone else around.
  if (localVideoActive) {
    tiles.push({
      key: SELF_CAMERA_TILE_KEY,
      peerId: selfId,
      kind: 'camera',
      self: true,
      label: displayPseudoForSelf(),
      color: null,
      stream: localVideoStream,
      talking: isTalking || freeHandMode,
      iceType: null,
      topology: (_localVideoTopology.video && _localVideoTopology.video.mode) || 'p2p'
    });
  }
  return tiles;
}

// The tiles actually rendered: everything live, minus the ones the viewer chose
// not to watch from the roster. A hide is released as soon as its source goes
// away, so a peer who turns their camera off and on again comes back visible
// rather than staying silently hidden behind an icon nobody remembers pressing.
function visibleVideoStageTiles() {
  var all = videoStageTiles();
  if (!_hiddenStageKeys.size) return all;
  var live = {};
  all.forEach(function(t) { live[t.key] = true; });
  _hiddenStageKeys.forEach(function(key) {
    if (!live[key]) _hiddenStageKeys.delete(key);
  });
  return all.filter(function(t) { return !_hiddenStageKeys.has(t.key); });
}

// Your own camera is a self-view, not content: it takes a small draggable badge
// floating over the stage instead of a tile in the grid. The one case where it
// IS the content is when nobody else has a camera on — there is then nothing for
// it to be small beside, so it takes the stage like any other tile. An explicit
// pin means "show me this big" and outranks minimising either way.
// Returns '' when the self-view should stay a normal tile (or does not exist).
function selfBadgeTileKey(tiles, focusKey) {
  var selfKey = '';
  var others = 0;
  for (var i = 0; i < tiles.length; i++) {
    if (tiles[i].kind !== 'camera') continue;
    if (tiles[i].self) selfKey = tiles[i].key; else others++;
  }
  if (!selfKey || !others || selfKey === focusKey) return '';
  return selfKey;
}

// Which tile fills the focus area: an explicit pin wins, otherwise the first
// screen share (someone sharing a screen is nearly always the thing to look at).
// Returns '' when nothing should be focused, i.e. a plain grid of cameras.
function videoStageFocusKey(tiles) {
  if (_stagePinnedKey) {
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].key === _stagePinnedKey) return _stagePinnedKey;
    }
    _stagePinnedKey = null;   // pinned tile is gone; fall through
  }
  for (var j = 0; j < tiles.length; j++) {
    if (tiles[j].kind === 'screen') return tiles[j].key;
  }
  return '';
}

function _buildVideoTile(tile) {
  var el = document.createElement('div');
  el.className = 'video-tile video-tile-' + tile.kind + (tile.self ? ' video-tile-self' : '');
  el.dataset.key = tile.key;
  if (tile.peerId) el.dataset.peerId = tile.peerId;

  var vid = document.createElement('video');
  vid.autoplay = true;
  vid.playsInline = true;
  vid.setAttribute('playsinline', '');
  // Every tile is muted: audio travels on its own MediaConnection and is already
  // being played by the audio pipeline. Unmuting here would double every voice.
  vid.muted = true;
  el.appendChild(vid);

  var placeholder = document.createElement('div');
  placeholder.className = 'video-tile-placeholder hidden';
  el.appendChild(placeholder);

  // Front/back flip belongs to this camera, not to the room, so it rides on the
  // tile. renderVideoStage() MOVES the same element between the grid and the
  // minimized badge, so this one button serves both.
  if (tile.self && tile.kind === 'camera') {
    var flip = document.createElement('button');
    flip.type = 'button';
    flip.className = 'video-tile-flip';
    flip.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/><path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/><polyline points="15 3 13 5 15 7"/><polyline points="9 17 11 19 9 21"/></svg>';
    // Every tile has a click-to-pin handler, and the badge has a drag — neither
    // should fire because the flip button was pressed.
    flip.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      flipCamera();
    });
    flip.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
    el.appendChild(flip);

    // Your background belongs to your camera, so the control sits on your own
    // picture rather than in the room's control row — icon only, next to the
    // flip, and it rides along when renderVideoStage() moves the tile into the
    // minimized badge.
    var bg = document.createElement('button');
    bg.type = 'button';
    bg.className = 'video-tile-bg';
    bg.setAttribute('aria-haspopup', 'true');
    bg.setAttribute('aria-controls', 'video-bg-popover');
    bg.setAttribute('aria-expanded', 'false');
    bg.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/><path d="M3 4.5h3"/><path d="M18 4.5h3"/><path d="M3 9.5h1.5"/><path d="M19.5 9.5H21"/><path d="M3 14.5h1"/><path d="M20 14.5h1"/></svg>';
    bg.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleVideoBackgroundPopover(bg);
    });
    bg.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
    el.appendChild(bg);
  }

  var bar = document.createElement('div');
  bar.className = 'video-tile-bar';
  var mic = document.createElement('span');
  mic.className = 'video-tile-mic';
  var name = document.createElement('span');
  name.className = 'video-tile-name';
  var badges = document.createElement('span');
  badges.className = 'video-tile-badges';
  var topology = document.createElement('span');
  topology.className = 'video-tile-topology hidden';
  topology.title = 'Relayed through a media server (Cloudflare) — voice always stays direct';
  var ice = document.createElement('span');
  ice.className = 'video-tile-ice';
  badges.appendChild(topology);
  badges.appendChild(ice);
  bar.appendChild(mic);
  bar.appendChild(name);
  bar.appendChild(badges);
  el.appendChild(bar);

  el.addEventListener('click', function() { toggleStagePin(tile.key); });
  return el;
}

// Reconcile one existing tile in place. Reassigning `srcObject` restarts
// playback and visibly flashes the tile, and updateVideoStage() runs on every
// roster tick — so the stream is only ever assigned when it actually changed.
function _syncVideoTile(el, tile) {
  var vid = el.querySelector('video');
  var placeholder = el.querySelector('.video-tile-placeholder');
  if (vid && vid.srcObject !== tile.stream) vid.srcObject = tile.stream || null;

  // Mirroring is right for a front camera and wrong for a rear one — you expect
  // your own face flipped, but not the scene behind the phone.
  if (tile.self && tile.kind === 'camera') {
    el.dataset.facing = _cameraFacing;
    var flip = el.querySelector('.video-tile-flip');
    if (flip) {
      flip.classList.toggle('available', !!_cameraFlipSupported);
      flip.title = _cameraFacing === 'user'
        ? 'Switch to the rear camera' : 'Switch to the front camera';
      flip.setAttribute('aria-label', flip.title);
    }
    var bg = el.querySelector('.video-tile-bg');
    if (bg) {
      var mode = videoBackgroundMode();
      bg.classList.toggle('available', videoEffectsAvailable());
      bg.classList.toggle('is-on', mode !== 'off');
      bg.title = mode === 'off' ? 'Change your background' : 'Background: on';
      bg.setAttribute('aria-label', bg.title);
    }
  }

  var hasStream = !!tile.stream;
  if (vid) vid.classList.toggle('hidden', !hasStream);
  if (placeholder) {
    placeholder.classList.toggle('hidden', hasStream);
    // A peer whose camera is on but whose stream has not arrived (or briefly
    // dropped) keeps its slot, rather than making the whole grid reflow.
    var initial = (tile.label || '?').trim().charAt(0).toUpperCase();
    if (placeholder.textContent !== initial) placeholder.textContent = initial;
  }

  el.classList.toggle('talking', !!tile.talking);
  el.classList.toggle('video-tile-pinned', _stagePinnedKey === tile.key);

  var name = el.querySelector('.video-tile-name');
  if (name) {
    if (name.textContent !== tile.label) name.textContent = tile.label;
    name.style.color = tile.color || '';
  }
  _setDotIceClass(el.querySelector('.video-tile-ice'), tile.iceType);

  // Distinct from the ICE dot above on purpose: "direct vs relayed ICE path"
  // and "P2P vs SFU topology" are orthogonal questions (see
  // docs/video-routing.md). Only ever shown for video/screen — audio has no
  // topology choice and never renders this badge anywhere.
  var topologyBadge = el.querySelector('.video-tile-topology');
  if (topologyBadge) {
    var isSfu = tile.topology === 'sfu';
    topologyBadge.classList.toggle('hidden', !isSfu);
    if (isSfu) {
      // A failed subscription leaves a black tile. Saying "Relayed" over it
      // claims media is flowing when it isn't, which is exactly how the earlier
      // bugs in this feature stayed invisible.
      var broken = tile.trackState === 'failed';
      var label = broken ? '⚠ Relay failed' : tile.trackState === 'reconnecting' ? '☁ Reconnecting…' : '☁ Relayed';
      if (topologyBadge.textContent !== label) topologyBadge.textContent = label;
      topologyBadge.classList.toggle('failed', broken);
      topologyBadge.title = broken
        ? 'Could not receive this video through the relay — see the dev log for the reason'
        : 'Relayed through a media server (Cloudflare) — voice always stays direct';
    }
  }
}

function toggleStagePin(key) {
  _stagePinnedKey = (_stagePinnedKey === key) ? null : key;
  updateVideoStage();
}

// Reconcile by key: create what is new, remove what is gone, move tiles between
// the focus slot, the self-view badge and the grid, and leave everything else
// alone. Moving a tile between containers keeps the same element, so the video
// never has its srcObject reassigned and never flashes.
function renderVideoStage(tiles, focusKey, badgeKey) {
  var focusEl  = document.getElementById('video-stage-focus');
  var gridEl   = document.getElementById('video-stage-grid');
  var badgeEl  = document.getElementById('video-stage-self');
  var ribbonEl = document.getElementById('video-stage-ribbon');
  var ribbonWrap = document.getElementById('video-stage-ribbon-wrap');
  if (!focusEl || !gridEl) return;
  var containers = [focusEl, gridEl];
  if (ribbonEl) containers.push(ribbonEl);
  if (badgeEl) containers.push(badgeEl);

  var seen = {};
  tiles.forEach(function(t) { seen[t.key] = true; });

  // Drop tiles that no longer belong, releasing their stream reference.
  containers.forEach(function(container) {
    Array.prototype.slice.call(container.children).forEach(function(child) {
      if (seen[child.dataset.key]) return;
      var v = child.querySelector('video');
      if (v) v.srcObject = null;
      child.remove();
    });
  });

  var existing = {};
  containers.forEach(function(container) {
    Array.prototype.slice.call(container.children).forEach(function(child) {
      existing[child.dataset.key] = child;
    });
  });

  // Everything that is neither focused nor minimized into the self-view badge
  // competes for a grid slot; the rest go to the ribbon. With a focus tile the
  // grid IS already a scrolling filmstrip, so there is no second overflow strip
  // to build — the split only applies to a plain grid of faces.
  var contenders = tiles.filter(function(t) {
    return t.key !== focusKey && !(badgeEl && t.key === badgeKey);
  });
  var split;
  if (focusKey) {
    split = { gridKeys: contenders.map(function(t) { return t.key; }), ribbonKeys: [] };
    _stageGridKeys = split.gridKeys.slice();
    _stageRibbonKeys = [];
  } else {
    var box = stageGridBox(gridEl);
    split = partitionStageTiles(contenders, stageGridCapacity(
      contenders.length, box.width, box.height,
      document.body.classList.contains('video-stage-immersive')
    ));
  }
  var inRibbon = {};
  split.ribbonKeys.forEach(function(key) { inRibbon[key] = true; });

  tiles.forEach(function(tile) {
    var el = existing[tile.key] || _buildVideoTile(tile);
    var target = gridEl;
    if (tile.key === focusKey) target = focusEl;
    else if (badgeEl && tile.key === badgeKey) target = badgeEl;
    else if (ribbonEl && inRibbon[tile.key]) target = ribbonEl;
    if (el.parentNode !== target) target.appendChild(el);
    el.classList.toggle('video-tile-mini', target === ribbonEl);
    _syncVideoTile(el, tile);
  });

  // Keep each container's order matching the order we decided on.
  var order = split.gridKeys.concat(split.ribbonKeys);
  order.forEach(function(key) {
    var container = inRibbon[key] ? ribbonEl : gridEl;
    if (!container) return;
    var el = container.querySelector('[data-key="' + cssEscapeAttr(key) + '"]');
    if (el) container.appendChild(el);
  });

  focusEl.classList.toggle('hidden', !focusKey);
  if (badgeEl) {
    badgeEl.classList.toggle('hidden', !badgeKey);
    badgeEl.dataset.corner = _selfBadgeCorner;
  }
  // Toggled BEFORE the grid is measured: the ribbon is a flex sibling, so its
  // presence is part of the box the column count is chosen against.
  if (ribbonWrap) ribbonWrap.classList.toggle('hidden', !split.ribbonKeys.length);
  layoutVideoStageGrid(gridEl, focusKey ? 0 : split.gridKeys.length);
  updateStageRibbonOverflow();
}

// The space the grid has to work with, in content-box terms and independent of
// whether a ribbon happens to be showing right now — the ribbon's own reserve is
// added back, so stageGridCapacity() can subtract it exactly once and the two
// can never chase each other across ticks.
function stageGridBox(gridEl) {
  var rect = gridEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return { width: 0, height: 0 };
  var style = window.getComputedStyle(gridEl);
  var width = rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  var height = rect.height - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  var wrap = document.getElementById('video-stage-ribbon-wrap');
  if (wrap && !wrap.classList.contains('hidden')) height += STAGE_RIBBON_RESERVE;
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

// How many ribbon tiles are scrolled out of sight. The ribbon is the overflow of
// an overflow, so it has to say what it is still hiding — and be scrollable to
// reach it.
function updateStageRibbonOverflow() {
  var ribbon = document.getElementById('video-stage-ribbon');
  var more = document.getElementById('video-stage-ribbon-more');
  if (!ribbon || !more) return;
  var viewLeft = ribbon.scrollLeft;
  var viewRight = viewLeft + ribbon.clientWidth;
  var hidden = 0;
  for (var i = 0; i < ribbon.children.length; i++) {
    var el = ribbon.children[i];
    var left = el.offsetLeft;
    var right = left + el.offsetWidth;
    // A tile only counts as reachable when it is fully in view — half a face at
    // the edge is what the indicator is there to tell you about.
    if (right > viewRight + 1 || left < viewLeft - 1) hidden++;
  }
  more.classList.toggle('hidden', hidden <= 0);
  if (hidden > 0) {
    var label = '+' + hidden;
    if (more.textContent !== label) more.textContent = label;
    more.title = hidden + ' more participant' + (hidden === 1 ? '' : 's') + ' — scroll the strip to see them';
  }
}

// --- How the stage is divided up ---------------------------------------------
//
// Three rules, in priority order, and they are the whole of the layout policy:
//
//   1. Show as much of the video as the measured box allows. Pure CSS can size
//      columns but knows nothing about the leftover *height*, which is why an
//      `auto-fit` grid leaves half the stage empty.
//   2. Among arrangements that are within STAGE_AREA_TOLERANCE of the best,
//      prefer the one whose splits are balanced — as close to as many vertical
//      cuts as horizontal ones (|cols - rows| smallest).
//   3. Still tied? Take the extra COLUMN. A vertical split reads better in a
//      conference: faces end up side by side rather than stacked, and the exact
//      tie is the common case (two tiles on a 16:9 stage come out the same size
//      either way).
//
// Everything is recomputed from scratch on every roster change and every
// resize, so the arrangement always matches the current participant count.
//
// Rule 1 needs a metric, and the obvious one — the largest 16:9 rectangle a cell
// can hold — describes a *letterboxed* tile, which is not what is on screen: a
// tile fills its cell and the video is `object-fit: cover`, so a mismatched cell
// crops the frame rather than shrinking it. What the viewer loses is the cropped
// part, and the two directions do NOT cost the same:
//
//   * a cell WIDER than the frame crops top and bottom — foreheads and chins,
//     the part you are looking at. Charged in full (`frame / cell`).
//   * a cell NARROWER than the frame crops left and right — mostly background,
//     and the subject renders BIGGER because the cell is taller. Charged at the
//     square root, i.e. discounted.
//
// That asymmetry is also why a phone ends up with 2×2 rather than four
// full-width letterbox strips, and it is what makes rule 3 fall out naturally
// rather than being bolted on.
var STAGE_TILE_ASPECT = 16 / 9;
// Within 20% is "about the same" — the metric above is a heuristic (both
// arrangements fill the box; only the crop differs), so anything this close is
// decided on shape instead.
var STAGE_AREA_TOLERANCE = 0.8;

// The arrangement itself for `count` tiles in a `width` × `height` box:
// `{ cols, rows, cellW, cellH, tileW, tileH, score }`. `cellW`/`cellH` are the
// tile as laid out; `tileW`/`tileH` are the uncropped `aspect` rectangle inside
// it, kept because "is this still big enough to be worth a slot" is a question
// about the frame, not the cell.
function bestGridLayout(count, width, height, aspect) {
  var fallback = { cols: 1, rows: Math.max(1, count), cellW: 0, cellH: 0, tileW: 0, tileH: 0, score: 0 };
  if (count <= 0 || !(width > 0) || !(height > 0)) return fallback;
  var ratio = aspect > 0 ? aspect : STAGE_TILE_ASPECT;

  var candidates = [];
  var bestScore = 0;
  for (var cols = 1; cols <= count; cols++) {
    var rows = Math.ceil(count / cols);
    // Skip arrangements with a column that would stand entirely empty — 3×2 for
    // four tiles is never better than the 2×2 it degenerates into.
    if ((cols - 1) * rows >= count) continue;
    var cellW = width / cols;
    var cellH = height / rows;
    var cellAspect = cellW / cellH;
    var kept = cellAspect >= ratio
      ? ratio / cellAspect                      // vertical crop: charged in full
      : Math.sqrt(cellAspect / ratio);          // horizontal crop: discounted
    var score = cellW * cellH * kept;
    if (score > bestScore) bestScore = score;
    var tileW = Math.min(cellW, cellH * ratio);
    candidates.push({
      cols: cols, rows: rows, cellW: cellW, cellH: cellH,
      tileW: tileW, tileH: tileW / ratio, score: score
    });
  }
  if (!candidates.length) return fallback;

  var best = null;
  candidates.forEach(function(c) {
    if (c.score < bestScore * STAGE_AREA_TOLERANCE) return;  // rule 1
    if (!best) { best = c; return; }
    var balance = Math.abs(c.cols - c.rows);
    var bestBalance = Math.abs(best.cols - best.rows);
    if (balance < bestBalance) { best = c; return; }         // rule 2
    if (balance === bestBalance && c.cols > best.cols) best = c;  // rule 3
  });
  return best || candidates[0];
}

function bestGridColumns(count, width, height, aspect) {
  return bestGridLayout(count, width, height, aspect).cols;
}

// --- Who gets a grid slot -----------------------------------------------------
//
// Past a point another tile makes every tile worse, so the grid takes a bounded
// number of participants and the rest are minimized into the ribbon along the
// bottom. A phone is a hard 4 — a fifth face on a 390px screen is a thumbnail
// either way, and 2×2 is the last arrangement that still reads. Every surface is
// additionally bounded by measurement, so a short stage cannot "fit" nine tiles
// 40px tall.
var STAGE_MAX_GRID_TILES_IMMERSIVE = 4;
var STAGE_MAX_GRID_TILES_DESKTOP = 12;
var STAGE_MIN_TILE_W = 160;
var STAGE_MIN_TILE_H = 90;
// Height the ribbon takes off the grid when it is shown. Kept in step with
// `--stage-ribbon-tile-h` in styles.css. A constant rather than a measurement on
// purpose: the ribbon's presence depends on the capacity that depends on the
// available height, so measuring the live ribbon would let the two oscillate.
var STAGE_RIBBON_RESERVE = 84;

function stageGridCapacity(count, width, height, immersive) {
  var max = immersive ? STAGE_MAX_GRID_TILES_IMMERSIVE : STAGE_MAX_GRID_TILES_DESKTOP;
  var cap = Math.min(count, max);
  if (cap <= 1) return cap;
  // Nothing to measure yet (first layout, or the stage is hidden): trust the cap
  // rather than committing to a wrong one — the next tick measures for real.
  if (!(width > 0) || !(height > 0)) return cap;
  while (cap > 1) {
    // A ribbon appears as soon as the grid cannot hold everyone, and it takes
    // its height off the grid.
    var usable = cap < count ? Math.max(0, height - STAGE_RIBBON_RESERVE) : height;
    var layout = bestGridLayout(cap, width, usable, STAGE_TILE_ASPECT);
    // The cell is what ends up on screen, so the floor is measured against it.
    if (layout.cellW >= STAGE_MIN_TILE_W && layout.cellH >= STAGE_MIN_TILE_H) break;
    cap--;
  }
  return cap;
}

// A screen share always outranks a camera (it is nearly always the thing to look
// at), then it is whoever spoke most recently — the order the user asked for and
// the only ordering in a voice-first app that tracks who matters right now.
function stageTileRank(tile) {
  if (!tile) return 0;
  if (tile.kind === 'screen') return Infinity;
  return _speakerRecency.get(tile.peerId) || 0;
}

// Split the tiles the grid would otherwise hold into the grid itself and the
// overflow ribbon.
//
// Membership is by rank, but it is STICKY: a tile already in the grid keeps its
// slot until someone the grid does not hold out-ranks it. A grid that re-sorts
// itself on every press would be unreadable, so only the displacement actually
// moves anyone, and the survivors keep their relative order.
function partitionStageTiles(tiles, capacity) {
  var gridKeys = [];
  var ribbonKeys = [];
  var i;
  if (capacity >= tiles.length) {
    for (i = 0; i < tiles.length; i++) gridKeys.push(tiles[i].key);
    _stageGridKeys = gridKeys.slice();
    _stageRibbonKeys = ribbonKeys;
    return { gridKeys: gridKeys, ribbonKeys: ribbonKeys };
  }

  var byRank = tiles.map(function(t, index) {
    return { key: t.key, rank: stageTileRank(t), index: index };
  }).sort(function(a, b) {
    if (b.rank !== a.rank) return b.rank > a.rank ? 1 : -1;
    return a.index - b.index;   // never-spoken peers keep their natural order
  });

  var promoted = {};
  for (i = 0; i < capacity && i < byRank.length; i++) promoted[byRank[i].key] = true;

  // Incumbents first, in the order they already occupy, then the newcomers that
  // displaced someone — so a promotion fills the freed slot instead of reshuffling.
  var taken = {};
  for (i = 0; i < _stageGridKeys.length && gridKeys.length < capacity; i++) {
    var key = _stageGridKeys[i];
    if (!promoted[key] || taken[key]) continue;
    taken[key] = true;
    gridKeys.push(key);
  }
  for (i = 0; i < byRank.length && gridKeys.length < capacity; i++) {
    if (!promoted[byRank[i].key] || taken[byRank[i].key]) continue;
    taken[byRank[i].key] = true;
    gridKeys.push(byRank[i].key);
  }
  // The ribbon is plain rank order: most recent speaker nearest the grid.
  for (i = 0; i < byRank.length; i++) {
    if (!taken[byRank[i].key]) ribbonKeys.push(byRank[i].key);
  }

  _stageGridKeys = gridKeys.slice();
  _stageRibbonKeys = ribbonKeys.slice();
  return { gridKeys: gridKeys, ribbonKeys: ribbonKeys };
}

// Stamp the speaking order. Cheap enough to run on every press: one Map write,
// and a stage re-render ONLY when the talker is currently minimized — i.e. when
// there is genuinely something to promote.
function noteStageSpeaker(peerId, active) {
  if (!peerId || !active) return;
  _speakerSeq++;
  _speakerRecency.set(peerId, _speakerSeq);
  if (!_stageRibbonKeys.length) return;
  if (_stageRibbonKeys.indexOf('camera:' + peerId) === -1) return;
  updateVideoStage();
}

// In immersive mode the stage is edge-to-edge and the header/roster panels
// OVERLAY it, so neither costs the tiles any height. What does is the control
// stack at the bottom, which is always on screen — without an inset it buries
// the bottom tile's name bar. The inset is measured rather than a constant,
// because that stack changes height with content (a wrapped name, an absent
// Screen button). The stage background stays full-bleed, so the video still
// reaches the physical edges.
//
// Anything above the tiles is inset by a small constant instead: the only thing
// permanently up there is the top drag handle.
var STAGE_HANDLE_CLEARANCE = 26;

function applyImmersiveStageInsets(gridEl) {
  if (!gridEl) return;
  var stage = document.getElementById('video-stage');
  var ribbonWrap = document.getElementById('video-stage-ribbon-wrap');
  var ribbonOpen = !!ribbonWrap && !ribbonWrap.classList.contains('hidden');
  document.documentElement.style.setProperty(
    '--stage-ribbon-height', ribbonOpen ? STAGE_RIBBON_RESERVE + 'px' : '0px');
  if (!document.body.classList.contains('video-stage-immersive')) {
    gridEl.style.removeProperty('padding-top');
    gridEl.style.removeProperty('padding-bottom');
    if (ribbonWrap) ribbonWrap.style.removeProperty('padding-bottom');
    document.documentElement.style.removeProperty('--stage-inset-top');
    document.documentElement.style.removeProperty('--stage-inset-bottom');
    return;
  }
  if (!stage) return;
  var stageBox = stage.getBoundingClientRect();
  if (!stageBox.height) return;

  var bar = document.querySelector('.room-bottom-bar');
  var barBox = bar ? bar.getBoundingClientRect() : null;

  var insetTop = STAGE_HANDLE_CLEARANCE;
  var insetBottom = (barBox && barBox.height)
    ? Math.max(0, Math.round(stageBox.bottom - barBox.top))
    : 0;

  gridEl.style.paddingTop = insetTop + 'px';
  // The clearance belongs to whatever is actually at the bottom of the stack: a
  // ribbon under a grid that still carried the inset would sit on the controls.
  gridEl.style.paddingBottom = ribbonOpen ? '0px' : insetBottom + 'px';
  if (ribbonWrap) ribbonWrap.style.paddingBottom = ribbonOpen ? insetBottom + 'px' : '';
  // Published on the root, not the stage, because two things outside the stage
  // need them: the self-view badge (corner-anchored, would otherwise park on the
  // control stack) and the panel scrim (must stop above the talk button).
  document.documentElement.style.setProperty('--stage-inset-top', insetTop + 'px');
  document.documentElement.style.setProperty('--stage-inset-bottom', insetBottom + 'px');
}

function layoutVideoStageGrid(gridEl, count) {
  if (!gridEl) return;
  if (count <= 0) { _clearGridPlacement(gridEl); return; }
  applyImmersiveStageInsets(gridEl);
  var rect = gridEl.getBoundingClientRect();
  // Before first layout (or while hidden) there is nothing to measure — leave
  // the CSS fallback in place rather than committing to a wrong column count.
  if (!rect.width || !rect.height) { _clearGridPlacement(gridEl); return; }
  // The rect is the border box; the tiles only get the content box, so the
  // immersive insets above have to come off before choosing a column count.
  var style = window.getComputedStyle(gridEl);
  var innerW = rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  var innerH = rect.height - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  if (innerW <= 0 || innerH <= 0) { _clearGridPlacement(gridEl); return; }
  var layout = bestGridLayout(count, innerW, innerH, STAGE_TILE_ASPECT);

  // Twice the tracks, every tile spanning two of them: the gaps work out to
  // exactly the same widths as `repeat(cols, 1fr)`, but a last row that does not
  // fill can be offset by half a tile and end up CENTRED instead of jammed
  // against the left edge — which is what an unbalanced final row looks like.
  var cols = layout.cols;
  gridEl.style.gridTemplateColumns = 'repeat(' + (cols * 2) + ', minmax(0, 1fr))';
  var remainder = count % cols;
  var firstOfLastRow = cols * (layout.rows - 1);
  for (var i = 0; i < gridEl.children.length; i++) {
    var el = gridEl.children[i];
    el.style.gridColumn = (remainder && i === firstOfLastRow)
      ? (cols - remainder + 1) + ' / span 2'
      : 'span 2';
  }
}

function _clearGridPlacement(gridEl) {
  gridEl.style.removeProperty('grid-template-columns');
  for (var i = 0; i < gridEl.children.length; i++) {
    gridEl.children[i].style.removeProperty('grid-column');
  }
}

// Tile keys are built from peer ids (UUIDs) plus a fixed prefix, but a
// querySelector attribute value still has to survive quoting.
function cssEscapeAttr(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// Which shape of stage applies here, if any:
//
//   'desktop'   — the tile grid with the voice UI railed right (wide web).
//   'immersive' — tiles fill the room edge to edge and the voice UI overlays
//                 them (phones: mobile web AND the Capacitor apps).
//   'none'      — no stage; the roster's camera icon keeps opening the floating
//                 viewer panel, and the room layout is untouched. This is the
//                 tiny embed and Tauri, which has its own pop-out WebviewWindow.
//
// `is-native` / `is-web` are set by the head inline script in index.html; Tauri
// gets NEITHER, which is exactly what keeps it on the pop-out.
var VIDEO_STAGE_MIN_WIDTH = 861;

function videoStageWideEnough() {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(min-width: ' + VIDEO_STAGE_MIN_WIDTH + 'px)').matches;
  }
  return window.innerWidth >= VIDEO_STAGE_MIN_WIDTH;
}

function videoStageMode() {
  if (IS_TINY_EMBED) return 'none';
  var root = document.documentElement.classList;
  // Native is immersive at any width — an iPad in portrait is ~768-1024px, and
  // the desktop grid is `html.is-web`-qualified so it can never match there.
  if (root.contains('is-native')) return 'immersive';
  if (!root.contains('is-web')) return 'none';
  return videoStageWideEnough() ? 'desktop' : 'immersive';
}

function videoStageAvailable() {
  return videoStageMode() !== 'none';
}

// Single entry point. Safe to call from anywhere video/screen state changes.
function updateVideoStage() {
  var stage = document.getElementById('video-stage');
  if (!stage) return;
  var mode = videoStageMode();
  var tiles = (inRoom && mode !== 'none') ? visibleVideoStageTiles() : [];
  var active = tiles.length > 0;

  document.body.classList.toggle('video-stage', active);
  // Both classes obey the same rule: set ONLY while a camera or screen is
  // genuinely live, so an audio-only room still renders byte-identically.
  document.body.classList.toggle('video-stage-immersive', active && mode === 'immersive');
  stage.classList.toggle('hidden', !active);
  // The screen must not sleep while you are watching someone — and must be
  // allowed to again the moment the stage stands down.
  if (active) requestStageWakeLock(); else releaseStageWakeLock();
  if (active && mode === 'immersive') {
    initStagePanelHandles();
    publishStageHeaderHeight();
  } else {
    // Leaving immersive (or the stage entirely) must not strand a panel open
    // over a layout that no longer has anywhere to slide it back to.
    closeStagePanels();
  }
  if (!active) {
    renderVideoStage([], '', '');
    _stagePinnedKey = null;
    return;
  }
  var focusKey = videoStageFocusKey(tiles);
  stage.classList.toggle('has-focus', !!focusKey);
  renderVideoStage(tiles, focusKey, selfBadgeTileKey(tiles, focusKey));
}

// The column count is measured, so it has to be recomputed when the window
// changes size — including the first resize that crosses the stage breakpoint,
// where the stage goes from unmeasurable (hidden) to visible.
var _stageResizeRaf = null;
window.addEventListener('resize', function() {
  if (_stageResizeRaf) return;
  _stageResizeRaf = requestAnimationFrame(function() {
    _stageResizeRaf = null;
    updateVideoStage();
  });
});

// The "+N still hidden" count is a property of the scroll position, not of the
// roster, so it is the one piece of stage state that updates without a render.
var _stageRibbonScrollRaf = null;
document.addEventListener('DOMContentLoaded', function() {
  var ribbon = document.getElementById('video-stage-ribbon');
  if (!ribbon) return;
  ribbon.addEventListener('scroll', function() {
    if (_stageRibbonScrollRaf) return;
    _stageRibbonScrollRaf = requestAnimationFrame(function() {
      _stageRibbonScrollRaf = null;
      updateStageRibbonOverflow();
    });
  }, { passive: true });
});

// --- Screen wake lock ---------------------------------------------------------
//
// Watching someone's camera is the one thing in this app that involves no touch
// input for minutes at a time, so without a wake lock the phone dims and locks
// mid-call. Held only while the stage is actually up, never for audio-only.
//
// The sentinel is released by the browser whenever the page is hidden, so it has
// to be re-acquired on the way back to the foreground — see the visibilitychange
// handler in the DOMContentLoaded bootstrap.

var _stageWakeLock = null;
var _stageWakeLockWanted = false;

function requestStageWakeLock() {
  _stageWakeLockWanted = true;
  // Chromium and Safari 16.4+; older WebKit simply has no equivalent.
  if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
  if (_stageWakeLock) return;
  navigator.wakeLock.request('screen').then(function(sentinel) {
    if (!_stageWakeLockWanted) { try { sentinel.release(); } catch (e) { /* ignore */ } return; }
    _stageWakeLock = sentinel;
    sentinel.addEventListener('release', function() { _stageWakeLock = null; });
  }).catch(function(e) {
    // Denied (backgrounded tab, low battery, no permission). Not worth an error.
    devLog('[Video] Wake lock unavailable: ' + (e && e.message ? e.message : String(e)), 'warn');
  });
}

function releaseStageWakeLock() {
  _stageWakeLockWanted = false;
  if (!_stageWakeLock) return;
  var sentinel = _stageWakeLock;
  _stageWakeLock = null;
  try { sentinel.release(); } catch (e) { /* already gone */ }
}

// --- Immersive sliding panels -------------------------------------------------
//
// On a phone the video takes the screen, so the header and the participant list
// are off-screen while a camera is live and are pulled back OVER the tiles by a
// drag handle — top-centre for the header, right-centre for the roster. They
// overlay rather than reserve space, so revealing one never reflows the video.
//
// Deliberately NOT hidden this way: the talk button and the control row. This is
// a push-to-talk app, and putting the talk button behind a reveal gesture would
// hide the one control people reach for without looking.
//
// The panels keep the app's own surface colours — switching a camera on must not
// restyle the room, which is also what makes them legible over video without a
// video-only palette.

// `sign` is the direction of the GESTURE that opens the panel, not the direction
// of the transform that hides it — they are opposites, and conflating them is
// how the drag ends up refusing to open. The header hides upward and is opened
// by pulling DOWN (+y); the roster hides to the right and is opened by pulling
// LEFT (-x).
var STAGE_PANELS = {
  header: { cls: 'stage-header-open', panel: '.room-header', handle: 'stage-handle-header', axis: 'y', sign: 1 },
  roster: { cls: 'stage-roster-open', panel: '.room-peers-panel', handle: 'stage-handle-roster', axis: 'x', sign: -1 }
};

// A drag has to travel this fraction of the panel before release counts as a
// change of state; anything shorter snaps back, and a tap toggles.
var STAGE_PANEL_COMMIT = 0.4;
var STAGE_PANEL_DRAG_SLOP = 6;

function stagePanelOpen(which) {
  var spec = STAGE_PANELS[which];
  return !!spec && document.body.classList.contains(spec.cls);
}

function setStagePanel(which, open) {
  var spec = STAGE_PANELS[which];
  if (!spec) return;
  // The two panels are alternatives: opening one closes the other, so they can
  // never overlap each other on a screen this small.
  if (open) {
    Object.keys(STAGE_PANELS).forEach(function(other) {
      if (other !== which) document.body.classList.remove(STAGE_PANELS[other].cls);
    });
  }
  document.body.classList.toggle(spec.cls, !!open);
  Object.keys(STAGE_PANELS).forEach(function(key) {
    var el = document.getElementById(STAGE_PANELS[key].handle);
    if (el) el.setAttribute('aria-expanded', String(stagePanelOpen(key)));
  });
  publishStageHeaderHeight();
}

function closeStagePanels() {
  Object.keys(STAGE_PANELS).forEach(function(key) {
    document.body.classList.remove(STAGE_PANELS[key].cls);
    var el = document.getElementById(STAGE_PANELS[key].handle);
    if (el) el.setAttribute('aria-expanded', 'false');
  });
}

// The top handle rides down with the header so it stays the thing you grab to
// close it, which means it needs the header's real height.
function publishStageHeaderHeight() {
  var header = document.querySelector('#screen-room .room-header');
  if (!header) return;
  var h = header.getBoundingClientRect().height;
  if (h) document.documentElement.style.setProperty('--stage-header-height', Math.round(h) + 'px');
}

function relayoutVideoStage() {
  var grid = document.getElementById('video-stage-grid');
  if (grid) layoutVideoStageGrid(grid, grid.children.length);
}

// One drag implementation for both handles; `axis`/`sign` are all that differ.
var _stagePanelDrag = null;

function _stagePanelPointerDown(which, e) {
  var spec = STAGE_PANELS[which];
  if (!spec || _stagePanelDrag || (e.button !== undefined && e.button !== 0)) return;
  var panel = document.querySelector('#screen-room ' + spec.panel);
  if (!panel) return;
  var box = panel.getBoundingClientRect();
  _stagePanelDrag = {
    which: which,
    spec: spec,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    wasOpen: stagePanelOpen(which),
    size: spec.axis === 'y' ? box.height : box.width,
    panel: panel
  };
  // On the window, not the handle: a finger routinely leaves a 22px handle
  // mid-drag, and a lost pointerup would strand the panel under the cursor.
  window.addEventListener('pointermove', _onStagePanelPointerMove);
  window.addEventListener('pointerup', _onStagePanelPointerUp);
  window.addEventListener('pointercancel', _onStagePanelPointerUp);
  document.body.classList.add('stage-panel-dragging');
  e.preventDefault();
}

function _onStagePanelPointerMove(e) {
  var d = _stagePanelDrag;
  if (!d || (e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
  var delta = d.spec.axis === 'y' ? (e.clientY - d.startY) : (e.clientX - d.startX);
  if (!d.moved && Math.abs(delta) > STAGE_PANEL_DRAG_SLOP) d.moved = true;
  if (!d.moved) return;

  // `sign` points in the direction that OPENS the panel; progress runs 0
  // (closed) → 1 (open) whichever state the drag started from.
  var travel = delta * d.spec.sign;
  var progress = d.wasOpen ? 1 + (travel / d.size) : travel / d.size;
  d.progress = Math.max(0, Math.min(1, progress));
  var offset = (1 - d.progress) * d.size * -d.spec.sign;
  d.panel.style.transform = d.spec.axis === 'y'
    ? 'translateY(' + offset + 'px)'
    : 'translateX(' + offset + 'px)';
}

function _onStagePanelPointerUp(e) {
  var d = _stagePanelDrag;
  if (!d || (e && e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
  window.removeEventListener('pointermove', _onStagePanelPointerMove);
  window.removeEventListener('pointerup', _onStagePanelPointerUp);
  window.removeEventListener('pointercancel', _onStagePanelPointerUp);
  _stagePanelDrag = null;
  document.body.classList.remove('stage-panel-dragging');
  d.panel.style.removeProperty('transform');   // hand control back to the class

  // A tap is a toggle; a drag commits only once it has travelled far enough,
  // otherwise it snaps back to where it started.
  var open;
  if (!d.moved) open = !d.wasOpen;
  else if (d.wasOpen) open = d.progress > (1 - STAGE_PANEL_COMMIT);
  else open = d.progress > STAGE_PANEL_COMMIT;
  setStagePanel(d.which, open);
}

function initStagePanelHandles() {
  Object.keys(STAGE_PANELS).forEach(function(which) {
    var el = document.getElementById(STAGE_PANELS[which].handle);
    if (!el || el._voxalHandleWired) return;
    el._voxalHandleWired = true;
    el.addEventListener('pointerdown', function(e) { _stagePanelPointerDown(which, e); });
    // Keyboard parity: the handle is a real button, so Enter/Space must work.
    el.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setStagePanel(which, !stagePanelOpen(which));
    });
  });
  var scrim = document.getElementById('stage-panel-scrim');
  if (scrim && !scrim._voxalWired) {
    scrim._voxalWired = true;
    scrim.addEventListener('pointerdown', function() { closeStagePanels(); });
  }
}

// --- The minimized self-view badge --------------------------------------------
//
// The badge is corner-anchored rather than free-floating: a self-view parked at
// an arbitrary offset drifts over someone's face as soon as the window is
// resized, whereas a corner stays a corner at every size, with no state to
// recompute. Dragging is therefore a *pick a corner* gesture — the badge follows
// the pointer, then snaps to whichever corner it was let go nearest.

var SELF_BADGE_CORNERS = ['tl', 'tr', 'bl', 'br'];
var _selfBadgeCorner = readSelfBadgeCorner();
var _selfBadgeDrag = null;
var _selfBadgeDragged = false;   // a drag just ended: swallow the click it produces

function readSelfBadgeCorner() {
  try {
    var stored = localStorage.getItem(SELF_VIDEO_CORNER_KEY);
    if (SELF_BADGE_CORNERS.indexOf(stored) >= 0) return stored;
  } catch (e) { /* private mode / disabled storage */ }
  return 'br';
}

function setSelfBadgeCorner(corner) {
  if (SELF_BADGE_CORNERS.indexOf(corner) < 0) return;
  _selfBadgeCorner = corner;
  try { localStorage.setItem(SELF_VIDEO_CORNER_KEY, corner); } catch (e) { /* ignore */ }
  var badge = document.getElementById('video-stage-self');
  if (badge) badge.dataset.corner = corner;
}

// Pure: the corner a badge dropped at `box` (stage-relative) belongs to. Decided
// by the badge's centre, not its top-left, so the snap lands where it looks like
// you let go rather than a half-badge earlier.
function nearestBadgeCorner(box, stage) {
  var cx = box.left + (box.width || 0) / 2;
  var cy = box.top + (box.height || 0) / 2;
  return (cy < (stage.height || 0) / 2 ? 't' : 'b') + (cx < (stage.width || 0) / 2 ? 'l' : 'r');
}

function _clampBadge(value, max) {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(max, value));
}

var SELF_BADGE_DRAG_SLOP = 3;   // px of movement before a press counts as a drag

function _onSelfBadgePointerDown(e) {
  var badge = document.getElementById('video-stage-self');
  var stage = document.getElementById('video-stage');
  if (!badge || !stage || _selfBadgeDrag || (e.button !== undefined && e.button !== 0)) return;
  var b = badge.getBoundingClientRect();
  var s = stage.getBoundingClientRect();
  _selfBadgeDragged = false;
  _selfBadgeDrag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    // Grab offset inside the badge, so it does not jump under the pointer.
    grabX: e.clientX - b.left,
    grabY: e.clientY - b.top,
    width: b.width,
    height: b.height,
    stage: { left: s.left, top: s.top, width: s.width, height: s.height },
    left: b.left - s.left,
    top: b.top - s.top
  };
  // Listen on the window, not the badge: the pointer routinely leaves a 200px
  // badge mid-drag, and a lost pointerup would leave it stuck to the cursor.
  window.addEventListener('pointermove', _onSelfBadgePointerMove);
  window.addEventListener('pointerup', _onSelfBadgePointerUp);
  window.addEventListener('pointercancel', _onSelfBadgePointerUp);
  badge.classList.add('dragging');
  e.preventDefault();
}

function _onSelfBadgePointerMove(e) {
  var d = _selfBadgeDrag;
  if (!d || (e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
  var badge = document.getElementById('video-stage-self');
  if (!badge) return;
  if (!_selfBadgeDragged &&
      (Math.abs(e.clientX - d.startX) > SELF_BADGE_DRAG_SLOP ||
       Math.abs(e.clientY - d.startY) > SELF_BADGE_DRAG_SLOP)) {
    _selfBadgeDragged = true;
  }
  d.left = _clampBadge(e.clientX - d.stage.left - d.grabX, d.stage.width - d.width);
  d.top  = _clampBadge(e.clientY - d.stage.top  - d.grabY, d.stage.height - d.height);
  badge.style.left = d.left + 'px';
  badge.style.top = d.top + 'px';
  badge.style.right = 'auto';
  badge.style.bottom = 'auto';
}

function _onSelfBadgePointerUp(e) {
  var d = _selfBadgeDrag;
  if (!d || (e && e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
  _selfBadgeDrag = null;
  window.removeEventListener('pointermove', _onSelfBadgePointerMove);
  window.removeEventListener('pointerup', _onSelfBadgePointerUp);
  window.removeEventListener('pointercancel', _onSelfBadgePointerUp);
  var badge = document.getElementById('video-stage-self');
  if (!badge) return;
  badge.classList.remove('dragging');
  badge.style.removeProperty('left');
  badge.style.removeProperty('top');
  badge.style.removeProperty('right');
  badge.style.removeProperty('bottom');
  if (_selfBadgeDragged) {
    setSelfBadgeCorner(nearestBadgeCorner(
      { left: d.left, top: d.top, width: d.width, height: d.height },
      { width: d.stage.width, height: d.stage.height }
    ));
  }
}

function initSelfVideoBadge() {
  var badge = document.getElementById('video-stage-self');
  if (!badge || badge._voxalDragWired) return;
  badge._voxalDragWired = true;
  badge.dataset.corner = _selfBadgeCorner;
  badge.addEventListener('pointerdown', _onSelfBadgePointerDown);
  // The tile inside the badge carries the click-to-pin handler every tile has,
  // and a drag ends with a click. Swallow that one in the capture phase, or
  // moving the badge would also blow it up to the focus slot.
  badge.addEventListener('click', function(e) {
    if (!_selfBadgeDragged) return;
    _selfBadgeDragged = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// --- Watching a peer: the roster's camera / screen icons ----------------------
//
// Every participant with a live camera (or screen) keeps an icon on their roster
// row, and it is a control rather than a label. On your own row it is the camera
// itself — press to switch it on or off. On someone else's it decides whether
// *you* watch them: a purely local choice, nothing is signalled and their camera
// keeps running, because no participant gets to reach across the room and switch
// off somebody else's camera.

var VIDEO_ICON_PATHS = {
  camera: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
  'camera-off': '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  'screen-off': '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="1" y1="1" x2="23" y2="23"/>'
};

function peerVideoTileKey(peerId, kind) {
  return (kind === 'screen' ? 'screen:' : 'camera:') + peerId;
}

// Where the stage applies, "watching" means the peer has a tile on it; elsewhere
// (mobile, tiny embed, narrow web, Tauri's pop-out window) it means the floating
// viewer is open on them. Gated on videoStageAvailable() — which is a media
// query, not a count — rather than on whether the stage currently has any tiles:
// hiding the last one would otherwise flip the icon's meaning underneath the
// user and leave nothing that could un-hide it.
function peerVideoWatched(peerId, kind) {
  if (videoStageAvailable()) return !_hiddenStageKeys.has(peerVideoTileKey(peerId, kind));
  return kind === 'screen' ? _screenViewerPeerId === peerId : _videoViewerPeerId === peerId;
}

// Show or hide one tile, for this viewer only.
function toggleStageTileHidden(key) {
  if (_hiddenStageKeys.has(key)) _hiddenStageKeys.delete(key);
  else _hiddenStageKeys.add(key);
  updatePeerList();   // repaints the icon; the stage rides the same tick
}

function togglePeerVideoWatch(peerId, kind) {
  if (!peerId) return;
  if (videoStageAvailable()) {
    toggleStageTileHidden(peerVideoTileKey(peerId, kind));
    return;
  }
  if (kind === 'screen') {
    if (_screenViewerPeerId === peerId) closeScreenViewer(); else openScreenViewer(peerId);
  } else if (_videoViewerPeerId === peerId) {
    closeVideoViewer();
  } else {
    openVideoViewer(peerId);
  }
}

function _videoIconButton(kind, on, title, onClick) {
  var btn = document.createElement('button');
  btn.className = 'btn-icon peer-cam-btn' + (on ? '' : ' peer-cam-btn-off');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.setAttribute('aria-pressed', String(!!on));
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    VIDEO_ICON_PATHS[on ? kind : kind + '-off'] + '</svg>';
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function appendPeerVideoButtons(parent, peerId, isSelf) {
  if (!parent || !videoModeEnabled) return;

  if (isSelf) {
    // Your own icon shows or hides your *self-view*, nothing more. Whether the
    // camera transmits at all belongs to the footer Camera button and stays
    // there — two controls for one stream is how you end up switching off a
    // camera you only meant to stop looking at. So the icon is offered only
    // where a self-view exists to hide: a live camera, on the stage surface.
    if (IS_TINY_EMBED || !localVideoActive || !videoStageAvailable()) return;
    var selfShown = !_hiddenStageKeys.has(SELF_CAMERA_TILE_KEY);
    parent.appendChild(_videoIconButton(
      'camera',
      selfShown,
      selfShown ? 'Hide your self-view' : 'Show your self-view',
      function() { toggleStageTileHidden(SELF_CAMERA_TILE_KEY); }
    ));
    return;
  }

  var conn = peerId ? connections.get(peerId) : null;
  if (!conn) return;
  var who = conn.pseudo || shortId(peerId);
  if (conn.videoActive) {
    var seesCamera = peerVideoWatched(peerId, 'camera');
    parent.appendChild(_videoIconButton(
      'camera',
      seesCamera,
      (seesCamera ? 'Hide ' : 'Show ') + who + "'s camera",
      function() { togglePeerVideoWatch(peerId, 'camera'); }
    ));
  }
  if (conn.screenActive) {
    var seesScreen = peerVideoWatched(peerId, 'screen');
    parent.appendChild(_videoIconButton(
      'screen',
      seesScreen,
      (seesScreen ? 'Hide ' : 'Show ') + who + "'s screen",
      function() { togglePeerVideoWatch(peerId, 'screen'); }
    ));
  }
}

function updateVideoModeUI() {
  // Video mode toggle in settings — a normal room capability, no longer dev-gated.
  var settingRow = document.getElementById('video-mode-setting');
  if (settingRow) {
    settingRow.classList.remove('hidden');
    var toggleBtn = document.getElementById('btn-video-mode');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', videoModeEnabled);
      toggleBtn.textContent = videoModeEnabled ? 'ON' : 'OFF';
      // role="switch" → aria-checked, not aria-pressed.
      toggleBtn.setAttribute('aria-checked', String(videoModeEnabled));
    }
  }
  // Share camera button in room controls (visible when video mode is active)
  var shareBtn = document.getElementById('btn-share-camera');
  if (shareBtn) {
    shareBtn.classList.toggle('hidden', !videoModeEnabled);
    shareBtn.classList.toggle('active', localVideoActive);
    shareBtn.setAttribute('aria-pressed', String(localVideoActive));
  }
  // Note there is no flip button here: front/back belongs to the self-view
  // tile (see _buildVideoTile), not to the room's control row.
  // The background control is not here: it rides on the self-view tile, beside
  // the flip button, because it belongs to your camera rather than to the room
  // (see _buildVideoTile). Close its popover when the camera goes away.
  if (!localVideoActive) closeVideoBackgroundPopover();
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
  if (!videoModeEnabled) {
    stopVideoShare();
    stopScreenShare();
  }
  updateVideoStage();
  updateVideoModeUI();
}

// --- Video/screen media routing (P2P mesh or Cloudflare SFU) -----------------
//
// startVideoShare()/startScreenShare() capture locally (unchanged below), then
// decide ONCE per share action how this client's track reaches the room:
//   p2p — the original full-mesh MediaConnection code, unchanged, one call per
//         peer (p2pPublishVideo/p2pPublishScreen)
//   sfu — ONE upload session to Cloudflare's Realtime SFU (sfuPublishVideo/
//         sfuPublishScreen); every other peer independently subscribes to it
//         (sfuSubscribeVideo/sfuSubscribeScreen) rather than being "called"
// This never applies to audio — selectVideoTopology() and everything below is
// invisible to the voice/PTT path. See docs/video-routing.md.

// Cached SFU-availability hint: null = unknown (optimistic — let the first mint
// attempt decide), true/false = the last mint outcome, expires after
// SFU_AVAILABILITY_TTL_MS so a temporary Cloudflare/network hiccup doesn't
// permanently pin the room to P2P.
function sfuAvailabilityHint() {
  if (_sfuAvailability === null) return true;
  if (Date.now() - _sfuAvailabilityCheckedAt > SFU_AVAILABILITY_TTL_MS) return true;
  return _sfuAvailability;
}
function noteSfuAvailability(available) {
  _sfuAvailability = available;
  _sfuAvailabilityCheckedAt = Date.now();
}

function decideVideoTopology(kind) {
  return selectVideoTopology(kind, {
    preference: videoRoutingPreference(),
    participantCount: connections.size + 1,
    meshHealthy: true,
    sfuConfigured: sfuAvailabilityHint()
  });
}

function _trackRegistryKey(participantId, kind) { return participantId + ':' + kind; }

// The subscription's health, for the tile. A relayed tile that is black because
// its subscription failed must not look identical to one that is working — that
// was the whole failure mode of the first two rounds of this feature.
function remoteTrackState(participantId, kind) {
  var track = _videoTrackRegistry.get(_trackRegistryKey(participantId, kind));
  return track ? track.state : null;
}

function _setTrackState(participantId, kind, patch) {
  var key = _trackRegistryKey(participantId, kind);
  var track = _videoTrackRegistry.get(key) || {
    callId: roomCode, participantId: participantId, kind: kind, state: 'unpublished', topology: 'p2p'
  };
  Object.assign(track, patch);
  _videoTrackRegistry.set(key, track);
  return track;
}

async function startVideoShare() {
  if (localVideoActive) return;
  var rawStream;
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({
      video: selectedCameraConstraints(),
      audio: false
    });
  } catch (e) {
    devLog('[Video] Camera share failed: ' + (e && e.message ? e.message : String(e)), 'warn');
    showCopyToast(cameraAccessHint(e));
    return;
  }
  // Wrap before publishing, so peers only ever see the composited track and
  // nobody catches a frame of the unprocessed room.
  localVideoStream = await maybeApplyVideoEffects(rawStream);
  localVideoActive = true;
  // Auto-activate hands-free when sharing camera
  if (!freeHandMode) setFreeHand(true);
  await publishLocalTrack('video', localVideoStream);
  updateVideoModeUI();
  // Fire and forget: the flip button appears a tick later if there is a second
  // camera. Nothing waits on it, so a slow enumerateDevices never delays video.
  cameraFlipAvailable().then(function(supported) {
    if (supported === _cameraFlipSupported) return;
    _cameraFlipSupported = supported;
    updateVideoModeUI();
  });
}

function stopVideoShare() {
  if (!localVideoActive && !localVideoStream) return;
  unpublishLocalTrack('video'); // closes the outgoing mesh calls or the SFU session
  if (localVideoStream) {
    stopStreamTracks(localVideoStream);
    localVideoStream = null;
  }
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

// --- Front/back camera flip (mobile) ------------------------------------------
//
// Shaped after reacquireMicForRoom(), which solved exactly this problem for the
// microphone. The rules it learned apply verbatim here:
//
//   * acquire the new stream FIRST and keep the old one on any failure — a flip
//     that leaves the call with a dead camera is far worse than one that does
//     nothing;
//   * swap with sender.replaceTrack(), never a teardown + re-publish. Republishing
//     renegotiates, drops every viewer's tile, and re-opens the glare window;
//   * say NOTHING on the wire. `conn.videoActive` is signaling state meaning
//     "this peer is sharing" — a flip is not a stop, and re-announcing would make
//     every peer tear the tile down and rebuild it.

var _cameraFlipInFlight = false;
// Probed after the camera starts (a device count is only trustworthy once the
// page holds a capture grant), then cached for the session.
var _cameraFlipSupported = false;

function localVideoSenders() {
  var pcs = [];
  connections.forEach(function(conn) {
    videoPeerConnections(conn).forEach(function(pc) { pcs.push(pc); });
  });
  // The relay path publishes through its own peer connection, not the mesh.
  var sfu = _sfuPublishSessions.video;
  if (sfu && sfu.pc) pcs.push(sfu.pc);

  var senders = [];
  pcs.forEach(function(pc) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    pc.getSenders().forEach(function(sender) {
      if (sender.track && sender.track.kind === 'video') senders.push(sender);
    });
  });
  return senders;
}

async function flipCamera() {
  if (!localVideoActive || _cameraFlipInFlight) return;
  _cameraFlipInFlight = true;
  var previousFacing = _cameraFacing;
  var oldStream = localVideoStream;
  try {
    _cameraFacing = (_cameraFacing === 'user') ? 'environment' : 'user';
    var newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: selectedCameraConstraints(),
        audio: false
      });
    } catch (e) {
      // Keep the old camera wired up, exactly as reacquireMicForRoom does.
      _cameraFacing = previousFacing;
      devLog('[Video] Camera flip failed: ' + (e && e.message ? e.message : String(e)), 'warn');
      showCopyToast('Could not switch camera');
      return;
    }

    var newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      _cameraFacing = previousFacing;
      stopStreamTracks(newStream);
      showCopyToast('Could not switch camera');
      return;
    }

    // A flip that lands while backgrounded must not silently un-pause capture.
    if (_localCameraSuspended) { try { newTrack.enabled = false; } catch (e) { /* ignore */ } }

    // With a background effect running, the thing we publish is the canvas, not
    // the camera — so repointing the effect at the new camera swaps nothing on
    // the wire at all. No replaceTrack, no re-tune, no glare window.
    if (localVideoStream && localVideoStream._effectsProcessor) {
      var previousRaw = localVideoStream._effectsOriginal;
      await VideoEffects.setSource(newStream);
      localVideoStream._effectsOriginal = newStream;
      if (previousRaw && previousRaw !== newStream) stopStreamTracks(previousRaw);
      updateVideoModeUI();
      updatePeerList();
      return;
    }

    localVideoStream = newStream;
    await swapLocalVideoTrack(newTrack);

    if (oldStream) stopStreamTracks(oldStream);
    updateVideoModeUI();
    updatePeerList();   // refreshes the stage, which re-reads localVideoStream
  } finally {
    _cameraFlipInFlight = false;
  }
}

// --- Background effect: the picker --------------------------------------------
//
// One chip row, rendered by VideoEffects.renderPicker() into two places: the
// room's popover and the settings card. The markup and the preset list live in
// video-effects.js so settings.html can render the identical row without a
// third hand-written copy of it.

var _videoBgPickers = [];

function syncVideoBackgroundControls() {
  var mode = videoBackgroundMode();
  _videoBgPickers.forEach(function(p) { try { p.sync(mode); } catch (e) { /* ignore */ } });
  // The room control lives on the self-view tile; refreshing the stage is what
  // re-reads its state.
  if (inRoom) updatePeerList();
}

function closeVideoBackgroundPopover() {
  var pop = document.getElementById('video-bg-popover');
  if (!pop || pop.classList.contains('hidden')) return;
  pop.classList.add('hidden');
  document.querySelectorAll('.video-tile-bg[aria-expanded="true"]').forEach(function(b) {
    b.setAttribute('aria-expanded', 'false');
  });
  _videoBgAnchor = null;
}

// The popover is a child of #screen-room, not of the tile: renderVideoStage()
// moves the self-view tile between the grid and the minimized badge, and the
// badge is far too small to contain a picker. So it is positioned by hand
// against whichever button opened it, and clamped into the viewport.
var _videoBgAnchor = null;

function positionVideoBackgroundPopover() {
  var pop = document.getElementById('video-bg-popover');
  if (!pop || !_videoBgAnchor || pop.classList.contains('hidden')) return;
  if (!_videoBgAnchor.isConnected) { closeVideoBackgroundPopover(); return; }

  var a = _videoBgAnchor.getBoundingClientRect();
  var box = pop.getBoundingClientRect();
  var margin = 8;

  // Prefer below the button; flip above when there is no room, which is the
  // usual case for a badge parked in a bottom corner.
  var top = a.bottom + margin;
  if (top + box.height > window.innerHeight - margin) {
    top = Math.max(margin, a.top - box.height - margin);
  }
  var left = a.left + a.width / 2 - box.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

  pop.style.top = Math.round(top) + 'px';
  pop.style.left = Math.round(left) + 'px';
}

function toggleVideoBackgroundPopover(anchor) {
  var pop = document.getElementById('video-bg-popover');
  if (!pop) return;
  var opening = pop.classList.contains('hidden') || anchor !== _videoBgAnchor;
  if (!opening) { closeVideoBackgroundPopover(); return; }

  _videoBgAnchor = anchor || _videoBgAnchor;
  pop.classList.remove('hidden');
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  syncVideoBackgroundControls();
  renderVideoBackgroundProgress();
  positionVideoBackgroundPopover();
  var first = pop.querySelector('.bg-chip[aria-checked="true"]') || pop.querySelector('.bg-chip');
  if (first) first.focus();
}

// --- First run: 12 MB, and a way out -----------------------------------------
//
// The segmentation runtime is not bundled (see docs/video-effects.md), so the
// first time anybody turns an effect on it has to be downloaded. On a phone
// tether that is not instant, and a picker that sits there looking broken is
// worse than a slow one — so say what is happening, how far along it is, and
// offer to stop.

var _videoBgLoad = null;   // last progress event, or null when nothing is loading

function renderVideoBackgroundProgress() {
  var row = document.getElementById('video-bg-progress');
  if (!row) return;
  var active = !!_videoBgLoad && _videoBgLoad.phase !== 'ready' &&
               _videoBgLoad.phase !== 'cancelled' && _videoBgLoad.phase !== 'failed';
  row.classList.toggle('hidden', !active);
  if (!active) { positionVideoBackgroundPopover(); return; }

  var pct = Math.round((_videoBgLoad.ratio || 0) * 100);
  var text = row.querySelector('.video-bg-progress-text');
  var fill = row.querySelector('.video-bg-progress-fill');
  if (text) {
    // Name the size up front: this is a one-off download, and a user who does
    // not want to spend it on the connection they are on should be able to tell
    // before it finishes rather than after.
    text.textContent = _videoBgLoad.phase === 'cache'
      ? 'Preparing background effects…'
      : 'Downloading background effects (about 12 MB) — ' + pct + '%';
  }
  if (fill) fill.style.width = pct + '%';
  positionVideoBackgroundPopover();
}

function cancelVideoBackgroundLoad() {
  if (typeof VideoEffects === 'undefined') return;
  VideoEffects.cancelLoad();
}

function initVideoBackgroundUI() {
  if (typeof VideoEffects === 'undefined') return;

  _videoBgPickers = [];
  ['video-bg-picker', 'settings-bg-picker'].forEach(function(id) {
    var host = document.getElementById(id);
    if (!host) return;
    var picker = VideoEffects.renderPicker(host, {
      onPick: function(mode) { applyVideoBackground(mode); },
      onError: function(msg) { showCopyToast(msg); }
    });
    if (picker) _videoBgPickers.push(picker);
  });

  var pop = document.getElementById('video-bg-popover');
  if (pop) pop.addEventListener('click', function(ev) { ev.stopPropagation(); });
  document.addEventListener('click', closeVideoBackgroundPopover);
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape') closeVideoBackgroundPopover();
  });
  // An anchored popover has to follow its anchor, and the self-view badge moves
  // with the layout.
  window.addEventListener('resize', positionVideoBackgroundPopover);
  window.addEventListener('scroll', positionVideoBackgroundPopover, true);

  var cancelBtn = document.getElementById('btn-video-bg-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      cancelVideoBackgroundLoad();
    });
  }

  VideoEffects.onLoadProgress(function(e) {
    var done = e.phase === 'ready' || e.phase === 'cancelled' || e.phase === 'failed';
    _videoBgLoad = done ? null : e;
    renderVideoBackgroundProgress();
  });

  // A device that cannot sustain the effect gets dropped back to a plain
  // camera rather than a slideshow. VideoEffects has already stepped the
  // segmentation rate down as far as it goes by the time this fires.
  VideoEffects.onOverload(function(why) {
    devLog('[Video] Background effect disabled: ' + why, 'warn');
    showCopyToast('Background effect turned off — this device can\'t keep up');
    applyVideoBackground('off');
  });

  syncVideoBackgroundControls();
}

// --- Background effect: switching it live -------------------------------------
//
// Same rules as flipCamera() above, for the same reasons: acquire before you
// swap, keep the working stream on any failure, and say NOTHING on the wire —
// changing your background is not a start and not a stop, and re-announcing
// would make every peer tear the tile down and rebuild it.
//
// The one thing worth spelling out is what does *not* happen here. Once the
// camera is wrapped, the published track is the canvas, and the canvas does not
// change when the background does. So blur → image → other image is a texture
// swap inside the shader: no replaceTrack, no renegotiation, no tile flicker.
// Only crossing the off↔on boundary swaps a track.

var _videoBackgroundInFlight = false;

async function applyVideoBackground(mode) {
  if (typeof VideoEffects === 'undefined') return;
  mode = VideoEffects.normalizeMode(mode);
  VideoEffects.writeMode(mode);
  syncVideoBackgroundControls();

  // Not sharing. The preference is all that needs to change, unless the
  // settings preview happens to be running the pipeline — then keep it in step
  // so the chips show what they claim to.
  if (!localVideoActive || !localVideoStream) {
    if (_cameraPreviewStream) {
      if (_cameraPreviewStream._effectsProcessor && mode !== 'off') await VideoEffects.setMode(mode);
      else await startCameraPreview().catch(function() { /* the preview is not load-bearing */ });
    }
    return;
  }
  if (_videoBackgroundInFlight) return;
  _videoBackgroundInFlight = true;

  try {
    var wrapped = !!localVideoStream._effectsProcessor;

    // Already running: just repoint the shader.
    if (wrapped && mode !== 'off') {
      await VideoEffects.setMode(mode);
      return;
    }

    // Turning it off: publish the camera again, then tear the pipeline down.
    if (wrapped && mode === 'off') {
      var raw = localVideoStream._effectsOriginal;
      var rawTrack = raw && raw.getVideoTracks()[0];
      if (!rawTrack) return;
      var processed = localVideoStream;
      localVideoStream = raw;
      await swapLocalVideoTrack(rawTrack);
      processed._effectsOriginal = null;   // the camera lives on in localVideoStream
      VideoEffects.stop(processed);
      try { processed.getTracks().forEach(function(t) { t.stop(); }); } catch (e) { /* ignore */ }
      updateVideoModeUI();
      updatePeerList();
      return;
    }

    // Turning it on over a live camera.
    if (!wrapped && mode !== 'off') {
      if (!videoEffectsAvailable()) { showCopyToast('Background effects are not available here'); return; }
      var source = localVideoStream;
      var next;
      try {
        next = await VideoEffects.wrap(source, mode);
      } catch (e) {
        // Keep the plain camera wired up, exactly as flipCamera does on failure.
        VideoEffects.writeMode('off');
        syncVideoBackgroundControls();
        if (VideoEffects.isAbort(e)) {
          // The user pressed Cancel. That is an answer, not an error.
          devLog('[Video] Background effect download cancelled', 'info');
          return;
        }
        devLog('[Video] Background effect failed: ' + (e && e.message ? e.message : String(e)), 'warn');
        showCopyToast('Background effect unavailable on this device');
        return;
      }
      var nextTrack = next.getVideoTracks()[0];
      if (!nextTrack) { VideoEffects.stop(next); return; }
      if (_localCameraSuspended) { try { nextTrack.enabled = false; } catch (e) { /* ignore */ } }
      localVideoStream = next;
      await swapLocalVideoTrack(nextTrack);
      updateVideoModeUI();
      updatePeerList();
    }
  } finally {
    _videoBackgroundInFlight = false;
    syncVideoBackgroundControls();
  }
}

// Point every live sender — mesh and relay alike — at a new local video track,
// then re-tune. A replaced track carries none of the old one's encoder
// parameters, which is why the tuning pass is not optional.
async function swapLocalVideoTrack(track) {
  var swaps = localVideoSenders().map(function(sender) {
    return Promise.resolve(sender.replaceTrack(track)).catch(function(e) {
      devLog('[Video] replaceTrack failed on background change: ' +
             (e && e.message ? e.message : String(e)), 'warn');
    });
  });
  await Promise.all(swaps);
  connections.forEach(function(conn) {
    videoPeerConnections(conn).forEach(function(pc) { tuneVideoSenders(pc, 'video'); });
  });
  if (_sfuPublishSessions.video && _sfuPublishSessions.video.pc) {
    tuneVideoSenders(_sfuPublishSessions.video.pc, 'video');
  }
}

// Release a camera or screen stream completely. The unwrap matters for the same
// reason stopMicStreamFully()'s does: with a background effect on, the stream
// being stopped is a *canvas capture*, and stopping its track leaves the real
// camera running with the indicator light on and the render loop spinning.
function stopStreamTracks(stream) {
  if (!stream) return;
  var raw = stream._effectsOriginal;
  if (stream._effectsProcessor && typeof VideoEffects !== 'undefined') {
    try { VideoEffects.stop(stream); } catch (e) { /* ignore */ }
  }
  if (raw) {
    try { raw.getTracks().forEach(function(t) { t.stop(); }); } catch (e) { /* ignore */ }
  }
  try { stream.getTracks().forEach(function(t) { t.stop(); }); } catch (e) { /* ignore */ }
  stream._effectsOriginal = null;
  stream._effectsProcessor = null;
}

// Backgrounding the app should stop burning battery on an encode nobody can
// see. `enabled = false` — not `track.stop()` — is the right lever: it needs no
// renegotiation, is instantly reversible, and leaves `conn.videoActive` alone,
// so nobody's tile disappears and no `video-stop` goes on the wire. It is the
// same mechanism PTT already uses to gate the microphone.
var _localCameraSuspended = false;

function setLocalCameraSuspended(suspended) {
  suspended = !!suspended;
  if (suspended === _localCameraSuspended) return;
  _localCameraSuspended = suspended;
  if (!localVideoStream) return;
  // With an effect on, the tracks on localVideoStream belong to a canvas.
  // Disabling only those would leave the real camera capturing and the render
  // loop spinning — exactly the battery drain this function exists to avoid.
  if (localVideoStream._effectsProcessor && typeof VideoEffects !== 'undefined') {
    try { VideoEffects.setPaused(suspended); } catch (e) { /* ignore */ }
  }
  var raw = rawCameraStream(localVideoStream);
  [raw, localVideoStream].forEach(function(s) {
    if (!s) return;
    try {
      s.getVideoTracks().forEach(function(t) { t.enabled = !suspended; });
    } catch (e) { /* track already ended */ }
  });
}

// Only worth offering where there is more than one camera to flip between, and
// only on a phone — a laptop's second camera is not a "flip".
async function cameraFlipAvailable() {
  if (!IS_MOBILE_DEVICE) return false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return false;
  try {
    var devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(function(d) { return d.kind === 'videoinput'; }).length > 1;
  } catch (e) {
    return false;
  }
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
  await publishLocalTrack('screen', localScreenStream);
  updateVideoModeUI();
}

function stopScreenShare() {
  if (!localScreenActive && !localScreenStream) return;
  unpublishLocalTrack('screen'); // closes the outgoing mesh calls or the SFU session
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(function(t) { t.stop(); });
    localScreenStream = null;
  }
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

// Decide topology once for this share action, publish accordingly, then
// announce it over the existing video-offer/screen-offer signaling (extended
// with an optional `topology`/`providerRef` so other peers know whether to
// expect an incoming MediaConnection (p2p) or to subscribe via the SFU.
async function publishLocalTrack(kind, stream) {
  var topology = decideVideoTopology(kind);
  _localVideoTopology[kind] = topology;
  devLog('[SFU] publish ' + kind + ' -> ' + topology.mode + ' (' + topology.reason + ')');

  var providerRef = null;
  if (topology.mode === 'sfu') {
    try {
      providerRef = await (kind === 'video' ? sfuPublishVideo(stream) : sfuPublishScreen(stream));
    } catch (e) {
      // SFU publish failed (not configured, network, etc) — fall back to the
      // always-available P2P mesh rather than leaving the room with no video
      // at all. Never silently escalate the OTHER direction (p2p -> sfu).
      devLog('[SFU] publish ' + kind + ' failed, falling back to P2P: ' + (e && e.message ? e.message : e), 'warn');
      noteSfuAvailability(false);
      topology = { mode: 'p2p', reason: VIDEO_TOPOLOGY_REASON.SFU_UNAVAILABLE };
      _localVideoTopology[kind] = topology;
    }
  }
  if (topology.mode === 'p2p') {
    connections.forEach(function(c, peerId) {
      if (kind === 'video') p2pPublishVideo(peerId, c, stream);
      else p2pPublishScreen(peerId, c, stream);
    });
  }

  announceLocalTrackTopology(kind, topology, providerRef);
}

// Stop publishing this kind over whichever topology is currently carrying it.
// Both branches matter: `stopVideoShare`/`stopScreenShare` and topology
// migration share this one teardown, so a migration cannot leave the losing
// path running (which is exactly what P2P -> SFU used to do).
function unpublishLocalTrack(kind) {
  var topology = _localVideoTopology[kind];
  _localVideoTopology[kind] = null;
  if (topology && topology.mode === 'sfu') {
    if (kind === 'video') sfuUnpublishVideo(); else sfuUnpublishScreen();
    return;
  }
  connections.forEach(function(c, peerId) {
    if (kind === 'video') p2pUnpublishVideo(peerId, c);
    else p2pUnpublishScreen(peerId, c);
  });
}

// Re-run the topology decision for whatever this client is currently
// publishing, e.g. after the routing preference changes or the roster size
// changes. Only re-publishes when the decision actually changed (never tears
// down a perfectly good SFU or P2P session just because it was re-evaluated
// and reached the same answer). Never touches audio.
// An SFU publish is awaited while `_localVideoTopology[kind]` still holds the
// OLD mode, so a second reconcile landing mid-flight would see a stale "current"
// and publish the same track twice. One migration per kind at a time.
var _topologyReconcileInFlight = { video: false, screen: false };

function reconcileVideoTopology() {
  ['video', 'screen'].forEach(function(kind) {
    var active = kind === 'video' ? localVideoActive : localScreenActive;
    var stream = kind === 'video' ? localVideoStream : localScreenStream;
    if (!active || !stream) return;
    if (_topologyReconcileInFlight[kind]) return;
    var next = decideVideoTopology(kind);
    var current = _localVideoTopology[kind];
    if (current && current.mode === next.mode) return; // same decision, nothing to do
    devLog('[SFU] reconcile ' + kind + ': ' + (current ? current.mode : '(none)') + ' -> ' + next.mode + ' (' + next.reason + ')');
    unpublishLocalTrack(kind);
    if (next.mode === 'p2p') {
      connections.forEach(function(c, peerId) {
        if (kind === 'video') p2pPublishVideo(peerId, c, stream);
        else p2pPublishScreen(peerId, c, stream);
      });
      _localVideoTopology[kind] = next;
      announceLocalTrackTopology(kind, next);
    } else {
      _topologyReconcileInFlight[kind] = true;
      (kind === 'video' ? sfuPublishVideo(stream) : sfuPublishScreen(stream)).then(function(providerRef) {
        _localVideoTopology[kind] = next;
        announceLocalTrackTopology(kind, next, providerRef);
      }).catch(function(e) {
        devLog('[SFU] reconcile ' + kind + ' publish failed, staying on P2P: ' + (e && e.message ? e.message : e), 'warn');
        noteSfuAvailability(false);
        connections.forEach(function(c, peerId) {
          if (kind === 'video') p2pPublishVideo(peerId, c, stream);
          else p2pPublishScreen(peerId, c, stream);
        });
        _localVideoTopology[kind] = { mode: 'p2p', reason: VIDEO_TOPOLOGY_REASON.SFU_UNAVAILABLE };
        announceLocalTrackTopology(kind, _localVideoTopology[kind]);
      }).then(function() {
        _topologyReconcileInFlight[kind] = false;
      });
    }
  });
}

// The roster is what makes the topology decision go stale: `decideVideoTopology`
// reads `connections.size + 1`, so a join or leave can change the answer for
// someone who is ALREADY sharing. Before this existed, only new joiners ever got
// the SFU and existing publishers stayed on the mesh for the life of the call.
//
// Debounced, because a burst of joins (or a join immediately followed by a drop)
// should settle before anything is torn down — migrating interrupts video
// briefly, so flapping on it is worse than reacting a second later. Memoized on
// the count so the many updatePeerList() calls that are about talking state or
// video icons cost nothing.
var ROSTER_RECONCILE_DEBOUNCE_MS = 1500;
var _lastReconciledParticipantCount = null;
var _rosterReconcileTimer = null;

function reconcileVideoTopologyForRoster() {
  if (!inRoom) return;
  var count = connections.size + 1;
  if (count === _lastReconciledParticipantCount) return;
  _lastReconciledParticipantCount = count;
  if (_rosterReconcileTimer) clearTimeout(_rosterReconcileTimer);
  _rosterReconcileTimer = setTimeout(function() {
    _rosterReconcileTimer = null;
    if (!inRoom) return;
    reconcileVideoTopology();
  }, ROSTER_RECONCILE_DEBOUNCE_MS);
}

function resetRosterReconcileState() {
  if (_rosterReconcileTimer) clearTimeout(_rosterReconcileTimer);
  _rosterReconcileTimer = null;
  _lastReconciledParticipantCount = null;
  _topologyReconcileInFlight.video = false;
  _topologyReconcileInFlight.screen = false;
}

function announceLocalTrackTopology(kind, topology, providerRef) {
  if (!peer || !inRoom) return;
  var msg = {
    type: kind === 'video' ? 'video-offer' : 'screen-offer',
    peerId: peer.id,
    topology: topology.mode,
    providerRef: providerRef || undefined
  };
  if (isHost) {
    connections.forEach(function(c) { if (c.data) c.data.send(msg); });
  } else {
    var hc = connections.get(roomCode);
    if (hc && hc.data) hc.data.send(msg);
  }
}

// Per-peer full-mesh publish — unchanged behavior, extracted verbatim from the
// original startVideoShare()/startScreenShare() loops so P2P has zero
// regression from this refactor.
function p2pPublishVideo(peerId, c, stream) {
  if (!peer || peerId === peer.id) return;
  var videoCall = peer.call(peerId, stream, { metadata: { type: 'video' } });
  if (!videoCall) return;
  tuneVideoCall(videoCall, 'camera');
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
}

function p2pPublishScreen(peerId, c, stream) {
  if (!peer || peerId === peer.id) return;
  var screenCall = peer.call(peerId, stream, { metadata: { type: 'screen' } });
  if (!screenCall) return;
  tuneVideoCall(screenCall, 'screen');
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
}

// The inverse of p2pPublishVideo/p2pPublishScreen: stop sending this kind to one
// peer over the mesh. Needed by topology migration — reconciling P2P -> SFU used
// to leave these MediaConnections running, so the publisher uploaded N direct
// streams *and* one to Cloudflare, which is strictly worse than not migrating.
function p2pUnpublishVideo(peerId, c) {
  if (!c || !c.videoMediaOut) return;
  try { c.videoMediaOut.close(); } catch (_) {}
  c.videoMediaOut = null;
}

function p2pUnpublishScreen(peerId, c) {
  if (!c || !c.screenMediaOut) return;
  try { c.screenMediaOut.close(); } catch (_) {}
  c.screenMediaOut = null;
}

// --- Cloudflare SFU router (video/screen only) --------------------------------
//
// Mints a scoped, short-lived capability from /api/sfu-session, then proxies
// SDP negotiation through /api/sfu-track — the Cloudflare Realtime app secret
// never reaches this client (see api/sfu-session.js, api/sfu-track.js). The
// client<->Cloudflare RTCPeerConnection here is a plain, independent leg: one
// per (participant, kind, role) — publish and subscribe never share a session,
// which sidesteps needing Cloudflare session renegotiation support that has
// not been verified against a live account (see docs/video-routing.md open
// questions). Never used for audio.

// Capability tokens are minted with a TTL (SFU_CAPABILITY_TTL, 300s by default)
// and are scoped to {roomCode, participantId, kind, action} — all four stable
// for the life of a share. Minting a fresh one per publish/subscribe/retry
// ignored the TTL entirely and turned /api/sfu-session's per-IP rate limit
// (30/min) into a live hazard: every peer-list broadcast re-subscribed every
// viewer to every publisher, and several test peers behind one NAT share one
// budget. The mints that lost the race were the newest subscriptions — i.e. a
// new joiner's camera, black for everyone else.
//
// Cached per kind:action, re-minted only when the room, the participant or the
// remaining lifetime says it must be.
var _sfuCapabilityCache = {};
var _sfuCapabilityInFlight = {};
var SFU_CAPABILITY_RENEW_MARGIN_MS = 30000;

function clearSfuCapabilityCache() {
  _sfuCapabilityCache = {};
  _sfuCapabilityInFlight = {};
}

function _cachedCapability(kind, action) {
  var entry = _sfuCapabilityCache[kind + ':' + action];
  if (!entry) return null;
  // A host migration changes roomCode, and the server checks the tuple — a
  // token minted for the old room would simply be rejected.
  if (entry.roomCode !== roomCode || entry.participantId !== (peer && peer.id)) return null;
  if (Date.now() > entry.expiresAt - SFU_CAPABILITY_RENEW_MARGIN_MS) return null;
  return entry.minted;
}

function sfuMintCapability(kind, action) {
  var cached = _cachedCapability(kind, action);
  if (cached) return Promise.resolve(cached);

  // Subscribes are fired concurrently (one per publisher, off a single
  // peer-list), so caching only the RESULT still lets a burst all miss the
  // cache and mint in parallel — straight into the rate limit. Cache the
  // in-flight promise so a burst collapses into one request.
  var key = kind + ':' + action;
  if (_sfuCapabilityInFlight[key]) return _sfuCapabilityInFlight[key];

  var pending = _sfuMintCapabilityNow(kind, action).then(function(minted) {
    delete _sfuCapabilityInFlight[key];
    return minted;
  }, function(err) {
    delete _sfuCapabilityInFlight[key];
    throw err;
  });
  _sfuCapabilityInFlight[key] = pending;
  return pending;
}

async function _sfuMintCapabilityNow(kind, action) {
  var res = await fetch(sfuSessionUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomCode: roomCode, participantId: peer.id, kind: kind, action: action }),
    cache: 'no-store'
  });
  if (res.status === 503) {
    noteSfuAvailability(false);
    throw Object.assign(new Error('SFU not configured on this deployment'), { code: 'not_configured' });
  }
  if (res.status === 429) {
    // Temporary and retryable — emphatically NOT "no SFU here". Marking the SFU
    // unavailable would demote the whole room to P2P over a transient limit.
    var retryAfter = Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 0;
    throw Object.assign(
      new Error('SFU capability rate-limited (HTTP 429)' + (retryAfter ? ', retry after ' + retryAfter + 's' : '')),
      { code: 'rate_limited', retryAfterMs: (retryAfter || 5) * 1000 }
    );
  }
  if (!res.ok) throw Object.assign(new Error('SFU session mint failed: HTTP ' + res.status), { code: 'mint_failed' });
  noteSfuAvailability(true);

  var minted = await res.json(); // { capability, expires_at, sfu_app_id }
  var expiresAt = Date.parse(minted && minted.expires_at);
  if (expiresAt) {
    _sfuCapabilityCache[kind + ':' + action] = {
      minted: minted,
      expiresAt: expiresAt,
      roomCode: roomCode,
      participantId: peer && peer.id
    };
  }
  return minted;
}

// Reads the SDP out of whatever shape Cloudflare returned — it may be a bare
// string or a {type, sdp} description depending on the leg.
function _sdpOf(description) {
  if (!description) return '';
  return typeof description === 'string' ? description : (description.sdp || '');
}

// A stable, human-readable track name, unique per publisher per kind so a
// subscriber can name exactly what it wants and the Cloudflare dashboard is
// readable. Voxal's own peer id — no Cloudflare concept leaks outward.
function sfuTrackNameFor(participantId, kind) {
  return participantId + '-' + kind;
}

async function sfuNegotiate(kind, action, offerSdp, minted, tracks, sessionId) {
  var res = await fetch(sfuTrackUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: minted.capability,
      roomCode: roomCode,
      participantId: peer.id,
      kind: kind,
      action: action,
      offer: offerSdp || undefined,
      sessionId: sessionId || undefined,
      // The instruction that actually routes media. Without it Cloudflare
      // negotiates a session and forwards nothing — a black tile.
      tracks: tracks
    }),
    cache: 'no-store'
  });
  if (!res.ok) {
    var detail = await res.json().catch(function() { return {}; });
    throw Object.assign(
      new Error('SFU negotiate failed: HTTP ' + res.status + (detail.detail ? ' — ' + detail.detail : '')),
      { code: 'negotiate_failed' }
    );
  }
  return res.json(); // { sessionId, sessionDescription, requiresImmediateRenegotiation, tracks }
}

async function sfuRenegotiate(kind, action, answerSdp, minted, sessionId) {
  var res = await fetch(sfuRenegotiateEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: minted.capability,
      roomCode: roomCode,
      participantId: peer.id,
      kind: kind,
      action: action,
      answer: answerSdp,
      sessionId: sessionId
    }),
    cache: 'no-store'
  });
  if (!res.ok) {
    var detail = await res.json().catch(function() { return {}; });
    throw Object.assign(
      new Error('SFU renegotiate failed: HTTP ' + res.status + (detail.detail ? ' — ' + detail.detail : '')),
      { code: 'renegotiate_failed' }
    );
  }
  return res.json();
}

async function sfuPublishTrack(kind, stream) {
  var minted = await sfuMintCapability(kind, 'publish');
  var pc = new RTCPeerConnection(); // client<->Cloudflare edge leg — STUN/TURN need unverified per docs/video-routing.md
  var trackName = sfuTrackNameFor(peer.id, kind);

  // Keep the transceivers: Cloudflare needs each track's `mid` to know which
  // m-line carries which named track.
  var transceivers = stream.getTracks().map(function(t) {
    return pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] });
  });
  var offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  var tracks = transceivers.map(function(tr) {
    return { location: 'local', mid: tr.mid, trackName: trackName };
  });
  var result = await sfuNegotiate(kind, 'publish', pc.localDescription.sdp, minted, tracks);
  await pc.setRemoteDescription({ type: 'answer', sdp: _sdpOf(result.sessionDescription) });

  _sfuPublishSessions[kind] = { pc: pc, cfSessionId: result.sessionId, trackName: trackName };
  var providerRef = { sessionId: result.sessionId, trackName: trackName };
  _setTrackState(peer.id, kind, { state: 'published', topology: 'sfu', _providerRef: providerRef });
  devLog('[SFU] published ' + kind + ' as "' + trackName + '" in session ' + result.sessionId);
  _wireSfuReconnect(pc, kind, peer.id, 'publish', function() { return sfuRenegotiatePublish(kind, stream); });
  return providerRef;
}

function sfuUnpublishTrack(kind) {
  var session = _sfuPublishSessions[kind];
  if (session && session.pc) { try { session.pc.close(); } catch (_) {} }
  _sfuPublishSessions[kind] = null;
  _setTrackState(peer.id, kind, { state: 'unpublished' });
}

async function sfuRenegotiatePublish(kind, stream) {
  sfuUnpublishTrack(kind);
  var providerRef = await sfuPublishTrack(kind, stream);
  // A republish mints a NEW Cloudflare session, so every subscriber's
  // {sessionId, trackName} is now stale — re-announce or they keep pulling a
  // track that no longer exists (a black tile that "reconnected successfully").
  var topology = _localVideoTopology[kind] || { mode: 'sfu', reason: VIDEO_TOPOLOGY_REASON.PREFERENCE_ALLOW_SFU };
  announceLocalTrackTopology(kind, topology, providerRef);
  return providerRef;
}

function sfuPublishVideo(stream) { return sfuPublishTrack('video', stream); }
function sfuPublishScreen(stream) { return sfuPublishTrack('screen', stream); }
function sfuUnpublishVideo() { return sfuUnpublishTrack('video'); }
function sfuUnpublishScreen() { return sfuUnpublishTrack('screen'); }

// Subscribing needs the publisher's Cloudflare {sessionId, trackName}, which
// arrives over Voxal's own signaling as `providerRef`. Without naming the
// remote track there is nothing for Cloudflare to forward — the session
// connects and the tile stays black, which is exactly how this failed before.
function _normalizeProviderRef(providerRef) {
  if (!providerRef || typeof providerRef !== 'object') return null;
  if (!providerRef.sessionId || !providerRef.trackName) return null;
  return { sessionId: providerRef.sessionId, trackName: providerRef.trackName };
}

// A peer-list is broadcast on every join, leave, prune and rename, so one lands
// mid-negotiation routinely. Without this guard each broadcast opened a SECOND
// peer connection for the same track: the first was orphaned but still live,
// still holding a Cloudflare session and still pulling media, and every attempt
// burned another capability mint against the per-IP rate limit — which, with
// several participants behind one address, is how a room ends up rate-limited.
var _sfuSubscribeInFlight = {};

function sfuSubscribeTrack(kind, publisherPeerId, providerRef) {
  var key = _trackRegistryKey(publisherPeerId, kind);
  var ref = _normalizeProviderRef(providerRef || _rememberedProviderRef(publisherPeerId, kind));
  var pending = _sfuSubscribeInFlight[key];
  if (pending && ref && pending.ref &&
      pending.ref.sessionId === ref.sessionId && pending.ref.trackName === ref.trackName) {
    return pending.promise;
  }
  var promise = _sfuSubscribeTrackNow(kind, publisherPeerId, providerRef);
  var settle = function() {
    if (_sfuSubscribeInFlight[key] && _sfuSubscribeInFlight[key].promise === promise) {
      delete _sfuSubscribeInFlight[key];
    }
  };
  promise.then(settle, settle);
  _sfuSubscribeInFlight[key] = { ref: ref, promise: promise };
  return promise;
}

async function _sfuSubscribeTrackNow(kind, publisherPeerId, providerRef) {
  var conn = connections.get(publisherPeerId);
  if (!conn) {
    // The ref is remembered, but nothing here retries — say so rather than
    // vanishing, which is indistinguishable from a black tile with no cause.
    devLog('[SFU] subscribe ' + kind + ' from ' + shortId(publisherPeerId) +
      ' skipped: no connection entry for that peer yet', 'warn');
    return;
  }

  var ref = _normalizeProviderRef(providerRef || _rememberedProviderRef(publisherPeerId, kind));
  if (!ref) {
    // Bail loudly instead of negotiating a transceiver that can never receive.
    devLog('[SFU] subscribe ' + kind + ' from ' + shortId(publisherPeerId) +
      ' skipped: publisher sent no track reference', 'warn');
    return;
  }

  var existing = _rememberedProviderRef(publisherPeerId, kind);
  var media = kind === 'video' ? conn.videoMedia : conn.screenMedia;
  if (media && existing && existing.sessionId === ref.sessionId && existing.trackName === ref.trackName) {
    var livePc = media.peerConnection;
    var dead = livePc && (livePc.connectionState === 'failed' || livePc.connectionState === 'closed' ||
                          livePc.iceConnectionState === 'failed');
    if (livePc && !dead) return; // already subscribed to exactly this track
  }
  // Replacing a subscription: close the old peer connection instead of orphaning
  // it. Overwriting conn.videoMedia left the previous one alive, holding a
  // Cloudflare session and still attached to the tile.
  if (media) _teardownRemoteTrack(publisherPeerId, kind);

  var minted = await sfuMintCapability(kind, 'subscribe');
  var pc = new RTCPeerConnection();
  var remoteStream = new MediaStream();
  pc.addEventListener('track', function(ev) {
    (ev.streams[0] ? ev.streams[0].getTracks() : [ev.track]).forEach(function(t) {
      if (!remoteStream.getTracks().includes(t)) remoteStream.addTrack(t);
    });
    if (kind === 'video') attachRemoteVideo(publisherPeerId, remoteStream);
    else attachRemoteScreen(publisherPeerId, remoteStream);
  });

  // No local transceiver and no local offer here: for a remote pull Cloudflare
  // describes the track it will forward, so it generates the offer.
  var result = await sfuNegotiate(kind, 'subscribe', null, minted, [{
    location: 'remote',
    sessionId: ref.sessionId,
    trackName: ref.trackName
  }]);

  var sdp = _sdpOf(result.sessionDescription);
  if (result.requiresImmediateRenegotiation && sdp) {
    // Cloudflare offered; answer it and hand the answer back to close the loop.
    await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sfuRenegotiate(kind, 'subscribe', pc.localDescription.sdp, minted, result.sessionId);
  } else if (sdp) {
    await pc.setRemoteDescription({ type: 'answer', sdp: sdp });
  } else {
    throw Object.assign(new Error('SFU subscribe returned no session description'), { code: 'negotiate_failed' });
  }

  // Re-resolve rather than reusing the `conn` captured before the awaits above:
  // the peer may have left mid-negotiation, in which case this subscription has
  // no owner and its peer connection would leak.
  var live = connections.get(publisherPeerId);
  if (!live) {
    try { pc.close(); } catch (_) {}
    devLog('[SFU] subscribe ' + kind + ' from ' + shortId(publisherPeerId) +
      ' completed after the peer left — dropping it', 'warn');
    return;
  }

  var shim = { peerConnection: pc, close: function() { try { pc.close(); } catch (_) {} } };
  if (kind === 'video') live.videoMedia = shim; else live.screenMedia = shim;
  var topologyPatch = {}; topologyPatch[kind + 'Topology'] = { mode: 'sfu', reason: VIDEO_TOPOLOGY_REASON.PREFERENCE_ALLOW_SFU };
  Object.assign(live, topologyPatch);
  _setTrackState(publisherPeerId, kind, { state: 'subscribed', topology: 'sfu', _providerRef: ref, error: null });
  delete _sfuSubscribeRetries[_trackRegistryKey(publisherPeerId, kind)];
  devLog('[SFU] subscribed to ' + kind + ' "' + ref.trackName + '" from ' + shortId(publisherPeerId));
  _wireSfuReconnect(pc, kind, publisherPeerId, 'subscribe', function() {
    return sfuSubscribeTrack(kind, publisherPeerId, ref);
  });
}

// Publishers announce their {sessionId, trackName} over signaling; remember it
// per peer so a resubscribe (reconnect, topology reconcile) doesn't need the
// original message again.
function _rememberProviderRef(publisherPeerId, kind, providerRef) {
  var ref = _normalizeProviderRef(providerRef);
  if (!ref) return null;
  _setTrackState(publisherPeerId, kind, { _providerRef: ref });
  return ref;
}

function _rememberedProviderRef(publisherPeerId, kind) {
  var track = _videoTrackRegistry.get(_trackRegistryKey(publisherPeerId, kind));
  return track ? track._providerRef : null;
}

// A failed subscription used to be a dev-log line and nothing else, so a viewer
// saw a black tile still badged "☁ Relayed" — indistinguishable from a working
// one. Record the failure on the track state (which the tile renders) and, for
// the one failure that is genuinely transient, retry with backoff rather than
// leaving the tile black until the publisher happens to republish.
var SFU_SUBSCRIBE_MAX_RETRIES = 5;
var _sfuSubscribeRetries = {};

function _sfuSubscribeFailed(kind, publisherPeerId, providerRef, err) {
  var message = (err && err.message) ? err.message : String(err);
  devLog('[SFU] subscribe ' + kind + ' from ' + shortId(publisherPeerId) + ' failed: ' + message, 'warn');
  _setTrackState(publisherPeerId, kind, { state: 'failed', error: message });

  if (!err || err.code !== 'rate_limited') return;
  var key = _trackRegistryKey(publisherPeerId, kind);
  var attempts = (_sfuSubscribeRetries[key] || 0) + 1;
  if (attempts > SFU_SUBSCRIBE_MAX_RETRIES) {
    devLog('[SFU] subscribe ' + kind + ' from ' + shortId(publisherPeerId) + ' giving up after ' + (attempts - 1) + ' retries', 'warn');
    return;
  }
  _sfuSubscribeRetries[key] = attempts;
  // Honour the server's Retry-After, backing further off each attempt.
  var delay = (err.retryAfterMs || 5000) * attempts;
  devLog('[SFU] subscribe ' + kind + ' from ' + shortId(publisherPeerId) + ' retrying in ' + Math.round(delay / 1000) + 's');
  setTimeout(function() {
    if (!inRoom || !connections.get(publisherPeerId)) return;
    sfuSubscribeTrack(kind, publisherPeerId, providerRef).then(function() {
      delete _sfuSubscribeRetries[key];
    }).catch(function(e2) { _sfuSubscribeFailed(kind, publisherPeerId, providerRef, e2); });
  }, delay);
}

function sfuSubscribeVideo(publisherPeerId, providerRef) {
  return sfuSubscribeTrack('video', publisherPeerId, providerRef).catch(function(e) {
    _sfuSubscribeFailed('video', publisherPeerId, providerRef, e);
  });
}
function sfuSubscribeScreen(publisherPeerId, providerRef) {
  return sfuSubscribeTrack('screen', publisherPeerId, providerRef).catch(function(e) {
    _sfuSubscribeFailed('screen', publisherPeerId, providerRef, e);
  });
}

function sfuUnsubscribeTrack(kind, publisherPeerId) {
  var conn = connections.get(publisherPeerId);
  var media = conn && (kind === 'video' ? conn.videoMedia : conn.screenMedia);
  if (media && media.close) { try { media.close(); } catch (_) {} }
  _videoTrackRegistry.delete(_trackRegistryKey(publisherPeerId, kind));
}

// Drop whatever is currently carrying a remote track, whichever topology it is.
// `conn.videoMedia`/`screenMedia` holds a PeerJS MediaConnection on the mesh and
// the SFU subscription shim on the relay; both expose `.close()`, so one
// teardown covers a migration in either direction.
//
// Deliberately NOT detachRemoteVideo/detachRemoteScreen: those also clear
// `videoActive`/`screenActive`, and that flag means "this peer is sharing" —
// signaling state owned by video-offer/video-stop, not by whichever transport
// happens to be carrying the pixels. `videoStageTiles()` skips any peer whose
// `videoActive` is false, so clearing it here made the publisher vanish from the
// stage for the whole migration and never come back: nothing on the subscribe
// path sets it again. That is what made a peer joining an already-relayed room
// see nobody at all.
function _teardownRemoteTrack(publisherPeerId, kind) {
  _videoTrackRegistry.delete(_trackRegistryKey(publisherPeerId, kind));
  if (kind === 'video') detachRemoteVideoTransport(publisherPeerId);
  else detachRemoteScreenTransport(publisherPeerId);
}

/**
 * Viewer side of a video-offer/screen-offer.
 *
 * A re-announcement is not necessarily a fresh share: the publisher may have
 * MIGRATED this track between the mesh and the SFU mid-call, because the room
 * crossed the size threshold (see reconcileVideoTopologyForRoster). Whatever was
 * carrying it before has to be torn down first, or the viewer ends up holding
 * two live streams for one track and rendering whichever arrived last.
 *
 * Returns the normalized mode so the host can relay it. An absent or
 * unrecognized topology is always read as 'p2p' — the always-available path —
 * and never inferred as 'sfu'.
 */
function applyRemoteTrackTopology(publisherPeerId, kind, rawTopology, providerRef) {
  var mode = rawTopology === 'sfu' ? 'sfu' : 'p2p';
  var conn = connections.get(publisherPeerId);
  var prev = conn ? (kind === 'video' ? conn.videoTopology : conn.screenTopology) : null;
  var ref = _normalizeProviderRef(providerRef);
  var prevRef = _rememberedProviderRef(publisherPeerId, kind);

  // A republish re-announces the same track (sfuRenegotiatePublish does exactly
  // this), and churning a healthy subscription on that would drop video for no
  // reason. Only the {sessionId, trackName} actually changing means "resubscribe".
  //
  // For the SFU case "unchanged" also requires that a subscription actually
  // exists: the ref is remembered before the subscribe is attempted, so a failed
  // attempt (a rate-limited mint, say) would otherwise look identical to a
  // healthy one and never be retried — a permanently black tile.
  var media = conn && (kind === 'video' ? conn.videoMedia : conn.screenMedia);
  var unchanged = !!prev && prev.mode === mode && (
    mode === 'p2p' ||
    (!!media && !!ref && !!prevRef && ref.sessionId === prevRef.sessionId && ref.trackName === prevRef.trackName)
  );

  if (conn) {
    var next = { mode: mode, reason: VIDEO_TOPOLOGY_REASON.PREFERENCE_ALLOW_SFU };
    if (kind === 'video') conn.videoTopology = next; else conn.screenTopology = next;
  }
  if (unchanged) return mode;

  if (prev) {
    devLog('[SFU] remote ' + kind + ' from ' + shortId(publisherPeerId) + ': ' +
      prev.mode + ' -> ' + mode + ', dropping the old path');
    _teardownRemoteTrack(publisherPeerId, kind);
  }

  if (mode === 'sfu' && publisherPeerId !== (peer && peer.id)) {
    _rememberProviderRef(publisherPeerId, kind, providerRef);
    if (kind === 'video') sfuSubscribeVideo(publisherPeerId, providerRef);
    else sfuSubscribeScreen(publisherPeerId, providerRef);
  }
  // mode === 'p2p' needs no equivalent call: the publisher's MediaConnection
  // arrives on its own through the ordinary peer.on('call') path.
  return mode;
}

// --- SFU reconnection (video/screen only; never touches roomState/host migration) ---
//
// Confirmed pre-existing gap this does NOT fix: there is no ICE-restart or
// MediaConnection-failure recovery anywhere else in this codebase, for audio
// or P2P video/screen. This state machine is scoped exclusively to the new
// SFU RTCPeerConnections created above.
var SFU_RECONNECT_MAX_ATTEMPTS = 5;
var SFU_RECONNECT_BASE_DELAY_MS = 1500;

function _wireSfuReconnect(pc, kind, participantId, role, renegotiate) {
  if (!pc) return;
  var attempts = 0;
  var settled = false;
  pc.addEventListener('iceconnectionstatechange', function onChange() {
    var state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      attempts = 0;
      return;
    }
    if (state === 'disconnected') {
      _setTrackState(participantId, kind, { state: 'reconnecting' });
      devLog('[SFU] ' + role + ' ' + kind + ' for ' + shortId(participantId) + ' disconnected', 'warn');
      return;
    }
    if ((state === 'failed' || state === 'closed') && !settled) {
      if (attempts >= SFU_RECONNECT_MAX_ATTEMPTS) {
        settled = true;
        _setTrackState(participantId, kind, { state: 'error' });
        devLog('[SFU] ' + role + ' ' + kind + ' for ' + shortId(participantId) + ' reconnect exhausted after ' + attempts + ' attempts', 'warn');
        pc.removeEventListener('iceconnectionstatechange', onChange);
        // Feed the failure back so a persistently unhealthy SFU doesn't keep
        // getting recommended by the topology selector for future publishes.
        noteSfuAvailability(false);
        return;
      }
      attempts++;
      var delay = SFU_RECONNECT_BASE_DELAY_MS * attempts;
      devLog('[SFU] ' + role + ' ' + kind + ' for ' + shortId(participantId) + ' retrying in ' + delay + 'ms (attempt ' + attempts + '/' + SFU_RECONNECT_MAX_ATTEMPTS + ')', 'warn');
      setTimeout(function() {
        if (settled) return;
        renegotiate().catch(function(e) {
          devLog('[SFU] ' + role + ' ' + kind + ' reconnect attempt failed: ' + (e && e.message ? e.message : e), 'warn');
        });
      }, delay);
    }
  });
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
  detachRemoteScreenTransport(peerId);
  var conn = connections.get(peerId);
  if (conn) conn.screenActive = false;
  if (_screenViewerPeerId === peerId) closeScreenViewer();
  updatePeerList();
}

// Transport half of detachRemoteScreen: drop the stream and whatever is
// carrying it, but leave `screenActive` and the open viewer alone. Used when the
// share is still live and only its route is changing (mesh <-> SFU), so the
// viewer re-attaches on its own once the new subscription delivers a track.
function detachRemoteScreenTransport(peerId) {
  var conn = connections.get(peerId);
  if (!conn) return;
  if (conn.screenMedia) {
    try { conn.screenMedia.close(); } catch (_) {}
    conn.screenMedia = null;
  }
  conn.remoteScreenStream = null;
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
  detachRemoteVideoTransport(peerId);
  var conn = connections.get(peerId);
  if (conn) conn.videoActive = false;
  if (_videoViewerPeerId === peerId) closeVideoViewer();
  updatePeerList();
}

// Transport half of detachRemoteVideo — see detachRemoteScreenTransport.
function detachRemoteVideoTransport(peerId) {
  var conn = connections.get(peerId);
  if (!conn) return;
  if (conn.videoMedia) {
    try { conn.videoMedia.close(); } catch (_) {}
    conn.videoMedia = null;
  }
  conn.remoteVideoStream = null;
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
  panel.classList.remove('hidden', 'pip-active');
  _videoFpsIntervalId = _stopFpsOverlay(_videoFpsIntervalId, 'video-viewer-fps');
  _videoFpsIntervalId = _startFpsOverlay('video-viewer-element', 'video-viewer-fps');
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
  panel.classList.remove('hidden', 'pip-active');
  _screenFpsIntervalId = _stopFpsOverlay(_screenFpsIntervalId, 'screen-viewer-fps');
  _screenFpsIntervalId = _startFpsOverlay('screen-viewer-element', 'screen-viewer-fps');
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
          if (panel) panel.classList.add('pip-active');
        }).catch(function(e) {
          console.warn('[video] PiP failed:', e.message);
          showCopyToast('Picture-in-Picture not available');
        });
      } else if (vid.webkitSetPresentationMode) {
        vid.webkitSetPresentationMode('picture-in-picture');
        var panel = document.getElementById('video-viewer-panel');
        if (panel) panel.classList.add('pip-active');
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
          if (panel) panel.classList.add('pip-active');
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
  _videoFpsIntervalId = _stopFpsOverlay(_videoFpsIntervalId, 'video-viewer-fps');
  var panel = document.getElementById('video-viewer-panel');
  var vid   = document.getElementById('video-viewer-element');
  if (panel) { panel.classList.add('hidden'); panel.classList.remove('pip-active'); }
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
  _screenFpsIntervalId = _stopFpsOverlay(_screenFpsIntervalId, 'screen-viewer-fps');
  var panel = document.getElementById('screen-viewer-panel');
  var vid   = document.getElementById('screen-viewer-element');
  if (panel) { panel.classList.add('hidden'); panel.classList.remove('pip-active'); }
  if (vid) vid.srcObject = null;
  if (_screenPopoutWindow && !_screenPopoutWindow.closed) {
    _screenPopoutWindow.close();
  }
  _screenPopoutWindow = null;
  _cleanupScreenLoopback();
  _screenViewerPeerId = null;
}

function resetVideoState() {
  _videoFpsIntervalId  = _stopFpsOverlay(_videoFpsIntervalId, 'video-viewer-fps');
  _screenFpsIntervalId = _stopFpsOverlay(_screenFpsIntervalId, 'screen-viewer-fps');
  stopVideoShare();
  stopScreenShare();
  // Close any SFU subscriptions to other peers' video/screen — these are
  // independent RTCPeerConnections to Cloudflare, not PeerJS connections, so
  // leaving the room doesn't tear them down on its own.
  connections.forEach(function(c, peerId) {
    if (c.videoTopology && c.videoTopology.mode === 'sfu') sfuUnsubscribeTrack('video', peerId);
    if (c.screenTopology && c.screenTopology.mode === 'sfu') sfuUnsubscribeTrack('screen', peerId);
  });
  _videoTrackRegistry.clear();
  _sfuSubscribeInFlight = {};
  // Re-read rather than force: leaving a room must not overwrite the user's
  // (or the host's last) choice. The forced `true` here was prototype scaffolding.
  videoModeEnabled = readVideoModeEnabled();
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
  _stagePinnedKey = null;
  // Session state that belongs to the call, not to the user: every room starts
  // on the front camera with the screen free to sleep again.
  _cameraFacing = 'user';
  _cameraFlipSupported = false;
  _localCameraSuspended = false;
  releaseStageWakeLock();
  closeStagePanels();
  // Choosing not to watch someone is scoped to the room you chose it in.
  _hiddenStageKeys.clear();
  // Grid membership and speaking order describe one call and nothing else.
  _stageGridKeys = [];
  _stageRibbonKeys = [];
  _speakerRecency.clear();
  _speakerSeq = 0;
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
  updateVideoStage();
  updateVideoModeUI();
}

// --- End video / screen sharing helpers --------------------------------------

function leaveRoom() {
  var returnTinyRoomId = IS_TINY_EMBED ? (_invitePendingRoomId || roomDisplayCode() || roomCode || '') : '';
  var returnTinyPeerCount = IS_TINY_EMBED ? currentRoomPeerCount() : 0;
  saveRejoinSnapshot();
  resetVideoState();
  // If this host is the last participant in a published lobby, delete it from the API
  if (isHost && _publishSecret && connections.size === 0) {
    unpublishRoom();
  } else {
    clearPublishState();
  }
  inRoom = false; freeHandMode = false; isTalking = false;
  _pendingTalkingStart = false;
  // Restore the name to what it was before any room-forced rename.
  if (_preRenameMyPseudo !== null) {
    setMyPseudo(_preRenameMyPseudo, { silentAnnounce: true });
    _preRenameMyPseudo = null;
  }
  if (_preRenameAnonPseudo !== null && _anonymousProfile) {
    _anonymousProfile.pseudo = _preRenameAnonPseudo;
    _preRenameAnonPseudo = null;
  }
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
  resetRosterReconcileState();
  resetBandwidthHistory();
  clearSfuCapabilityCache(); // tokens are scoped to {roomCode, participantId}
  _sfuSubscribeRetries = {};
  publishNetworkUsage();  // let an open preferences window show its empty state
  renderNetUsagePanel();  // …and the in-page modal, if it is the one open
  closeStatsPopover();
  closeDeviceInfoPopover();
  _hostDebugMode = false;
  _hostJitterMs = null;
  cancelAudioCheck();
  resetRemoteLogState();
  updateDebugConsentBanner();
  stopHostHeartbeat();
  stopHostHeartbeatMonitor();
  stopPeerHeartbeat();
  stopPeerHeartbeatSweep();
  knownPeerIds.clear();
  releaseAudioFocus();
  nativePTTLeave();
  stopKeepAlive();
  publishRoomActive(false);
  localStorage.removeItem('active-room-code');
  if (activeChannel) { deleteSession(); activeChannel = null; }
  activeChannelRoomId = null;
  Array.from(connections.keys()).forEach(removePeer);
  stopMicStreamFully(stream);
  if (peer) peer.destroy();
  peer = null; stream = null; audioTrack = null;
  isHost = false; roomCode = '';
  document.querySelectorAll('audio[id^="audio-"]').forEach(function(el) { el.remove(); });
  resetAudioRouteOnLeave();
  iframeEmit({ type: 'left' });
  if (IS_TINY_EMBED && returnTinyRoomId) {
    showTinyInviteConnect(returnTinyRoomId, returnTinyPeerCount);
    return;
  }
  showScreen('home');
}

// --- Host migration ----------------------------------------------------------

var HOST_CONNECT_TIMEOUT    = 8000; // per-attempt timeout
var HOST_RETRY_DELAY        = 1500; // delay between retries
// Retries before giving up on the elected new host and re-electing. This budget
// must outlast how long the elected deputy can take to actually assume the host
// role after the old host vanishes — worst case the heartbeat timeout
// (HOST_HEARTBEAT_TIMEOUT_MS, ~7s) plus becomeHost(). Until the deputy is host
// it redirects/closes our connection, so too small a budget makes a survivor
// abandon the rightful deputy and self-promote → split-brain. ~8 × 1.5s ≈ 12s.
var HOST_MAX_RETRIES        = 8;    // retries before re-electing
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
    connections.set(peerId, { data: null, media: null, pseudo: shortId(peerId), pseudoColor: null, talking: false });
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
  publishRoomActive(true);
  localStorage.setItem('active-room-code', peer.id);
  console.log(
    '[migration] This peer became host: ' + migrationPeerLabel(peer.id) +
    '. Deputy is now ' + migrationPeerLabel(currentDeputyId() || null) + '.'
  );
  iframeEmit({ type: 'host-changed', roomCode: peer.id, isSelf: true });
  saveRejoinSnapshot();
  updateRoomHeader();
  updatePeerList();
  // Broadcast full authoritative state to existing peers.
  broadcastHostPeerLists();
  // peer.on('connection') is already wired in joinRoom() and will route here
  // since isHost is now true

  // If the room was published as a public lobby, update the API with our new peer ID.
  if (_publishedRoomId && _publishSecret) {
    // Original host flow: POST with secret updates voxal_room_code.
    publishRoom().catch(function(e) { console.warn('[migration] re-publish failed:', e.message); });
  } else if (_publishedRoomId) {
    // PATCH-claimed room (no secret) — register ourselves as the new host.
    tauriFetch(ANONYMOUS_ROOMS_BASE + '/by-code/' + encodeURIComponent(_publishedRoomId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voxal_room_code: peer.id }),
    }).then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.room_code) { _publishedRoomId = data.room_code; updateRoomHeader(); }
      })
      .catch(function(e) { console.warn('[migration] PATCH host failed:', e.message); });
  }
  if (activeChannel) {
    syncPresenceChannelSession();
  }
}

// --- Protocol version / skew detection ---------------------------------------

// The `hello` a joiner sends to a host (and re-sends to a new host on migration).
function helloMessage() {
  return {
    type: 'hello',
    pseudo: pseudoForPeer(),
    pseudoColor: pseudoColorForSelf(),
    protocolVersion: PROTOCOL_VERSION,
    appVersion: VOXAL_VERSION
  };
}

var _sawNewerProtocol = false;
var _versionWarned = new Set(); // dedupe skew warnings (peer-list repeats often)

// Record a remote peer's advertised protocol/app version and warn on skew. A
// missing protocolVersion means a peer from before versioning (treated as 0).
// If anyone is on a NEWER protocol than us, we're the outdated one → hint once.
function noteRemoteVersion(label, remoteProtocol, remoteApp, peerId) {
  var remote = parseInt(remoteProtocol, 10);
  if (!isFinite(remote)) remote = 0;
  if (peerId) {
    var conn = connections.get(peerId);
    if (conn) connections.set(peerId, Object.assign({}, conn, { protocolVersion: remote, appVersion: remoteApp || null }));
  }
  if (remote !== PROTOCOL_VERSION) {
    var key = (peerId || label) + ':' + remote;
    if (!_versionWarned.has(key)) {
      _versionWarned.add(key);
      console.warn('[version] ' + (label || 'peer') + ' on protocol v' + remote +
        ' (app ' + (remoteApp || '?') + ') — local is protocol v' + PROTOCOL_VERSION + ' (app ' + VOXAL_VERSION + ')');
    }
  }
  if (remote > PROTOCOL_VERSION && !_sawNewerProtocol) {
    _sawNewerProtocol = true;
    maybeShowOutdatedHint();
  }
}

// One-time, non-blocking nudge when a peer is on a newer protocol. Desktop/mobile
// auto-update (Tauri updater / Capgo OTA) on next launch; this mainly helps web.
function maybeShowOutdatedHint() {
  try { showCopyToast('A newer version of Voxal is available — refresh to update.'); } catch (_) {}
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
      var entry = { id: id, pseudo: pseudo, pseudoColor: conn && conn.pseudoColor ? conn.pseudoColor : null };
      if (conn && conn.videoActive) {
        entry.videoActive = true;
        if (conn.videoTopology && conn.videoTopology.mode === 'sfu') {
          entry.videoTopology = 'sfu';
          // A late joiner gets no mesh call for an SFU sharer, so it needs the
          // publisher's {sessionId, trackName} to subscribe on its own.
          entry.videoProviderRef = _rememberedProviderRef(id, 'video') || undefined;
        }
      }
      if (conn && conn.screenActive) {
        entry.screenActive = true;
        if (conn.screenTopology && conn.screenTopology.mode === 'sfu') {
          entry.screenTopology = 'sfu';
          entry.screenProviderRef = _rememberedProviderRef(id, 'screen') || undefined;
        }
      }
      if (conn && conn.protocolVersion != null) entry.protocolVersion = conn.protocolVersion;
      if (conn && conn.appVersion) entry.appVersion = conn.appVersion;
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
  if (!hostData) {
    // peer.connect() returns undefined when the peer is disconnected from the
    // signaling broker. Try to reconnect to the broker, then retry / re-elect.
    console.warn('[migration] peer.connect returned undefined (broker disconnected). Reconnecting…');
    try { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); } catch (_) {}
    if (!inRoom) return;
    if (retriesLeft > 0) {
      setTimeout(function() { _attemptHostConnection(targetHostId, retriesLeft - 1); }, HOST_RETRY_DELAY);
    } else {
      _migrationExcluded.add(targetHostId);
      _migrationCandidateId = null;
      proceedWithHostElection();
    }
    return;
  }
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
    hostData.send(helloMessage());
  });

  hostData.on('data', function(msg) {
    if (gen !== _hostConnGeneration) return;

    if (msg && msg.type === 'pseudo-assigned') {
      applyAssignedSelfProfile(msg.pseudo, msg.pseudoColor || null);
      return;
    }

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
      publishRoomActive(true);
      localStorage.setItem('active-room-code', targetHostId);
      iframeEmit({ type: 'host-changed', roomCode: targetHostId, isSelf: false });
      updateRoomHeader();
      var prev = connections.get(targetHostId) || { media: null, pseudoColor: null, talking: false };
      connections.set(targetHostId, Object.assign({}, prev, {
        data: hostData,
        pseudo: msg.hostPseudo || shortId(targetHostId),
        pseudoColor: msg.hostPseudoColor || null
      }));
      console.log('[migration] Connected to new host ' + migrationPeerLabel(targetHostId) + '. Received peer-list.');
      safeHandleHostMessage(msg);
      return;
    }

    if (receivedPeerList) safeHandleHostMessage(msg);
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
  if (!hostData) {
    // peer.connect() returns undefined when disconnected from the broker.
    console.warn('[initial] peer.connect returned undefined (broker disconnected). Reconnecting…');
    try { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); } catch (_) {}
    if (onInitialJoinReject) onInitialJoinReject(new Error('Lost connection to the signaling server. Please try again.'));
    return;
  }
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
    hostData.send(helloMessage());
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
      if (!peer || peer.destroyed) return; // cancelled mid-join
      devLog('✓ Joined! ' + (msg.peers ? msg.peers.length : 0) + ' peer(s) in room');
      finishJoin(hostId, hostData);
      safeHandleHostMessage(msg);
      if (onInitialJoinResolve) onInitialJoinResolve(peer.id);
      return;
    }

    if (msg && msg.type === 'pseudo-assigned') {
      applyAssignedSelfProfile(msg.pseudo, msg.pseudoColor || null);
      return;
    }

    // Pass other messages to host handler (after peer-list received)
    if (receivedPeerList) safeHandleHostMessage(msg);
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
  call.answer(stream || new MediaStream(), audioCallOptions());
  call.on('stream', function(remote) {
    attachAudio(call.peer, remote);
    const prev = connections.get(call.peer) || { data: null, pseudo: shortId(call.peer), pseudoColor: null, talking: false };
    connections.set(call.peer, Object.assign({}, prev, { media: call }));
    applyAudioTuningToPeer(call.peer);
    updatePeerList();
  });
  call.on('close', function() { clearPeerMedia(call.peer); });
  call.on('error', function(err) { console.warn('[call]', err); });
}

// --- Host logic --------------------------------------------------------------

function sendHostPeerList(dataConn, excludedPeerId) {
  if (!dataConn) return;
  var successorIds = reconcileHostSuccessorIds();
  var hostProfile = selfPseudoProfile();
  var selfConn = excludedPeerId ? connections.get(excludedPeerId) : null;
  dataConn.send({
    type: 'peer-list',
    peers: buildHostPeerList(excludedPeerId),
    hostId: peer.id,
    hostPseudo: hostProfile.pseudo,
    hostPseudoColor: hostProfile.pseudoColor || null,
    selfPseudo: selfConn && selfConn.pseudo ? selfConn.pseudo : null,
    selfPseudoColor: selfConn && selfConn.pseudoColor ? selfConn.pseudoColor : null,
    hostVideoActive: localVideoActive,
    hostScreenActive: localScreenActive,
    hostVideoTopology: (_localVideoTopology.video && _localVideoTopology.video.mode === 'sfu') ? 'sfu' : 'p2p',
    hostScreenTopology: (_localVideoTopology.screen && _localVideoTopology.screen.mode === 'sfu') ? 'sfu' : 'p2p',
    hostVideoProviderRef: _rememberedProviderRef(peer.id, 'video') || undefined,
    hostScreenProviderRef: _rememberedProviderRef(peer.id, 'screen') || undefined,
    videoModeEnabled: videoModeEnabled,
    debugMode: isDevModeEnabled(),
    jitterMs: hostJitterBroadcastMs(),
    deputyId: successorIds[0] || null,
    successorIds: successorIds,
    protocolVersion: PROTOCOL_VERSION,
    appVersion: VOXAL_VERSION
  });
  dataConn.send({
    type: 'heartbeat',
    at: Date.now(),
    debugMode: isDevModeEnabled(),
    jitterMs: hostJitterBroadcastMs(),
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
  if (activeChannel) {
    schedulePresenceRefresh();
  }
}

function handleJoinerDataConnection(dataConn) {
  const joinerId = dataConn.peer;

  dataConn.on('open', function() {
    const previous = connections.get(joinerId);
    dataConn._voxalExistingPeer = !!previous;
    rememberPeer(joinerId);
    const existing = previous || { media: null, pseudo: shortId(joinerId), pseudoColor: null, talking: false };
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
    if (!msg || typeof msg !== 'object') return; // ignore malformed packets
    notePeerHeartbeat(joinerId, msg.at ? msg.at : Date.now());
    if (msg.type === 'hello') {
      rememberPeer(joinerId);
      const requestedPseudo = msg.pseudo || shortId(joinerId);
      const canonical = canonicalizePeerProfile(joinerId, requestedPseudo, msg.pseudoColor || null);
      const pseudo = canonical.pseudo;
      const existing = connections.get(joinerId) || { data: dataConn, media: null, pseudoColor: null, talking: false };
      connections.set(joinerId, Object.assign({}, existing, {
        pseudo: pseudo,
        pseudoColor: canonical.pseudoColor
      }));
      noteRemoteVersion('joiner ' + shortId(joinerId), msg.protocolVersion, msg.appVersion, joinerId);

      sendDataIfOpen(dataConn, {
        type: 'pseudo-assigned',
        pseudo: pseudo,
        pseudoColor: canonical.pseudoColor
      });
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
          if (id !== joinerId && c.data) sendDataIfOpen(c.data, {
            type: 'peer-joined',
            peerId: joinerId,
            pseudo: pseudo,
            pseudoColor: canonical.pseudoColor
          });
        });
        playCarillon();
      }
      // Always broadcast updated peer-list to all existing peers so they receive
      // the latest successorIds (deputy chain). Without this, existing peers only
      // see peer-joined (which carries no successorIds) and keep stale election
      // state — causing split-brain if the host dies right after the new join.
      broadcastHostPeerLists();

      // If host has active video over P2P, call the newcomer. When the host's
      // video is on the SFU, skip the mesh "call" entirely — the newcomer picks
      // it up on its own via peer-list's videoTopology:'sfu' (see the joiner-side
      // peer-list handler) instead of being called.
      var hostVideoIsSfu = _localVideoTopology.video && _localVideoTopology.video.mode === 'sfu';
      if (localVideoActive && localVideoStream && !hostVideoIsSfu) {
        var videoCall = peer.call(joinerId, localVideoStream, { metadata: { type: 'video' } });
        if (videoCall) {
          tuneVideoCall(videoCall, 'camera');
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
      // Tell other P2P video-active peers to call the newcomer. An SFU-topology
      // sharer needs no such nudge — the newcomer subscribes to it directly.
      connections.forEach(function(c, id) {
        var isSfu = c.videoTopology && c.videoTopology.mode === 'sfu';
        if (id !== joinerId && c.videoActive && !isSfu && c.data) {
          sendDataIfOpen(c.data, { type: 'video-call-peer', peerId: joinerId });
        }
      });

      // Same P2P-vs-SFU split for the host's own screen share.
      var hostScreenIsSfu = _localVideoTopology.screen && _localVideoTopology.screen.mode === 'sfu';
      if (localScreenActive && localScreenStream && !hostScreenIsSfu) {
        var screenCall = peer.call(joinerId, localScreenStream, { metadata: { type: 'screen' } });
        if (screenCall) {
          tuneVideoCall(screenCall, 'screen');
          var jConn2 = connections.get(joinerId);
          if (jConn2) jConn2.screenMediaOut = screenCall;
          screenCall.on('close', function() {
            var jc2 = connections.get(joinerId);
            if (jc2 && jc2.screenMediaOut === screenCall) jc2.screenMediaOut = null;
          });
        }
      }
      // Tell other P2P screen-active peers to call the newcomer.
      connections.forEach(function(c, id) {
        var isSfu = c.screenTopology && c.screenTopology.mode === 'sfu';
        if (id !== joinerId && c.screenActive && !isSfu && c.data) {
          sendDataIfOpen(c.data, { type: 'screen-call-peer', peerId: joinerId });
        }
      });

      updatePeerList();

    } else if (msg.type === 'heartbeat') {
      return;

    } else if (msg.type === 'talking') {
      updatePeerTalking(joinerId, msg.active);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) sendDataIfOpen(c.data, { type: 'talking', peerId: joinerId, active: msg.active });
      });
    } else if (msg.type === 'pseudo') {
      const requestedPseudo = msg.pseudo || shortId(joinerId);
      const canonical = canonicalizePeerProfile(joinerId, requestedPseudo, msg.pseudoColor || null);
      const pseudo = canonical.pseudo;
      const existing = connections.get(joinerId) || { data: dataConn, media: null, pseudoColor: null, talking: false };
      connections.set(joinerId, Object.assign({}, existing, {
        pseudo: pseudo,
        pseudoColor: canonical.pseudoColor
      }));
      sendDataIfOpen(dataConn, {
        type: 'pseudo-assigned',
        pseudo: pseudo,
        pseudoColor: canonical.pseudoColor
      });
      updatePeerList();
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) sendDataIfOpen(c.data, {
          type: 'peer-renamed',
          peerId: joinerId,
          pseudo: pseudo,
          pseudoColor: canonical.pseudoColor
        });
      });
    } else if (msg.type === 'video-offer') {
      // Relay to all other peers, forwarding the sender's routing topology so
      // everyone knows whether to expect a MediaConnection or to subscribe via
      // the SFU. Never inferred/defaulted to 'sfu' — an absent/unrecognized
      // value is treated as 'p2p', the always-available path.
      markPeerVideoActive(joinerId, true);
      // The host is a viewer too, just like any other peer — this both applies
      // the topology locally (migrating off the old path when it changed) and
      // hands back the normalized mode to relay.
      var voTopology = applyRemoteTrackTopology(joinerId, 'video', msg.topology, msg.providerRef);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) {
          sendDataIfOpen(c.data, { type: 'video-offer', peerId: joinerId, topology: voTopology, providerRef: msg.providerRef });
        }
      });
    } else if (msg.type === 'video-stop') {
      // Relay to all other peers
      var vsConn = connections.get(joinerId);
      if (vsConn && vsConn.videoTopology && vsConn.videoTopology.mode === 'sfu') sfuUnsubscribeTrack('video', joinerId);
      detachRemoteVideo(joinerId);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) sendDataIfOpen(c.data, { type: 'video-stop', peerId: joinerId });
      });
    } else if (msg.type === 'screen-offer') {
      markPeerScreenActive(joinerId, true);
      var soTopology = applyRemoteTrackTopology(joinerId, 'screen', msg.topology, msg.providerRef);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) {
          sendDataIfOpen(c.data, { type: 'screen-offer', peerId: joinerId, topology: soTopology, providerRef: msg.providerRef });
        }
      });
    } else if (msg.type === 'screen-stop') {
      var ssConn = connections.get(joinerId);
      if (ssConn && ssConn.screenTopology && ssConn.screenTopology.mode === 'sfu') sfuUnsubscribeTrack('screen', joinerId);
      detachRemoteScreen(joinerId);
      connections.forEach(function(c, id) {
        if (id !== joinerId && c.data) sendDataIfOpen(c.data, { type: 'screen-stop', peerId: joinerId });
      });
    } else if (msg.type === 'audio-check-request') {
      handleAudioCheckRequestAtHost(joinerId, msg.peerId || null, msg.durationMs);
    } else if (msg.type === 'audio-check-response') {
      if (msg.from && msg.from !== (peer && peer.id)) {
        var acReq = connections.get(msg.from);
        if (acReq && acReq.data) sendDataIfOpen(acReq.data, {
          type: 'audio-check-response', peerId: joinerId, report: msg.report, declined: msg.declined
        });
      } else {
        onAudioCheckResponse(joinerId, msg.report, msg.declined);
      }
    } else if (msg.type === 'log-session-request' || msg.type === 'log-session-stop') {
      // Remote debug logs, viewer -> target: answer for the host, else relay on.
      handleLogControlAtHost(joinerId, msg.peerId || null, msg.type, msg.fromPseudo);
    } else if (msg.type === 'log-session-response' || msg.type === 'log-session-end' || msg.type === 'log-entries') {
      handleLogReplyAtHost(joinerId, msg);
    } else if (msg.type === 'device-info-request') {
      // A peer wants someone's device info: answer for the host, else relay to the target.
      handleDeviceInfoRequestAtHost(joinerId, msg.peerId);
    } else if (msg.type === 'device-info-response') {
      // Store this joiner's snapshot; relay back if it was for another requester.
      updatePeerDeviceInfo(joinerId, msg.info, msg.declined);
      if (msg.from && msg.from !== (peer && peer.id)) {
        var reqConn = connections.get(msg.from);
        if (reqConn && reqConn.data) sendDataIfOpen(reqConn.data, { type: 'device-info-response', peerId: joinerId, info: msg.info, declined: msg.declined });
      } else {
        onDeviceInfoResponse(joinerId, msg.info, msg.declined);
      }
    }
  });

  dataConn.on('close', function() {
    if (!isCurrentPeerDataConnection(joinerId, dataConn)) return;
    // Defer the peer-left / roster broadcast by one tick. If our own Peer is
    // being torn down, ALL our connections close in a synchronous cascade and
    // `peer.destroyed` only flips true once that cascade finishes — so checking
    // it inside the close handler is too early (it reads false). On the next
    // tick a self-destroying host sees destroyed=true and skips: it must NOT
    // broadcast a shrunken peer-list/successor chain to the survivors on its way
    // out, or it poisons their migration election (dropping peers whose host
    // link merely collapsed alongside ours) and causes split-brain. A genuine
    // single peer-leave passes this check and broadcasts as before.
    setTimeout(function() {
      if (!peer || peer.destroyed || !inRoom || !isHost) return;
      if (!isCurrentPeerDataConnection(joinerId, dataConn)) return; // peer reconnected meanwhile
      forgetPeer(joinerId);
      connections.forEach(function(c) {
        if (c.data) sendDataIfOpen(c.data, { type: 'peer-left', peerId: joinerId });
      });
      playGoodbye();
      removePeer(joinerId);
      broadcastHostPeerLists();
    }, 0);
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
  var cancelled = false;
  _cancelJoin = function() {
    cancelled = true;
    _cancelJoin = null;
    if (peer && !peer.destroyed) peer.destroy();
  };

  knownPeerIds.clear();
  _lastAuthoritativePeerIds = null;
  _authoritativeSuccessorIds = [];
  const iceServers = await fetchIceServers();
  if (cancelled) throw new Error('Connection cancelled.');
  peer = new Peer(Object.assign({ config: { iceServers } }, peerServerOptions()));
  peer.on('connection', function(dataConn) { handleJoinerDataConnection(dataConn); });
  peer.on('call',       function(call)     { handleIncomingCall(call); });
  let settled = false;
  function settle(fn, val) {
    if (settled) return;
    settled = true;
    _cancelJoin = null;
    fn(val);
  }
  await new Promise(function(resolve, reject) {
    _cancelJoin = function() {
      devLog('→ Create cancelled');
      peer.destroy();
      settle(reject, new Error('Connection cancelled.'));
    };
    peer.on('open', function(id) {
      if (cancelled) { peer.destroy(); settle(reject, new Error('Connection cancelled.')); return; }
      isHost = true; roomCode = id; inRoom = true;
      roomState = ROOM_STATE_CONNECTED;
      stopHostHeartbeatMonitor();
      stopPeerHeartbeat();
      startPeerHeartbeatSweep();
      startHostHeartbeat();
      publishRoomActive(true);
      localStorage.setItem('active-room-code', id);
      updateRoomHeader();
      nativePTTJoin();
      startKeepAlive();
      requestAudioFocus(); // Keep foreground service running while in room
      initAudioRouteForRoom(); // Every room starts on the loudspeaker
      showScreen('room');
      updatePeerList();
      updateShortcutDisplay();
      updateVideoModeUI();
      startStatsPolling();
      saveRejoinSnapshot();
      iframeEmit({ type: 'joined', roomCode: id, peerId: id });
      if (onJoined) onJoined(id);

      autoAcquireMicOnJoin();

      settle(resolve, id);
    });
    peer.on('error', function(err) {
      if (!settled) {
        settle(reject, err);
        handlePeerRuntimeError(err, false, function() {});
        return;
      }
      handlePeerRuntimeError(err, true, reject);
    });
  });
}

// --- Non-host logic ----------------------------------------------------------

// Defensive wrapper around handleHostMessage. In a P2P room any peer drives the
// data channel, so a malformed or hostile message must never throw out of a data
// handler and disrupt the room — at worst we drop that one packet.
function safeHandleHostMessage(msg) {
  try {
    handleHostMessage(msg);
  } catch (e) {
    console.warn('[host-msg] dropped malformed "' + (msg && msg.type) + '" message:', e);
  }
}

function handleHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  noteHostHeartbeat(msg.at ? msg.at : Date.now());
  applyHostRoutingHints(msg);
  // Mirror the host's debug-mode flag (carried in peer-list + heartbeat) so the
  // device-info "i" button only appears while the host is actually debugging.
  if (typeof msg.debugMode === 'boolean' && _hostDebugMode !== msg.debugMode) {
    _hostDebugMode = msg.debugMode;
    if (inRoom && !isHost) { updatePeerList(); updateDebugConsentBanner(); }
  }
  // Room-wide jitter buffer pushed by a host that is debugging. Carried in
  // peer-list + heartbeat like debugMode; absent (or null) clears the override.
  if ('jitterMs' in msg) {
    var pushed = sanitizeJitterMs(msg.jitterMs);
    if (pushed !== _hostJitterMs) {
      _hostJitterMs = pushed;
      if (inRoom && !isHost) reapplyAudioTuningToAllPeers();
    }
  }
  if (msg.type === 'heartbeat') return;
  if (msg.type === 'audio-check-request') {
    respondToAudioCheckRequest(msg.from || null, msg.durationMs);
    return;
  }
  if (msg.type === 'audio-check-response') {
    onAudioCheckResponse(msg.peerId, msg.report, msg.declined);
    return;
  }
  if (msg.type === 'log-session-request') {
    handleLogSessionRequest(msg.from || null, msg.fromPseudo);
    return;
  }
  if (msg.type === 'log-session-stop') {
    handleLogSessionStop(msg.from || null);
    return;
  }
  if (msg.type === 'log-session-response' || msg.type === 'log-session-end' || msg.type === 'log-entries') {
    handleLogReplyMessage(msg.peerId, msg);
    return;
  }
  if (msg.type === 'device-info-request') {
    respondToDeviceInfoRequest(msg.from || null);
    return;
  }
  if (msg.type === 'device-info-response') {
    onDeviceInfoResponse(msg.peerId, msg.info, msg.declined);
    return;
  }
  if (msg.type === 'pseudo-assigned') {
    applyAssignedSelfProfile(msg.pseudo, msg.pseudoColor || null);
    return;
  }
  if (msg.type === 'peer-list') {
    if (msg.selfPseudo) {
      applyAssignedSelfProfile(msg.selfPseudo, msg.selfPseudoColor || null);
    }
    const listedPeerIds = (msg.peers || []).map(function(p) { return p.id; }).concat([roomCode]);
    const listedPeerSet = new Set(listedPeerIds);

    resetAuthoritativePeerIds(listedPeerIds);
    resetKnownPeers(listedPeerIds);

    Array.from(connections.keys()).forEach(function(existingPeerId) {
      if (!listedPeerSet.has(existingPeerId)) {
        removePeer(existingPeerId);
      }
    });

    const authoritativePeers = (msg.peers || []).concat([{
      id: roomCode,
      pseudo: msg.hostPseudo || shortId(roomCode),
      pseudoColor: msg.hostPseudoColor || null,
      videoActive: !!msg.hostVideoActive,
      screenActive: !!msg.hostScreenActive,
      videoTopology: msg.hostVideoTopology,
      screenTopology: msg.hostScreenTopology,
      videoProviderRef: msg.hostVideoProviderRef,
      screenProviderRef: msg.hostScreenProviderRef,
      protocolVersion: msg.protocolVersion,
      appVersion: msg.appVersion
    }]);
    // Peers whose already-active video/screen is SFU-routed: this client won't
    // receive a mesh MediaConnection for them (no "call the newcomer" nudge is
    // sent for SFU sharers, see the host-side peer-joined handler), so it must
    // subscribe on its own once connections/peer.id are in place below.
    var toSubscribeVideo = [];
    var toSubscribeScreen = [];
    authoritativePeers.forEach(function(p) {
      const peerId = p.id;
      const pseudo = p.pseudo;
      const prev = connections.get(peerId);
      var update = { pseudo: pseudo, pseudoColor: p.pseudoColor || null };
      // `videoTopology`/`screenTopology` are deliberately NOT set here. They are
      // applyRemoteTrackTopology's record of what is actually carrying the track,
      // and it compares against them to decide whether anything changed. Setting
      // them up-front made a publisher this client had never subscribed to look
      // like one whose transport was being swapped, so the first sight of every
      // already-relayed peer tore down a subscription that did not exist yet.
      if (p.videoActive) {
        update.videoActive = true;
        if (p.videoTopology === 'sfu' && peerId !== peer.id) {
          toSubscribeVideo.push({ peerId: peerId, ref: p.videoProviderRef });
        }
      }
      if (p.screenActive) {
        update.screenActive = true;
        if (p.screenTopology === 'sfu' && peerId !== peer.id) {
          toSubscribeScreen.push({ peerId: peerId, ref: p.screenProviderRef });
        }
      }
      // Mutated in place rather than replaced. An in-flight sfuSubscribeTrack
      // holds a reference to this object across its awaits; swapping in a copy
      // orphaned the subscription it wrote back, so the next peer-list saw no
      // live media and tore it down again — churn that never converged.
      if (prev) Object.assign(prev, update);
      else connections.set(peerId, Object.assign({ data: null, media: null, pseudoColor: null, talking: false }, update));
      noteRemoteVersion((peerId === roomCode ? 'host ' : 'peer ') + shortId(peerId), p.protocolVersion, p.appVersion, peerId);
    });
    // Routed through applyRemoteTrackTopology rather than subscribing directly:
    // a peer-list is broadcast on every join, leave, prune, rename and settings
    // change, and this list barely ever changes between them. Subscribing
    // unconditionally here re-created a peer connection per publisher per
    // broadcast — leaking the previous one and burning the capability rate
    // limit, which is what made a new joiner's camera black for everyone.
    // applyRemoteTrackTopology already no-ops on an unchanged {mode, ref}.
    toSubscribeVideo.forEach(function(t) {
      applyRemoteTrackTopology(t.peerId, 'video', 'sfu', t.ref);
    });
    toSubscribeScreen.forEach(function(t) {
      applyRemoteTrackTopology(t.peerId, 'screen', 'sfu', t.ref);
    });

    // Sync video mode state from host
    if (msg.videoModeEnabled !== undefined) {
      videoModeEnabled = true;
      updateVideoModeUI();
    }

    // Establish outgoing audio to all peers. When joined muted (no mic yet)
    // this is a no-op until the user first speaks; connectOutgoingAudioToPeers
    // guards against a null stream and tracks calls via audioMediaOut.
    connectOutgoingAudioToPeers();
    updatePeerList();
    saveRejoinSnapshot();

  } else if (msg.type === 'peer-joined') {
    rememberPeer(msg.peerId);
    const wasKnown = connections.has(msg.peerId);
    const existing = connections.get(msg.peerId) || { data: null, media: null, talking: false };
    connections.set(msg.peerId, Object.assign({}, existing, {
      pseudo: msg.pseudo || existing.pseudo || shortId(msg.peerId),
      pseudoColor: msg.pseudoColor || existing.pseudoColor || null
    }));
    if (!wasKnown) {
      playCarillon();
    }
    updatePeerList();

  } else if (msg.type === 'peer-left') {
    forgetPeer(msg.peerId);
    playGoodbye();
    removePeer(msg.peerId);

  } else if (msg.type === 'talking') {
    updatePeerTalking(msg.peerId, msg.active);
  } else if (msg.type === 'peer-renamed') {
    const existing = connections.get(msg.peerId) || { data: null, media: null, pseudoColor: null, talking: false };
    connections.set(msg.peerId, Object.assign({}, existing, {
      pseudo: msg.pseudo || shortId(msg.peerId),
      pseudoColor: msg.pseudoColor || null
    }));
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
    applyRemoteTrackTopology(msg.peerId, 'video', msg.topology, msg.providerRef);
  } else if (msg.type === 'video-stop') {
    var vsMsgConn = connections.get(msg.peerId);
    if (vsMsgConn && vsMsgConn.videoTopology && vsMsgConn.videoTopology.mode === 'sfu') sfuUnsubscribeTrack('video', msg.peerId);
    detachRemoteVideo(msg.peerId);
  } else if (msg.type === 'video-call-peer') {
    // Host is telling us to call a newcomer with our video
    if (localVideoActive && localVideoStream && msg.peerId) {
      var vc = peer.call(msg.peerId, localVideoStream, { metadata: { type: 'video' } });
      if (vc) {
        tuneVideoCall(vc, 'camera');
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
    applyRemoteTrackTopology(msg.peerId, 'screen', msg.topology, msg.providerRef);
  } else if (msg.type === 'screen-stop') {
    var ssMsgConn = connections.get(msg.peerId);
    if (ssMsgConn && ssMsgConn.screenTopology && ssMsgConn.screenTopology.mode === 'sfu') sfuUnsubscribeTrack('screen', msg.peerId);
    detachRemoteScreen(msg.peerId);
  } else if (msg.type === 'screen-call-peer') {
    // Host is telling us to call a newcomer with our screen
    if (localScreenActive && localScreenStream && msg.peerId) {
      var sc = peer.call(msg.peerId, localScreenStream, { metadata: { type: 'screen' } });
      if (sc) {
        tuneVideoCall(sc, 'screen');
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

  // Set cancellation hook immediately so the button works during all awaits below.
  var cancelled = false;
  _cancelJoin = function() {
    cancelled = true;
    _cancelJoin = null;
    if (peer && !peer.destroyed) peer.destroy();
  };

  var requestedCode = code;
  devLog('→ Joining room ' + code + '…');
  // Resolve public lobby identifier to PeerJS peer ID if applicable
  var resolved = await lookupRoom(code);
  if (cancelled) throw new Error('Connection cancelled.');
  if (resolved) {
    devLog('✓ Resolved lobby "' + code + '" → ' + resolved);
    activeChannelRoomId = requestedCode;
    code = resolved;
  } else if (!UUID_RE.test(requestedCode)) {
    var channelResolved = await resolvePresenceChannelHost(requestedCode);
    if (cancelled) throw new Error('Connection cancelled.');
    if (channelResolved && channelResolved.hostId) {
      devLog('✓ Resolved presence channel "' + requestedCode + '" → ' + channelResolved.hostId);
      activeChannel = channelResolved.channelName || requestedCode;
      activeChannelRoomId = '';
      code = channelResolved.hostId;
    } else if (channelResolved && !channelResolved.hostId) {
      // Channel found but empty — callers that go through joinOrCreateByChannelName
      // never reach here; this path is only hit by direct joinRoom() calls.
      activeChannel = channelResolved.channelName || requestedCode;
      await createRoom(onJoined);
      return;
    }
  } else if (UUID_RE.test(requestedCode)) {
    // Direct peer-id join: keep UUID as display/share code unless a room id is later published.
    activeChannelRoomId = '';
  }

  // Safety net: if code is still non-UUID here, all resolution failed.
  // Become the host rather than attempting to connect to a non-existent peer.
  if (!UUID_RE.test(code)) {
    await createRoom(onJoined);
    publishRoom().catch(function(e) { console.warn('[publish] auto-publish failed:', e.message); });
    return;
  }

  resetKnownPeers([code]);
  _lastAuthoritativePeerIds = null;
  _authoritativeSuccessorIds = [];
  const iceServers = await fetchIceServers();
  if (cancelled) throw new Error('Connection cancelled.');
  devLog('✓ ICE: ' + iceServers.length + ' server(s)');
  devLog('→ Connecting to PeerJS broker…');
  peer = new Peer(Object.assign({ config: { iceServers } }, peerServerOptions()));
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

    // Override cancel hook now that we have a peer to destroy
    _cancelJoin = function() {
      devLog('→ Cancelled');
      cancelled = true;
      peer.destroy();
      settle(reject, new Error('Connection cancelled.'));
    };

    peer.on('open', function() {
      if (cancelled) { settle(reject, new Error('Connection cancelled.')); return; }
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
        stopMicStreamFully(stream); stream = null; audioTrack = null;
        throw err;
      }
      // Non-fatal (peer-unavailable): try next candidate
    }
  }

  // All UUID candidates exhausted — if the room had a named code, re-resolve it.
  // This handles stale hosts: the API may already point at a new host (or we become one).
  if (snapshot.channelName) {
    await joinOrCreateByChannelName(snapshot.channelName);
    return;
  }

  stopMicStreamFully(stream); stream = null; audioTrack = null;
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
  publishRoomActive(true);
  localStorage.setItem('active-room-code', targetHostId);
  rememberPeer(targetHostId);
  connections.set(targetHostId, { data: hostData, media: null, pseudo: shortId(targetHostId), pseudoColor: null, talking: false });
  updateRoomHeader();
  nativePTTJoin();
  startKeepAlive();
  requestAudioFocus(); // Keep foreground service running while in room
  initAudioRouteForRoom(); // Every room starts on the loudspeaker
  showScreen('room');
  updatePeerList();
  updateDebugConsentBanner();
  updateShortcutDisplay();
  updateVideoModeUI();
  startStatsPolling();
  iframeEmit({ type: 'joined', roomCode: targetHostId, peerId: peer.id });

  autoAcquireMicOnJoin();
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
    const peerCountRaw = typeof item.peer_count === 'number' ? item.peer_count : parseInt(item.peer_count, 10);
    const peerCount = Number.isFinite(peerCountRaw) ? peerCountRaw : connected.length;
    const div       = document.createElement('div');
    div.className   = 'channel-item';
    div.setAttribute('role', 'button');
    div.tabIndex    = 0;
    div.innerHTML =
      '<div class="channel-info">' +
        '<span class="channel-name">' + ch.name + '</span>' +
        (names ? '<span class="channel-members">' + names + '</span>' : '') +
      '</div>' +
      (peerCount ? '<span class="channel-count">' + peerCount + '</span>' : '') +
      '<span class="channel-join-icon">›</span>';
    function handleJoin() {
      if (div.classList.contains('loading') || !beginHomeAction()) return;
      div.classList.add('loading');
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      lockHomeCTAs();
      joinChannel(presenceData[idx]).catch(function(err) {
        if (err && err.message === 'Connection cancelled.') return;
        showError(err.message);
      }).finally(function() { div.classList.remove('loading'); unlockHomeCTAs(); endHomeAction(); });
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
    syncMyPseudoFromPresence();
    renderPresenceChannels();
  } catch (e) {
    list.textContent = '';
    const err = document.createElement('p');
    err.className = 'presence-error';
    err.textContent = (e && e.message) ? e.message : String(e);
    list.appendChild(err);
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
    }
    // Outside the guard on purpose: signing into an account with no usable org
    // still changes which relay we should be on, and the previous resolution
    // must not survive it.
    refreshIceServers();
  } catch (e) {
    console.error('[Auth] selectOrgAndStartPolling failed:', e.message);
  }
}

async function joinChannel(item) {
  const connected    = item.connected || [];
  activeChannel      = item.channel.name;
  activeChannelRoomId = publicAssociatedRoomId(associatedRoomIdFromPresenceItem(item));
  const postPresence = function(peerId) {
    postSession(activeChannel, peerId, buildPresenceSessionPayload(peerId)).then(function(data) {
      var associated = publicAssociatedRoomId(associatedRoomIdFromSessionResponse(data));
      if (associated && associated !== activeChannelRoomId) {
        activeChannelRoomId = associated;
        updateRoomHeader();
      }
      return refreshPresence();
    }).catch(function(e) {
      console.warn('[Presence] session registration failed:', e.message);
    });
  };
  // Presence shows no reachable host. Before creating a fresh room, check the
  // anonymous-rooms service — a host may be live there (presence poll lag, or a
  // host that only registered anonymously) and is exactly what the embedded /
  // iframe path resolves. Join it if present; otherwise create.
  var recoverOrCreate = async function() {
    var anonHostId = await lookupRoom(activeChannel);
    if (anonHostId) {
      try {
        await joinRoom(anonHostId, postPresence);
        return;
      } catch (err) {
        if (err && err.message === 'Connection cancelled.') throw err;
        if (isMicDeniedError(err)) throw err;
        // Stale anonymous host — fall through to create.
      }
    }
    showInviteLoading(activeChannel || '', 'Connecting…');
    await createRoom(postPresence);
  };
  if (connected.length === 0) {
    await recoverOrCreate();
  } else {
    const candidateHostIds = Array.from(new Set(
      connected
        .map(function(c) { return c && c.peer_id ? String(c.peer_id).trim() : ''; })
        .filter(Boolean)
        .sort()
    ));
    var lastError = null;
    var allUnavailable = true;
    for (var i = 0; i < candidateHostIds.length; i++) {
      var hostId = candidateHostIds[i];
      try {
        await joinRoom(hostId, postPresence);
        return;
      } catch (err) {
        lastError = err;
        if (peer && !peer.destroyed) { try { peer.destroy(); } catch (_) {} }
        peer = null;
        if (!isNonFatalPeerRuntimeError(err)) {
          allUnavailable = false;
          break;
        }
      }
    }
    if (allUnavailable) {
      await recoverOrCreate();
      return;
    }
    throw lastError || new Error('Could not join this channel.');
  }
}

// Join or create a room by non-UUID name.
// With presence configured: delegates to joinChannel which handles host lookup
// and presence session registration.
// Without presence: falls back to the anonymous room service — joins an existing
// host if one is registered, otherwise creates the room and publishes it.
async function joinOrCreateByChannelName(channelName) {
  var normalizedName = String(channelName || '').trim();
  if (!normalizedName) return;

  var cancelled = false;
  _cancelJoin = function() {
    cancelled = true;
    _cancelJoin = null;
    if (peer && !peer.destroyed) peer.destroy();
  };

  if (presenceConfigured()) {
    var list = Array.isArray(presenceData) && presenceData.length ? presenceData : [];
    if (!list.length) {
      try { list = await fetchPresence(); } catch (_) { list = []; }
    }
    if (cancelled) throw new Error('Connection cancelled.');
    var target = normalizedName.toLowerCase();
    var item = null;
    for (var i = 0; i < list.length; i++) {
      var li = list[i] || {};
      if (String((li.channel || {}).name || '').trim().toLowerCase() === target) { item = li; break; }
    }
    if (item) {
      await joinChannel(item);
      return;
    }
    // Channel not in org's presence list — fall through to anonymous-rooms path.
  }

  // No presence configured, or channel not found in org — use anonymous room service.
  var lookupRes = null;
  try { lookupRes = await tauriFetch(ANONYMOUS_ROOMS_BASE + '/' + encodeURIComponent(normalizedName), { cache: 'no-store' }); }
  catch (_) {}
  if (cancelled) throw new Error('Connection cancelled.');

  if (lookupRes && lookupRes.ok) {
    var roomData = null;
    try { roomData = await lookupRes.json(); } catch (_) {}
    var hostId = (roomData && (roomData.room_id || roomData.voxal_room_code)) || null;
    var claimSlug = (roomData && roomData.room_code) || normalizedName;

    if (hostId) {
      // Room has a registered host — try to join.
      try {
        await joinRoom(hostId);
        activeChannelRoomId = normalizedName;
        updateRoomHeader();
        return;
      } catch (joinErr) {
        if (joinErr.message === 'Connection cancelled.') throw joinErr;
        if (isMicDeniedError(joinErr)) throw joinErr;
        // Stale host — fall through to claim the slot.
        devLog('✗ Stale host for "' + claimSlug + '", claiming host slot…', 'warn');
      }
      if (cancelled) throw new Error('Connection cancelled.');
    }

    // No host or stale host — become the new host and claim the slot via PATCH.
    await createRoom();
    if (cancelled) return;
    activeChannelRoomId = claimSlug;
    updateRoomHeader();
    tauriFetch(ANONYMOUS_ROOMS_BASE + '/by-code/' + encodeURIComponent(claimSlug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voxal_room_code: roomCode }),
    }).then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        _publishedRoomId = (data && data.room_code) || claimSlug;
        updateRoomHeader();
      })
      .catch(function(e) { console.warn('[room] PATCH host failed:', e.message); });
    return;
  }

  // Room not found (404) — create it and POST with this slug to claim it.
  await createRoom();
  publishRoom({ room_code: normalizedName }).catch(function(e) {
    console.warn('[publish] auto-publish failed:', e.message);
  });
}

// --- Bootstrap ---------------------------------------------------------------

window.addEventListener('DOMContentLoaded', function() {
  function applyEmbedHeaderMode() {
    if (!_isIframe || !HIDE_EMBED_HEADER) return;
    document.body.classList.add('embed-hide-header');
  }

  function applyTinyEmbedMode() {
    if (!IS_TINY_EMBED) return;
    document.body.classList.add('embed-tiny');

    // Pop-out: opt-in via ?popout=1, and only when actually embedded in a parent page.
    var popoutBtn = $('btn-popout-tiny');
    if (popoutBtn) {
      if (_isIframe && ALLOW_POPOUT) {
        document.body.classList.add('embed-can-popout');
        popoutBtn.addEventListener('click', popOutTinyEmbed);
      } else {
        popoutBtn.remove();
      }
    }

    var btn = $('btn-toggle-peers');
    var pttBtn = $('ptt-btn');
    var pttHint = $('ptt-hint');
    if (pttBtn && pttHint) {
      var helper = (pttHint.textContent || '').replace(/\s+/g, ' ').trim();
      if (helper) {
        pttBtn.title = helper;
        pttBtn.setAttribute('aria-label', helper);
      }
    }
    window._updateTinyPeersToggle = function() {
      if (!IS_TINY_EMBED || !btn) return;
      btn.classList.add('hidden');
    };
    window._updateTinyPeersToggle();
    var staleLeft = $('btn-peers-left');
    if (staleLeft && staleLeft.parentNode) staleLeft.parentNode.removeChild(staleLeft);
    var staleRight = $('btn-peers-right');
    if (staleRight && staleRight.parentNode) staleRight.parentNode.removeChild(staleRight);

    function updateTinyRoomBreakpoint() {
      var w = document.body.offsetWidth;
      document.body.classList.toggle('tiny-micro',   w <= 100);
      document.body.classList.toggle('tiny-compact', w > 100 && w < 200);
    }
    new ResizeObserver(updateTinyRoomBreakpoint).observe(document.body);
    updateTinyRoomBreakpoint();
  }

  applyPopoutIdentityFromUrl();
  // Voxal Connect returns here as https://<origin>/auth/callback?token=…&state=…
  if (!consumeAuthCallbackFromUrl()) reportAbandonedAuth();
  applyEmbedHeaderMode();
  applyTinyEmbedMode();

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

  // Handedness — which side the talk button sits on in the landscape layout.
  const HANDEDNESS_KEY = 'handedness';
  function applyHandedness(val) {
    var v = val === 'left' ? 'left' : 'right';
    document.documentElement.setAttribute('data-hand', v);
    var toggle = document.getElementById('hand-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('button[data-hand]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.hand === v);
    });
  }
  applyHandedness(localStorage.getItem(HANDEDNESS_KEY));
  var handToggle = document.getElementById('hand-toggle');
  if (handToggle) {
    handToggle.addEventListener('click', function(e) {
      var btn = e.target.closest('button[data-hand]');
      if (!btn) return;
      localStorage.setItem(HANDEDNESS_KEY, btn.dataset.hand);
      applyHandedness(btn.dataset.hand);
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
    var _micSourceRow = $('settings-audio-mic-row'); if (_micSourceRow) _micSourceRow.style.display = 'none';
    var _videoSection = $('settings-video'); if (_videoSection) _videoSection.style.display = 'none';
    var _devPopoutBtn = $('btn-popout-dev-log'); if (_devPopoutBtn) _devPopoutBtn.style.display = 'none';
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
    var rawCode = $('input-code').value.trim();
    var joinCode = normalizeRoomCode(rawCode);
    var joinPromise = !UUID_RE.test(joinCode)
      ? joinOrCreateByChannelName(joinCode)
      : joinRoom(rawCode);
    joinPromise
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
      if (cancelInviteJoinBtn.dataset.action === 'connect' && _invitePendingRoomId) {
        startInviteRoomJoin(_invitePendingRoomId);
        return;
      }
      if (cancelInviteJoinBtn.dataset.action === 'join-web' && _inviteWebFallbackRoomId) {
        startInviteRoomJoin(_inviteWebFallbackRoomId);
        return;
      }
      if (_cancelJoin) {
        _cancelJoin();
        _cancelJoin = null;
      }
      _inviteWebFallbackRoomId = '';
      if (IS_TINY_EMBED && _invitePendingRoomId) {
        showTinyInviteConnect(_invitePendingRoomId, _invitePendingPeerCount);
        return;
      }
      setInviteLoadingCtaMode('back');
      showScreen('home');
    });
  }

  var invitedRoomCode = consumeRoomInviteFromQuery();
  if (invitedRoomCode) {
    // On native (Tauri/Capacitor) the deep-link is already being handled; join directly.
    // On tiny embeds, auto-join if a name is already set or the iframe is in micro mode
    // (≤ 100 px — too small for the name-entry screen; a random name will be used).
    // On regular web, try opening the native app first, then fall back.
    var isNative = window.__TAURI__ || (window.Capacitor && window.Capacitor.isNativePlatform());
    if (IS_TINY_EMBED) {
      var isMicro = document.body.classList.contains('tiny-micro');
      if ((myPseudo || '').trim() || isMicro) {
        startInviteRoomJoin(invitedRoomCode);
      } else {
        showTinyInviteConnect(invitedRoomCode);
      }
    } else if (isNative || FORCE_WEB_JOIN) {
      startInviteRoomJoin(invitedRoomCode);
    } else {
      _tryNativeAppThenJoin(invitedRoomCode);
    }
  }

  // Where the relay currently comes from, in words the user can act on. Derived
  // from the live resolution, NOT from the persisted org-only metered-status key
  // — that key is blank for anonymous users with a perfectly working relay.
  // No parentheses in these — they are rendered inside a "(…)" already.
  const ICE_SOURCE_LABELS = {
    embed:     'provided by this site',
    org:       'your Voxal organisation',
    metered:   'metered.ca',
    anonymous: 'Cloudflare, anonymous',
  };

  // { state: 'ok' | 'warn' | 'none' | 'pending', text }
  function turnStatusSummary() {
    if (!_lastIceResolution) return { state: 'pending', text: 'Checking relay…' };

    const { source, relayCount } = _lastIceResolution;
    if (!relayCount) {
      return { state: 'none', text: 'TURN not configured' };
    }

    // The built-in public relay is retired and does not work. Reporting it as
    // "configured" just because servers were returned would be a lie with a
    // green tick on it.
    if (source === 'fallback') {
      if (usingDefaultFallbackRelay(fallbackIceServers())) {
        return { state: 'warn', text: 'TURN — built-in public relay (retired, unlikely to work)' };
      }
      return { state: 'ok', text: 'TURN — ' + relayCount + ' server' + (relayCount === 1 ? '' : 's') + ' (custom relay)' };
    }

    const label = ICE_SOURCE_LABELS[source];
    return {
      state: 'ok',
      text: 'TURN — ' + relayCount + ' server' + (relayCount === 1 ? '' : 's') +
            (label ? ' (' + label + ')' : ''),
    };
  }

  // TURN settings modal
  function connStatusHTML() {
    const turn = turnStatusSummary();
    // A relayed round trip is the only actual proof, as opposed to "configured".
    const verified = turn.state === 'ok' && _relayVerifiedAt ? ' · verified' : '';
    const turnLine =
      turn.state === 'ok'   ? '<span class="cs-ok">✓</span> ' + turn.text + verified
      : turn.state === 'warn' ? '<span class="cs-err">⚠</span> ' + turn.text
      : turn.state === 'pending' ? '<span class="cs-muted">…</span> ' + turn.text
      : '<span class="cs-muted">—</span> ' + turn.text;

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
    const online = navigator.onLine;
    const badge  = $('turn-badge');
    if (!badge) return;
    badge.classList.remove('ok', 'partial');
    if (!online) {
      // red (default) — no connection possible
    } else if (turnStatusSummary().state === 'ok') {
      badge.classList.add('ok');      // green — STUN + a relay we believe in
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

    var isNative = !!window.__TAURI__ ||
      !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

    // build-info.js is stamped by `make gen-build-info` (web deploy, and every
    // native build: build/build-debug/build-signed/cap-sync — see Makefile).
    // On web there's no app version number, so the commit stands in for it.
    // On native the real app version stays, and the commit rides next to the
    // build date instead.
    if (typeof window.VOXAL_COMMIT !== 'undefined') {
      var stampedDate = new Date(window.VOXAL_WEB_BUILD_DATE).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
      if (!isNative) {
        versionEl.textContent = window.VOXAL_COMMIT;
        dateEl.textContent = stampedDate;
        return;
      }
      dateEl.textContent = stampedDate + ' · ' + window.VOXAL_COMMIT;
    } else {
      dateEl.textContent = new Date(VOXAL_BUILD_DATE).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
    }

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
    // The connection-status popover is anchored to the topbar the modal is about
    // to cover. Leaving it open left it floating over the settings dialog with
    // no way to dismiss it — the badge that toggles it is now behind the modal.
    hideConnPopover();
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
    loadRelayControls();
    syncVideoRoutingControls();
    loadJitterControls();
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
    var shareBtn = document.getElementById('toggle-debug-share-modal');
    if (shareBtn) {
      var shareOn = isDeviceInfoSharingEnabled();
      shareBtn.setAttribute('aria-checked', String(shareOn));
      shareBtn.classList.toggle('active', shareOn);
      shareBtn.textContent = shareOn ? 'ON' : 'OFF';
    }
    updateVideoModeUI();
    syncMicHintToggle();
    stopMicTest();
    stopCameraPreview();
    initModalSettingsSidebar();
    // Populate About section
    initAboutSection('about-version-modal', 'about-build-date-modal');
    showSettingsModal();
    if (presenceToken()) loadOrgs();
  }
  function closeSettings() {
    stopMicTest();
    stopCameraPreview();
    var speakerStatus = $('speaker-test-status');
    if (speakerStatus) speakerStatus.textContent = '';
    hideSettingsModal();
    startPresencePolling(); // refresh in case org changed
  }

  // Below 640px .modal-content is a bottom sheet (see styles.css); everywhere
  // else these are a plain instant show/hide, unchanged from before.
  const SETTINGS_SHEET_TRANSITION_MS = 300;
  function isSettingsSheetLayout() { return window.matchMedia('(max-width: 640px)').matches; }
  function showSettingsModal() {
    var modalEl = $('modal-settings');
    var contentEl = modalEl.querySelector('.modal-content');
    modalEl.classList.remove('hidden');
    if (contentEl && isSettingsSheetLayout()) {
      contentEl.classList.remove('modal-sheet-open'); // rest at translateY(100%) for one frame
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { contentEl.classList.add('modal-sheet-open'); });
      });
    }
  }
  function hideSettingsModal() {
    var modalEl = $('modal-settings');
    var contentEl = modalEl.querySelector('.modal-content');
    if (contentEl && isSettingsSheetLayout()) {
      contentEl.classList.remove('modal-sheet-open'); // slide back down
      setTimeout(function() { modalEl.classList.add('hidden'); }, SETTINGS_SHEET_TRANSITION_MS);
    } else {
      modalEl.classList.add('hidden');
    }
  }

  // Swipe-down-to-dismiss for the full-screen mobile settings sheet. Only
  // starts tracking when the inner scroller is already at its top — otherwise
  // the first pixel of a downward swipe would hijack an ordinary scroll-up
  // gesture inside a long settings section.
  const SETTINGS_SWIPE_CLOSE_PX = 120;
  function setupSettingsSwipeToClose() {
    var content = document.querySelector('#modal-settings .modal-content');
    var scroller = document.querySelector('#modal-settings .modal-settings-scrollable');
    var backdrop = $('modal-backdrop');
    if (!content || !scroller) return;
    var startY = 0, dy = 0, tracking = false;

    content.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) return;
      tracking = scroller.scrollTop <= 0;
      startY = e.touches[0].clientY;
      dy = 0;
      content.style.transition = 'none';
    }, { passive: true });

    content.addEventListener('touchmove', function(e) {
      if (!tracking) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0) { dy = 0; content.style.transform = ''; if (backdrop) backdrop.style.opacity = ''; return; }
      content.style.transform = 'translateY(' + dy + 'px)';
      if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - dy / 300));
    }, { passive: true });

    var finish = function() {
      if (!tracking) return;
      tracking = false;
      content.style.transition = '';
      content.style.transform = '';
      if (backdrop) backdrop.style.opacity = '';
      if (dy > SETTINGS_SWIPE_CLOSE_PX) closeSettings();
      dy = 0;
    };
    content.addEventListener('touchend', finish);
    content.addEventListener('touchcancel', finish);
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
    // The org relay went away with the account — re-resolve so we fall back to
    // the anonymous credential now, not on the next room.
    refreshIceServers();
    // Stay in settings — navigate home in background
    var tinyRoomId = _invitePendingRoomId;
    var tinyPeerCount = _invitePendingPeerCount;
    if (inRoom) {
      leaveRoom();
      return;
    }
    if (IS_TINY_EMBED && tinyRoomId) {
      showTinyInviteConnect(tinyRoomId, tinyPeerCount);
      return;
    }
    if (!IS_TINY_EMBED) showScreen('home');
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
  document.querySelectorAll('input[name="relay-mode"]').forEach(function(r) {
    r.addEventListener('change', syncRelayFromControls);
  });
  ['input-relay-url', 'input-relay-user', 'input-relay-pass'].forEach(function(id) {
    var el = $(id);
    if (el) el.addEventListener('input', syncRelayFromControls);
  });
  document.querySelectorAll('input[name="video-routing-mode"]').forEach(function(r) {
    r.addEventListener('change', function(e) {
      if (!e.target.checked) return;
      localStorage.setItem(VIDEO_ROUTING_KEY, e.target.value);
      reconcileVideoTopology();
    });
  });
  document.querySelectorAll('input[name="jitter-mode"]').forEach(function(r) {
    r.addEventListener('change', syncJitterFromControls);
  });
  var jitterSlider = $('input-jitter-ms');
  if (jitterSlider) jitterSlider.addEventListener('input', syncJitterFromControls);
  document.querySelectorAll('input[name="noise-suppression-mode"]').forEach(function(input) {
    input.addEventListener('change', function(e) {
      if (!e.target.checked) return;
      localStorage.setItem(NOISE_SUPPRESSION_KEY, e.target.value);
      // The mode is only read inside getMicStream(), so a live call keeps the
      // old pipeline until it re-acquires. No-op when not in a room.
      reacquireMicForRoom();
    });
  });
  var micSelect = $('select-mic-device');
  if (micSelect) {
    micSelect.addEventListener('change', function(e) {
      if (e.target.value) localStorage.setItem(MIC_DEVICE_KEY, e.target.value);
      else localStorage.removeItem(MIC_DEVICE_KEY);
      if (_micTestStream) startMicTest().catch(function(err) { console.warn('[Mic test]', err.message); stopMicTest(); });
      reacquireMicForRoom();   // same staleness as the mode above
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
  syncVideoRoutingControls();
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
    // Same reasoning for the in-room gear, and here the button can go entirely:
    // unlike the home one it carries no status LED, so nothing is lost. Settings
    // are already one click away in the menu bar (Voxal → Preferences, ⌘,).
    var roomGear = $('btn-open-settings-room');
    if (roomGear) roomGear.classList.add('hidden');
  }
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-close-settings-footer').addEventListener('click', closeSettings);
  $('modal-backdrop').addEventListener('click', closeSettings);
  setupSettingsSwipeToClose();
  $('btn-test-turn').addEventListener('click', testTurnCredentials);
  var btnMicTest = $('btn-test-mic');
  if (btnMicTest) btnMicTest.addEventListener('click', toggleMicTest);
  var btnEchoTest = $('btn-test-echo');
  if (btnEchoTest) btnEchoTest.addEventListener('click', toggleEchoTest);
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
        // Let peers learn the host's debug state so their "i" button toggles too.
        if (isHost) broadcastHostPeerLists();
      }
    });
  }

  var netUsageSummary = document.getElementById('net-usage-summary');
  if (netUsageSummary) {
    netUsageSummary.addEventListener('click', function() { setNetUsageExpanded(!_netUsageExpanded); });
    renderNetUsagePanel();
  }

  var micHintToggle = document.getElementById('toggle-mic-hint-modal');
  if (micHintToggle) {
    micHintToggle.addEventListener('click', function() {
      setMicHintEnabled(!micHintEnabled());
    });
  }

  var shareToggleModal = document.getElementById('toggle-debug-share-modal');
  if (shareToggleModal) {
    shareToggleModal.addEventListener('click', function() {
      setDeviceInfoConsent(isDeviceInfoSharingEnabled() ? 'declined' : 'accepted');
      syncDeviceShareToggles();
      updateDebugConsentBanner();
    });
  }

  var acceptBtn = document.getElementById('btn-debug-accept');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', function() {
      setDeviceInfoConsent('accepted');
      updateDebugConsentBanner();
      syncDeviceShareToggles();
    });
  }
  var declineBtn = document.getElementById('btn-debug-decline');
  if (declineBtn) {
    declineBtn.addEventListener('click', function() {
      setDeviceInfoConsent('declined');
      updateDebugConsentBanner();
      syncDeviceShareToggles();
    });
  }

  // Remote debug logs: the authorization prompt and the "you are sharing" banner
  // on the device being read, plus the viewer's log panel.
  var logAllowBtn = document.getElementById('btn-log-consent-allow');
  if (logAllowBtn) logAllowBtn.addEventListener('click', function() { acceptLogSessionRequest(); });
  var logDenyBtn = document.getElementById('btn-log-consent-deny');
  if (logDenyBtn) logDenyBtn.addEventListener('click', function() { declineLogSessionRequest(); });
  var logStopBtn = document.getElementById('btn-log-share-stop');
  if (logStopBtn) logStopBtn.addEventListener('click', function() { stopLogSharing('stopped'); });
  var logCloseBtn = document.getElementById('btn-close-remote-log');
  if (logCloseBtn) logCloseBtn.addEventListener('click', function() { closeRemoteLogPanel(); });
  var logCopyBtn = document.getElementById('btn-copy-remote-log');
  if (logCopyBtn) {
    logCopyBtn.addEventListener('click', function() {
      if (!_remoteLogViewPeerId) return;
      copyTextToClipboard(remoteLogAsText(_remoteLogViewPeerId), 'Log copied!');
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
    window.__TAURI__.event.listen('deep-link://new-url', function(e) {
      var urls = Array.isArray(e.payload) ? e.payload : [e.payload];
      urls.forEach(function(url) {
        if (url) handleDeepLink(url);
      });
    });
    var tauriDeepLink = window.__TAURI__.deepLink;
    if (tauriDeepLink && typeof tauriDeepLink.getCurrent === 'function') {
      tauriDeepLink.getCurrent().then(function(urls) {
        (urls || []).forEach(function(url) {
          if (url) handleDeepLink(url);
        });
      }).catch(function() {});
    }
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
                          SPEAKER_DEVICE_KEY, JITTER_BUFFER_KEY, ECHO_BRIDGE_REQUEST_KEY,
                          NOISE_SUPPRESSION_KEY, MIC_DEVICE_KEY, VIDEO_ROUTING_KEY,
                          NETWORK_USAGE_REQUEST_KEY, VIDEO_BACKGROUND_STORAGE_KEY];
    if (relevantKeys.indexOf(e.key) === -1) return;
    if (e.key === VIDEO_BACKGROUND_STORAGE_KEY) {
      // Changed from the desktop preferences window, which has no capture
      // pipeline of its own — same reason the mic keys are handled here.
      applyVideoBackground(e.newValue || 'off');
      return;
    }
    if (e.key === NOISE_SUPPRESSION_KEY || e.key === MIC_DEVICE_KEY) {
      // Changed from the desktop preferences window — that window cannot touch
      // the capture pipeline (no module system, so no getMicStream there), so
      // the main window has to do the swap.
      if (e.key === NOISE_SUPPRESSION_KEY) syncNoiseSuppressionControls();
      else refreshMediaDeviceSelectors();
      reacquireMicForRoom();
      return;
    }
    if (e.key === JITTER_BUFFER_KEY) {
      // Changed from the desktop preferences window — apply it to live links.
      loadJitterControls();
      reapplyAudioTuningToAllPeers();
      if (inRoom && isHost) broadcastHostPeerLists();
      return;
    }
    if (e.key === VIDEO_ROUTING_KEY) {
      // Changed from the desktop preferences window — re-evaluate topology for
      // whatever we're currently sharing. Never touches audio.
      syncVideoRoutingControls();
      reconcileVideoTopology();
      return;
    }
    if (e.key === DEV_MODE_KEY) {
      updateDevLogPanel();
      if (inRoom) {
        // Keep polling regardless of dev mode: the adaptive jitter buffer and
        // the peer dot's ICE colour both feed off these samples, and the poll
        // already gates the dev-only badge rendering internally.
        startStatsPolling();
        updateVideoModeUI();
        updatePeerList();
        if (isHost) broadcastHostPeerLists();
      }
      return;
    }
    if (e.key === SPEAKER_DEVICE_KEY) {
      applySpeakerSinkToAllAudio();
      return;
    }
    if (e.key === ECHO_BRIDGE_REQUEST_KEY) {
      // The preferences window cannot run the network test itself — see the
      // bridge notes above echoStatus(). Run it here and report back.
      var req = null;
      try { req = JSON.parse(e.newValue || 'null'); } catch (_) {}
      if (!req) return;
      if (req.action === 'stop' && echoTestRunning()) stopEchoTest({ replay: true });
      else if (req.action === 'start' && !echoTestRunning()) toggleEchoTest();
      // Nothing to do means the two windows disagree about what is running (a
      // reopened preferences window starts from a blank slate). Re-publish so
      // the remote button snaps back instead of sitting on "Stopping…".
      else publishEchoBridgeState('');
      return;
    }
    if (e.key === NETWORK_USAGE_REQUEST_KEY) {
      // The preferences window has no peer connections to measure — it asks to
      // be fed, and stops asking when the panel closes.
      var usageReq = null;
      try { usageReq = JSON.parse(e.newValue || 'null'); } catch (_) {}
      setNetworkUsageWatching(!!(usageReq && usageReq.watching));
      return;
    }
    updateTurnBadge();
    if (e.key === PRESENCE_TOKEN_KEY || e.key === PRESENCE_ORG_KEY) {
      updateDisconnectVisibility(); updateConnectVisibility();
      // Signed in or out from the desktop preferences window — the main window
      // owns the ICE state, so it has to re-resolve here too.
      refreshIceServers();
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
      // When the embed has declared its origin (?parentOrigin), reject commands
      // from anywhere else. No-op for embeds that don't declare one (legacy).
      if (!isTrustedParentMessage(e)) {
        console.warn('[iframe] Ignoring "' + msg.type + '" from disallowed origin: ' + e.origin);
        return;
      }
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
        var iframeChannelName = typeof msg.channelName === 'string' ? msg.channelName.trim() : '';
        if (iframeChannelName) activeChannel = iframeChannelName;
        var iframeAssociatedRoomId = normalizeRoomCode(
          String(msg.roomCode || msg.roomId || '')
        );
        if (iframeAssociatedRoomId) activeChannelRoomId = iframeAssociatedRoomId;
        showInviteLoading(roomDisplayCode() || activeChannel || '', 'Connecting…');
        createRoom(function(peerId) {
          if (!activeChannel || !presenceConfigured()) return;
          postSession(activeChannel, peerId, buildPresenceSessionPayload(peerId)).then(function(data) {
            var associated = publicAssociatedRoomId(associatedRoomIdFromSessionResponse(data));
            if (associated && associated !== activeChannelRoomId) {
              activeChannelRoomId = associated;
              updateRoomHeader();
            }
            return refreshPresence();
          }).catch(function(e) {
            console.warn('[Presence] session registration failed:', e.message);
          });
        }).catch(function(err) { iframeEmit({ type: 'error', message: err.message }); });
      } else if (msg.type === 'leave') {
        if (inRoom) leaveRoom();
      } else if (msg.type === 'key' && msg.source === 'voxal-parent') {
        if (msg.code === 'Space' && !shouldIgnorePTTShortcuts()) {
          if (msg.down) { setTalking(true); } else { setTalking(false); }
        }
      } else if (msg.type === 'config') {
        // ICE servers (incl. TURN credentials) supplied by the embedding page.
        // Origin-validated because it carries credentials: the embed must declare
        // its origin via ?parentOrigin=... and the message must come from it.
        var allowedOrigin = getAllowedParentOrigin();
        if (!allowedOrigin || e.origin !== allowedOrigin) {
          console.warn('[iframe] Ignoring config from disallowed origin: ' + e.origin);
          return;
        }
        applyIframeConfig(msg);
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
    // Each org has its own relay configuration — one may have TURN where the
    // other has none.
    refreshIceServers();
  });
  $('btn-refresh-presence').addEventListener('click', refreshPresence);

  // Start presence polling on load (if configured)
  startPresencePolling();

  // Warm the ICE cache as soon as the app loads, for EVERY user.
  //
  // This used to run only inside `if (presenceConfigured())` — i.e. signed-in
  // org users — so an anonymous visitor never resolved ICE until createRoom() /
  // joinRoom() awaited it. That put the credential endpoint's latency (plus a
  // cold serverless start) directly on the critical path of joining, and left
  // the relay badge stuck on "Checking relay…" on the welcome screen.
  //
  // Fire-and-forget: nothing on the home screen waits for it, and by the time
  // the user creates or joins a room the in-memory cache is already warm.
  fetchIceServers().catch(function(e) { console.warn('[ICE] prefetch failed:', e.message); });

  $('btn-copy').addEventListener('click', function() {
    var text = roomDisplayCode();
    if (!text) return;
    copyTextToClipboard(text, 'Room code copied!');
  });
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-leave-tiny').addEventListener('click', leaveRoom);

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
    shareInviteLink(url);
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

  // --- Recent rooms list ---
  var updateRecentRooms = function() {
    var wrap = $('recent-rooms');
    var listEl = $('recent-rooms-list');
    if (!wrap || !listEl) return;
    var rooms = loadRecentRooms();
    if (!rooms.length) { wrap.classList.add('hidden'); return; }
    listEl.textContent = '';
    rooms.forEach(function(code) {
      var chip = document.createElement('div');
      chip.className = 'recent-room-chip';
      var joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'recent-room-join';
      joinBtn.textContent = code;
      joinBtn.title = 'Join "' + code + '"';
      joinBtn.addEventListener('click', function() {
        var input = $('input-code');
        if (input) input.value = code;
        // Reuse the Join button flow: spinner/cancel UX, CTA locking, errors.
        $('btn-join').click();
      });
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-icon recent-room-remove';
      removeBtn.setAttribute('aria-label', 'Remove "' + code + '" from recent rooms');
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', function() { removeRecentRoom(code); });
      chip.appendChild(joinBtn);
      chip.appendChild(removeBtn);
      listEl.appendChild(chip);
    });
    wrap.classList.remove('hidden');
  };
  window._updateRecentRooms = updateRecentRooms;
  updateRecentRooms();
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

  // Video / screen sharing buttons
  var videoModeBtnEl = $('btn-video-mode');
  if (videoModeBtnEl) videoModeBtnEl.addEventListener('click', toggleVideoMode);
  $('btn-share-camera').addEventListener('click', function() {
    if (localVideoActive) stopVideoShare(); else startVideoShare();
  });
  initSelfVideoBadge();
  initVideoBackgroundUI();
  var screenBtnEl = $('btn-share-screen');
  if (screenBtnEl) {
    screenBtnEl.addEventListener('click', function() {
      if (localScreenActive) stopScreenShare(); else startScreenShare();
    });
  }
  var audioRouteBtnEl = $('btn-audio-route');
  if (audioRouteBtnEl) {
    audioRouteBtnEl.addEventListener('click', function() { toggleAudioRoute(); });
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

  // Return from PiP to integrated panel (screen share)
  var screenViewerVid = document.getElementById('screen-viewer-element');
  if (screenViewerVid) {
    screenViewerVid.addEventListener('leavepictureinpicture', function() {
      if (_screenViewerPeerId) openScreenViewer(_screenViewerPeerId);
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
    // User tapped "Leave" in the system PTT UI (Lock Screen / Dynamic Island).
    PTT.addListener('ptt-left',    function() { if (inRoom) leaveRoom(); });
    PTT.addListener('ptt-error',   function(e) { console.warn('[PTT]', e.message); });
  }

  // Resume audio context and keep-alive when app returns to foreground
  document.addEventListener('visibilitychange', function() {
    var visible = document.visibilityState === 'visible';
    setLocalCameraSuspended(!visible);
    if (!visible) return;
    // A wake-lock sentinel is auto-released whenever the page is hidden, so
    // coming back is the only place it can be re-taken.
    if (_stageWakeLockWanted) requestStageWakeLock();
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
  });

  // Capacitor delivers a real app-lifecycle event; on iOS the WebContent
  // process can be suspended before a visibilitychange is dispatched, so the
  // native signal is the more reliable of the two. Both are idempotent.
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', function(state) {
      var active = !!(state && state.isActive);
      setLocalCameraSuspended(!active);
      if (active && _stageWakeLockWanted) requestStageWakeLock();
    });
  }
});
