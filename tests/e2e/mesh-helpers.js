// Driver helpers for the multi-peer mesh tests. Each helper operates on a
// Playwright Page that has loaded the app pointed at the local PeerServer
// broker (see mesh-fixtures.js). They drive the real global createRoom/joinRoom
// functions and read real module state, so the tests exercise actual PeerJS
// signaling + WebRTC, not mocks.

/** Create a room; resolves with the room code (the host's PeerJS id). */
export function createRoom(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.createRoom((id) => resolve(id)).catch(reject);
      })
  );
}

/** Join a room by code; resolves once this peer's signaling is open. */
export function joinRoom(page, code) {
  return page.evaluate(
    (code) =>
      new Promise((resolve, reject) => {
        window.joinRoom(code, () => resolve()).catch(reject);
      }),
    code
  );
}

/** Acquire the (fake) mic and start transmitting, then stop — opens audio mesh. */
export async function speak(page, ms = 300) {
  await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        window.setTalking(true);
        setTimeout(() => {
          window.setTalking(false);
          resolve();
        }, ms);
      }),
    ms
  );
}

/**
 * Simulate this peer crashing / losing the network: close the whole browser
 * context so survivors detect the loss via heartbeat timeout (the production
 * crash path). This is the realistic way a host disappears.
 */
export function killPeer(page) {
  return page.context().close();
}

/**
 * Abruptly tear down the PeerJS connection (synchronous 'close' to every peer)
 * without leaving the room cleanly — i.e. a graceful socket close that is not a
 * proper leaveRoom(). Kept for the documented simultaneous-close edge case.
 */
export function killPeerGraceful(page) {
  return page.evaluate(() => {
    if (typeof peer !== 'undefined' && peer && !peer.destroyed) peer.destroy();
  });
}

/** Snapshot of a peer's room state for assertions. */
export function getState(page) {
  return page.evaluate(() => ({
    peerId: typeof peer !== 'undefined' && peer ? peer.id : null,
    isHost: typeof isHost !== 'undefined' ? isHost : null,
    inRoom: typeof inRoom !== 'undefined' ? inRoom : null,
    roomCode: typeof roomCode !== 'undefined' ? roomCode : null,
    connections: typeof connections !== 'undefined' ? connections.size : null,
    deputy:
      typeof currentDeputyId === 'function' && typeof roomCode !== 'undefined' && roomCode
        ? currentDeputyId()
        : null,
    // "How many peers can I actually hear."
    //
    // Deliberately measured from the attached <audio> elements and their live
    // tracks, NOT from `conn.media`. A PeerJS MediaConnection is bidirectional:
    // whoever places the call sends its mic, and `handleIncomingCall` answers
    // with `call.answer(stream)`, so ONE connection carries audio both ways.
    // Which side happened to place it is an implementation detail — the caller
    // records it as `audioMediaOut`, the answerer as `media`, and counting only
    // `media` reports 0 for a peer that is hearing the other side perfectly.
    //
    // That is not hypothetical: these tests used to pass only because
    // initRNNoise() stalled ~5s on every mic acquisition, which delayed the
    // host's `connectOutgoingAudioToPeers()` until after the joiner had
    // arrived, so BOTH sides redundantly placed a call. Fixing that stall
    // (#111) left one connection instead of two — correct and cheaper — and
    // collapsed the old proxy metric.
    incomingAudio: Array.from(document.querySelectorAll('audio[id^="audio-"]')).filter(
      (el) =>
        el.srcObject &&
        el.srcObject.getAudioTracks().some((t) => t.readyState === 'live')
    ).length,
    outgoingAudio:
      typeof connections !== 'undefined'
        ? Array.from(connections.values()).filter((c) => c && c.audioMediaOut).length
        : 0,
  }));
}

/**
 * Resolve once all given pages agree on the same non-null deputy (the head of
 * the authoritative successor chain). Returns that deputy id. Use before killing
 * a host so the test mirrors a host that lived long enough to publish its
 * succession — migration is undefined if the chain never propagated.
 */
export async function waitForSharedDeputy(expect, pages, opts) {
  let agreed = null;
  await expect
    .poll(async () => {
      const states = await Promise.all(pages.map(getState));
      const deputies = states.map((s) => s.deputy);
      agreed = deputies.every((d) => d && d === deputies[0]) ? deputies[0] : null;
      return agreed;
    }, opts)
    .toBeTruthy();
  return agreed;
}

/**
 * Per remote peer, the number of live audio senders we have across both possible
 * MediaConnections — `media` (the call we answered) and `audioMediaOut` (the
 * call we opened). More than 1 means we are uploading the same mic twice to that
 * peer: the speaker's uplink is the mesh's real ceiling, so that alone can chop
 * the audio the peer hears.
 */
