/**
 * RNNoise AudioWorklet Processor
 * Processes mic audio through RNNoise WASM for real-time noise suppression.
 *
 * RNNoise operates on 480-sample frames (10ms at 48kHz).
 * AudioWorklet's process() delivers 128-sample blocks.
 * We buffer samples and process whenever a full frame is ready.
 *
 * 480 is NOT a multiple of 128, so production and consumption are permanently
 * out of phase even though their long-run RATES match exactly. Draining a frame
 * the instant it is produced therefore runs dry every few blocks — the earlier
 * version did exactly that and zero-filled the shortfall, punching ~5% of the
 * outgoing audio out as silence in ~75 dropouts per second. That is a phase
 * problem, not a CPU one, so it sounded identically choppy on every device.
 *
 * The fix is a ring FIFO plus a pre-fill: playout does not start until PREFILL
 * samples are banked, and from then on the FIFO always has enough to satisfy a
 * 128-sample block. PREFILL is two frames — one frame is enough to make the
 * arithmetic work, but leaves zero headroom for real worklet jitter on mobile.
 * The cost is 20ms of added mouth-to-ear latency, which is invisible on PTT.
 */
const FRAME = 480;              // RNNoise's fixed frame size (10ms @ 48kHz)
const PREFILL = FRAME * 2;      // bank 20ms before playout starts
const RING_SIZE = FRAME * 4;    // 40ms of slack, so a late frame cannot overrun

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready = false;
    this._destroyed = false;

    this._inputBuf = new Float32Array(FRAME);
    this._inputPos = 0;

    // Output FIFO: _ring[_rTail.._rHead) holds _rCount processed samples.
    this._ring = new Float32Array(RING_SIZE);
    this._rHead = 0;
    this._rTail = 0;
    this._rCount = 0;
    this._priming = true;

    this.port.onmessage = (e) => {
      if (e.data.type === 'wasm-bytes') {
        this._initWasm(e.data.bytes);
      } else if (e.data.type === 'destroy') {
        this._cleanup();
      }
    };
  }

  async _initWasm(wasmBytes) {
    try {
      let wasmMemory = null;
      let HEAPU8 = null;

      const updateViews = () => {
        HEAPU8 = new Uint8Array(wasmMemory.buffer);
        this._HEAPF32 = new Float32Array(wasmMemory.buffer);
      };

      // wasmBytes is raw ArrayBuffer, not a pre-compiled Module, so this both
      // compiles and instantiates (returns { module, instance }).
      const { instance } = await WebAssembly.instantiate(wasmBytes, {
        a: {
          a: (requestedSize) => {
            const oldSize = HEAPU8.length;
            requestedSize = requestedSize >>> 0;
            if (requestedSize > 2147483648) return false;
            for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
              let overGrown = oldSize * (1 + 0.2 / cutDown);
              overGrown = Math.min(overGrown, requestedSize + 100663296);
              const newSize = Math.min(2147483648,
                (Math.max(requestedSize, overGrown) + 65535) & ~65535);
              try {
                wasmMemory.grow((newSize - wasmMemory.buffer.byteLength + 65535) >>> 16);
                updateViews();
                return true;
              } catch (e) { /* try next */ }
            }
            return false;
          },
          b: (dest, src, num) => {
            HEAPU8.copyWithin(dest, src, src + num);
          }
        }
      });

      // instantiate() is async, so a 'destroy' may have landed while it ran.
      // Allocating now would leak the state and the two buffers for good.
      if (this._destroyed) return;

      const exports = instance.exports;
      wasmMemory = exports.c;
      updateViews();

      if (exports.d) exports.d(); // __wasm_call_ctors

      this._malloc = exports.g;
      this._free = exports.i;
      this._rnnoise_create = exports.f;
      this._rnnoise_destroy = exports.h;
      this._rnnoise_process_frame = exports.j;
      this._wasmMemory = wasmMemory;

      this._state = this._rnnoise_create();
      this._wasmInputPtr = this._malloc(FRAME * 4);
      this._wasmOutputPtr = this._malloc(FRAME * 4);

      this._ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: err.message });
    }
  }

  // Reachable BEFORE _initWasm resolves (the node can be torn down while the
  // WASM module is still compiling), so nothing here may assume the exports
  // exist — calling an undefined this._rnnoise_destroy would throw inside the
  // port handler and leave the processor alive.
  _cleanup() {
    this._destroyed = true;
    this._ready = false;
    if (this._state && this._rnnoise_destroy) {
      this._rnnoise_destroy(this._state);
    }
    if (this._wasmInputPtr && this._free) {
      this._free(this._wasmInputPtr);
      this._free(this._wasmOutputPtr);
    }
    this._state = null;
    this._wasmInputPtr = null;
    this._wasmOutputPtr = null;
    this._rCount = 0;
    this._priming = true;
  }

  process(inputs, outputs) {
    if (this._destroyed) return false;

    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!input || !output) return true;

    if (!this._ready) {
      output.set(input);
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      this._inputBuf[this._inputPos++] = input[i];
      if (this._inputPos === FRAME) {
        this._processFrame();
        this._inputPos = 0;
      }
    }

    // Silence only while priming (the first ~20ms after the worklet starts) or
    // on a genuine underrun. In steady state the FIFO always has a full block.
    if (this._priming) {
      output.fill(0);
      return true;
    }

    for (let i = 0; i < output.length; i++) {
      if (this._rCount > 0) {
        output[i] = this._ring[this._rTail];
        this._rTail = (this._rTail + 1) % RING_SIZE;
        this._rCount--;
      } else {
        output[i] = 0;
        // Underrun: re-prime rather than trickling out one starved block after
        // another. Costs 20ms once instead of chopping every block that follows.
        this._priming = true;
      }
    }

    return true;
  }

  _processFrame() {
    if (this._HEAPF32.buffer !== this._wasmMemory.buffer) {
      this._HEAPF32 = new Float32Array(this._wasmMemory.buffer);
    }

    const inIdx = this._wasmInputPtr >> 2;
    for (let i = 0; i < FRAME; i++) {
      this._HEAPF32[inIdx + i] = this._inputBuf[i] * 32768;
    }

    this._rnnoise_process_frame(this._state, this._wasmOutputPtr, this._wasmInputPtr);

    const outIdx = this._wasmOutputPtr >> 2;
    for (let i = 0; i < FRAME; i++) {
      // Overflow (playout stalled — e.g. the context was suspended): drop the
      // OLDEST sample. Never reset the read pointer; that is what destroyed the
      // phase relationship in the first place.
      if (this._rCount === RING_SIZE) {
        this._rTail = (this._rTail + 1) % RING_SIZE;
        this._rCount--;
      }
      this._ring[this._rHead] = this._HEAPF32[outIdx + i] / 32768;
      this._rHead = (this._rHead + 1) % RING_SIZE;
      this._rCount++;
    }

    if (this._priming && this._rCount >= PREFILL) this._priming = false;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
