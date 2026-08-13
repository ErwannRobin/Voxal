import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// selectVideoTopology() decides P2P vs Cloudflare SFU for camera/screen-share
// ONLY — voice/PTT audio never reaches this function and is never routed
// through an SFU under any preference. See docs/video-routing.md.
//
// The single most important property, asserted explicitly below: the function
// can only ever return mode:'sfu' when preference === 'allow-sfu'. A
// 'prefer-p2p' user is never silently moved onto an SFU, and 'p2p-only' can
// never end up on one regardless of participant count or SFU availability.

function decide(page, kind, opts) {
  return callFn(page, 'selectVideoTopology', kind, opts);
}

test.describe('selectVideoTopology — truth table', () => {
  test('p2p-only never returns sfu, even over capacity with a configured SFU', async ({ page }) => {
    await page.goto('/');
    const healthy = await decide(page, 'video', {
      preference: 'p2p-only', participantCount: 50, meshHealthy: true, sfuConfigured: true,
    });
    expect(healthy).toEqual({ mode: 'p2p', reason: 'ok' });

    const unhealthy = await decide(page, 'video', {
      preference: 'p2p-only', participantCount: 50, meshHealthy: false, sfuConfigured: true,
    });
    expect(unhealthy).toEqual({ mode: 'p2p', reason: 'p2p-failed-temporary' });
  });

  test('an unconfigured SFU always falls back to p2p, even for allow-sfu over capacity', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'video', {
      preference: 'allow-sfu', participantCount: 50, meshHealthy: true, sfuConfigured: false,
    });
    expect(result).toEqual({ mode: 'p2p', reason: 'ok' });

    const degraded = await decide(page, 'video', {
      preference: 'allow-sfu', participantCount: 50, meshHealthy: false, sfuConfigured: false,
    });
    expect(degraded).toEqual({ mode: 'p2p', reason: 'sfu-unavailable' });
  });

  test('prefer-p2p under capacity and healthy stays p2p/ok', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'video', {
      preference: 'prefer-p2p', participantCount: 2, meshHealthy: true, sfuConfigured: true,
    });
    expect(result).toEqual({ mode: 'p2p', reason: 'ok' });
  });

  test('prefer-p2p over capacity reports p2p-unsuitable, never switches to sfu', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'video', {
      preference: 'prefer-p2p', participantCount: 50, meshHealthy: true, sfuConfigured: true,
    });
    expect(result).toEqual({ mode: 'p2p', reason: 'p2p-unsuitable' });
  });

  test('prefer-p2p under capacity but unhealthy reports p2p-failed-temporary', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'video', {
      preference: 'prefer-p2p', participantCount: 2, meshHealthy: false, sfuConfigured: true,
    });
    expect(result).toEqual({ mode: 'p2p', reason: 'p2p-failed-temporary' });
  });

  test('allow-sfu under capacity still prefers p2p', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'video', {
      preference: 'allow-sfu', participantCount: 2, meshHealthy: true, sfuConfigured: true,
    });
    expect(result).toEqual({ mode: 'p2p', reason: 'ok' });
  });

  test('allow-sfu over capacity with a configured SFU switches to sfu', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'video', {
      preference: 'allow-sfu', participantCount: 50, meshHealthy: true, sfuConfigured: true,
    });
    expect(result).toEqual({ mode: 'sfu', reason: 'preference-allow-sfu' });
  });

  test('boundary: exactly 2 participants stays p2p, more than 2 switches to sfu under allow-sfu', async ({ page }) => {
    // Pins VIDEO_SFU_THRESHOLD_PEERS = 2 explicitly, since this is the number
    // the product decision hinges on ("more than 2 peers with a camera on").
    await page.goto('/');
    const atThreshold = await decide(page, 'video', {
      preference: 'allow-sfu', participantCount: 2, meshHealthy: true, sfuConfigured: true,
    });
    expect(atThreshold).toEqual({ mode: 'p2p', reason: 'ok' });

    const overThreshold = await decide(page, 'video', {
      preference: 'allow-sfu', participantCount: 3, meshHealthy: true, sfuConfigured: true,
    });
    expect(overThreshold).toEqual({ mode: 'sfu', reason: 'preference-allow-sfu' });
  });

  test('applies identically to the screen kind', async ({ page }) => {
    await page.goto('/');
    const result = await decide(page, 'screen', {
      preference: 'allow-sfu', participantCount: 50, meshHealthy: true, sfuConfigured: true,
    });
    expect(result.mode).toBe('sfu');
  });

  test('invariant: mode is only ever "sfu" when preference is "allow-sfu"', async ({ page }) => {
    await page.goto('/');
    const preferences = ['prefer-p2p', 'allow-sfu', 'p2p-only'];
    const counts = [0, 1, 2, 3, 8, 9, 12, 50];
    const bools = [true, false];
    const combos = [];
    preferences.forEach((preference) => counts.forEach((participantCount) => bools.forEach((meshHealthy) => bools.forEach((sfuConfigured) => {
      combos.push({ preference, participantCount, meshHealthy, sfuConfigured });
    }))));
    const results = await page.evaluate((cs) => cs.map((c) => ({
      c, r: selectVideoTopology('video', c),
    })), combos);
    for (const { c, r } of results) {
      expect(['p2p', 'sfu']).toContain(r.mode);
      if (r.mode === 'sfu') expect(c.preference).toBe('allow-sfu');
      if (c.preference === 'p2p-only') expect(r.mode).toBe('p2p');
    }
  });
});