export function outgoingAudioSenderCounts(page) {
  return page.evaluate(() => {
    const counts = {};
    connections.forEach((conn, id) => {
      let n = 0;
      [conn.media, conn.audioMediaOut].forEach((mc) => {
        if (!mc || mc.closed || !mc.peerConnection) return;
        n += mc.peerConnection
          .getSenders()
          .filter((s) => s.track && s.track.kind === 'audio' && s.track.readyState === 'live').length;
      });
      counts[id] = n;
    });
    return counts;
  });
}

/** Opus fmtp lines actually negotiated into the local SDP of every audio link. */
export function negotiatedOpusFmtp(page) {
  return page.evaluate(() => {
    const lines = [];
    connections.forEach((conn) => {
      [conn.media, conn.audioMediaOut].forEach((mc) => {
        const pc = mc && !mc.closed ? mc.peerConnection : null;
        const sdp = pc && pc.localDescription ? pc.localDescription.sdp : null;
        if (!sdp) return;
        sdp
          .split('\r\n')
          .filter((l) => /^a=fmtp:\d+ .*useinbandfec/.test(l))
          .forEach((l) => lines.push(l));
      });
    });
    return lines;
  });
}

/**
 * The `a=ptime` of each audio section in every audio link's local description,
 * as a number (null for a section without one) — what we ask the far side to
 * packetize at.
 */
export function negotiatedAudioPtimes(page) {
  return page.evaluate(() => {
    const out = [];
    connections.forEach((conn) => {
      [conn.media, conn.audioMediaOut].forEach((mc) => {
        const pc = mc && !mc.closed ? mc.peerConnection : null;
        const sdp = pc && pc.localDescription ? pc.localDescription.sdp : null;
        if (!sdp) return;
        sdp.split('\r\nm=').filter((s) => s.startsWith('audio') || s.startsWith('m=audio')).forEach((section) => {
          const m = /^a=ptime:(\d+)/m.exec(section);
          out.push(m ? Number(m[1]) : null);
        });
      });
    });
    return out;
  });
}

/** Number of participant rows rendered in the peer list (self + others). */
export function rosterCount(page) {
  return page.locator('#peers-list .peer-item').count();
}

/** Rendered peer-list text, for asserting name propagation. */
export function rosterText(page) {
  return page.locator('#peers-list').innerText();
}

/** Send a chat message as this peer, through the real data channel. */
export function sendChat(page, text) {
  return page.evaluate((t) => window.sendChatMessage(t), text);
}

/** The ids currently in this peer's transcript, in order. */
export function chatIds(page) {
  return page.evaluate(() => chatLog.map((m) => m.id));
}

/** Rendered transcript text, for asserting a message reached the other side. */
export function chatText(page) {
  return page.locator('#chat-messages').innerText();
}

/** Rendered "x is typing…" line, or '' when nobody is. */
export function chatTypingText(page) {
  return page.locator('#chat-typing').innerText();
}

/** The reaction chips on one message, as "<emoji> <count>" strings. */
export function chatReactions(page, msgId) {
  return page.evaluate((id) => {
    const m = chatLog.find((x) => x.id === id);
    if (!m) return null;
    return Array.from(m.reactions.entries()).map(([emoji, peers]) => emoji + ' ' + peers.size);
  }, msgId);
}

/**
 * Replace this peer's camera with a painted canvas, before it shares one.
 *
 * Chromium's fake device is a gradient with a green-tinged test pattern, and a
 * keyed-camera test must never be able to mistake the camera itself for the
 * key: this picture is warm grey and blue, with a skin-coloured head and a
 * blue shirt that drift a little every frame — no pixel anywhere near green.
 * It is repainted on an interval because a canvas that is never redrawn emits
 * one frame and the capture stalls.
 */
