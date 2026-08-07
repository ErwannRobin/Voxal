import { test, expect } from './fixtures.js';

// RNNoise emits 480-sample frames; AudioWorklet's process() must deliver
// 128-sample blocks. 480 is not a multiple of 128, so the two are permanently
// out of phase even though their long-run RATES match exactly.
//
// The original implementation drained a frame the instant it was produced, reset
// the read pointer on every frame, and zero-filled whenever it ran dry. That
// punched ~5% of the outgoing audio out as silence in ~75 dropouts per second —
// a phase bug, not a CPU one, so it sounded identically choppy on every device
// and only the REMOTE peer could hear it. These tests pin the FIFO arithmetic.
//
// The real src/assets/rnnoise-processor.js is loaded and driven here; only the
// WASM-facing members are stubbed, so the buffering under test is the shipped
// code, not a re-implementation.

const FRAME = 480;
const BLOCK = 128;

async function loadProcessor(page) {
  await page.goto('/');
  const source = await page.evaluate(async () => {
    const res = await fetch('assets/rnnoise-processor.js');
    return res.text();
  });
  await page.evaluate((src) => {
    // The file is an AudioWorklet module: it subclasses AudioWorkletProcessor
    // and hands the class to registerProcessor. Neither exists on the main
    // thread, so provide both and capture the class.
    window.AudioWorkletProcessor = class {
      constructor() { this.port = { postMessage() {}, onmessage: null }; }
    };
    window.registerProcessor = (name, cls) => { window.__RNNoiseClass = cls; };
    // eslint-disable-next-line no-eval
    (0, eval)(src);
  }, source);
}

// Drive `blocks` render quanta through the processor and report what came out.
// The WASM frame call is stubbed to copy input straight to output, so any
// silence in the result is the FIFO's doing and nothing else.
async function runBlocks(page, blocks) {
  return page.evaluate(({ blocks, FRAME, BLOCK }) => {
    const p = new window.__RNNoiseClass();

    // Stub the WASM surface _processFrame reaches for. One shared ArrayBuffer so
    // the real buffer-detach check in _processFrame passes.
    const heap = new Float32Array(4096);
    p._HEAPF32 = heap;
    p._wasmMemory = { buffer: heap.buffer };
    p._wasmInputPtr = 0;
    p._wasmOutputPtr = FRAME * 4;
    p._state = 1;
    p._rnnoise_process_frame = (_state, outPtr, inPtr) => {
      const o = outPtr >> 2, i = inPtr >> 2;
      for (let k = 0; k < FRAME; k++) heap[o + k] = heap[i + k];
    };
    p._ready = true;

    const input = new Float32Array(BLOCK);
    const output = new Float32Array(BLOCK);
    let emitted = 0, zeros = 0, dropouts = 0, prevZero = false;
    let primedAfter = null, warm = false;

    for (let b = 0; b < blocks; b++) {
      // A constant non-zero signal: every zero in the output is then a dropout,
      // never the waveform passing through zero.
      input.fill(0.5);
      output.fill(NaN);
      p.process([[input]], [[output]]);

      for (let k = 0; k < BLOCK; k++) {
        const v = output[k];
        if (v !== 0) { warm = true; if (primedAfter === null) primedAfter = emitted; }
        if (!warm) { emitted++; continue; }   // still priming — not yet playout
        emitted++;
        if (v === 0) {
          zeros++;
          if (!prevZero) dropouts++;
          prevZero = true;
        } else {
          prevZero = false;
        }
      }
    }
    return { emitted, zeros, dropouts, primedAfter, ringCapacity: p._ring.length };
  }, { blocks, FRAME, BLOCK });
}

test('steady-state playout has zero dropouts', async ({ page }) => {
  await loadProcessor(page);
  // 4000 blocks ≈ 10.6s at 48kHz — long enough for the 480/128 phase pattern
  // (period 15 blocks) to repeat hundreds of times. The pre-fix code produced
  // 800 dropouts and 5.07% silence over exactly this run.
  const r = await runBlocks(page, 4000);
  expect(r.zeros).toBe(0);
  expect(r.dropouts).toBe(0);
});

test('priming costs no more than two frames of latency', async ({ page }) => {
  await loadProcessor(page);
  const r = await runBlocks(page, 200);
  // Playout starts once the FIFO banks PREFILL (2 frames = 20ms). The block
  // clock is coarse, so allow the partial block that straddles the threshold.
  expect(r.primedAfter).toBeGreaterThan(0);
  expect(r.primedAfter).toBeLessThanOrEqual(FRAME * 2 + BLOCK);
});

test('the ring holds more than one frame, so a frame cannot overwrite unread audio', async ({ page }) => {
  await loadProcessor(page);
  const r = await runBlocks(page, 100);
  // The original bug in one assertion: a 480-sample buffer reset on every frame.
  expect(r.ringCapacity).toBeGreaterThanOrEqual(FRAME * 2);
});

test('audio passes through untouched before the WASM module is ready', async ({ page }) => {
  await loadProcessor(page);
  const passedThrough = await page.evaluate(({ BLOCK }) => {
    const p = new window.__RNNoiseClass();
    const input = new Float32Array(BLOCK).fill(0.25);
    const output = new Float32Array(BLOCK);
    p.process([[input]], [[output]]);
    return Array.from(output).every((v) => v === 0.25);
  }, { BLOCK });
  expect(passedThrough).toBe(true);
});

test('destroy before init completes does not throw', async ({ page }) => {
  await loadProcessor(page);
  // _cleanup is reachable from the port handler while the WASM module is still
  // compiling, when none of the exports exist yet.
  const threw = await page.evaluate(() => {
    const p = new window.__RNNoiseClass();
    try { p._cleanup(); return false; } catch (e) { return e.message; }
  });
  expect(threw).toBe(false);
});

test('a destroyed processor stops being pulled', async ({ page }) => {
  await loadProcessor(page);
  const keepAlive = await page.evaluate(({ BLOCK }) => {
    const p = new window.__RNNoiseClass();
    p._cleanup();
    return p.process([[new Float32Array(BLOCK)]], [[new Float32Array(BLOCK)]]);
  }, { BLOCK });
  expect(keepAlive).toBe(false);
});