test.describe('video routing preference — persistence', () => {
  test('defaults to allow-sfu when unset', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => videoRoutingPreference())).toBe('allow-sfu');
  });

  test('reads back a stored value', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'prefer-p2p'));
    expect(await page.evaluate(() => videoRoutingPreference())).toBe('prefer-p2p');
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'p2p-only'));
    expect(await page.evaluate(() => videoRoutingPreference())).toBe('p2p-only');
  });

  test('an invalid stored value falls back to the default rather than crashing', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'nonsense'));
    expect(await page.evaluate(() => videoRoutingPreference())).toBe('allow-sfu');
  });

  test('the in-page modal radios reflect the stored preference', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('video-routing-mode', 'allow-sfu');
      syncVideoRoutingControls();
    });
    const checked = await page.evaluate(() =>
      document.querySelector('input[name="video-routing-mode"]:checked').value);
    expect(checked).toBe('allow-sfu');
  });

  test('selecting a radio persists the preference', async ({ page }) => {
    // The control lives inside the collapsed Advanced <details> of a modal
    // that's hidden until opened — dispatch the change event directly rather
    // than depending on that chrome, matching how other settings-modal specs
    // in this suite (e.g. unit-noise-suppression.spec.js) drive hidden
    // controls without opening the surrounding UI.
    await page.goto('/');
    await page.evaluate(() => {
      syncVideoRoutingControls();
      const input = document.querySelector('input[name="video-routing-mode"][value="p2p-only"]');
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(() => localStorage.getItem('video-routing-mode'))).toBe('p2p-only');
  });
});

test.describe('SFU session mint — stubbed backend, no real Cloudflare credentials', () => {
  test('a 503 not_configured response marks the SFU unavailable', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/sfu-session', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'not_configured' }) }));
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self' });
    const err = await page.evaluate(async () => {
      try { await sfuMintCapability('video', 'publish'); return null; }
      catch (e) { return e.code; }
    });
    expect(err).toBe('not_configured');
    expect(await page.evaluate(() => sfuAvailabilityHint())).toBe(false);
  });

  test('a successful mint returns a capability and marks the SFU available', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/sfu-session', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ capability: 'fake.capability', expires_at: new Date(Date.now() + 300e3).toISOString(), sfu_app_id: 'app1' }),
    }));
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self' });
    const result = await page.evaluate(() => sfuMintCapability('video', 'publish'));
    expect(result.capability).toBe('fake.capability');
    expect(await page.evaluate(() => sfuAvailabilityHint())).toBe(true);
  });
});

