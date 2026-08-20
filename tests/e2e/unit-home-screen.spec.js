import { test, expect } from './fixtures.js';
import { callFn } from './_helpers.js';

// The home screen: the two CTAs and the guard that stops them racing each
// other, the room-code field, the clipboard/share helpers behind the invite
// buttons, and the metered.ca credential test in Settings → Advanced.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    // Stand in for the two flows the buttons drive; both do real network work.
    window.__createCalls = 0;
    window.__joinCalls = [];
    window.__createResult = Promise.resolve();
    window.__joinResult = Promise.resolve();
    window.createRoom = () => { window.__createCalls++; return window.__createResult; };
    window.joinRoom = (code) => { window.__joinCalls.push(['joinRoom', code]); return window.__joinResult; };
    window.joinOrCreateByChannelName = (name) => {
      window.__joinCalls.push(['byName', name]);
      return window.__joinResult;
    };
    endHomeAction();
  });
});

test.describe('the Create Room button', () => {
  test('starts a room and locks the other CTAs while it runs', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      let release;
      window.__createResult = new Promise((r) => { release = r; });
      document.getElementById('btn-create').click();
      const during = {
        calls: window.__createCalls,
        inputDisabled: document.getElementById('input-code').disabled,
        label: document.getElementById('btn-create').textContent,
      };
      release();
      await new Promise((r) => setTimeout(r, 20));
      return { during, after: { inputDisabled: document.getElementById('input-code').disabled } };
    });
    expect(seen.during.calls).toBe(1);
    expect(seen.during.inputDisabled).toBe(true);
    expect(seen.during.label).toContain('Create Room');
    expect(seen.after.inputDisabled).toBe(false);
  });

  test('a second click while the first is in flight is ignored', async ({ page }) => {
    const calls = await page.evaluate(async () => {
      let release;
      window.__createResult = new Promise((r) => { release = r; });
      document.getElementById('btn-create').click();
      document.getElementById('btn-create').click();
      const during = window.__createCalls;
      release();
      await new Promise((r) => setTimeout(r, 20));
      return during;
    });
    expect(calls).toBe(1);
  });

  test('a failure is reported and the CTAs come back', async ({ page }) => {
    await page.evaluate(async () => {
      window.__createResult = Promise.reject(new Error('broker unreachable'));
      document.getElementById('btn-create').click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await page.locator('#error-message').textContent()).toBe('broker unreachable');
    expect(await page.evaluate(() => document.getElementById('input-code').disabled)).toBe(false);
  });
});

test.describe('the Join button', () => {
  test('a UUID goes straight to joinRoom, a name goes through create-or-join', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      document.getElementById('input-code').value = uuid;
      document.getElementById('btn-join').click();
      await new Promise((r) => setTimeout(r, 20));
      endHomeAction();
      document.getElementById('input-code').value = 'happy-otter';
      document.getElementById('btn-join').click();
      await new Promise((r) => setTimeout(r, 20));
      return window.__joinCalls;
    });
    expect(seen).toEqual([
      ['joinRoom', '11111111-2222-3333-4444-555555555555'],
      ['byName', 'happy-otter'],
    ]);
  });

  test('while connecting it turns into Cancel, and cancelling says so', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      let cancelled = false;
      window.__joinResult = new Promise(() => {}); // never settles
      document.getElementById('input-code').value = 'happy-otter';
      const btn = document.getElementById('btn-join');
      btn.click();
      _cancelJoin = () => { cancelled = true; };
      const during = btn.textContent;
      btn.click(); // second click acts as Cancel
      return { during, cancelled, hook: _cancelJoin };
    });
    expect(seen.during).toContain('Cancel');
    expect(seen.cancelled).toBe(true);
    expect(seen.hook).toBe(null);
  });

  test('a cancelled join is a toast, not an error screen', async ({ page }) => {
    await page.evaluate(async () => {
      window.__joinResult = Promise.reject(new Error('Connection cancelled.'));
      document.getElementById('input-code').value = 'happy-otter';
      document.getElementById('btn-join').click();
      await new Promise((r) => setTimeout(r, 30));
    });
    await expect(page.locator('#copy-toast')).toHaveText('Connection cancelled');
    expect(await page.evaluate(() =>
      document.getElementById('screen-error').classList.contains('active'))).toBe(false);
  });

  test('a real failure surfaces the message', async ({ page }) => {
    await page.evaluate(async () => {
      window.__joinResult = Promise.reject(new Error('Room not found or host is unreachable.'));
      document.getElementById('input-code').value = 'happy-otter';
      document.getElementById('btn-join').click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await page.locator('#error-message').textContent())
      .toBe('Room not found or host is unreachable.');
  });
});

