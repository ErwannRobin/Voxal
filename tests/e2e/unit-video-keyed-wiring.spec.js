import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// "Let others draw my scene" — the half of the keyed camera that lives in
// main.js: the setting, the signalling (caps, offers, acks through the host),
// which peer each of our senders carries, and the receiver's lifecycle around a
// cut-out. The pixels are VideoEffects'; here they are stood in for through its
// public contract only (design §6), so these tests stay valid whatever the real
// implementation does inside:
//
//   keyedTrack/isKeyedTrack/keyedState/setKeyedDemand/onKeyedState/onPressure
//   on the sending side; keyIn (a handle whose lastKeyedAt/lastUnkeyedAt the
//   test sets), keyProbe, canKeyIn on the receiving side.
//
// The stand-ins go in through an init script, before video-effects.js runs:
// main.js mirrors KEYED_CAP and SUBJECT_ONLY_KEY when it loads, and registers
// its hooks at bootstrap. The setting functions are used as they ship when they
// exist, and only filled in when they do not.

async function installKeyedContract(page) {
  await page.addInitScript(() => {
    const K = window.__keyed = {
      canKeyIn: true,
      scene: 'office',
      reason: null,
      demand: [],
      tracks: new Map(),       // processed stream -> keyed track
      allocs: 0,
      keyIns: [],
      handles: [],
      probes: [],
      hooks: {},
      autoResolve: true,
      failScene: null,
    };
    let trackSeq = 0;
    K.fakeTrack = (label) => ({ kind: 'video', id: label + '-' + (++trackSeq), label, enabled: true, contentHint: '' });
    K.makeHandle = (raw, offer) => ({
      stream: new MediaStream(),
      raw, scene_: offer.scene, alive_: true, paused: false, expect: false,
      keyedAt: 0, unkeyedAt: 0, destroyed: 0, sources: [], offers: [],
      setSource(r) { this.raw = r; this.sources.push(r); },
      setOffer(o) {
        this.offers.push(o);
        if (K.failScene && o.scene === K.failScene) return Promise.reject(new Error('will not compile'));
        this.scene_ = o.scene;
        return Promise.resolve();
      },
      scene() { return this.scene_; },
      setExpectKeyed(b) { this.expect = !!b; },
      setPaused(b) { this.paused = !!b; },
      lastKeyedAt() { return this.keyedAt; },
      lastUnkeyedAt() { return this.unkeyedAt; },
      alive() { return this.alive_ && !this.destroyed; },
      destroy() { this.destroyed++; },
    });

    function fillSetting(ve) {
      if (ve.SUBJECT_ONLY_KEY) return;
      const KEY = 'send-subject-only';
      let hook = null;
      ve.SUBJECT_ONLY_KEY = KEY;
      ve.readSubjectOnly = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; } };
      ve.writeSubjectOnly = (on) => {
        on = !!on;
        if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off');
        return on;
      };
      ve.onSubjectOnlyChange = (fn) => { hook = fn; };
      ve.setSubjectOnly = (on) => { on = ve.writeSubjectOnly(on); if (hook) hook(on); return on; };
      ve.renderSubjectOnly = (el, opts) => {
        if (!el) return null;
        opts = opts || {};
        el.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toggle-btn';
        btn.setAttribute('role', 'switch');
        if (opts.id) btn.id = opts.id;
        const sync = (on) => {
          on = on === undefined ? ve.readSubjectOnly() : !!on;
          btn.textContent = on ? 'ON' : 'OFF';
          btn.setAttribute('aria-checked', on ? 'true' : 'false');
          return on;
        };
        btn.addEventListener('click', () => {
          const on = btn.getAttribute('aria-checked') !== 'true';
          sync(on);
          if (opts.onChange) opts.onChange(on); else ve.setSubjectOnly(on);
        });
        el.appendChild(btn);
        sync();
        return { sync, element: el, button: btn };
      };
    }

    function stubContract(ve) {
      if (!ve.KEYED_CAP) ve.KEYED_CAP = 'keyed-video-1';
      ve.canKeyIn = () => K.canKeyIn;
      ve.keyedTrack = (stream) => {
        if (!stream || !stream._effectsProcessor) return null;
        let t = K.tracks.get(stream);
        if (!t) { t = K.fakeTrack('keyed'); K.tracks.set(stream, t); K.allocs++; }
        return t;
      };
      ve.isKeyedTrack = (t) => { for (const v of K.tracks.values()) if (v === t) return true; return false; };
      ve.keyedState = (stream) => {
        if (!K.tracks.has(stream)) return null;
        return {
          scene: K.scene, reason: K.reason, size: [640, 360], edgeE: -0.08,
          look: { tint: [1.02, 1, 0.97], exposure: 0.9, dirX: 0.4, dirY: 0.5, hard: 0.5, side: 1 },
        };
      };
      ve.setKeyedDemand = (stream, n) => { K.demand.push(n); };
      ve.onKeyedState = (fn) => { K.hooks.keyedState = fn; };
      ve.onPressure = (fn) => { K.hooks.pressure = fn; };
      ve.keyIn = (raw, offer, opts) => new Promise((resolve, reject) => {
        const rec = { raw, offer, opts, resolve, reject, handle: null };
        rec.resolveNow = () => { rec.handle = K.makeHandle(raw, offer); K.handles.push(rec.handle); resolve(rec.handle); };
        K.keyIns.push(rec);
        if (K.autoResolve) setTimeout(rec.resolveNow, 0);
      });
      ve.keyProbe = (raw) => {
        const p = {
          raw, keyedAt: 0, unkeyedAt: 0, destroyed: 0,
          setSource(r) { this.raw = r; },
          lastKeyedAt() { return this.keyedAt; },
          lastUnkeyedAt() { return this.unkeyedAt; },
          destroy() { this.destroyed++; },
        };
        K.probes.push(p);
        return p;
      };
      ve.keyInCount = () => K.handles.filter((h) => !h.destroyed).length;
    }

    let real;
    Object.defineProperty(window, 'VideoEffects', {
      configurable: true,
      enumerable: true,
      get() { return real; },
      set(v) { real = v; if (v && typeof v === 'object') { fillSetting(v); stubContract(v); } },
    });
  });
}

// In-page helpers shared by every test.
async function installHelpers(page) {
  await page.evaluate(() => {
    // Let every queued sender job, timer tick and stage refresh land.
    window.__flush = async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 0));
        let q;
        do { q = _videoSenderQueue; await q; } while (q !== _videoSenderQueue);
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
    };
    // A PeerJS DataConnection stand-in: records what is sent to it, and
    // emits whatever a test hands it.
    window.__dataConn = (id) => {
      const h = {};
      return { peer: id, open: true, closed: false, sent: [], send(m) { this.sent.push(m); }, close() {},
        on(e, fn) { (h[e] = h[e] || []).push(fn); }, emit(e, a) { (h[e] || []).forEach((fn) => fn(a)); } };
    };
    window.__canvasStream = (color) => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 36;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color || '#c89678';
      ctx.fillRect(0, 0, 64, 36);
      return c.captureStream(5);
    };
  });
}

test.beforeEach(async ({ page }) => {
  await installKeyedContract(page);
  await page.goto('/');
  await installHelpers(page);
});

// --- a sender ------------------------------------------------------------------

// This page hosts a room and shares a camera through a (stand-in) running
// pipeline with a scene picked. Every call gets its own sender, so which peer
// carries which track can be read per peer.
async function seedSender(page, opts = {}) {
  const peers = opts.peers || [
    { id: 'p1', caps: ['keyed-video-1'] },
    { id: 'p2', caps: [] },
  ];
  await seedRoom(page, {
    selfId: 'host', isHost: true, roomCode: 'host',
    knownPeerIds: peers.map((p) => p.id),
    connections: peers.map((p) => ({ id: p.id, pseudo: p.id })),
  });
  await page.evaluate(async ({ peers, subjectOnly, mode }) => {
    localStorage.setItem('video-routing-mode', 'p2p-only');
    if (subjectOnly === false) localStorage.setItem(VideoEffects.SUBJECT_ONLY_KEY, 'off');
    else localStorage.removeItem(VideoEffects.SUBJECT_ONLY_KEY);
    VideoEffects.writeMode(mode || 'preset:office');
    window.__sent = [];
    window.__swapLog = [];
    window.__failSwap = null;
    window.__holdSwap = null;
    peers.forEach((p) => {
      const c = connections.get(p.id);
      c.caps = p.caps;
      c.data.send = (m) => window.__sent.push({ to: p.id, msg: m });
    });
    let n = 0;
    window.__calls = [];
    peer = {
      id: 'host', destroyed: false,
      call(peerId, stream, callOpts) {
        const handlers = {};
        const sender = {
          track: stream.getVideoTracks()[0],
          params: { encodings: [{}] },
          replaceTrack(t) {
            window.__swapLog.push({ peerId, track: t });
            if (window.__failSwap && window.__failSwap(peerId, t)) return Promise.reject(new Error('pc closed'));
            const apply = () => { this.track = t; };
            if (window.__holdSwap) return window.__holdSwap.then(apply);
            apply();
            return Promise.resolve();
          },
          getParameters() { return JSON.parse(JSON.stringify(this.params)); },
          setParameters(p) { this.params = p; return Promise.resolve(); },
        };
        const call = {
          peer: peerId,
          connectionId: 'mc_' + peerId + '_' + (++n),
          metadata: callOpts && callOpts.metadata,
          closed: false,
          sender,
          peerConnection: { getSenders: () => [sender], getStats: () => Promise.resolve(new Map()) },
          close() { if (this.closed) return; this.closed = true; (handlers.close || []).forEach((fn) => fn()); },
          on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
          emit(e, a) { (handlers[e] || []).forEach((fn) => fn(a)); },
        };
        window.__calls.push(call);
        return call;
      },
    };
    const raw = window.__canvasStream('#c89678');
    const processed = window.__canvasStream('#5a7');
    window.__procDestroyed = 0;
    processed._effectsOriginal = raw;
    processed._effectsProcessor = { destroy() { window.__procDestroyed++; } };
    window.__raw = raw;
    window.__processed = processed;
    localVideoStream = processed;
    localVideoActive = true;
    await publishLocalTrack('video', processed);
  }, { peers, subjectOnly: opts.subjectOnly, mode: opts.mode });
  await page.evaluate(() => window.__flush());
}