// The strongest end-to-end guarantee of the "never silently switch" requirement:
// drive the real publish path (not just the pure selector) and assert which
// backend endpoints were actually called. Uses a canvas-captured MediaStream so
// no camera permission / --use-fake-device-for-media-stream flag is needed.
test.describe('publish path — endpoint call pattern by preference', () => {
  async function seedOverCapacityRoom(page) {
    const connections = [];
    for (let i = 0; i < 9; i++) connections.push({ id: 'peer-' + i, pseudo: 'p' + i, open: true });
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self', connections });
    // p2pPublishVideo calls peer.call(...) per connected peer — stub it so the
    // P2P branch doesn't throw in a page with no real PeerJS Peer.
    await page.evaluate(() => {
      window.__peerCallCount = 0;
      peer.call = function() {
        window.__peerCallCount++;
        return { on() {}, close() {} };
      };
    });
  }

  test('p2p-only never calls /api/sfu-session, even over capacity', async ({ page }) => {
    await page.goto('/');
    let sfuHits = 0;
    await page.route('**/api/sfu-session', (route) => { sfuHits++; route.abort(); });
    await seedOverCapacityRoom(page);
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'p2p-only'));
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      const stream = canvas.captureStream(5);
      await publishLocalTrack('video', stream);
    });
    expect(sfuHits).toBe(0);
    expect(await page.evaluate(() => window.__peerCallCount)).toBe(9);
  });

  test('allow-sfu over capacity does call /api/sfu-session', async ({ page }) => {
    await page.goto('/');
    let sfuHits = 0;
    await page.route('**/api/sfu-session', (route) => {
      sfuHits++;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ capability: 'fake.capability', expires_at: new Date(Date.now() + 300e3).toISOString(), sfu_app_id: 'app1' }),
      });
    });
    // The subsequent SDP negotiation step is not expected to succeed against a
    // stub answer — that's fine, publishLocalTrack falls back to P2P on failure.
    // This test only asserts the mint step was attempted, per the "allow-sfu
    // over capacity tries the SFU" requirement.
    await page.route('**/api/sfu-track', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }));
    await seedOverCapacityRoom(page);
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'allow-sfu'));
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      const stream = canvas.captureStream(5);
      await publishLocalTrack('video', stream);
    });
    expect(sfuHits).toBeGreaterThan(0);
  });
});