test.describe('the room-code field', () => {
  test('Enter is the same as pressing Join', async ({ page }) => {
    const joins = await page.evaluate(async () => {
      const input = document.getElementById('input-code');
      input.value = 'happy-otter';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
      return window.__joinCalls;
    });
    expect(joins).toEqual([['byName', 'happy-otter']]);
  });

  test('a pasted invite URL is reduced to the room code', async ({ page }) => {
    const value = await page.evaluate(async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      const input = document.getElementById('input-code');
      input.value = 'https://ptt.voxal.app/?room=' + uuid;
      input.dispatchEvent(new Event('paste', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      return input.value;
    });
    expect(value).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('leaving the field normalises it too', async ({ page }) => {
    const value = await page.evaluate(() => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      const input = document.getElementById('input-code');
      input.value = '  ' + uuid + '  ';
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return input.value;
    });
    expect(value).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('the clear button empties it', async ({ page }) => {
    const value = await page.evaluate(() => {
      const input = document.getElementById('input-code');
      input.value = 'something';
      clearRoomCodeInput();
      return input.value;
    });
    expect(value).toBe('');
  });
});

test.describe('the CTA lock', () => {
  test('locking disables every entry point, unlocking restores them', async ({ page }) => {
    const seen = await page.evaluate(() => {
      lockHomeCTAs();
      const locked = {
        create: document.getElementById('btn-create').disabled,
        input: document.getElementById('input-code').disabled,
        channels: document.getElementById('channels-list').getAttribute('aria-disabled'),
      };
      unlockHomeCTAs();
      return {
        locked,
        unlocked: {
          create: document.getElementById('btn-create').disabled,
          input: document.getElementById('input-code').disabled,
          channels: document.getElementById('channels-list').getAttribute('aria-disabled'),
        },
      };
    });
    expect(seen.locked).toEqual({ create: true, input: true, channels: 'true' });
    expect(seen.unlocked).toEqual({ create: false, input: false, channels: null });
  });

  test('beginHomeAction admits one caller at a time', async ({ page }) => {
    const seen = await page.evaluate(() => {
      endHomeAction();
      const first = beginHomeAction();
      const second = beginHomeAction();
      endHomeAction();
      const third = beginHomeAction();
      endHomeAction();
      return { first, second, third };
    });
    expect(seen).toEqual({ first: true, second: false, third: true });
  });

  test('setLoading swaps the label for a spinner and puts it back', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.textContent = 'Go';
      document.body.appendChild(btn);
      setLoading(btn, true);
      const during = { disabled: btn.disabled, spinner: !!btn.querySelector('.btn-spinner'), text: btn.textContent };
      setLoading(btn, false);
      const after = { disabled: btn.disabled, text: btn.textContent };
      btn.remove();
      return { during, after };
    });
    expect(seen.during).toEqual({ disabled: true, spinner: true, text: 'Go' });
    expect(seen.after).toEqual({ disabled: false, text: 'Go' });
  });

  test('setLoading can be given the label to restore', async ({ page }) => {
    const text = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.textContent = '';
      document.body.appendChild(btn);
      setLoading(btn, true, 'Rejoin');
      const out = btn.textContent;
      btn.remove();
      return out;
    });
    expect(text).toBe('Rejoin');
  });
});

