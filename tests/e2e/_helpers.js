// Shared helpers for Voxal E2E / in-browser unit tests.
//
// main.js is a flat (non-module) script: its top-level `function` declarations
// and `var`/`let` state live in the page's global scope, so Playwright can call
// the real functions and seed the real module state via page.evaluate. This lets
// us unit-test the pure logic (host election, successor chain, pseudo dedup,
// peer-list building) deterministically, without a bundler or a module refactor
// and without any live PeerJS / WebRTC connections.

/**
 * Seed main.js's room/membership globals to a known state.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   selfId?: string,
 *   isHost?: boolean,
 *   inRoom?: boolean,
 *   roomCode?: string,
 *   knownPeerIds?: string[],
 *   authoritativePeerIds?: string[],
 *   successorIds?: string[],
 *   connections?: Array<{id:string,pseudo?:string,pseudoColor?:string,open?:boolean,videoActive?:boolean,screenActive?:boolean}>,
 *   myPseudo?: string,
 *   anonymousProfile?: {pseudo:string,pseudoColor:string}|null,
 * }} cfg
 */
export async function seedRoom(page, cfg = {}) {
  await page.evaluate((c) => {
    // eslint-disable-next-line no-undef
    peer = { id: c.selfId || 'self', destroyed: false };
    // eslint-disable-next-line no-undef
    isHost = !!c.isHost;
    // eslint-disable-next-line no-undef
    inRoom = c.inRoom !== false;
    // eslint-disable-next-line no-undef
    roomCode = c.roomCode || (c.isHost ? c.selfId : c.hostId) || '';

    // eslint-disable-next-line no-undef
    knownPeerIds.clear();
    // eslint-disable-next-line no-undef
    (c.knownPeerIds || []).forEach((id) => knownPeerIds.add(id));

    // eslint-disable-next-line no-undef
    connections.clear();
    (c.connections || []).forEach((entry) => {
      const open = entry.open !== false;
      // eslint-disable-next-line no-undef
      connections.set(entry.id, {
        data: { open, closed: !open, send() {} },
        pseudo: entry.pseudo,
        pseudoColor: entry.pseudoColor,
        videoActive: entry.videoActive,
        screenActive: entry.screenActive,
      });
    });

    // _lastAuthoritativePeerIds (drives authoritativeElectionCandidates). Falls
    // back to knownPeerIds when an explicit snapshot is not provided.
    // eslint-disable-next-line no-undef
    resetAuthoritativePeerIds(c.authoritativePeerIds || c.knownPeerIds || []);
    // eslint-disable-next-line no-undef
    setAuthoritativeSuccessorIds(c.successorIds || []);

    // eslint-disable-next-line no-undef
    if (c.myPseudo !== undefined) myPseudo = c.myPseudo;
    // eslint-disable-next-line no-undef
    if (c.anonymousProfile !== undefined) _anonymousProfile = c.anonymousProfile;
  }, cfg);
}

/**
 * Call a global function from main.js by name with JSON-serializable args.
 * main.js's top-level `function` declarations attach to `window` in a classic
 * (non-module) script, so window[name] resolves the real implementation.
 */
export function callFn(page, name, ...args) {
  return page.evaluate(
    ({ name, args }) => window[name](...args),
    { name, args }
  );
}