// Regression tests for the black-remote-camera bug: an SFU session can
// negotiate perfectly and still forward no media, because routing is driven by
// the `tracks[]` instruction, not by the SDP exchange. The first version of
// this integration sent no tracks[] at all and never named the remote track —
// the session connected, the badge said "Relayed", and every tile was black.
test.describe('SFU wire protocol — tracks[] is what actually routes media', () => {
  function stubMint(page) {
    return page.route('**/api/sfu-session', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ capability: 'fake.capability', expires_at: new Date(Date.now() + 300e3).toISOString(), sfu_app_id: 'app1' }),
    }));
  }

  test('publishing names its own track: tracks[] carries location:local, a mid and a trackName', async ({ page }) => {
    await page.goto('/');
    await stubMint(page);
    let published = null;
    await page.route('**/api/sfu-track', async (route) => {
      published = route.request().postDataJSON();
      // Answer plausibly so setRemoteDescription succeeds against the offer.
      const offer = published.offer;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ sessionId: 'cf-sess-1', sessionDescription: { type: 'answer', sdp: offer }, requiresImmediateRenegotiation: false, tracks: [] }),
      });
    });
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self' });
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      try { await sfuPublishTrack('video', canvas.captureStream(5)); } catch (_) { /* SDP round-trip may still reject; the request body is what matters */ }
    });

    expect(published, 'publish must reach /api/sfu-track').not.toBeNull();
    expect(published.action).toBe('publish');
    expect(Array.isArray(published.tracks)).toBe(true);
    expect(published.tracks.length).toBeGreaterThan(0);
    expect(published.tracks[0].location).toBe('local');
    expect(published.tracks[0].trackName).toBeTruthy();
    expect(published.tracks[0].mid == null).toBe(false);
  });

  test('subscribing names the REMOTE track: location:remote + publisher sessionId/trackName', async ({ page }) => {
    await page.goto('/');
    await stubMint(page);
    let subscribed = null;
    await page.route('**/api/sfu-track', (route) => {
      subscribed = route.request().postDataJSON();
      route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }); // stop after asserting the request
    });
    await seedRoom(page, {
      selfId: 'self', isHost: true, roomCode: 'self',
      connections: [{ id: 'peer-1', pseudo: 'p1', open: true }],
    });
    await page.evaluate(async () => {
      await sfuSubscribeVideo('peer-1', { sessionId: 'cf-publisher-sess', trackName: 'peer-1-video' });
    });

    expect(subscribed, 'subscribe must reach /api/sfu-track').not.toBeNull();
    expect(subscribed.action).toBe('subscribe');
    expect(subscribed.tracks[0]).toMatchObject({
      location: 'remote',
      sessionId: 'cf-publisher-sess',
      trackName: 'peer-1-video',
    });
  });

  test('a subscribe with no publisher track reference bails instead of opening a dead connection', async ({ page }) => {
    // This is the exact silent failure that produced a black tile: negotiating
    // a transceiver the SFU was never told to fill.
    await page.goto('/');
    await stubMint(page);
    let trackHits = 0;
    await page.route('**/api/sfu-track', (route) => { trackHits++; route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }); });
    await seedRoom(page, {
      selfId: 'self', isHost: true, roomCode: 'self',
      connections: [{ id: 'peer-1', pseudo: 'p1', open: true }],
    });
    await page.evaluate(() => sfuSubscribeVideo('peer-1', undefined));
    expect(trackHits).toBe(0);

    await page.evaluate(() => sfuSubscribeVideo('peer-1', { sessionId: 'only-half' }));
    expect(trackHits).toBe(0);
  });

  test('a remote pull answers Cloudflare\'s offer via /api/sfu-renegotiate', async ({ page }) => {
    await page.goto('/');
    await stubMint(page);
    // Cloudflare describes the track it will forward, so the SUBSCRIBER must
    // answer an offer rather than receive an answer.
    const OFFER_SDP = [
      'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0',
      'a=group:BUNDLE 0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0',
      'a=rtcp-mux', 'a=ice-ufrag:aaaa', 'a=ice-pwd:bbbbbbbbbbbbbbbbbbbbbb',
      'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
      'a=setup:actpass', 'a=mid:0', 'a=sendonly',
      'a=rtpmap:96 VP8/90000', '',
    ].join('\r\n');
    await page.route('**/api/sfu-track', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'cf-sub-sess',
        sessionDescription: { type: 'offer', sdp: OFFER_SDP },
        requiresImmediateRenegotiation: true,
        tracks: [],
      }),
    }));
    let renegotiated = null;
    await page.route('**/api/sfu-renegotiate', (route) => {
      renegotiated = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await seedRoom(page, {
      selfId: 'self', isHost: true, roomCode: 'self',
      connections: [{ id: 'peer-1', pseudo: 'p1', open: true }],
    });
    await page.evaluate(() =>
      sfuSubscribeVideo('peer-1', { sessionId: 'cf-publisher-sess', trackName: 'peer-1-video' }));

    expect(renegotiated, 'an offer with requiresImmediateRenegotiation must be answered').not.toBeNull();
    expect(renegotiated.sessionId).toBe('cf-sub-sess');
    expect(renegotiated.answer).toContain('v=0');
  });
});