test.describe('copying and sharing', () => {
  test('a successful clipboard write is confirmed', async ({ page }) => {
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.resolve();
      copyTextToClipboard('room-x', 'Room code copied!');
    });
    await expect(page.locator('#copy-toast')).toHaveText('Room code copied!');
  });

  test('a refused clipboard falls back to the textarea trick', async ({ page }) => {
    await page.evaluate(async () => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
      copyTextToClipboard('room-x', 'Room code copied!');
      await new Promise((r) => setTimeout(r, 20));
    });
    await expect(page.locator('#copy-toast')).toHaveText('Room code copied!');
  });

  test('a browser with no clipboard API still copies', async ({ page }) => {
    await page.evaluate(() => {
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      copyTextToClipboard('room-x', 'Copied anyway');
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    });
    await expect(page.locator('#copy-toast')).toHaveText('Copied anyway');
  });

  test('fallbackCopy leaves no stray textarea behind', async ({ page }) => {
    const left = await page.evaluate(() => {
      const before = document.querySelectorAll('textarea').length;
      fallbackCopy('anything');
      return document.querySelectorAll('textarea').length - before;
    });
    expect(left).toBe(0);
  });

  test('sharing without a share sheet copies instead', async ({ page }) => {
    await page.evaluate(() => {
      navigator.share = undefined;
      navigator.clipboard.writeText = () => Promise.resolve();
      shareInviteLink('https://ptt.voxal.app/?room=x');
    });
    await expect(page.locator('#copy-toast')).toHaveText('Invite link copied!');
  });

  test('a cancelled share sheet copies nothing', async ({ page }) => {
    const copied = await page.evaluate(async () => {
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      navigator.share = () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      shareInviteLink('https://ptt.voxal.app/?room=x');
      await new Promise((r) => setTimeout(r, 20));
      return seen;
    });
    expect(copied).toEqual([]);
  });

  test('a share blocked by the embed falls back to copying', async ({ page }) => {
    const copied = await page.evaluate(async () => {
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      navigator.share = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
      shareInviteLink('https://ptt.voxal.app/?room=x');
      await new Promise((r) => setTimeout(r, 20));
      return seen;
    });
    expect(copied).toEqual(['https://ptt.voxal.app/?room=x']);
  });

  test('sharing nothing does nothing', async ({ page }) => {
    const copied = await page.evaluate(() => {
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      shareInviteLink('');
      return seen;
    });
    expect(copied).toEqual([]);
  });
});

