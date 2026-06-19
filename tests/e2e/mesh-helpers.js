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
    incomingAudio:
      typeof connections !== 'undefined'
        ? Array.from(connections.values()).filter((c) => c && c.media).length
        : 0,
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

/** Number of participant rows rendered in the peer list (self + others). */
export function rosterCount(page) {
  return page.locator('#peers-list .peer-item').count();
}

/** Rendered peer-list text, for asserting name propagation. */
export function rosterText(page) {
  return page.locator('#peers-list').innerText();
}