// The sender each peer's current camera call carries.
async function senderTracks(page) {
  return page.evaluate(() => {
    const out = {};
    const keyed = VideoEffects.keyedTrack(localVideoStream);
    const composite = localVideoStream && localVideoStream.getVideoTracks()[0];
    connections.forEach((c, id) => {
      const mc = c.videoMediaOut;
      if (!mc || mc.closed) { out[id] = null; return; }
      const t = mc.sender.track;
      out[id] = t === keyed ? 'keyed' : t === composite ? 'composite'
        : (window.__raw && t === window.__raw.getVideoTracks()[0]) ? 'raw' : 'other';
    });
    return out;
  });
}

// A receiver's ack, arriving at this host exactly as it would off the wire.
async function ack(page, peerId, patch = {}) {
  await page.evaluate(({ peerId, patch }) => {
    const offer = currentOffer();
    const mc = connections.get(peerId).videoMediaOut;
    handleKeyedAckAtHost(peerId, Object.assign({
      type: 'video-keyed-ready', to: 'host', ok: true,
      call: mc && mc.connectionId, epoch: offer && offer.epoch, scene: offer && offer.scene,
    }, patch));
  }, { peerId, patch });
  await page.evaluate(() => window.__flush());
}

const offersSent = (page) => page.evaluate(() =>
  window.__sent.filter((s) => s.msg.type === 'video-keyed').map((s) => ({ to: s.to, offer: s.msg.offer })));

test.describe('the setting', () => {
  test('is on by default, and the switch stores only "off"', async ({ page }) => {
    expect(await page.evaluate(() => [VideoEffects.readSubjectOnly(), localStorage.getItem(VideoEffects.SUBJECT_ONLY_KEY)]))
      .toEqual([true, null]);
    await page.click('#btn-open-settings');
    await page.click('#modal-settings [data-target="settings-video"]');
    const btn = page.locator('#settings-subject-only .toggle-btn');
    await expect(btn).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('label[for="btn-subject-only"]')).toHaveText('Let others draw my scene');
    // On outside a call, the line under it says why it is idle.
    await expect(page.locator('#settings-subject-only-status')).toHaveText('Not in use: your camera is off');
    await btn.click();
    expect(await page.evaluate(() => [VideoEffects.readSubjectOnly(), localStorage.getItem(VideoEffects.SUBJECT_ONLY_KEY)]))
      .toEqual([false, 'off']);
    await expect(page.locator('#settings-subject-only-status')).toBeHidden();
    await btn.click();
    expect(await page.evaluate(() => [VideoEffects.readSubjectOnly(), localStorage.getItem(VideoEffects.SUBJECT_ONLY_KEY)]))
      .toEqual([true, null]);
  });

  test('both settings pages carry the switch, under the picker, with the same ids and hint', async ({ page }) => {
    const pages = await page.evaluate(async () => {
      const read = async (url) => (await fetch(url)).text();
      return [await read('/index.html'), await read('/settings.html')];
    });
    for (const html of pages) {
      expect(html).toContain('id="settings-subject-only"');
      expect(html).toContain('for="btn-subject-only"');
      expect(html.replace(/\s+/g, ' ')).toContain(
        'With an animated scene, sends just you and a thin edge of your room; the people you call draw the same ' +
        'scene on their own device. Uses less upload in calls that go peer to peer. They may see the scene slightly ' +
        'differently, and it costs their device some work. Has no effect with blur or your own image.');
      // The picker's promise stays true with the setting on.
      expect(html).not.toContain('everything is computed on this device');
      expect(html.indexOf('id="settings-bg-picker"')).toBeLessThan(html.indexOf('id="settings-subject-only"'));
      expect(html.indexOf('id="settings-subject-only"')).toBeLessThan(html.indexOf('id="settings-blur-strength"'));
    }
  });

  test('the preferences window stores it, and follows a change made elsewhere', async ({ page }) => {
    await page.goto('/settings.html');
    await page.click('.prefs-nav-btn[data-target="settings-video"]');
    const btn = page.locator('#settings-subject-only .toggle-btn');
    await expect(btn).toHaveAttribute('aria-checked', 'true');
    await btn.click();
    expect(await page.evaluate(() => localStorage.getItem(VideoEffects.SUBJECT_ONLY_KEY))).toBe('off');
    // It only stores: no status line here, the main window holds the calls.
    expect(await page.locator('#settings-subject-only-status').count()).toBe(0);
    await page.evaluate(() => {
      localStorage.removeItem(VideoEffects.SUBJECT_ONLY_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: VideoEffects.SUBJECT_ONLY_KEY, newValue: null }));
    });
    await expect(btn).toHaveAttribute('aria-checked', 'true');
  });

  test('flipped in the preferences window, it re-runs the senders, never applyVideoBackground', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    expect(await senderTracks(page)).toEqual({ p1: 'keyed', p2: 'composite' });
    await page.evaluate(() => {
      window.__bgApplied = 0;
      window.applyVideoBackground = () => { window.__bgApplied++; };
      window.__swapLog = [];
      localStorage.setItem(VideoEffects.SUBJECT_ONLY_KEY, 'off');
      window.dispatchEvent(new StorageEvent('storage', { key: VideoEffects.SUBJECT_ONLY_KEY, newValue: 'off' }));
    });
    await page.evaluate(() => window.__flush());
    expect(await senderTracks(page)).toEqual({ p1: 'composite', p2: 'composite' });
    const seen = await page.evaluate(() => ({
      applied: window.__bgApplied,
      swaps: window.__swapLog.map((s) => s.peerId),
      toggle: document.querySelector('#settings-subject-only .toggle-btn').getAttribute('aria-checked'),
    }));
    expect(seen).toEqual({ applied: 0, swaps: ['p1'], toggle: 'false' });
  });
});

