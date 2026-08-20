import { test, expect } from './fixtures.js';
import { callFn } from './_helpers.js';

// Push-to-talk shortcut handling. The shortcut is stored as a `code`-based
// string ("Ctrl+KeyK", "Space", or a bare modifier like "Alt") and every layer
// — matching a keydown, rendering the hint, re-registering the Tauri global —
// reads it back from that one string, so the parsing has to stay exact.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/** Build the minimal shape of a KeyboardEvent the shortcut helpers read. */
function keyEvent(code, mods = {}) {
  return {
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  };
}

test.describe('isModifierOnly', () => {
  test('recognises the four bare modifiers', async ({ page }) => {
    for (const s of ['Alt', 'Shift', 'Ctrl', 'Meta']) {
      expect(await callFn(page, 'isModifierOnly', s)).toBe(true);
    }
  });

  test('a real key — with or without modifiers — is not modifier-only', async ({ page }) => {
    expect(await callFn(page, 'isModifierOnly', 'Space')).toBe(false);
    expect(await callFn(page, 'isModifierOnly', 'Ctrl+KeyK')).toBe(false);
  });
});

test.describe('shortcutFromEvent', () => {
  test('returns null for a bare modifier keypress', async ({ page }) => {
    for (const code of ['ControlLeft', 'AltRight', 'ShiftLeft', 'MetaRight']) {
      expect(await callFn(page, 'shortcutFromEvent', keyEvent(code))).toBe(null);
    }
  });

  test('a plain key becomes its own code', async ({ page }) => {
    expect(await callFn(page, 'shortcutFromEvent', keyEvent('Space'))).toBe('Space');
  });

  test('modifiers are emitted in Ctrl, Alt, Shift order', async ({ page }) => {
    const sc = await callFn(page, 'shortcutFromEvent',
      keyEvent('KeyK', { ctrl: true, alt: true, shift: true }));
    expect(sc).toBe('Ctrl+Alt+Shift+KeyK');
  });

  test('Meta is folded into Ctrl so one shortcut works on macOS and Windows', async ({ page }) => {
    expect(await callFn(page, 'shortcutFromEvent', keyEvent('KeyK', { meta: true }))).toBe('Ctrl+KeyK');
  });
});

test.describe('keyCodeOf', () => {
  test('takes the bare key from a modified shortcut', async ({ page }) => {
    expect(await callFn(page, 'keyCodeOf', 'Ctrl+Alt+Backquote')).toBe('Backquote');
  });

  test('an unmodified shortcut is its own key', async ({ page }) => {
    expect(await callFn(page, 'keyCodeOf', 'Space')).toBe('Space');
  });
});

test.describe('matchesShortcut', () => {
  test('a bare modifier matches either side of the keyboard', async ({ page }) => {
    await page.evaluate(() => { shortcutStr = 'Alt'; });
    expect(await callFn(page, 'matchesShortcut', keyEvent('AltLeft'))).toBe(true);
    expect(await callFn(page, 'matchesShortcut', keyEvent('AltRight'))).toBe(true);
    expect(await callFn(page, 'matchesShortcut', keyEvent('ControlLeft'))).toBe(false);
  });

  test('an exact modifier combination is required', async ({ page }) => {
    await page.evaluate(() => { shortcutStr = 'Ctrl+Shift+KeyK'; });
    expect(await callFn(page, 'matchesShortcut', keyEvent('KeyK', { ctrl: true, shift: true }))).toBe(true);
    // Meta stands in for Ctrl, exactly as shortcutFromEvent recorded it.
    expect(await callFn(page, 'matchesShortcut', keyEvent('KeyK', { meta: true, shift: true }))).toBe(true);
    // Missing or extra modifiers must not match.
    expect(await callFn(page, 'matchesShortcut', keyEvent('KeyK', { ctrl: true }))).toBe(false);
    expect(await callFn(page, 'matchesShortcut', keyEvent('KeyK', { ctrl: true, shift: true, alt: true }))).toBe(false);
    expect(await callFn(page, 'matchesShortcut', keyEvent('KeyJ', { ctrl: true, shift: true }))).toBe(false);
  });

  test('an unmodified shortcut does not fire while a modifier is held', async ({ page }) => {
    await page.evaluate(() => { shortcutStr = 'Space'; });
    expect(await callFn(page, 'matchesShortcut', keyEvent('Space'))).toBe(true);
    expect(await callFn(page, 'matchesShortcut', keyEvent('Space', { alt: true }))).toBe(false);
  });
});