// Migrating an ALREADY-RUNNING share when the roster crosses the threshold.
//
// Before this existed, only new joiners ever got the SFU: someone who started
// sharing in a 2-person room stayed on the mesh for the life of the call, no
// matter how large it grew — exactly the case the relay exists for. Migration
// is not the same problem as the initial decision, because the losing path has
// to be torn down on both the publisher and every viewer; leaving it up means
// two live streams for one track, which is strictly worse than not migrating.
test.describe('topology migration — existing participants, not just joiners', () => {
  function stubMint(page) {
    return page.route('**/api/sfu-session', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ capability: 'fake.capability', expires_at: new Date(Date.now() + 300e3).toISOString(), sfu_app_id: 'app1' }),
    }));
  }

  // A room seeded with `peerCount` peers and a live P2P camera share, with
  // peer.call stubbed so the mesh branch works without a real PeerJS Peer. The
  // stub records closes, which is what the migration has to actually perform.
  async function seedSharingRoom(page, peerCount) {
    const connections = [];
    for (let i = 0; i < peerCount; i++) connections.push({ id: 'peer-' + i, pseudo: 'p' + i, open: true });
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self', connections });
    await page.evaluate(() => {
      window.__peerCallCount = 0;
      window.__peerCallClosed = 0;
      peer.call = function() {
        window.__peerCallCount++;
        return { on() {}, close() { window.__peerCallClosed++; } };
      };
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      localVideoStream = canvas.captureStream(5);
      localVideoActive = true;
    });
  }

  test('crossing the threshold migrates a live share onto the SFU and closes the mesh calls', async ({ page }) => {
    await page.goto('/');
    await stubMint(page);
    let publishBody = null;
    let sawPublish;
    const publishReached = new Promise((resolve) => { sawPublish = resolve; });
    await page.route('**/api/sfu-track', (route) => {
      publishBody = route.request().postDataJSON();
      sawPublish();
      route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
    });
    // Two participants total: under the threshold, so this share starts on the mesh.
    await seedSharingRoom(page, 1);
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'allow-sfu'));
    await page.evaluate(() => publishLocalTrack('video', localVideoStream));
    expect(await page.evaluate(() => _localVideoTopology.video.mode)).toBe('p2p');
    expect(await page.evaluate(() => window.__peerCallCount)).toBe(1);

    // A third participant arrives.
    await page.evaluate(() => {
      connections.set('peer-late', { data: { open: true, closed: false, send() {}, close() {} }, pseudo: 'late' });
    });
    // reconcileVideoTopology() fires the SFU publish without returning its
    // promise, so wait on the route handler itself rather than assuming the
    // request has already landed.
    await page.evaluate(() => reconcileVideoTopology());
    await publishReached;

    expect(publishBody, 'the migration must attempt an SFU publish').not.toBeNull();
    expect(publishBody.action).toBe('publish');
    // The load-bearing half: the mesh calls it was already making are closed.
    // Leaving them open means uploading N direct streams AND one to the relay.
    expect(await page.evaluate(() => window.__peerCallClosed)).toBe(1);
  });

  test('p2p-only never migrates, no matter how large the room gets', async ({ page }) => {
    await page.goto('/');
    let sfuHits = 0;
    await page.route('**/api/sfu-session', (route) => { sfuHits++; route.abort(); });
    await seedSharingRoom(page, 1);
    await page.evaluate(() => localStorage.setItem('video-routing-mode', 'p2p-only'));
    await page.evaluate(() => publishLocalTrack('video', localVideoStream));

    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        connections.set('flood-' + i, { data: { open: true, closed: false, send() {}, close() {} }, pseudo: 'f' + i });
      }
    });
    await page.evaluate(() => reconcileVideoTopology());

    expect(sfuHits).toBe(0);
    expect(await page.evaluate(() => _localVideoTopology.video.mode)).toBe('p2p');
  });

  test('a roster change schedules a reconcile; an unchanged count does not', async ({ page }) => {
    await page.goto('/');
    await seedSharingRoom(page, 1);
    await page.evaluate(() => {
      window.__reconciles = 0;
      window.__realReconcile = reconcileVideoTopology;
      reconcileVideoTopology = function() { window.__reconciles++; };
      resetRosterReconcileState();
    });

    // First call establishes the baseline count; a repeat at the same count is
    // a no-op, which is what keeps this cheap on the many updatePeerList()
    // calls that are about talking state rather than membership.
    await page.evaluate(() => { reconcileVideoTopologyForRoster(); reconcileVideoTopologyForRoster(); });
    await page.evaluate(() => {
      connections.set('peer-late', { data: { open: true, closed: false, send() {}, close() {} }, pseudo: 'late' });
      reconcileVideoTopologyForRoster();
    });
    await page.waitForTimeout(2000); // past ROSTER_RECONCILE_DEBOUNCE_MS
    // Debounced: the burst collapses into a single reconcile.
    expect(await page.evaluate(() => window.__reconciles)).toBe(1);
  });
});