test.describe('signalling', () => {
  test('hello carries the capability and the live offer', async ({ page }) => {
    const hello = await page.evaluate(() => helloMessage());
    expect(hello.protocolVersion).toBe(5);
    expect(hello.caps).toEqual(['keyed-video-1', 'keyed-tilt-1', 'keyed-sfu-1']);
    expect(hello.keyedOffer).toBeNull();
    const cannot = await page.evaluate(() => { window.__keyed.canKeyIn = false; return helloMessage().caps; });
    expect(cannot).toEqual([]);

    await seedSender(page);
    const offer = await page.evaluate(() => helloMessage().keyedOffer);
    expect(offer).toMatchObject({ scene: 'office', edgeE: -0.08, size: [640, 360] });
    expect(Number.isInteger(offer.epoch)).toBe(true);
    expect(offer.look).toEqual({ tint: [1.02, 1, 0.97], exposure: 0.9, dirX: 0.4, dirY: 0.5, hard: 0.5, side: 1 });
  });

  test('the host stores what hello says, and relays it in every peer-list', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host', myPseudo: 'Host' });
    const seen = await page.evaluate(() => {
      const mk = window.__dataConn;
      const a = mk('a');
      handleJoinerDataConnection(a); a.emit('open');
      a.emit('data', { type: 'hello', pseudo: 'Ada', caps: ['keyed-video-1', 42, 'x'.repeat(40)],
        keyedOffer: { epoch: 3, scene: 'island', look: {}, edgeE: -0.2, size: [320, 180] } });
      const old = mk('old');
      handleJoinerDataConnection(old); old.emit('open');
      old.emit('data', { type: 'hello', pseudo: 'Old' });   // an app from before v4
      const b = mk('b');
      handleJoinerDataConnection(b); b.emit('open');
      b.emit('data', { type: 'hello', pseudo: 'Bea', caps: [] });
      const list = b.sent.filter((m) => m.type === 'peer-list').pop();
      return {
        aCaps: connections.get('a').caps,
        oldCaps: connections.get('old').caps,
        oldOffer: connections.get('old').keyedOffer,
        aEntry: list.peers.find((p) => p.id === 'a'),
        oldEntry: list.peers.find((p) => p.id === 'old'),
        hostCaps: list.hostCaps,
        hostKeyedOffer: list.hostKeyedOffer,
      };
    });
    expect(seen.aCaps).toEqual(['keyed-video-1']);
    expect(seen.oldCaps).toEqual([]);
    expect(seen.oldOffer).toBeNull();
    expect(seen.aEntry.caps).toEqual(['keyed-video-1']);
    expect(seen.aEntry.keyedOffer).toMatchObject({ epoch: 3, scene: 'island', edgeE: -0.2, size: [320, 180] });
    expect(seen.oldEntry.caps).toEqual([]);
    expect(seen.oldEntry.keyedOffer).toBeNull();
    expect(seen.hostCaps).toEqual(['keyed-video-1', 'keyed-tilt-1', 'keyed-sfu-1']);
    expect(seen.hostKeyedOffer).toBeNull();
  });

  test('a placeholder entry says nothing about caps or offers', async ({ page }) => {
    const entry = await page.evaluate(() => {
      peer = { id: 'host' }; isHost = true;
      knownPeerIds.clear(); knownPeerIds.add('ghost');
      connections.clear();
      connections.set('ghost', { data: null, media: null, pseudo: 'ghost', pseudoColor: null, talking: false });
      startMigrationSettle();
      const e = buildHostPeerList(null).find((p) => p.id === 'ghost');
      stopMigrationSettle();
      return e;
    });
    expect('caps' in entry).toBe(false);
    expect('keyedOffer' in entry).toBe(false);
  });

  test('a receiver keeps caps through silence, and reads a missing offer as none only from a capable host', async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: false, roomCode: 'h', connections: [{ id: 'h' }, { id: 'p1' }] });
    const seen = await page.evaluate(() => {
      const offer = { epoch: 1, scene: 'office', look: {}, edgeE: 0, size: [640, 360] };
      const base = { type: 'peer-list', hostPseudo: 'H' };
      _keyedHostChangedAt = 0;
      // An older host: no hostCaps, no keyed fields at all.
      handleHostMessage(Object.assign({}, base, { peers: [{ id: 'p1', pseudo: 'P1', caps: ['keyed-video-1'], keyedOffer: offer }] }));
      const a = { caps: connections.get('p1').caps, offer: connections.get('p1').keyedOffer && connections.get('p1').keyedOffer.scene };
      handleHostMessage(Object.assign({}, base, { peers: [{ id: 'p1', pseudo: 'P1' }] }));
      const b = { caps: connections.get('p1').caps, offer: connections.get('p1').keyedOffer && connections.get('p1').keyedOffer.scene,
        hostCaps: connections.get('h').caps };
      // A capable host that has just taken over: silence is "not known yet".
      _keyedHostChangedAt = Date.now();
      handleHostMessage(Object.assign({}, base, { hostCaps: ['keyed-video-1'], hostKeyedOffer: null, peers: [{ id: 'p1', pseudo: 'P1' }] }));
      const c = { offer: connections.get('p1').keyedOffer && connections.get('p1').keyedOffer.scene,
        hostCaps: connections.get('h').caps, hostOffer: connections.get('h').keyedOffer };
      // …and after its settle window, silence from it means none.
      _keyedHostChangedAt = 0;
      handleHostMessage(Object.assign({}, base, { hostCaps: ['keyed-video-1'], peers: [{ id: 'p1', pseudo: 'P1' }] }));
      const d = { caps: connections.get('p1').caps, offer: connections.get('p1').keyedOffer,
        hostCaps: connections.get('h').caps };
      return { a, b, c, d };
    });
    expect(seen.a).toEqual({ caps: ['keyed-video-1'], offer: 'office' });
    expect(seen.b).toEqual({ caps: ['keyed-video-1'], offer: 'office', hostCaps: undefined });
    expect(seen.c).toEqual({ offer: 'office', hostCaps: ['keyed-video-1'], hostOffer: null });
    expect(seen.d).toEqual({ caps: ['keyed-video-1'], offer: null, hostCaps: ['keyed-video-1'] });
  });

  test('the host relays an offer under the connection it came on, never the claimed id', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host', myPseudo: 'Host' });
    const seen = await page.evaluate(() => {
      const mk = window.__dataConn;
      const conns = ['a', 'b', 'c'].map((id) => {
        const c = mk(id);
        handleJoinerDataConnection(c); c.emit('open');
        c.emit('data', { type: 'hello', pseudo: id, caps: ['keyed-video-1'] });
        c.sent = [];
        return c;
      });
      conns[0].emit('data', { type: 'video-keyed', peerId: 'b', offer: { epoch: 7, scene: 'mountain', look: {}, edgeE: 0, size: [640, 360] } });
      const relayed = (c) => c.sent.filter((m) => m.type === 'video-keyed');
      return {
        toA: relayed(conns[0]),
        toB: relayed(conns[1]).map((m) => [m.peerId, m.offer.scene, m.offer.epoch]),
        toC: relayed(conns[2]).map((m) => [m.peerId, m.offer.scene, m.offer.epoch]),
        storedOnA: connections.get('a').keyedOffer.scene,
        storedOnB: connections.get('b').keyedOffer,
      };
    });
    expect(seen.toA).toEqual([]);
    expect(seen.toB).toEqual([['a', 'mountain', 7]]);
    expect(seen.toC).toEqual([['a', 'mountain', 7]]);
    expect(seen.storedOnA).toBe('mountain');
    expect(seen.storedOnB).toBeNull();
  });

  test('an ack goes to `to` only — consumed by the host when it is for the host', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host', myPseudo: 'Host' });
    const seen = await page.evaluate(() => {
      const mk = window.__dataConn;
      const conns = {};
      ['a', 'b', 'c'].forEach((id) => {
        const c = mk(id);
        handleJoinerDataConnection(c); c.emit('open');
        c.emit('data', { type: 'hello', pseudo: id, caps: ['keyed-video-1'] });
        c.sent = [];
        conns[id] = c;
      });
      conns.a.emit('data', { type: 'video-keyed-ready', peerId: 'c', to: 'b', ok: true, call: 'mc_1', epoch: 2, scene: 'office' });
      conns.a.emit('data', { type: 'video-keyed-ready', to: 'a', ok: true, call: 'mc_1', epoch: 2 });        // to itself
      conns.a.emit('data', { type: 'video-keyed-ready', to: 'nobody', ok: true, call: 'mc_1', epoch: 2 });   // unknown
      conns.a.emit('data', { type: 'video-keyed-ready', to: 'host', ok: 'yes', call: 'mc_9', epoch: 4, scene: 'atlantis' });
      const acks = (c) => c.sent.filter((m) => m.type === 'video-keyed-ready');
      return { toA: acks(conns.a), toB: acks(conns.b), toC: acks(conns.c), host: _keyedAcks.get('a') };
    });
    expect(seen.toA).toEqual([]);
    expect(seen.toC).toEqual([]);
    expect(seen.toB).toEqual([{ type: 'video-keyed-ready', peerId: 'a', to: 'b', ok: true, call: 'mc_1', epoch: 2, scene: 'office' }]);
    // ok is true only when it is literally true; a scene nobody knows is no scene.
    expect(seen.host).toMatchObject({ ok: false, call: 'mc_9', epoch: 4, scene: null });
  });

  test('offers and caps are sanitised, and nothing creates a connection entry', async ({ page }) => {
    const seen = await page.evaluate(() => ({
      tooLong: sanitizeCaps(['ok', 'x'.repeat(33), 7, null, 'ok']),
      notList: sanitizeCaps('keyed-video-1'),
      many: sanitizeCaps(Array.from({ length: 40 }, (_, i) => 'c' + i)).length,
      badEpoch: sanitizeKeyedOffer({ epoch: 1.5, scene: 'office' }),
      negEpoch: sanitizeKeyedOffer({ epoch: -1, scene: 'office' }),
      unknownScene: sanitizeKeyedOffer({ epoch: 1, scene: 'atlantis' }).scene,
      legacyScene: sanitizeKeyedOffer({ epoch: 1, scene: 'studio' }).scene,
      clamped: sanitizeKeyedOffer({
        epoch: 2, scene: 'island', edgeE: 0.4, size: [2, 99999],
        look: { tint: [9, -1, 'x'], exposure: Infinity, dirX: -7, dirY: 'up', hard: 3, side: -0.2 },
      }),
    }));
    expect(seen.tooLong).toEqual(['ok']);
    expect(seen.notList).toBeNull();
    expect(seen.many).toBe(16);
    expect(seen.badEpoch).toBeNull();
    expect(seen.negEpoch).toBeNull();
    expect(seen.unknownScene).toBeNull();
    expect(seen.legacyScene).toBe('office');
    expect(seen.clamped).toEqual({
      epoch: 2, scene: 'island',
      look: { tint: [2, 0.5, 1], exposure: 1, dirX: -1, dirY: 0.5, hard: 1, side: -1 },
      edgeE: 0, size: [16, 4096], tilt: false,
    });

    await seedRoom(page, { selfId: 'me', isHost: false, roomCode: 'h', connections: [{ id: 'h' }, { id: 'p1' }] });
    const receiver = await page.evaluate(() => {
      const offer = { epoch: 1, scene: 'office', look: {}, edgeE: 0, size: [640, 360] };
      handleHostMessage({ type: 'video-keyed', peerId: 'me', offer });
      handleHostMessage({ type: 'video-keyed', peerId: 'stranger', offer });
      handleHostMessage({ type: 'video-keyed-ready', peerId: 'p1', to: 'someone-else', ok: true, call: 'x', epoch: 1 });
      handleHostMessage({ type: 'video-keyed-ready', peerId: 'stranger', to: 'me', ok: true, call: 'x', epoch: 1 });
      return { size: connections.size, self: connections.has('me'), stranger: connections.has('stranger'), acks: _keyedAcks.size };
    });
    expect(receiver).toEqual({ size: 2, self: false, stranger: false, acks: 0 });
  });

  test('the tilt flag is true only when literally true, and joins the look key', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const base = { epoch: 1, scene: 'office' };
      const off = sanitizeKeyedOffer(base), on = sanitizeKeyedOffer({ ...base, tilt: true });
      return {
        absent: off.tilt, on: on.tilt,
        truthy: [1, 'true', {}, []].map((v) => sanitizeKeyedOffer({ ...base, tilt: v }).tilt),
        differs: keyedOfferLookKey(off) !== keyedOfferLookKey(on),
      };
    });
    expect(seen).toEqual({ absent: false, on: true, truthy: [false, false, false, false], differs: true });
  });

  test('the strip is allowed only with a flowing sensor and no keyable peer lacking the capability', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: true, roomCode: 'me',
      connections: [{ id: 'a', caps: ['keyed-video-1', 'keyed-tilt-1'] }, { id: 'b', caps: ['keyed-video-1', 'keyed-tilt-1'] },
        { id: 'plain', caps: [] }],
    });
    const seen = await page.evaluate(() => {
      const real = DeviceTilt.ready;
      const out = {};
      DeviceTilt.ready = () => false;
      out.silent = keyedTiltOk();
      DeviceTilt.ready = () => true;
      out.flowing = keyedTiltOk();
      // An older keyable peer takes the strip away from everyone…
      connections.get('plain').caps = ['keyed-video-1'];
      out.oldPeer = keyedTiltOk();
      // …and one that cannot be keyed at all does not.
      connections.get('plain').caps = [];
      connections.delete('a'); connections.delete('b');
      out.nobody = keyedTiltOk();
      DeviceTilt.ready = real;
      return out;
    });
    expect(seen).toEqual({ silent: false, flowing: true, oldPeer: false, nobody: true });
  });

  test('the host relays at most two non-null offers a second per source; a null always passes', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host', myPseudo: 'Host' });
    const relayed = await page.evaluate(() => {
      const mk = window.__dataConn;
      const a = mk('a'), b = mk('b');
      [a, b].forEach((c) => { handleJoinerDataConnection(c); c.emit('open'); c.emit('data', { type: 'hello', pseudo: c.peer }); });
      b.sent = [];
      ['office', 'island', 'mountain'].forEach((scene) => {
        a.emit('data', { type: 'video-keyed', offer: { epoch: 1, scene, look: {}, edgeE: 0, size: [64, 36] } });
      });
      a.emit('data', { type: 'video-keyed', offer: null });
      return b.sent.filter((m) => m.type === 'video-keyed').map((m) => m.offer && m.offer.scene);
    });
    expect(relayed).toEqual(['office', 'island', null]);
  });
});

