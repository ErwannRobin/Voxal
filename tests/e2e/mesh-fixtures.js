// Fixtures for the multi-peer mesh tests:
//   - `broker`   : a real local PeerServer (peerjs-server), one per worker.
//   - `makePeer` : a factory that opens an isolated browser context + page
//                  pointed at the broker, ready to create/join a room.
//
// Each peer is its own browser context so they have independent localStorage /
// sessionStorage and independent WebRTC stacks — i.e. genuinely separate peers.
// Coverage (when COVERAGE=1) is collected from every peer page, not just the
// default fixture page, so the mesh glue shows up in the report.
import { test as base, expect } from '@playwright/test';
import { PeerServer } from 'peer';
import { randomUUID } from 'node:crypto';
import { startCoverage, addCoverage } from './coverage-util.js';

export const test = base.extend({
  // One broker per worker, on a worker-unique port. generateClientId emits UUIDs
  // so host room codes match the app's UUID_RE and joins take the direct path
  // (no presence / lobby lookup).
  broker: [
    async ({}, use, workerInfo) => {
      const port = 9100 + workerInfo.workerIndex;
      const server = await new Promise((resolve) => {
        const s = PeerServer(
          { port, path: '/', generateClientId: () => randomUUID() },
          () => resolve(s)
        );
      });
      await use({ host: '127.0.0.1', port, path: '/', key: 'peerjs', secure: false });
      await new Promise((resolve) => {
        if (server && typeof server.close === 'function') server.close(() => resolve());
        else resolve();
      });
    },
    { scope: 'worker' },
  ],

  // factory: (opts?) => Page. Tracks every page for coverage + cleanup.
  makePeer: [
    async ({ broker, browser }, use) => {
      const created = [];
      let n = 0;
      const factory = async (opts = {}) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const pseudo = opts.pseudo || 'Peer' + ++n;
        await context.addInitScript(
          (cfg) => {
            localStorage.setItem('peerjs-server', JSON.stringify(cfg.server));
            localStorage.setItem('pseudo', cfg.pseudo);
            sessionStorage.setItem('pseudo', cfg.pseudo);
          },
          { server: broker, pseudo }
        );
        await startCoverage(page);
        await page.goto('/');
        created.push({ context, page });
        return page;
      };

      await use(factory);

      for (const { context, page } of created) {
        try {
          await addCoverage(page);
        } catch {
          /* page may already be closed */
        }
        try {
          await context.close();
        } catch {
          /* already closed */
        }
      }
    },
    { scope: 'test' },
  ],
});

export { expect };