test.describe('displayShortcut', () => {
  test('renders punctuation codes as the glyph they type', async ({ page }) => {
    expect(await callFn(page, 'displayShortcut', 'Backquote')).toBe('`');
    expect(await callFn(page, 'displayShortcut', 'Semicolon')).toBe(';');
    expect(await callFn(page, 'displayShortcut', 'BracketLeft')).toBe('[');
    expect(await callFn(page, 'displayShortcut', 'BracketRight')).toBe(']');
    expect(await callFn(page, 'displayShortcut', 'Quote')).toBe("'");
    expect(await callFn(page, 'displayShortcut', 'Minus')).toBe('-');
    expect(await callFn(page, 'displayShortcut', 'Equal')).toBe('=');
    expect(await callFn(page, 'displayShortcut', 'Slash')).toBe('/');
    expect(await callFn(page, 'displayShortcut', 'Comma')).toBe(',');
    expect(await callFn(page, 'displayShortcut', 'Period')).toBe('.');
  });

  test('strips the Key / Digit prefixes', async ({ page }) => {
    expect(await callFn(page, 'displayShortcut', 'Ctrl+KeyK')).toBe('Ctrl+K');
    expect(await callFn(page, 'displayShortcut', 'Alt+Digit7')).toBe('Alt+7');
  });

  test('leaves a name with no mapping alone', async ({ page }) => {
    expect(await callFn(page, 'displayShortcut', 'Space')).toBe('Space');
  });
});

test.describe('the shortcut hint', () => {
  test('pttHintHtml wraps the display label and keeps the edit button', async ({ page }) => {
    await page.evaluate(() => { shortcutStr = 'Ctrl+KeyK'; });
    const html = await callFn(page, 'pttHintHtml', 'Hold ', ' to talk');
    expect(html).toContain('<kbd id="shortcut-hint-kbd">Ctrl+K</kbd>');
    expect(html).toContain('id="btn-edit-shortcut"');
    expect(html.startsWith('Hold ')).toBe(true);
    expect(html.endsWith(' to talk')).toBe(true);
  });

  test('updateShortcutDisplay writes the label into every on-screen kbd', async ({ page }) => {
    const label = await page.evaluate(() => {
      shortcutStr = 'Backquote';
      updateShortcutDisplay();
      return document.getElementById('shortcut-hint-kbd').textContent;
    });
    expect(label).toBe('`');
  });

  test('the "focused only" note stays hidden off Tauri, even for a bare modifier', async ({ page }) => {
    const hidden = await page.evaluate(() => {
      shortcutStr = 'Alt';
      updateShortcutDisplay();
      return document.getElementById('shortcut-focused-note').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });
});

test.describe('recording a new shortcut', () => {
  test('start / stop toggles the recording bar and the flag', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const bar = document.getElementById('shortcut-recording');
      startRecordingShortcut();
      const during = { recording: recordingShortcut, hidden: bar.classList.contains('hidden') };
      stopRecordingShortcut();
      const after = { recording: recordingShortcut, hidden: bar.classList.contains('hidden') };
      return { during, after };
    });
    expect(seen.during).toEqual({ recording: true, hidden: false });
    expect(seen.after).toEqual({ recording: false, hidden: true });
  });

  test('applyNewShortcut persists, re-renders and closes the recorder', async ({ page }) => {
    const result = await page.evaluate(() => {
      startRecordingShortcut();
      applyNewShortcut('Ctrl+KeyM');
      return {
        shortcutStr,
        stored: localStorage.getItem('ptt-shortcut'),
        recording: recordingShortcut,
        label: document.getElementById('shortcut-hint-kbd').textContent,
      };
    });
    expect(result).toEqual({
      shortcutStr: 'Ctrl+KeyM',
      stored: 'Ctrl+KeyM',
      recording: false,
      label: 'Ctrl+M',
    });
  });
});

test.describe('shouldIgnorePTTShortcuts', () => {
  test('is true only while the display name is being edited', async ({ page }) => {
    expect(await page.evaluate(() => {
      editingSelfPseudo = false;
      return shouldIgnorePTTShortcuts();
    })).toBe(false);
    expect(await page.evaluate(() => {
      editingSelfPseudo = true;
      const v = shouldIgnorePTTShortcuts();
      editingSelfPseudo = false;
      return v;
    })).toBe(true);
  });
});