test.describe('which peer is sent which track', () => {
  test('only a capable peer that acked is keyed; the demand is raised before the swap', async ({ page }) => {
    await seedSender(page);
    // An offer goes out as soon as there is someone who could take it…
    const offers = await offersSent(page);
    expect(offers.map((o) => o.to).sort()).toEqual(['p1', 'p2']);
    expect(offers[0].offer).toMatchObject({ scene: 'office' });
    // …but nobody is keyed before saying so.
    expect(await senderTracks(page)).toEqual({ p1: 'composite', p2: 'composite' });
    await page.evaluate(() => {
      window.__order = [];
      const set = VideoEffects.setKeyedDemand;
      VideoEffects.setKeyedDemand = (s, n) => { window.__order.push('demand:' + n); set(s, n); };
      const log = window.__swapLog;
      window.__swapLog = { push: (e) => { window.__order.push('swap:' + e.peerId); log.push(e); } };
    });
    await ack(page, 'p1');
    expect(await senderTracks(page)).toEqual({ p1: 'keyed', p2: 'composite' });
    expect(await page.evaluate(() => window.__order)).toEqual(['demand:1', 'swap:p1']);
    // p2 says it is ready too — but it never advertised the capability.
    await ack(page, 'p2');
    expect(await senderTracks(page)).toEqual({ p1: 'keyed', p2: 'composite' });
  });

  test('never through the relay', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    expect(await senderTracks(page)).toEqual({ p1: 'keyed', p2: 'composite' });
    const seen = await page.evaluate(async () => {
      // The camera moved onto the SFU: one publish for everybody.
      unpublishLocalTrack('video');
      const sfuSender = { track: localVideoStream.getVideoTracks()[0], replaceTrack(t) { this.track = t; return Promise.resolve(); } };
      _sfuPublishSessions.video = { pc: { getSenders: () => [sfuSender] } };
      _localVideoTopology.video = { mode: 'sfu', reason: 'test' };
      refreshKeyedSend();
      await window.__flush();
      const offer = currentOffer();
      await swapLocalVideoTrack(localVideoStream.getVideoTracks()[0]);
      const out = { offer, sfuKeyed: VideoEffects.isKeyedTrack(sfuSender.track),
        lastOffer: window.__sent.filter((s) => s.msg.type === 'video-keyed').pop().msg.offer };
      _sfuPublishSessions.video = null;
      return out;
    });
    expect(seen).toEqual({ offer: null, sfuKeyed: false, lastOffer: null });
  });

  test('an ack for another call, epoch or scene, or an old one, keys nothing', async ({ page }) => {
    await seedSender(page);
    const keyedAfter = async (patch) => {
      await ack(page, 'p1', patch);
      return (await senderTracks(page)).p1;
    };
    expect(await keyedAfter({ call: 'mc_p1_999' })).toBe('composite');
    expect(await keyedAfter({ epoch: 12345 })).toBe('composite');
    expect(await keyedAfter({ scene: 'island' })).toBe('composite');
    expect(await keyedAfter({ ok: 1 })).toBe('composite');
    // The real thing keys…
    expect(await keyedAfter({})).toBe('keyed');
    // …until it is 25 s old with nothing to refresh it.
    await page.evaluate(() => { _keyedAcks.get('p1').at -= 26000; refreshKeyedSend(); });
    await page.evaluate(() => window.__flush());
    expect((await senderTracks(page)).p1).toBe('composite');
  });

  test('a late joiner starts on the composite and is keyed only after acking its own call', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    const callId = await page.evaluate(() => connections.get('p1').videoMediaOut.connectionId);
    // Migration-style re-call from the host's hello path: a NEW call to p1.
    await page.evaluate(() => {
      const dc = window.__dataConn('p1');
      dc.send = (m) => window.__sent.push({ to: 'p1', msg: m });
      handleJoinerDataConnection(dc); dc.emit('open');
      dc.emit('data', { type: 'hello', pseudo: 'p1', caps: ['keyed-video-1'] });
    });
    await page.evaluate(() => window.__flush());
    const fresh = await page.evaluate(() => connections.get('p1').videoMediaOut.connectionId);
    expect(fresh).not.toBe(callId);
    expect((await senderTracks(page)).p1).toBe('composite');
    // The receiver's old ack named the old call.
    await ack(page, 'p1', { call: callId });
    expect((await senderTracks(page)).p1).toBe('composite');
    await ack(page, 'p1');
    expect((await senderTracks(page)).p1).toBe('keyed');

    // The same for a newcomer a non-host sharer is told to call.
    const viaNudge = await page.evaluate(async () => {
      isHost = false; roomCode = 'p2';
      connections.get('p2').caps = ['keyed-video-1'];
      connections.set('p3', { data: null, media: null, pseudo: 'p3', caps: ['keyed-video-1'] });
      handleHostMessage({ type: 'video-call-peer', peerId: 'p3' });
      await window.__flush();
      const mc = connections.get('p3').videoMediaOut;
      return mc.sender.track === localVideoStream.getVideoTracks()[0];
    });
    expect(viaNudge).toBe(true);
  });

  test('flip and scene ↔ blur keep each peer\'s track; the setting off and on goes through the composite first', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    // A wrapped flip repoints the pipeline and swaps nothing.
    const flipSwaps = await page.evaluate(async () => {
      window.__swapLog = [];
      const realSetSource = VideoEffects.setSource;
      VideoEffects.setSource = () => Promise.resolve();
      const real = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => window.__canvasStream('#789');
      await flipCamera();
      navigator.mediaDevices.getUserMedia = real;
      VideoEffects.setSource = realSetSource;
      await window.__flush();
      return window.__swapLog.length;
    });
    expect(flipSwaps).toBe(0);
    expect(await senderTracks(page)).toEqual({ p1: 'keyed', p2: 'composite' });

    // Off: p1 goes back to the composite BEFORE the null offer goes out.
    const off = await page.evaluate(async () => {
      window.__order = [];
      window.__swapLog = { push: (e) => window.__order.push('swap:' + e.peerId) };
      const send = connections.get('p1').data.send;
      connections.get('p1').data.send = (m) => { if (m.type === 'video-keyed') window.__order.push('offer:' + (m.offer ? 'on' : 'null')); send(m); };
      VideoEffects.setSubjectOnly(false);
      await window.__flush();
      connections.get('p1').data.send = send;
      window.__swapLog = [];
      return window.__order;
    });
    expect(off).toEqual(['swap:p1', 'offer:null']);
    expect(await senderTracks(page)).toEqual({ p1: 'composite', p2: 'composite' });

    // On again: a new epoch, so the old ack keys nothing until p1 acks it.
    const epochs = await page.evaluate(async () => {
      const before = _keyedAcks.get('p1').epoch;
      VideoEffects.setSubjectOnly(true);
      await window.__flush();
      return [before, currentOffer().epoch];
    });
    expect(epochs[1]).toBeGreaterThan(epochs[0]);
    expect((await senderTracks(page)).p1).toBe('composite');
    await ack(page, 'p1');
    expect((await senderTracks(page)).p1).toBe('keyed');
  });

  test('scene → blur → scene, with the receiver answering acks, swaps nothing', async ({ page }) => {
    await seedSender(page);
    // p1 is a simulated receiver at the end of a fake data channel: it acks
    // every offer it is sent, with the scene it has (keeping the last one
    // while the offer has none), exactly as reconcileKeyedReceivers would.
    await page.evaluate(() => {
      let scene = currentOffer().scene;   // what its cut-out compiled for the first offer
      connections.get('p1').data.send = (m) => {
        window.__sent.push({ to: 'p1', msg: m });
        if (m.type !== 'video-keyed' || !m.offer) return;
        if (m.offer.scene) scene = m.offer.scene;
        const call = connections.get('p1').videoMediaOut.connectionId;
        setTimeout(() => handleKeyedAckAtHost('p1', {
          type: 'video-keyed-ready', to: 'host', ok: true, call, epoch: m.offer.epoch, scene,
        }), 0);
      };
    });
    // The first offer went out before the simulated receiver was wired up.
    await ack(page, 'p1');
    expect((await senderTracks(page)).p1).toBe('keyed');
    const swaps = await page.evaluate(async () => {
      window.__swapLog = [];
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const [mode, scene] of [['blur', null], ['preset:office', 'office'], ['blur', null], ['preset:office', 'office']]) {
        window.__keyed.scene = scene;
        await applyVideoBackground(mode);
        window.__keyed.hooks.keyedState(localVideoStream);   // what the pipeline says on a scene change
        await wait(1100);                                   // past the offer throttle
        await window.__flush();
      }
      return window.__swapLog.length;
    });
    expect(swaps).toBe(0);
    expect((await senderTracks(page)).p1).toBe('keyed');
  });

  test('turning the background off moves keyed peers off the keyed track before the pipeline stops', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    const seen = await page.evaluate(async () => {
      const order = [];
      const keyed = VideoEffects.keyedTrack(localVideoStream);
      const sender = connections.get('p1').videoMediaOut.sender;
      window.__processed._effectsProcessor.destroy = () => {
        order.push('stop:' + (sender.track === keyed ? 'still-keyed' : 'moved'));
      };
      await applyVideoBackground('off');
      await window.__flush();
      return { order, p1: sender.track === window.__raw.getVideoTracks()[0] };
    });
    expect(seen).toEqual({ order: ['stop:moved'], p1: true });
  });

  test('a keyed sender that cannot be moved off is closed, never left on a dying track', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    const seen = await page.evaluate(async () => {
      const keyed = VideoEffects.keyedTrack(localVideoStream);
      const oldCall = connections.get('p1').videoMediaOut;
      window.__failSwap = (peerId) => peerId === 'p1';
      await applyVideoBackground('off');
      await window.__flush();
      window.__failSwap = null;
      const now = connections.get('p1').videoMediaOut;
      return { closed: oldCall.closed, stillKeyed: oldCall.sender.track === keyed,
        recalled: !!now && now !== oldCall, recalledTrack: now && now.sender.track === window.__raw.getVideoTracks()[0] };
    });
    expect(seen).toEqual({ closed: true, stillKeyed: true, recalled: true, recalledTrack: true });
  });

  test('keyed senders get a share of the cap, but not on the frugal tier', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('video-resolution', 'off')); // 600 kbps ceiling
    await seedSender(page);
    await ack(page, 'p1');
    const caps = await page.evaluate(() => {
      const rate = (id) => connections.get(id).videoMediaOut.sender.params.encodings[0].maxBitrate;
      return {
        p1: rate('p1'), p2: rate('p2'),
        tiers: [keyedVideoBitrate(CAMERA_MAX_BITRATE), keyedVideoBitrate(CAMERA_MAX_BITRATE_MOBILE),
          keyedVideoBitrate(CAMERA_MAX_BITRATE_FRUGAL)],
      };
    });
    expect(caps).toEqual({ p1: 450000, p2: 600000, tiers: [450000, 225000, 150000] });
  });

  test('camera stop is synchronous: calls closed, offer withdrawn, acks forgotten, nothing swapped', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    const seen = await page.evaluate(() => {
      window.__swapLog = [];
      window.__sent = [];
      const calls = ['p1', 'p2'].map((id) => connections.get(id).videoMediaOut);
      stopVideoShare();
      // Read before any microtask runs.
      return {
        closed: calls.map((c) => c.closed),
        offers: window.__sent.filter((s) => s.msg.type === 'video-keyed').map((s) => s.msg.offer),
        stopsBeforeOffer: window.__sent.findIndex((s) => s.msg.type === 'video-stop') <
          window.__sent.findIndex((s) => s.msg.type === 'video-keyed'),
        acks: _keyedAcks.size,
        swaps: window.__swapLog.length,
        active: localVideoActive,
      };
    });
    expect(seen).toEqual({ closed: [true, true], offers: [null, null], stopsBeforeOffer: true, acks: 0, swaps: 0, active: false });
  });

  test('a backgrounded app darkens the keyed track with the others', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    const seen = await page.evaluate(() => {
      const keyed = VideoEffects.keyedTrack(localVideoStream);
      setLocalCameraSuspended(true);
      const off = keyed.enabled;
      setLocalCameraSuspended(false);
      return [off, keyed.enabled];
    });
    expect(seen).toEqual([false, true]);
  });

  test('a closed call is cleared from the live entry even after the host copied it', async ({ page }) => {
    await seedSender(page);
    const cleared = await page.evaluate(() => {
      const call = connections.get('p1').videoMediaOut;
      notePeerHeartbeat('p1', Date.now());   // the host copy-replaces the entry on every message
      call.close();
      return connections.get('p1').videoMediaOut;
    });
    expect(cleared).toBeNull();
  });

  test('a reconcile asked for while a swap is in flight is not dropped', async ({ page }) => {
    await seedSender(page);
    const seen = await page.evaluate(async () => {
      let release;
      window.__holdSwap = new Promise((r) => { release = r; });
      // A flip-style swap holds the queue…
      const swap = swapLocalVideoTrack(localVideoStream.getVideoTracks()[0]);
      // …while p1's ack arrives and asks for a reconcile.
      const mc = connections.get('p1').videoMediaOut;
      const offer = currentOffer();
      handleKeyedAckAtHost('p1', { to: 'host', ok: true, call: mc.connectionId, epoch: offer.epoch, scene: offer.scene });
      await new Promise((r) => setTimeout(r, 20));
      window.__holdSwap = null;
      release();
      await swap;
      await window.__flush();
      return mc.sender.track === VideoEffects.keyedTrack(localVideoStream);
    });
    expect(seen).toBe(true);
  });

  test('with the setting off, nothing is allocated, swapped or sent', async ({ page }) => {
    await seedSender(page, { subjectOnly: false });
    await ack(page, 'p1');
    const seen = await page.evaluate(async () => {
      await applyVideoBackground('preset:island');
      await swapLocalVideoTrack(localVideoStream.getVideoTracks()[0]);
      await window.__flush();
      return {
        allocs: window.__keyed.allocs,
        demand: window.__keyed.demand.length,
        offers: window.__sent.filter((s) => s.msg.type === 'video-keyed').length,
        hello: helloMessage().keyedOffer,
      };
    });
    expect(seen).toEqual({ allocs: 0, demand: 0, offers: 0, hello: null });
    expect(await senderTracks(page)).toEqual({ p1: 'composite', p2: 'composite' });
  });
});

