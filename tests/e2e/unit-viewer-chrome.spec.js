import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Odds and ends around watching someone's camera or screen: the three buttons
// on each viewer panel, whether the flip-camera control is worth offering at
// all, and the name you get back when you leave a room that renamed you.

/** Give a peer a live camera or screen stream and open its viewer. */
async function seedStream(page, kind = 'video') {
  await seedRoom(page, {
    selfId: 'self',
    isHost: false,
    roomCode: 'host-1',
    connections: [{ id: 'peer-1', pseudo: 'Alice' }],
  });
  await page.evaluate((kind) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    canvas.getContext('2d').fillRect(0, 0, 320, 240);
    const stream = canvas.captureStream(5);
    const conn = connections.get('peer-1');
    if (kind === 'screen') conn.remoteScreenStream = stream;
    else conn.remoteVideoStream = stream;
  }, kind);
}

/** Record what the page asks of the Fullscreen API without actually going full screen. */
async function stubFullscreen(page) {
  await page.evaluate(() => {
    window.__fs = { requests: [], exits: 0, element: null };
    Object.defineProperty(document, 'fullscreenElement', {
      get: () => window.__fs.element,
      configurable: true,
    });
    document.exitFullscreen = () => { window.__fs.exits++; window.__fs.element = null; return Promise.resolve(); };
    Element.prototype.requestFullscreen = function () {
      window.__fs.requests.push(this.id);
      window.__fs.element = this;
      return Promise.resolve();
    };
  });
}

const click = (page, id) => page.evaluate((i) => document.getElementById(i).click(), id);

test.describe('the camera viewer\'s buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await seedStream(page, 'video');
    await stubFullscreen(page);
  });

  test('close hides the panel and forgets who was being watched', async ({ page }) => {
    await page.evaluate(() => window.openVideoViewer('peer-1'));
    await click(page, 'video-viewer-close');

    const state = await page.evaluate(() => ({
      hidden: document.getElementById('video-viewer-panel').classList.contains('hidden'),
      src: document.getElementById('video-viewer-element').srcObject,
      viewer: window._videoViewerPeerId,
    }));

    expect(state.hidden).toBe(true);
    // The <video> must let go of the stream, or it keeps decoding off-screen.
    expect(state.src).toBe(null);
    expect(state.viewer).toBe(null);
  });

  test('maximize asks for fullscreen on the panel', async ({ page }) => {
    await page.evaluate(() => window.openVideoViewer('peer-1'));
    await click(page, 'video-viewer-maximize');

    expect(await page.evaluate(() => window.__fs.requests)).toEqual(['video-viewer-panel']);
  });

  test('maximize again leaves fullscreen rather than asking twice', async ({ page }) => {
    await page.evaluate(() => window.openVideoViewer('peer-1'));
    await click(page, 'video-viewer-maximize');
    await click(page, 'video-viewer-maximize');

    const fs = await page.evaluate(() => window.__fs);
    expect(fs.requests).toHaveLength(1);
    expect(fs.exits).toBe(1);
  });

  test('minimize hands off to the pop-out', async ({ page }) => {
    // The listener holds a direct reference to popOutVideoViewer, so this
    // asserts the pop-out's effect rather than intercepting the call.
    const pip = await page.evaluate(async () => {
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => Promise.resolve({});
      window.openVideoViewer('peer-1');
      document.getElementById('video-viewer-minimize').click();
      await new Promise((r) => setTimeout(r, 0));
      return document.getElementById('video-viewer-panel').classList.contains('pip-active');
    });

    expect(pip).toBe(true);
  });

  test('closing while full screen also leaves full screen', async ({ page }) => {
    await page.evaluate(() => window.openVideoViewer('peer-1'));
    await click(page, 'video-viewer-maximize');
    await click(page, 'video-viewer-close');

    expect(await page.evaluate(() => window.__fs.exits)).toBe(1);
  });
});

