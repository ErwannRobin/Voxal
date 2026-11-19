import { test, expect } from './fixtures.js';

// WebMCP: the page registers its room tools on navigator.modelContext so a
// browser agent can start / join / leave a room for the person it works for.
// The tools press the same buttons a person would — these pin the names the
// agent skill (src/.well-known/agent-skills/join-voice-room/SKILL.md) and
// llms.txt promise, and that a tool goes through the UI rather than around it.

const TOOL_NAMES = ['create_voice_room', 'join_voice_room', 'get_room_status', 'leave_voice_room'];

async function withModelContext(page, api = 'registerTool') {
  await page.addInitScript((kind) => {
    window.__webmcpTools = {};
    const mc = {};
    if (kind === 'registerTool') mc.registerTool = (t) => { window.__webmcpTools[t.name] = t; };
    else mc.provideContext = ({ tools }) => { tools.forEach((t) => { window.__webmcpTools[t.name] = t; }); };
    Object.defineProperty(navigator, 'modelContext', { value: mc, configurable: true });
  }, api);
  await page.goto('/');
}

async function callTool(page, name, input) {
  return page.evaluate(async ([n, i]) => {
    const out = await window.__webmcpTools[n].execute(i || {});
    return JSON.parse(out.content[0].text);
  }, [name, input]);
}

test.describe('WebMCP tools', () => {
  test('registers every documented tool via registerTool', async ({ page }) => {
    await withModelContext(page, 'registerTool');
    const names = await page.evaluate(() => Object.keys(window.__webmcpTools).sort());
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  test('falls back to provideContext on the older API', async ({ page }) => {
    await withModelContext(page, 'provideContext');
    const names = await page.evaluate(() => Object.keys(window.__webmcpTools).sort());
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  test('is a no-op without navigator.modelContext', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    expect(await page.evaluate(() => 'modelContext' in navigator)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('get_room_status reports no room on the home screen', async ({ page }) => {
    await withModelContext(page);
    expect(await callTool(page, 'get_room_status')).toEqual({ in_room: false });
  });

  test('join_voice_room refuses an empty code without touching the UI', async ({ page }) => {
    await withModelContext(page);
    const res = await callTool(page, 'join_voice_room', { room: '   ' });
    expect(res.in_room).toBe(false);
    expect(res.error).toMatch(/No room code/);
  });

  test('join_voice_room goes through the Join button with the normalised code', async ({ page }) => {
    await withModelContext(page);
    // Swallow the click before the app's own handler, so no network join starts:
    // what is under test is that the tool drives the UI, not PeerJS.
    await page.evaluate(() => {
      window.__joinClicks = [];
      window.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'btn-join') {
          window.__joinClicks.push(document.getElementById('input-code').value);
          e.stopPropagation();
        }
      }, true);
    });
    const res = await callTool(page, 'join_voice_room', { room: 'https://web.voxal.app/?room=team-standup&video=1' });
    expect(await page.evaluate(() => window.__joinClicks)).toEqual(['team-standup']);
    expect(res.in_room).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