// --- a receiver ----------------------------------------------------------------

// This page is a non-host in a room hosted by 'h', and 'p1' shares a camera to
// it over the mesh. The host's data channel is fake: what we send it is
// recorded in window.__sent.
async function seedReceiver(page, opts = {}) {
  await seedRoom(page, {
    selfId: 'me', isHost: false, roomCode: 'h',
    knownPeerIds: ['h', 'p1'],
    connections: [{ id: 'h', pseudo: 'Host' }, { id: 'p1', pseudo: 'Ada' }],
  });
  await page.evaluate(({ hostCaps }) => {
    window.__sent = [];
    connections.get('h').caps = hostCaps === undefined ? ['keyed-video-1'] : hostCaps;
    connections.get('h').data.send = (m) => window.__sent.push(m);
    showScreen('room');
    window.__giveCamera = (peerId, n) => {
      const c = connections.get(peerId);
      c.videoActive = true;
      c.videoMedia = { peer: peerId, connectionId: 'mc_' + peerId + '_' + (n || 1), closed: false, close() {}, on() {} };
      c.remoteVideoStream = window.__canvasStream('#0a5');
    };
    window.__giveCamera('p1');
    updatePeerList();
    window.__offer = (peerId, patch) => handleHostMessage({
      type: 'video-keyed', peerId,
      offer: patch === null ? null : Object.assign({
        epoch: 1, scene: 'office', edgeE: -0.1, size: [640, 360],
        look: { tint: [1, 1, 1], exposure: 1, dirX: 0.3, dirY: 0.5, hard: 0.4, side: 1 },
      }, patch || {}),
    });
    window.__acks = () => window.__sent.filter((m) => m.type === 'video-keyed-ready');
    window.__tileVideo = (peerId) => document.querySelector('#video-stage [data-key="camera:' + peerId + '"] video');
    window.__spySrc = (peerId) => {
      const vid = window.__tileVideo(peerId);
      let desc = null;
      for (let p = Object.getPrototypeOf(vid); p && !desc; p = Object.getPrototypeOf(p)) {
        desc = Object.getOwnPropertyDescriptor(p, 'srcObject');
      }
      const log = [];
      Object.defineProperty(vid, 'srcObject', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { log.push(v); desc.set.call(this, v); },
      });
      return log;
    };
  }, { hostCaps: opts.hostCaps });
  await page.evaluate(() => window.__flush());
}

