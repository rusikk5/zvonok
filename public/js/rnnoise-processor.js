'use strict';

const FRAME = 480;
const CAP   = 16384; // ring buffer (power of 2)
const M     = CAP - 1;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready   = false;
    this._enabled = true;
    this._inRing  = new Float32Array(CAP);
    this._outRing = new Float32Array(CAP);
    this._inW = 0; this._inR = 0;
    this._outW = 0; this._outR = 0;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'wasm')    this._init(data.buffer);
      if (data.type === 'enabled') this._enabled = data.value;
    };
  }

  async _init(buffer) {
    // Emscripten imports: module "a", keys "a" (_emscripten_resize_heap) and "b" (_emscripten_memcpy_big)
    let HEAPU8     = new Uint8Array(0);
    let wasmMemory = null;

    const imports = {
      "a": {
        "b": (dest, src, num) => {
          HEAPU8.copyWithin(dest, src, src + num);
        },
        "a": (requestedSize) => {
          if (!wasmMemory) return 0;
          requestedSize = requestedSize >>> 0;
          if (requestedSize > 2147483648) return 0;
          const oldSize = HEAPU8.length;
          const alignUp = (x, m) => x + (m - x % m) % m;
          for (let c = 1; c <= 4; c *= 2) {
            const overgrown = Math.min(oldSize * (1 + 0.2 / c), requestedSize + 100663296);
            const newSize   = Math.min(2147483648, alignUp(Math.max(requestedSize, overgrown), 65536));
            try {
              wasmMemory.grow((newSize - HEAPU8.buffer.byteLength + 65535) >>> 16);
              HEAPU8 = new Uint8Array(wasmMemory.buffer);
              return 1;
            } catch {}
          }
          return 0;
        }
      }
    };

    try {
      const { instance } = await WebAssembly.instantiate(buffer, imports);
      const exp = instance.exports;

      wasmMemory = exp["c"];             // exported Memory
      HEAPU8     = new Uint8Array(wasmMemory.buffer);

      exp["d"]();                        // __wasm_call_ctors (must run before using the module)

      this._state  = exp["f"](0);        // rnnoise_create(null model → built-in)
      this._inPtr  = exp["g"](FRAME * 4);// malloc
      this._outPtr = exp["g"](FRAME * 4);// malloc
      this._proc   = exp["j"];           // rnnoise_process_frame
      this._inOff  = this._inPtr  >> 2;
      this._outOff = this._outPtr >> 2;
      this._heapF32 = new Float32Array(wasmMemory.buffer); // stable — rnnoise never grows memory during process

      this._ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', msg: String(e) });
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!inp || !out) return true;

    if (!this._ready || !this._enabled) {
      out.set(inp);
      return true;
    }

    // Enqueue scaled input
    for (let i = 0; i < inp.length; i++)
      this._inRing[this._inW++ & M] = inp[i] * 32768;

    // Process complete 480-sample frames
    while (this._inW - this._inR >= FRAME) {
      const hf = this._heapF32;
      for (let j = 0; j < FRAME; j++)
        hf[this._inOff + j] = this._inRing[(this._inR + j) & M];
      this._inR += FRAME;
      this._proc(this._state, this._outPtr, this._inPtr);
      for (let j = 0; j < FRAME; j++)
        this._outRing[this._outW++ & M] = hf[this._outOff + j];
    }

    // Dequeue 128 output samples
    if (this._outW - this._outR >= out.length) {
      for (let i = 0; i < out.length; i++)
        out[i] = this._outRing[this._outR++ & M] / 32768;
    } else {
      out.set(inp);
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
