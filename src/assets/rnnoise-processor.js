/**
 * RNNoise AudioWorklet Processor
 * Processes mic audio through RNNoise WASM for real-time noise suppression.
 *
 * RNNoise operates on 480-sample frames (10ms at 48kHz).
 * AudioWorklet's process() delivers 128-sample blocks.
 * We buffer samples and process whenever a full frame is ready.
 */
class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready = false;
    this._destroyed = false;

    this._inputBuf = new Float32Array(480);
    this._outputBuf = new Float32Array(480);
    this._inputPos = 0;
    this._outputPos = 0;
    this._outputReady = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'wasm-module') {
        this._initWasm(e.data.module);
      } else if (e.data.type === 'destroy') {
        this._cleanup();
      }
    };
  }

  async _initWasm(wasmModule) {
    try {
      let wasmMemory = null;
      let HEAPU8 = null;

      const updateViews = () => {
        HEAPU8 = new Uint8Array(wasmMemory.buffer);
        this._HEAPF32 = new Float32Array(wasmMemory.buffer);
      };

      const instance = await WebAssembly.instantiate(wasmModule, {
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
      this._wasmInputPtr = this._malloc(480 * 4);
      this._wasmOutputPtr = this._malloc(480 * 4);

      this._ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: err.message });
    }
  }

  _cleanup() {
    this._destroyed = true;
    if (this._state) {
      this._rnnoise_destroy(this._state);
      this._state = null;
    }
    if (this._wasmInputPtr) {
      this._free(this._wasmInputPtr);
      this._free(this._wasmOutputPtr);
      this._wasmInputPtr = null;
      this._wasmOutputPtr = null;
    }
    this._ready = false;
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
      if (this._inputPos === 480) {
        this._processFrame();
        this._inputPos = 0;
      }
    }

    for (let i = 0; i < output.length; i++) {
      if (this._outputReady > 0) {
        output[i] = this._outputBuf[this._outputPos++];
        this._outputReady--;
        if (this._outputPos >= 480) this._outputPos = 0;
      } else {
        output[i] = 0;
      }
    }

    return true;
  }

  _processFrame() {
    if (this._HEAPF32.buffer !== this._wasmMemory.buffer) {
      this._HEAPF32 = new Float32Array(this._wasmMemory.buffer);
    }

    const inIdx = this._wasmInputPtr >> 2;
    for (let i = 0; i < 480; i++) {
      this._HEAPF32[inIdx + i] = this._inputBuf[i] * 32768;
    }

    this._rnnoise_process_frame(this._state, this._wasmOutputPtr, this._wasmInputPtr);

    const outIdx = this._wasmOutputPtr >> 2;
    this._outputPos = 0;
    for (let i = 0; i < 480; i++) {
      this._outputBuf[i] = this._HEAPF32[outIdx + i] / 32768;
    }
    this._outputReady = 480;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