test.describe('drawing a sender\'s scene', () => {
  test('offer → keyIn → ok:true for this call, and the tile switches to the cut-out once', async ({ page }) => {
    await seedReceiver(page);
    const seen = await page.evaluate(async () => {
      const raw = connections.get('p1').remoteVideoStream;
      const tileWasRaw = window.__tileVideo('p1').srcObject === raw;
      const log = window.__spySrc('p1');
      window.__offer('p1');
      await window.__flush();
      const K = window.__keyed;
      const h = K.handles[0];
      for (let i = 0; i < 5; i++) { updatePeerList(); }
      await window.__flush();
      return {
        tileWasRaw,
        keyIns: K.keyIns.length,
        keyInRaw: K.keyIns[0].raw === raw,
        keyInScene: K.keyIns[0].offer.scene,
        acks: window.__acks(),
        writes: log.length,
        shows: window.__tileVideo('p1').srcObject === h.stream,
        expect: h.expect,
        rawStillRaw: connections.get('p1').remoteVideoStream === raw,
      };
    });
    expect(seen).toMatchObject({ tileWasRaw: true, keyIns: 1, keyInRaw: true, keyInScene: 'office',
      writes: 1, shows: true, expect: true, rawStillRaw: true });
    expect(seen.acks).toEqual([{ type: 'video-keyed-ready', peerId: 'me', to: 'p1', ok: true, call: 'mc_p1_1', epoch: 1, scene: 'office' }]);
  });

  test('scene ↔ no scene keeps the cut-out: no srcObject write, no recompile, the ack kept', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => { window.__offer('p1'); await window.__flush(); });
    const seen = await page.evaluate(async () => {
      const log = window.__spySrc('p1');
      const h = window.__keyed.handles[0];
      const acksBefore = window.__acks().length;
      for (let i = 0; i < 2; i++) {
        window.__offer('p1', { scene: null });
        await window.__flush();
        window.__offer('p1');
        await window.__flush();
      }
      return { writes: log.length, setOffers: h.offers.length, newAcks: window.__acks().length - acksBefore,
        destroyed: h.destroyed, keyIns: window.__keyed.keyIns.length };
    });
    expect(seen).toEqual({ writes: 0, setOffers: 0, newAcks: 0, destroyed: 0, keyIns: 1 });
  });

  test('a new scene is acked only once it has compiled; a new call is acked as such', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => { window.__offer('p1'); await window.__flush(); });
    const seen = await page.evaluate(async () => {
      const h = window.__keyed.handles[0];
      let finish;
      h.setOffer = function(o) { this.offers.push(o); return new Promise((r) => { finish = () => { this.scene_ = o.scene; r(); }; }); };
      window.__sent = [];
      window.__offer('p1', { scene: 'island' });
      await window.__flush();
      const whileCompiling = { acks: window.__acks().length, expect: h.expect };
      finish();
      await window.__flush();
      const afterCompile = window.__acks().map((a) => [a.ok, a.scene, a.call]);
      // The sender called again (a migration re-call): same handle, new ack.
      window.__sent = [];
      const tileStream = window.__tileVideo('p1').srcObject;
      window.__giveCamera('p1', 2);
      updatePeerList();
      await window.__flush();
      return { whileCompiling, afterCompile, newCall: window.__acks().map((a) => [a.ok, a.call]),
        sourced: h.sources.length, sameTile: window.__tileVideo('p1').srcObject === tileStream };
    });
    expect(seen.whileCompiling).toEqual({ acks: 0, expect: false });
    expect(seen.afterCompile).toEqual([[true, 'island', 'mc_p1_1']]);
    expect(seen.newCall).toEqual([[true, 'mc_p1_2']]);
    expect(seen.sourced).toBe(1);
    expect(seen.sameTile).toBe(true);
  });

  test('closing says ok:false and lets go only once the frames are seen unkeyed', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => { window.__offer('p1'); await window.__flush(); });
    const seen = await page.evaluate(async () => {
      const h = window.__keyed.handles[0];
      const raw = connections.get('p1').remoteVideoStream;
      window.__sent = [];
      h.keyedAt = performance.now();
      window.__offer('p1', null);           // the sender withdrew its offer
      await window.__flush();
      const saidStop = window.__acks().map((a) => a.ok);
      // Keyed frames keep coming (the sender has not switched yet): still the cut-out.
      await new Promise((r) => setTimeout(r, 700));
      h.keyedAt = performance.now();
      updatePeerList(); await window.__flush();
      const stillCut = window.__tileVideo('p1').srcObject === h.stream && !h.destroyed;
      // …and after 2 s of that, ok:false again.
      await new Promise((r) => setTimeout(r, 1500));
      h.keyedAt = performance.now();
      updatePeerList(); await window.__flush();
      const resent = window.__acks().filter((a) => a.ok === false).length;
      // The frames come in unkeyed: let go.
      h.unkeyedAt = performance.now() + 1;
      await new Promise((r) => setTimeout(r, 600));
      await window.__flush();
      return { saidStop, stillCut, resent, destroyed: h.destroyed, tileRaw: window.__tileVideo('p1').srcObject === raw };
    });
    expect(seen.saidStop).toEqual([false]);
    expect(seen.stillCut).toBe(true);
    expect(seen.resent).toBeGreaterThanOrEqual(2);
    expect(seen.destroyed).toBe(1);
    expect(seen.tileRaw).toBe(true);
  });

  test('keyed frames with no cut-out show a placeholder, never the raw picture', async ({ page }) => {
    await seedReceiver(page);
    const seen = await page.evaluate(async () => {
      // A full slot list: this sender gets no handle, only a probe.
      window.__keyed.canKeyIn = true;
      const realMax = keyedReceiversMax;
      window.keyedReceiversMax = () => 0;
      window.__offer('p1');
      await window.__flush();
      const probe = window.__keyed.probes[0];
      probe.keyedAt = performance.now();
      updatePeerList(); await window.__flush();
      const during = { stream: window.__tileVideo('p1').srcObject,
        placeholder: !document.querySelector('#video-stage [data-key="camera:p1"] .video-tile-placeholder').classList.contains('hidden') };
      await new Promise((r) => setTimeout(r, 1700));
      await window.__flush();
      window.keyedReceiversMax = realMax;
      return { keyIns: window.__keyed.keyIns.length, during,
        after: window.__tileVideo('p1').srcObject === connections.get('p1').remoteVideoStream };
    });
    expect(seen.keyIns).toBe(0);
    expect(seen.during).toEqual({ stream: null, placeholder: true });
    expect(seen.after).toBe(true);
  });

  test('a handle that gave up is never revived, and its scene is not retried at once', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => { window.__offer('p1'); await window.__flush(); });
    const seen = await page.evaluate(async () => {
      const K = window.__keyed;
      const h = K.handles[0];
      window.__sent = [];
      K.keyIns[0].opts.onGiveUp('budget');
      await window.__flush();
      // Still eligible in every other way, and the room keeps ticking.
      window.__offer('p1', { epoch: 2 });
      for (let i = 0; i < 3; i++) { updatePeerList(); await window.__flush(); }
      const state = _keyedReceivers.get('p1').state;
      h.unkeyedAt = performance.now() + 1;
      await new Promise((r) => setTimeout(r, 600));
      await window.__flush();
      return { acks: window.__acks().map((a) => a.ok), state, keyIns: K.keyIns.length, entry: _keyedReceivers.has('p1') };
    });
    expect(seen.acks.every((ok) => ok === false)).toBe(true);
    expect(seen.state).toBe('closing');
    expect(seen.keyIns).toBe(1);
    expect(seen.entry).toBe(false);
  });

  test('a keyIn that fails is backed off, and a late resolve for a dropped entry is destroyed', async ({ page }) => {
    await seedReceiver(page);
    const seen = await page.evaluate(async () => {
      const K = window.__keyed;
      K.autoResolve = false;
      window.__offer('p1');
      await window.__flush();
      K.keyIns[0].reject(new Error('no GPU'));
      await window.__flush();
      for (let i = 0; i < 3; i++) { updatePeerList(); await window.__flush(); }
      const afterFail = K.keyIns.length;
      // A different scene is a different attempt; drop it while it starts.
      window.__offer('p1', { scene: 'island' });
      await window.__flush();
      const second = K.keyIns.length;
      window.__offer('p1', null);
      await window.__flush();
      K.keyIns[1].resolveNow();
      await window.__flush();
      return { afterFail, second, lateDestroyed: K.keyIns[1].handle.destroyed, entry: _keyedReceivers.has('p1'),
        acks: window.__acks().filter((a) => a.ok).length };
    });
    expect(seen).toEqual({ afterFail: 1, second: 2, lateDestroyed: 1, entry: false, acks: 0 });
  });

  test('pressure on the local pipeline sheds the newest cut-out first', async ({ page }) => {
    await seedReceiver(page);
    const seen = await page.evaluate(async () => {
      const shedNone = window.__keyed.hooks.pressure();
      connections.set('p2', { data: null, media: null, pseudo: 'Bo', caps: [] });
      window.__giveCamera('p2');
      window.__offer('p1');
      await window.__flush();
      window.__offer('p2');
      await window.__flush();
      window.__sent = [];
      const shed = window.__keyed.hooks.pressure();
      await window.__flush();
      return { shedNone, shed, p1: _keyedReceivers.get('p1').state, p2: _keyedReceivers.get('p2').state,
        stops: window.__acks().filter((a) => !a.ok).map((a) => a.to) };
    });
    expect(seen).toEqual({ shedNone: false, shed: true, p1: 'ready', p2: 'closing', stops: ['p2'] });
  });

  test('slots are capped and sticky, and the relay or an incapable host means no cut-out', async ({ page }) => {
    await seedReceiver(page);
    const seen = await page.evaluate(async () => {
      ['p2', 'p3', 'p4'].forEach((id) => {
        connections.set(id, { data: null, media: null, pseudo: id });
        window.__giveCamera(id);
      });
      ['p1', 'p2', 'p3', 'p4'].forEach((id) => window.__offer(id));
      await window.__flush();
      const started = window.__keyed.keyIns.map((k) => k.raw === connections.get('p4').remoteVideoStream);
      // A sender behind the relay is never cut out.
      connections.get('p1').videoTopology = { mode: 'sfu' };
      updatePeerList(); await window.__flush();
      const p1 = _keyedReceivers.get('p1') && _keyedReceivers.get('p1').state;
      return { count: window.__keyed.keyIns.length, p4Started: started.some(Boolean), p1 };
    });
    expect(seen).toEqual({ count: 3, p4Started: false, p1: 'closing' });

    await seedReceiver(page, { hostCaps: [] });
    const viaOldHost = await page.evaluate(async () => {
      const before = window.__keyed.keyIns.length;
      window.__offer('p1');
      await window.__flush();
      return window.__keyed.keyIns.length - before;
    });
    expect(viaOldHost).toBe(0);
  });

  test('a hidden tile keeps its slot and pauses', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => { window.__offer('p1'); await window.__flush(); });
    const seen = await page.evaluate(async () => {
      const h = window.__keyed.handles[0];
      _hiddenStageKeys.add('camera:p1');
      updatePeerList(); await window.__flush();
      const paused = h.paused;
      const kept = _keyedReceivers.get('p1').state;
      _hiddenStageKeys.delete('camera:p1');
      updatePeerList(); await window.__flush();
      return { paused, kept, unpaused: !h.paused, keyIns: window.__keyed.keyIns.length, destroyed: h.destroyed };
    });
    expect(seen).toEqual({ paused: true, kept: 'ready', unpaused: true, keyIns: 1, destroyed: 0 });
  });

  test('after a migration, the new host\'s first peer-list gets our acks again, and its silence keeps the offer', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => {
      connections.set('n', { data: null, media: null, pseudo: 'Neo', caps: ['keyed-video-1'] });
      window.__offer('p1');
      await window.__flush();
    });
    const seen = await page.evaluate(async () => {
      // The host is gone; 'n' was elected.
      const mk = window.__dataConn;
      roomState = ROOM_STATE_MIGRATING;
      connections.delete('h');
      peer.connect = (id) => (window.__newHost = mk(id));
      _migrationCandidateId = 'n';
      _attemptHostConnection('n', 3);
      const conn = window.__newHost;
      conn.emit('open');
      // It has not heard from p1 yet, so its list says nothing about p1's offer.
      conn.emit('data', { type: 'peer-list', hostId: 'n', hostPseudo: 'Neo', hostCaps: ['keyed-video-1'],
        hostKeyedOffer: null, peers: [{ id: 'p1', pseudo: 'Ada', videoActive: true }] });
      await window.__flush();
      return {
        hello: conn.sent.filter((m) => m.type === 'hello').map((m) => m.caps),
        acks: conn.sent.filter((m) => m.type === 'video-keyed-ready').map((m) => [m.to, m.ok, m.call, m.epoch, m.scene]),
        offer: connections.get('p1').keyedOffer && connections.get('p1').keyedOffer.scene,
        state: _keyedReceivers.get('p1').state,
      };
    });
    expect(seen.hello).toEqual([['keyed-video-1', 'keyed-tilt-1', 'keyed-sfu-1']]);
    expect(seen.acks[0]).toEqual(['p1', true, 'mc_p1_1', 1, 'office']);
    expect(seen.offer).toBe('office');
    expect(seen.state).toBe('ready');
  });

  test('leaving the room destroys every cut-out and probe', async ({ page }) => {
    await seedReceiver(page);
    await page.evaluate(async () => { window.__offer('p1'); await window.__flush(); });
    const seen = await page.evaluate(() => {
      const h = window.__keyed.handles[0];
      resetVideoState();
      return { destroyed: h.destroyed, entries: _keyedReceivers.size, probes: _keyedProbes.size };
    });
    expect(seen).toEqual({ destroyed: 1, entries: 0, probes: 0 });
  });
});

test.describe('the device-info popover', () => {
  test('carries a Drawn scene section that says what each direction is doing', async ({ page }) => {
    await seedSender(page);
    await ack(page, 'p1');
    const rows = await page.evaluate(() => {
      const read = (id) => Array.from(_buildKeyedSection(id).querySelectorAll('.di-row'))
        .map((r) => [r.children[0].textContent, r.children[1].textContent]);
      const on = read('p1');
      const waiting = read('p2');
      localStorage.setItem(VideoEffects.SUBJECT_ONLY_KEY, 'off');
      return { on, waiting, off: read('p1') };
    });
    const send = (r) => r.find((x) => x[0] === 'Your camera → them')[1];
    expect(send(rows.on)).toBe('Scene drawn on their device');
    expect(send(rows.waiting)).toMatch(/^Composite/);
    expect(send(rows.off)).toBe('Off (setting)');
  });
});