export function installCanvasCamera(page, { width = 320, height = 240, fps = 15 } = {}) {
  return page.evaluate(({ width, height, fps }) => {
    navigator.mediaDevices.getUserMedia = function () {
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const ctx = c.getContext('2d', { alpha: false });
      let n = 0;
      const paint = () => {
        const g = ctx.createLinearGradient(0, 0, width, height);
        g.addColorStop(0, 'rgb(122,106,92)');
        g.addColorStop(1, 'rgb(86,100,124)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
        const dx = Math.sin(n / 12) * width * 0.03;
        ctx.fillStyle = 'rgb(60,72,140)';
        ctx.beginPath();
        ctx.ellipse(width / 2 + dx, height * 1.02, width * 0.3, height * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgb(205,150,122)';
        ctx.beginPath();
        ctx.ellipse(width / 2 + dx, height * 0.5, width * 0.12, height * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgb(140,120,110)';
        ctx.fillRect((n * 5) % width, height - 3, 3, 3);
        n++;
      };
      paint();
      const stream = c.captureStream(fps);
      const timer = setInterval(paint, Math.round(1000 / fps));
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return Promise.resolve(stream);
    };
  }, { width, height, fps });
}

/**
 * Watch every remote camera picture this peer puts on screen for green.
 *
 * Every 250 ms each displayed remote camera tile's <video> (and the camera
 * viewer's, when open) is drawn into a probe canvas, and a frame counts as a
 * violation when it is a keyed frame shown raw — a key-like top-left zone with
 * a dark patch in the top-right one, the sender's marker pattern — or when
 * more than 30% of it is pure green. Deliberately looser than the receiver's
 * own detector, so it catches what that detector might let through.
 *
 * Every frame a watched <video> presents is checked as well, through
 * requestVideoFrameCallback, so a keyed frame shown for a single frame cannot
 * slip between two scans.
 *
 * With `raw: true` it also decodes each peer's stream exactly as it arrived
 * (conn.remoteVideoStream, in a hidden <video>) and counts marked frames per
 * sender, frame by frame: zero is the proof that a peer was never sent one,
 * and more than zero is the proof that a peer really was keyed for.
 */
export function startGreenWatchdog(page, { label = '', raw = false } = {}) {
  return page.evaluate(({ label, raw }) => {
    if (window.__greenWatch) return;
    const W = { label, violations: [], frames: 0, presented: 0, rawFrames: {}, rawMarked: {}, timer: null, shots: 0 };
    window.__greenWatch = W;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rawVideos = new Map();
    const keyLike = (c) => c[1] > 150 && c[0] < 90 && c[2] < 90;

    function analyse(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;
      const s = Math.min(1, 320 / Math.max(vw, vh));
      const w = Math.max(20, Math.round(vw * s)), h = Math.max(20, Math.round(vh * s));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let green = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 1] >= 170 && d[i] <= 90 && d[i + 2] <= 90) green++;
      }
      // The sender's zones: squares of 0.10 of the short side at the top
      // corners, read at the same taps (on a 20-step grid) a receiver uses.
      const Z = 0.1 * Math.min(w, h);
      const at = (x, y) => {
        const o = (Math.min(h - 1, Math.floor(y)) * w + Math.min(w - 1, Math.floor(x))) * 4;
        return [d[o], d[o + 1], d[o + 2]];
      };
      const tl = [[5, 5], [15, 5], [5, 15], [15, 15], [10, 10]]
        .map(([x, y]) => at((x + 0.5) / 20 * Z, (y + 0.5) / 20 * Z));
      const patchTaps = [[9, 9], [10, 9], [9, 10], [10, 10]]
        .map(([x, y]) => at(w - Z + (x + 0.5) / 20 * Z, (y + 0.5) / 20 * Z));
      const patch = [0, 1, 2].map((k) => patchTaps.reduce((sum, c) => sum + c[k], 0) / patchTaps.length);
      return {
        marked: tl.every(keyLike) && Math.max(patch[0], patch[1], patch[2]) < 90,
        green: green / (w * h),
        size: [vw, vh],
      };
    }

    function describe(video, peerId) {
      const conn = typeof connections !== 'undefined' ? connections.get(peerId) : null;
      const entry = typeof _keyedReceivers !== 'undefined' ? _keyedReceivers.get(peerId) : null;
      if (conn && video.srcObject === conn.remoteVideoStream) return 'raw';
      if (entry && entry.handle && video.srcObject === entry.handle.stream) return 'cutout:' + entry.state;
      return 'other';
    }

    function check(v, peerId, how) {
      let r;
      try { r = analyse(v); } catch (e) { r = null; }
      if (!r) return;
      if (how === 'frame') W.presented++; else W.frames++;
      if (!r.marked && r.green <= 0.3) return;
      const rec = {
        at: Math.round(performance.now()), peerId, how, kind: r.marked ? 'marked' : 'green',
        green: Math.round(r.green * 1000) / 1000, size: r.size, src: describe(v, peerId),
        phase: window.__greenPhase || null,
      };
      // A picture of the first few, so a failure can be looked at.
      if (W.shots < 3) { W.shots++; try { rec.shot = canvas.toDataURL('image/png'); } catch (e) { /* ignore */ } }
      W.violations.push(rec);
    }

    function checkRaw(v, peerId) {
      let r;
      try { r = analyse(v); } catch (e) { r = null; }
      if (!r) return;
      W.rawFrames[peerId] = (W.rawFrames[peerId] || 0) + 1;
      if (r.marked) W.rawMarked[peerId] = (W.rawMarked[peerId] || 0) + 1;
    }

    // On top of the 250 ms scan, every frame a watched <video> presents is
    // looked at as it is presented: a single raw keyed frame lasts 125 ms at
    // the test camera's rate, and a scan alone could fall either side of it.
    const hooked = new WeakSet();
    const owner = new WeakMap();
    function hook(v, onFrame) {
      if (hooked.has(v) || typeof v.requestVideoFrameCallback !== 'function') return;
      hooked.add(v);
      const loop = () => v.requestVideoFrameCallback(() => {
        try { onFrame(); } catch (e) { /* the next frame will tell */ }
        loop();
      });
      loop();
    }
    function displayed(v) {
      return !!(v.srcObject && v.isConnected && !v.classList.contains('hidden') &&
        !(v.id === 'video-viewer-element' && document.getElementById('video-viewer-panel').classList.contains('hidden')));
    }

    function tick() {
      const shown = [];
      document.querySelectorAll('#video-stage .video-tile-camera:not(.video-tile-self)').forEach((tile) => {
        const v = tile.querySelector('video');
        if (v && v.srcObject && !v.classList.contains('hidden')) shown.push([v, tile.dataset.peerId || '?']);
      });
      const panel = document.getElementById('video-viewer-panel');
      const viewer = document.getElementById('video-viewer-element');
      if (panel && viewer && viewer.srcObject && !panel.classList.contains('hidden')) {
        shown.push([viewer, typeof _videoViewerPeerId !== 'undefined' ? _videoViewerPeerId : '?']);
      }
      shown.forEach(([v, peerId]) => {
        owner.set(v, peerId);
        check(v, peerId, 'scan');
        hook(v, () => { if (displayed(v)) check(v, owner.get(v), 'frame'); });
      });

      if (!raw || typeof connections === 'undefined') return;
      connections.forEach((conn, peerId) => {
        const stream = conn && conn.remoteVideoStream;
        let v = rawVideos.get(peerId);
        if (!stream) {
          if (v) { v.srcObject = null; rawVideos.delete(peerId); }
          return;
        }
        if (!v) {
          v = document.createElement('video');
          v.muted = true; v.playsInline = true; v.autoplay = true;
          rawVideos.set(peerId, v);
          hook(v, () => { if (v.srcObject && rawVideos.get(peerId) === v) checkRaw(v, peerId); });
        }
        if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
      });
    }
    W.analyse = analyse;
    W.timer = setInterval(tick, 250);
  }, { label, raw });
}