test.describe('the screen viewer\'s buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await seedStream(page, 'screen');
    await stubFullscreen(page);
  });

  test('close hides the panel and releases the stream', async ({ page }) => {
    await page.evaluate(() => window.openScreenViewer('peer-1'));
    await click(page, 'screen-viewer-close');

    const state = await page.evaluate(() => ({
      hidden: document.getElementById('screen-viewer-panel').classList.contains('hidden'),
      src: document.getElementById('screen-viewer-element').srcObject,
      viewer: window._screenViewerPeerId,
    }));

    expect(state).toEqual({ hidden: true, src: null, viewer: null });
  });

  test('maximize toggles fullscreen on its own panel, not the camera\'s', async ({ page }) => {
    await page.evaluate(() => window.openScreenViewer('peer-1'));
    await click(page, 'screen-viewer-maximize');
    expect(await page.evaluate(() => window.__fs.requests)).toEqual(['screen-viewer-panel']);

    await click(page, 'screen-viewer-maximize');
    expect(await page.evaluate(() => window.__fs.exits)).toBe(1);
  });

  test('minimize hands off to the screen pop-out', async ({ page }) => {
    const pip = await page.evaluate(async () => {
      const vid = document.getElementById('screen-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => Promise.resolve({});
      window.openScreenViewer('peer-1');
      document.getElementById('screen-viewer-minimize').click();
      await new Promise((r) => setTimeout(r, 0));
      return document.getElementById('screen-viewer-panel').classList.contains('pip-active');
    });

    expect(pip).toBe(true);
  });
});

test.describe('cameraFlipAvailable', () => {
  const ask = (page) => page.evaluate(() => window.cameraFlipAvailable());

  async function stubDevices(page, devices) {
    await page.evaluate((devices) => {
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve(devices);
    }, devices);
  }

  test('is offered on a phone with two cameras', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
      });
    });
    await page.goto('/');
    await stubDevices(page, [{ kind: 'videoinput' }, { kind: 'videoinput' }, { kind: 'audioinput' }]);

    expect(await ask(page)).toBe(true);
  });

  test('is not offered on a phone with only one camera', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile',
        configurable: true,
      });
    });
    await page.goto('/');
    await stubDevices(page, [{ kind: 'videoinput' }, { kind: 'audioinput' }]);

    expect(await ask(page)).toBe(false);
  });

  test('is never offered on a desktop — a second webcam is not a "flip"', async ({ page }) => {
    await page.goto('/');
    await stubDevices(page, [{ kind: 'videoinput' }, { kind: 'videoinput' }]);

    expect(await ask(page)).toBe(false);
  });

  test('a device enumeration that fails answers no, rather than throwing', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile',
        configurable: true,
      });
    });
    await page.goto('/');
    await page.evaluate(() => {
      navigator.mediaDevices.enumerateDevices = () => Promise.reject(new Error('permission denied'));
    });

    expect(await ask(page)).toBe(false);
  });
});

test.describe('a room-forced rename is undone on the way out', () => {
  test('a manual name is restored when leaving', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, myPseudo: 'Alice 2' });

    const after = await page.evaluate(async () => {
      peer = { id: 'self', destroyed: false, destroy() { this.destroyed = true; } };
      // What announcePseudoChange() records when the room already had an Alice.
      _preRenameMyPseudo = 'Alice';
      await leaveRoom();
      return { pseudo: myPseudo, marker: _preRenameMyPseudo };
    });

    expect(after.pseudo).toBe('Alice');
    expect(after.marker).toBe(null);
  });

  test('an anonymous name is restored to the one it was assigned', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      myPseudo: '',
      anonymousProfile: { pseudo: 'Azure Fox 2', pseudoColor: '#3b82f6' },
    });

    const after = await page.evaluate(async () => {
      peer = { id: 'self', destroyed: false, destroy() { this.destroyed = true; } };
      _preRenameAnonPseudo = 'Azure Fox';
      await leaveRoom();
      return { pseudo: _anonymousProfile.pseudo, marker: _preRenameAnonPseudo };
    });

    expect(after.pseudo).toBe('Azure Fox');
    expect(after.marker).toBe(null);
  });

  test('a name that was never forced is left exactly as the user typed it', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, myPseudo: 'Alice' });

    const pseudo = await page.evaluate(async () => {
      peer = { id: 'self', destroyed: false, destroy() { this.destroyed = true; } };
      _preRenameMyPseudo = null;
      await leaveRoom();
      return myPseudo;
    });

    expect(pseudo).toBe('Alice');
  });
});