test.describe('keyedStatus()', () => {
  test('says why it is idle, and how many people it is in use for', async ({ page }) => {
    const off = await page.evaluate(() => {
      localStorage.setItem(VideoEffects.SUBJECT_ONLY_KEY, 'off');
      return keyedStatus();
    });
    expect(off).toEqual({ state: 'off' });
    expect(await page.evaluate(() => {
      localStorage.removeItem(VideoEffects.SUBJECT_ONLY_KEY);
      return keyedStatus();
    })).toEqual({ state: 'inactive', reason: 'not-sharing' });

    await seedSender(page);
    const table = await page.evaluate(async () => {
      const out = {};
      const rows = [];
      const say = (label) => { const st = keyedStatus(); rows.push([label, st, keyedStatusText(st)]); };
      say('ready-to-start');
      const mc = connections.get('p1').videoMediaOut;
      const offer = currentOffer();
      handleKeyedAckAtHost('p1', { to: 'host', ok: true, call: mc.connectionId, epoch: offer.epoch, scene: offer.scene });
      await window.__flush();
      say('active');
      window.__keyed.reason = 'green'; window.__keyed.scene = null;
      say('paused');
      window.__keyed.reason = null; window.__keyed.scene = 'office';
      VideoEffects.writeMode('blur');
      say('no-scene');
      VideoEffects.writeMode('preset:office');
      const topo = _localVideoTopology.video;
      _localVideoTopology.video = { mode: 'sfu' };
      say('relay');
      _localVideoTopology.video = topo;
      const caps = connections.get('p1').caps;
      connections.get('p1').caps = [];
      say('nobody');
      connections.get('p1').caps = caps;
      out.rows = rows;
      renderKeyedStatus();
      out.line = document.getElementById('settings-subject-only-status').textContent;
      const pop = document.getElementById('video-bg-subject-only');
      out.pop = pop.querySelector('.video-bg-subject-only-text').textContent;
      out.popInfo = !!pop.querySelector('.video-bg-info');
      // Not in use: Settings says why, the call's popover says nothing.
      VideoEffects.writeMode('blur');
      renderKeyedStatus();
      out.idleLine = document.getElementById('settings-subject-only-status').textContent;
      out.idlePopHidden = pop.classList.contains('hidden');
      VideoEffects.writeMode('preset:office');
      return out;
    });
    const byLabel = Object.fromEntries(table.rows.map(([l, st, text]) => [l, { st, text }]));
    expect(byLabel['ready-to-start'].st).toEqual({ state: 'active', peers: 0, of: 2 });
    expect(byLabel.active).toEqual({ st: { state: 'active', peers: 1, of: 2 }, text: 'In use for 1 of 2 people' });
    expect(byLabel.paused.st).toEqual({ state: 'inactive', reason: 'paused' });
    expect(byLabel['no-scene']).toEqual({ st: { state: 'inactive', reason: 'no-scene' }, text: 'Not in use: pick an animated scene' });
    expect(byLabel.relay).toEqual({ st: { state: 'inactive', reason: 'relay' },
      text: 'Not in use: video goes through the relay, and nobody here can draw the scene from it' });
    expect(byLabel.nobody.st).toEqual({ state: 'inactive', reason: 'no-capable-peer' });
    expect(table.line).toBe('In use for 1 of 2 people');
    expect(table.pop).toBe('1 of 2 people draw this scene on their own device; the others see your usual picture.');
    expect(table.popInfo).toBe(true);
    expect(table.idleLine).toBe('Not in use: pick an animated scene');
    expect(table.idlePopHidden).toBe(true);
  });
});

// --- through the relay ------------------------------------------------------------
//
// The camera goes through the SFU: the sender publishes a second relay track
// with the keyed picture, and each receiver chooses which one it pulls. The
// Cloudflare legs are stood in for at their two seams, sfuPublishKeyedTrack()
// and sfuPullTrack() — the SDP dance behind them is the composite's own.

// This page hosts and shares its camera through the relay. p1 can key through
// the relay, p2 cannot key at all, p3 (when asked for) only on the mesh.
async function seedRelaySender(page, opts = {}) {
  await seedSender(page, { peers: opts.peers || [
    { id: 'p1', caps: ['keyed-video-1', 'keyed-tilt-1', 'keyed-sfu-1'] },
    { id: 'p2', caps: [] },
  ] });
  await page.evaluate(async () => {
    window.__pubs = [];
    window.__failPublish = false;
    sfuPublishKeyedTrack = async (track) => {
      if (window.__failPublish) throw new Error('relay said no');
      const sender = { track, replaceTrack(t) { this.track = t; return Promise.resolve(); },
        getParameters() { return { encodings: [{}] }; }, setParameters() { return Promise.resolve(); } };
      const pc = { closed: 0, sender, getSenders: () => [sender], close() { this.closed++; }, addEventListener() {} };
      const pub = { track, pc, ref: { sessionId: 'S-keyed-' + (window.__pubs.length + 1), trackName: 'host-video-keyed' } };
      window.__pubs.push(pub);
      return { pc, ref: pub.ref };
    };
    // The camera moved onto the SFU: one publish for everybody.
    unpublishLocalTrack('video');
    const sfuSender = { track: localVideoStream.getVideoTracks()[0], replaceTrack(t) { this.track = t; return Promise.resolve(); } };
    window.__sfuSender = sfuSender;
    _sfuPublishSessions.video = { pc: { getSenders: () => [sfuSender] } };
    _localVideoTopology.video = { mode: 'sfu', reason: 'test' };
    window.__sent = [];
    refreshKeyedSend();
  });
  await page.evaluate(() => window.__flush());
}

async function relayAck(page, peerId, ok = true) {
  await page.evaluate(({ peerId, ok }) => {
    const offer = currentOffer();
    handleKeyedAckAtHost(peerId, { type: 'video-keyed-ready', to: 'host', ok,
      call: ok ? 'sfu' : null, epoch: ok ? offer.epoch : null, scene: ok ? offer.scene : null });
  }, { peerId, ok });
  await page.evaluate(() => window.__flush());
}

test.describe('through the relay: sending', () => {
  test('offered to a peer that can key through the relay; published only once one acks', async ({ page }) => {
    await seedRelaySender(page);
    const before = await page.evaluate(() => ({
      offer: currentOffer(), pubs: window.__pubs.length, status: keyedStatus(),
    }));
    expect(before.offer).toMatchObject({ scene: 'office', tilt: false });
    expect(before.offer).not.toHaveProperty('ref');
    expect(before.pubs).toBe(0);
    expect(before.status).toEqual({ state: 'active', peers: 0, of: 2 });

    // p2 says yes — but it cannot key at all: nothing is published for it.
    await relayAck(page, 'p2');
    expect(await page.evaluate(() => window.__pubs.length)).toBe(0);

    await relayAck(page, 'p1');
    const after = await page.evaluate(async () => {
      // The offer that names the track waits for its slot (one a second).
      await new Promise((r) => setTimeout(r, KEYED_OFFER_MIN_GAP_MS + 100));
      await window.__flush();
      const offers = window.__sent.filter((s) => s.msg.type === 'video-keyed');
      return {
        pubs: window.__pubs.length,
        keyedOnPub: VideoEffects.isKeyedTrack(window.__pubs[0].track),
        compositeOnRelay: window.__sfuSender.track === localVideoStream.getVideoTracks()[0],
        demand: window.__keyed.demand[window.__keyed.demand.length - 1],
        lastOffer: offers[offers.length - 1].msg.offer,
        to: offers.filter((o) => o.msg.offer && o.msg.offer.ref).map((o) => o.to).sort(),
        status: keyedStatus(),
        text: keyedStatusText(keyedStatus()),
        state: _keyedSendingState('p1'),
      };
    });
    expect(after).toMatchObject({ pubs: 1, keyedOnPub: true, compositeOnRelay: true, demand: 1,
      to: ['p1', 'p2'], status: { state: 'active', peers: 1, of: 2 }, text: 'In use for 1 of 2 people' });
    expect(after.lastOffer.ref).toEqual({ sessionId: 'S-keyed-1', trackName: 'host-video-keyed' });
    expect(after.state).toBe('Scene drawn on their device (keyed track through the relay)');

    // A background swap moves the composite publish, never the keyed one.
    const swapped = await page.evaluate(async () => {
      await swapLocalVideoTrack(window.__raw.getVideoTracks()[0]);
      return { relay: window.__sfuSender.track === window.__raw.getVideoTracks()[0],
        keyed: VideoEffects.isKeyedTrack(window.__pubs[0].pc.sender.track) };
    });
    expect(swapped).toEqual({ relay: true, keyed: true });
  });

  test('the keyed track lingers after the last receiver lets go, then is withdrawn from the offer', async ({ page }) => {
    await seedRelaySender(page);
    await relayAck(page, 'p1');
    // The offer naming the track has gone out (it waited for its slot).
    await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, KEYED_OFFER_MIN_GAP_MS + 100));
      await window.__flush();
    });
    expect(await page.evaluate(() => !!_keyedSentOffer.ref)).toBe(true);
    await relayAck(page, 'p1', false);
    const lingering = await page.evaluate(() => ({ closed: window.__pubs[0].pc.closed, ref: !!currentOffer().ref }));
    expect(lingering).toEqual({ closed: 0, ref: true });
    const gone = await page.evaluate(async () => {
      _keyedSfuWantedAt -= KEYED_SFU_LINGER_MS + 1;
      window.__sent = [];
      refreshKeyedSend();
      await window.__flush();
      await new Promise((r) => setTimeout(r, KEYED_OFFER_MIN_GAP_MS + 100));
      await window.__flush();
      const offers = window.__sent.filter((s) => s.msg.type === 'video-keyed');
      const last = offers[offers.length - 1];
      return { closed: window.__pubs[0].pc.closed, ref: 'ref' in currentOffer(),
        sentWithout: !!(last && last.msg.offer && !('ref' in last.msg.offer)),
        demand: window.__keyed.demand[window.__keyed.demand.length - 1] };
    });
    expect(gone).toEqual({ closed: 1, ref: false, sentWithout: true, demand: 0 });
  });

  test('a failed publish is not retried at once; moving off the relay or stopping drops the track', async ({ page }) => {
    await seedRelaySender(page);
    await page.evaluate(() => { window.__failPublish = true; });
    await relayAck(page, 'p1');
    const failed = await page.evaluate(async () => {
      refreshKeyedSend(); await window.__flush();
      return { pubs: window.__pubs.length, held: _keyedSfuRetryAt > Date.now(), ref: 'ref' in currentOffer() };
    });
    expect(failed).toEqual({ pubs: 0, held: true, ref: false });

    const dropped = await page.evaluate(async () => {
      window.__failPublish = false;
      _keyedSfuRetryAt = 0;
      refreshKeyedSend(); await window.__flush();
      const pub = window.__pubs[0];
      unpublishLocalTrack('video');
      const onMove = pub.pc.closed;
      return { published: !!pub, onMove, offer: currentOffer() };
    });
    expect(dropped).toEqual({ published: true, onMove: 1, offer: null });
  });

  test('never offered through a host, or to peers, that cannot key through the relay', async ({ page }) => {
    await seedRelaySender(page, { peers: [
      { id: 'p1', caps: ['keyed-video-1', 'keyed-tilt-1'] },   // a v4 build: mesh only
      { id: 'p2', caps: [] },
    ] });
    expect(await page.evaluate(() => [currentOffer(), keyedStatus().reason])).toEqual([null, 'relay']);
    const viaOldHost = await page.evaluate(() => {
      connections.get('p1').caps = ['keyed-video-1', 'keyed-sfu-1'];
      const yes = anyPeerKeyableOverRelay();
      // Now a non-host, behind a host (p2) that does not know the reference.
      isHost = false; roomCode = 'p2';
      const no = anyPeerKeyableOverRelay();
      isHost = true; roomCode = 'host';
      return [yes, no];
    });
    expect(viaOldHost).toEqual([true, false]);
  });

  test('the reference survives the host, and is dropped when malformed', async ({ page }) => {
    const out = await page.evaluate(() => {
      const base = { epoch: 3, scene: 'office', look: {}, edgeE: -0.1, size: [640, 360] };
      return {
        mesh: 'ref' in sanitizeKeyedOffer(base),
        ok: sanitizeKeyedOffer(Object.assign({}, base, { ref: { sessionId: 'S', trackName: 'p-video-keyed', x: 1 } })).ref,
        bad: 'ref' in sanitizeKeyedOffer(Object.assign({}, base, { ref: { sessionId: 7, trackName: 'x' } })),
        long: 'ref' in sanitizeKeyedOffer(Object.assign({}, base, { ref: { sessionId: 'S'.repeat(200), trackName: 'x' } })),
      };
    });
    expect(out).toEqual({ mesh: false, ok: { sessionId: 'S', trackName: 'p-video-keyed' }, bad: false, long: false });
  });
});