test.describe('testing metered.ca credentials', () => {
  /** Open settings with every section on screen, as a user would see it. */
  async function openSettings(page) {
    await page.click('#btn-open-settings');
    await page.evaluate(() => {
      document.querySelectorAll('#modal-settings details').forEach((d) => { d.open = true; });
      document.querySelectorAll('#modal-settings .settings-card').forEach((c) => {
        c.classList.remove('is-collapsed');
        c.style.display = 'block';
      });
    });
  }

  test('asks for the credentials before testing anything', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(async () => {
      let fetched = 0;
      window.fetch = () => { fetched++; return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }); };
      document.getElementById('input-metered-app').value = '';
      document.getElementById('input-metered-key').value = '';
      document.getElementById('btn-test-turn').click();
      await new Promise((r) => setTimeout(r, 20));
      return { fetched, status: document.getElementById('turn-test-status').textContent };
    });
    expect(seen).toEqual({ fetched: 0, status: 'Enter app name and API key first.' });
  });

  test('a working key is reported with its server count and cached', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ urls: 'turn:a' }, { urls: 'turn:b' }]),
      });
      document.getElementById('input-metered-app').value = 'myapp';
      document.getElementById('input-metered-key').value = 'k3y';
      document.getElementById('btn-test-turn').click();
      await new Promise((r) => setTimeout(r, 50));
      return {
        status: document.getElementById('turn-test-status').textContent,
        stored: localStorage.getItem('metered-status'),
        count: localStorage.getItem('metered-count'),
        enabled: !document.getElementById('btn-test-turn').disabled,
      };
    });
    expect(seen.status).toBe('✓ 2 servers ready');
    expect(seen.stored).toBe('ok');
    expect(seen.count).toBe('2');
    expect(seen.enabled).toBe(true);
  });

  test('a rejected key is reported as an error, not silently ignored', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) });
      document.getElementById('input-metered-app').value = 'myapp';
      document.getElementById('input-metered-key').value = 'wrong';
      document.getElementById('btn-test-turn').click();
      await new Promise((r) => setTimeout(r, 50));
      return {
        status: document.getElementById('turn-test-status').textContent,
        stored: localStorage.getItem('metered-status'),
        count: localStorage.getItem('metered-count'),
      };
    });
    expect(seen.status).toBe('✕ HTTP 401');
    expect(seen.stored).toBe('error');
    expect(seen.count).toBe(null);
  });

  test('a key that returns no servers is an error too', async ({ page }) => {
    await openSettings(page);
    const status = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      document.getElementById('input-metered-app').value = 'myapp';
      document.getElementById('input-metered-key').value = 'k3y';
      document.getElementById('btn-test-turn').click();
      await new Promise((r) => setTimeout(r, 50));
      return document.getElementById('turn-test-status').textContent;
    });
    expect(status).toBe('✕ No servers returned');
  });
});

test.describe('the relay badge', () => {
  test('its popover opens on click and closes again', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const badge = document.getElementById('turn-badge');
      badge.click();
      const opened = !document.getElementById('conn-status-popover').classList.contains('hidden');
      badge.click();
      return { opened, closed: document.getElementById('conn-status-popover').classList.contains('hidden') };
    });
    expect(seen).toEqual({ opened: true, closed: true });
  });

  test('the keyboard opens it too', async ({ page }) => {
    const opened = await page.evaluate(() => {
      const badge = document.getElementById('turn-badge');
      badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return !document.getElementById('conn-status-popover').classList.contains('hidden');
    });
    expect(opened).toBe(true);
  });
});

test.describe('relay configuration', () => {
  test('the built-in fallback is used until one is configured', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.removeItem('turn-fallback');
      const dflt = fallbackTurnServers().length;
      localStorage.setItem('turn-fallback', '[]');
      const disabled = fallbackTurnServers().length;
      localStorage.setItem('turn-fallback', '{not json');
      const corrupted = fallbackTurnServers().length;
      localStorage.removeItem('turn-fallback');
      return { dflt, disabled, corrupted };
    });
    expect(seen.dflt).toBeGreaterThan(0);
    expect(seen.disabled).toBe(0);
    // A corrupt override must never leave the app with no relay at all.
    expect(seen.corrupted).toBe(seen.dflt);
  });

  test('fallbackIceServers always includes public STUN', async ({ page }) => {
    const urls = await page.evaluate(() => {
      localStorage.setItem('turn-fallback', '[]');
      const out = fallbackIceServers().map((s) => s.urls);
      localStorage.removeItem('turn-fallback');
      return out;
    });
    expect(urls.some((u) => String(u).startsWith('stun:'))).toBe(true);
  });

  test('countRelayServers counts only relays, in either URL shape', async ({ page }) => {
    expect(await callFn(page, 'countRelayServers', [
      { urls: 'stun:a' },
      { urls: 'turn:b' },
      { urls: ['stun:c', 'turns:d'] },
      { urls: ['stun:e'] },
      null,
    ])).toBe(2);
    expect(await callFn(page, 'countRelayServers', null)).toBe(0);
  });
});
