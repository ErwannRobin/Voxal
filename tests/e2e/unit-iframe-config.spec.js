import { test, expect } from './fixtures.js';

// Embedding pages can push their own ICE/TURN servers into the iframe via
// postMessage {type:'config', iceServers:[...]}. They take precedence over every
// other source, are kept in memory only, and the message is origin-validated
// (the embed must declare ?parentOrigin and the message must come from it).

test.describe('iframe config: applyIframeConfig + precedence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('supplied ICE servers take precedence in fetchIceServers', async ({ page }) => {
    const urls = await page.evaluate(async () => {
      applyIframeConfig({ type: 'config', iceServers: [{ urls: 'turn:embed.example:443?transport=tcp', username: 'u', credential: 'p' }] });
      return (await fetchIceServers()).map((s) => s.urls);
    });
    expect(urls).toEqual(['turn:embed.example:443?transport=tcp']);
  });

  test('an empty iceServers array clears the override', async ({ page }) => {
    const usesFallback = await page.evaluate(async () => {
      applyIframeConfig({ type: 'config', iceServers: [{ urls: 'turn:embed.example:443' }] });
      applyIframeConfig({ type: 'config', iceServers: [] });
      const urls = (await fetchIceServers()).map((s) => s.urls);
      return urls.some((u) => u.startsWith('stun:')); // back to the normal fallback
    });
    expect(usesFallback).toBe(true);
  });

  test('non-object / url-less entries are filtered out', async ({ page }) => {
    const urls = await page.evaluate(async () => {
      applyIframeConfig({ type: 'config', iceServers: ['nope', 42, {}, { foo: 'bar' }, { urls: 'turn:ok:443' }] });
      return (await fetchIceServers()).map((s) => s.urls);
    });
    expect(urls).toEqual(['turn:ok:443']);
  });
});

test.describe('iframe config: origin-gated postMessage channel', () => {
  // Spin up the app inside a same-origin child iframe so its _isIframe message
  // listener is active, then post config from this (parent) page.
  async function embed(page, query) {
    await page.goto('/');
    const name = 'vox-' + Math.random().toString(36).slice(2, 8);
    await page.evaluate(
      ({ name, query }) =>
        new Promise((resolve) => {
          const f = document.createElement('iframe');
          f.name = name;
          f.allow = 'camera; microphone';
          f.src = '/' + (query || '');
          f.addEventListener('load', () => resolve());
          document.body.appendChild(f);
        }),
      { name, query }
    );
    const frame = page.frame({ name });
    await expect.poll(async () => frame.evaluate(() => typeof fetchIceServers)).toBe('function');
    return { frame, name };
  }

  function postConfig(page, name, urls) {
    return page.evaluate(
      ({ name, urls }) => {
        document.querySelector(`iframe[name="${name}"]`).contentWindow.postMessage(
          { type: 'config', iceServers: [{ urls, username: 'u', credential: 'p' }] },
          '*'
        );
      },
      { name, urls }
    );
  }

  test('config from the allowed (same) origin is applied', async ({ page }) => {
    const { frame, name } = await embed(page, ''); // no parentOrigin → allowed = own origin
    await postConfig(page, name, 'turn:allowed.example:443?transport=tcp');
    await expect
      .poll(async () => frame.evaluate(async () => (await fetchIceServers()).map((s) => s.urls)))
      .toEqual(['turn:allowed.example:443?transport=tcp']);
  });

  test('config from a disallowed origin is ignored', async ({ page }) => {
    // The embed declares a different parent origin, so a message from THIS page
    // (127.0.0.1) must be rejected.
    const { frame, name } = await embed(page, '?parentOrigin=https://not-the-parent.example');
    await postConfig(page, name, 'turn:evil.example:443');
    await page.waitForTimeout(300); // allow the (ignored) message to be processed
    const urls = await frame.evaluate(async () => (await fetchIceServers()).map((s) => s.urls));
    expect(urls.some((u) => u.includes('evil.example'))).toBe(false);
  });

  test('a declared parentOrigin also gates other commands (auth rejected)', async ({ page }) => {
    const { frame, name } = await embed(page, '?parentOrigin=https://not-the-parent.example');
    await page.evaluate((name) => {
      document.querySelector(`iframe[name="${name}"]`).contentWindow.postMessage({ type: 'auth', token: 'INJECTED' }, '*');
    }, name);
    await page.waitForTimeout(300);
    const token = await frame.evaluate(() => localStorage.getItem('presence-api-token'));
    expect(token).not.toBe('INJECTED');
  });
});