/** What a peer's green watchdog has seen so far (see startGreenWatchdog). */
export function greenWatchdogReport(page) {
  return page.evaluate(() => {
    const W = window.__greenWatch;
    if (!W) return null;
    return {
      label: W.label, frames: W.frames, presented: W.presented, violations: W.violations.slice(),
      rawFrames: Object.assign({}, W.rawFrames), rawMarked: Object.assign({}, W.rawMarked),
    };
  });
}

/**
 * Prove the watchdog can see what it is there to catch, on this engine, before
 * trusting its silence: a keyed frame shown raw (person over the key, markers
 * in the top corners) must be called marked and green, the same frame with the
 * person filling most of it must still be called marked, and an ordinary
 * camera picture must be called neither.
 */
export function greenWatchdogSelfTest(page) {
  return page.evaluate(async () => {
    const W = window.__greenWatch;
    const paint = (ctx, w, h, kind) => {
      const Z = 0.1 * Math.min(w, h), P = 0.6 * Z;
      if (kind === 'camera') {
        ctx.fillStyle = 'rgb(110,104,100)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgb(205,150,122)';
        ctx.fillRect(w * 0.35, h * 0.3, w * 0.3, h * 0.7);
        return;
      }
      ctx.fillStyle = 'rgb(0,255,0)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(205,150,122)';
      if (kind === 'keyed') ctx.fillRect(w * 0.35, h * 0.3, w * 0.3, h * 0.7);
      else ctx.fillRect(Z * 1.2, Z * 1.2, w - 2.4 * Z, h - Z * 1.2);
      ctx.fillStyle = '#000';
      ctx.fillRect(w - Z + (Z - P) / 2, (Z - P) / 2, P, P);
    };
    const out = {};
    for (const kind of ['keyed', 'keyed-full', 'camera']) {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const ctx = c.getContext('2d', { alpha: false });
      let n = 0;
      const draw = () => { paint(ctx, 160, 120, kind); ctx.fillStyle = '#777'; ctx.fillRect((n++ * 3) % 160, 119, 1, 1); };
      draw();
      const stream = c.captureStream(15);
      const timer = setInterval(draw, 60);
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      await v.play().catch(() => {});
      const t0 = performance.now();
      while ((v.readyState < 2 || !v.videoWidth) && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      const r = W.analyse(v);
      out[kind] = r ? { marked: r.marked, overGreen: r.green > 0.3 } : null;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
    return out;
  });
}