// Viewer side of the same migration. A re-announced video-offer may mean the
// publisher moved the track between the mesh and the relay mid-call, so
// whatever was carrying it before has to go — otherwise the viewer holds two
// live streams for one track and renders whichever arrived last.
test.describe('applyRemoteTrackTopology — viewer-side migration', () => {
  async function seedViewer(page, existingMedia) {
    await seedRoom(page, {
      selfId: 'self', isHost: false, roomCode: 'host-1',
      connections: [{ id: 'peer-1', pseudo: 'p1', open: true }],
    });
    await page.evaluate((media) => {
      window.__oldMediaClosed = 0;
      const conn = connections.get('peer-1');
      conn.videoMedia = { peerConnection: {}, close() { window.__oldMediaClosed++; } };
      conn.videoTopology = media.topology;
      if (media.providerRef) _rememberProviderRef('peer-1', 'video', media.providerRef);
      window.__subscribes = [];
      sfuSubscribeVideo = function(id, ref) { window.__subscribes.push({ id, ref }); };
    }, existingMedia);
  }

  test('p2p -> sfu drops the incoming mesh stream before subscribing', async ({ page }) => {
    await page.goto('/');
    await seedViewer(page, { topology: { mode: 'p2p', reason: 'ok' } });
    await page.evaluate(() =>
      applyRemoteTrackTopology('peer-1', 'video', 'sfu', { sessionId: 'cf-1', trackName: 'peer-1-video' }));

    expect(await page.evaluate(() => window.__oldMediaClosed)).toBe(1);
    expect(await page.evaluate(() => connections.get('peer-1').videoTopology.mode)).toBe('sfu');
    expect(await page.evaluate(() => window.__subscribes.length)).toBe(1);
  });

  test('sfu -> p2p unsubscribes and opens nothing itself', async ({ page }) => {
    await page.goto('/');
    await seedViewer(page, {
      topology: { mode: 'sfu', reason: 'preference-allow-sfu' },
      providerRef: { sessionId: 'cf-1', trackName: 'peer-1-video' },
    });
    await page.evaluate(() => applyRemoteTrackTopology('peer-1', 'video', 'p2p', undefined));

    expect(await page.evaluate(() => window.__oldMediaClosed)).toBe(1);
    expect(await page.evaluate(() => connections.get('peer-1').videoTopology.mode)).toBe('p2p');
    // The publisher's MediaConnection arrives on its own via peer.on('call').
    expect(await page.evaluate(() => window.__subscribes.length)).toBe(0);
  });

  test('an unchanged re-announcement does not churn a healthy subscription', async ({ page }) => {
    // sfuRenegotiatePublish() re-announces on every republish. Tearing down a
    // working subscription on that would drop video for no reason at all.
    await page.goto('/');
    await seedViewer(page, {
      topology: { mode: 'sfu', reason: 'preference-allow-sfu' },
      providerRef: { sessionId: 'cf-1', trackName: 'peer-1-video' },
    });
    await page.evaluate(() =>
      applyRemoteTrackTopology('peer-1', 'video', 'sfu', { sessionId: 'cf-1', trackName: 'peer-1-video' }));

    expect(await page.evaluate(() => window.__oldMediaClosed)).toBe(0);
    expect(await page.evaluate(() => window.__subscribes.length)).toBe(0);
  });

  test('a NEW provider ref for the same peer does resubscribe', async ({ page }) => {
    // A republish mints a new Cloudflare session, so the old {sessionId,
    // trackName} no longer exists — continuing to pull it is a black tile.
    await page.goto('/');
    await seedViewer(page, {
      topology: { mode: 'sfu', reason: 'preference-allow-sfu' },
      providerRef: { sessionId: 'cf-1', trackName: 'peer-1-video' },
    });
    await page.evaluate(() =>
      applyRemoteTrackTopology('peer-1', 'video', 'sfu', { sessionId: 'cf-2', trackName: 'peer-1-video' }));

    expect(await page.evaluate(() => window.__oldMediaClosed)).toBe(1);
    expect(await page.evaluate(() => window.__subscribes[0].ref.sessionId)).toBe('cf-2');
  });

  test('an absent or unrecognized topology is read as p2p, never inferred as sfu', async ({ page }) => {
    await page.goto('/');
    await seedViewer(page, { topology: { mode: 'p2p', reason: 'ok' } });
    expect(await page.evaluate(() => applyRemoteTrackTopology('peer-1', 'video', undefined, undefined))).toBe('p2p');
    expect(await page.evaluate(() => applyRemoteTrackTopology('peer-1', 'video', 'RELAY', undefined))).toBe('p2p');
    expect(await page.evaluate(() => window.__subscribes.length)).toBe(0);
  });
});