// This page is a non-host behind a capable host 'h'; p1's camera reaches it
// through the relay, on a composite subscription.
async function seedRelayReceiver(page) {
  await seedReceiver(page, { hostCaps: ['keyed-video-1', 'keyed-sfu-1'] });
  await page.evaluate(async () => {
    window.__pulls = [];
    sfuPullTrack = (kind, ref) => new Promise((resolve, reject) => {
      const rec = { kind, ref, pc: { closed: 0, close() { this.closed++; }, addEventListener() {} },
        stream: window.__canvasStream('#0f0') };
      rec.resolve = () => resolve({ pc: rec.pc, stream: rec.stream });
      rec.reject = (e) => reject(e || new Error('no frame'));
      window.__pulls.push(rec);
    });
    const c = connections.get('p1');
    c.videoTopology = { mode: 'sfu', reason: 'test' };
    window.__composite = { _sfu: true, closed: 0, peerConnection: {}, close() { this.closed++; } };
    c.videoMedia = window.__composite;
    _rememberProviderRef('p1', 'video', { sessionId: 'S-comp', trackName: 'p1-video' });
    updatePeerList();
  });
  await page.evaluate(() => window.__flush());
}

const KEYED_REF = { sessionId: 'S-keyed', trackName: 'p1-video-keyed' };

test.describe('through the relay: receiving', () => {
  test('acks with call "sfu", and pulls the keyed track only once the offer names it — make before break', async ({ page }) => {
    await seedRelayReceiver(page);
    const first = await page.evaluate(async () => {
      window.__offer('p1');
      await window.__flush();
      return { acks: window.__acks(), pulls: window.__pulls.length, state: _keyedReceivers.get('p1').state };
    });
    expect(first.acks).toEqual([{ type: 'video-keyed-ready', peerId: 'me', to: 'p1', ok: true, call: 'sfu', epoch: 1, scene: 'office' }]);
    expect(first).toMatchObject({ pulls: 0, state: 'ready' });

    const pending = await page.evaluate(async (ref) => {
      window.__offer('p1', { ref });
      await window.__flush();
      for (let i = 0; i < 3; i++) updatePeerList();   // many relayouts, one pull
      await window.__flush();
      const h = window.__keyed.handles[0];
      return { pulls: window.__pulls.map((p) => p.ref), oldClosed: window.__composite.closed,
        onComposite: connections.get('p1').videoMedia === window.__composite, expect: h.expect,
        tileCut: window.__tileVideo('p1').srcObject === h.stream };
    }, KEYED_REF);
    expect(pending).toEqual({ pulls: [KEYED_REF], oldClosed: 0, onComposite: true, expect: false, tileCut: true });

    const switched = await page.evaluate(async () => {
      const p = window.__pulls[0];
      p.resolve();
      await window.__flush();
      const c = connections.get('p1');
      const h = window.__keyed.handles[0];
      return { keyedRef: c.videoMedia._keyedRef, oldClosed: window.__composite.closed,
        raw: c.remoteVideoStream === p.stream, handleOn: h.raw === p.stream, expect: h.expect,
        tileCut: window.__tileVideo('p1').srcObject === h.stream,
        registry: _rememberedProviderRef('p1', 'video'), keyedKey: p.stream._keyedKey };
    });
    expect(switched).toMatchObject({ keyedRef: KEYED_REF, oldClosed: 1, raw: true, handleOn: true, expect: true,
      tileCut: true, registry: { sessionId: 'S-comp', trackName: 'p1-video' } });
    expect(switched.keyedKey).toBe('sfu:p1:S-comp');
  });

  test('closing pulls the composite back, and lets go of the cut-out only once it is in', async ({ page }) => {
    await seedRelayReceiver(page);
    await page.evaluate(async (ref) => {
      window.__offer('p1'); await window.__flush();
      window.__offer('p1', { ref }); await window.__flush();
      window.__pulls[0].resolve(); await window.__flush();
    }, KEYED_REF);
    const seen = await page.evaluate(async () => {
      const h = window.__keyed.handles[0];
      const keyedPull = window.__pulls[0];
      window.__sent = [];
      window.__offer('p1', null);           // the sender withdrew its offer
      await window.__flush();
      const during = { stop: window.__acks().map((a) => a.ok), state: _keyedReceivers.get('p1').state,
        pull: window.__pulls[1] && window.__pulls[1].ref, destroyed: h.destroyed,
        tileCut: window.__tileVideo('p1').srcObject === h.stream };
      window.__pulls[1].resolve();
      await window.__flush();
      const c = connections.get('p1');
      return { during, after: { entry: _keyedReceivers.has('p1'), destroyed: h.destroyed,
        keyedRef: c.videoMedia._keyedRef, keyedClosed: keyedPull.pc.closed,
        tileRaw: window.__tileVideo('p1').srcObject === window.__pulls[1].stream } };
    });
    expect(seen.during).toEqual({ stop: [false], state: 'closing', pull: { sessionId: 'S-comp', trackName: 'p1-video' },
      destroyed: 0, tileCut: true });
    expect(seen.after).toEqual({ entry: false, destroyed: 1, keyedRef: null, keyedClosed: 1, tileRaw: true });
  });

  test('a keyed pull that fails is held off; a composite pull that fails resubscribes the plain way', async ({ page }) => {
    await seedRelayReceiver(page);
    const held = await page.evaluate(async (ref) => {
      window.__offer('p1'); await window.__flush();
      window.__offer('p1', { ref }); await window.__flush();
      window.__pulls[0].reject();
      await window.__flush();
      for (let i = 0; i < 3; i++) updatePeerList();
      await window.__flush();
      return { pulls: window.__pulls.length, hold: _keyedSfuPullHold.get('p1') > Date.now(),
        onComposite: connections.get('p1').videoMedia === window.__composite };
    }, KEYED_REF);
    expect(held).toEqual({ pulls: 1, hold: true, onComposite: true });

    const fallback = await page.evaluate(async () => {
      _keyedSfuPullHold.clear();
      updatePeerList(); await window.__flush();
      window.__pulls[1].resolve(); await window.__flush();
      window.__subs = [];
      sfuSubscribeTrack = (kind, id, ref) => { window.__subs.push({ kind, id, ref }); return Promise.resolve(); };
      window.__offer('p1', null); await window.__flush();
      window.__pulls[2].reject(); await window.__flush();
      const c = connections.get('p1');
      return { subs: window.__subs, media: c.videoMedia, keyedClosed: window.__pulls[1].pc.closed };
    });
    expect(fallback).toEqual({ subs: [{ kind: 'video', id: 'p1', ref: { sessionId: 'S-comp', trackName: 'p1-video' } }],
      media: null, keyedClosed: 1 });
  });

  test('a keyed pull with nothing left to cut it out goes back to the composite', async ({ page }) => {
    await seedRelayReceiver(page);
    const seen = await page.evaluate(async (ref) => {
      window.__offer('p1'); await window.__flush();
      window.__offer('p1', { ref }); await window.__flush();
      window.__pulls[0].resolve(); await window.__flush();
      dropKeyedReceiver('p1');            // lost without closing
      updatePeerList(); await window.__flush();
      return window.__pulls.slice(1).map((p) => p.ref);
    }, KEYED_REF);
    expect(seen[0]).toEqual({ sessionId: 'S-comp', trackName: 'p1-video' });
  });
});
