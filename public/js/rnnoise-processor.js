'use strict';

const FRAME = 480;
const CAP   = 16384; // ring buffer (power of 2)
const M     = CAP - 1;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready   = false;
    this._mode    = 'standard';     // 'off' | 'standard' | 'ghoul'
    this._inRing  = new Float32Array(CAP);
    this._outRing = new Float32Array(CAP);
    this._inW = 0; this._inR = 0;
    this._outW = 0; this._outR = 0;

    // Ghoul gate (VAD-driven), smoothed per-sample at 48 kHz
    this._gate      = 1;            // current smoothed gain
    this._attack    = 0.010;        // fast open  (~ reach target quickly, click-free)
    this._release   = 0.0006;       // slow close (~ preserve word tails)
    this._vadOpen   = 0.50;         // voice prob above → open (keep voice audible)
    this._vadClose  = 0.10;         // voice prob below → close (keyboard/clicks ≈ 0 → killed)
    this._gateOpen  = false;        // hysteresis latch

    this.port.onmessage = ({ data }) => {
      if (data.type === 'wasm') this._init(data.buffer);
      if (data.type === 'mode') this._mode = data.value;
      // back-compat
      if (data.type === 'enabled') this._mode = data.value ? 'standard' : 'off';
    };
  }

  async _init(buffer) {
    let HEAPU8     = new Uint8Array(0);
    let wasmMemory = null;

    const imports = {
      "a": {
        "b": (dest, src, num) => { HEAPU8.copyWithin(dest, src, src + num); },
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

      exp["d"]();                        // __wasm_call_ctors

      this._state  = exp["f"](0);        // rnnoise_create — main pass
      this._state2 = exp["f"](0);        // rnnoise_create — second pass (ghoul)
      this._inPtr  = exp["g"](FRAME * 4);// malloc
      this._outPtr = exp["g"](FRAME * 4);// malloc
      this._proc   = exp["j"];           // rnnoise_process_frame → returns VAD prob (0..1)
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

    if (!this._ready || this._mode === 'off') {
      out.set(inp);
      return true;
    }

    const ghoul = this._mode === 'ghoul';
    const hf    = this._heapF32;

    // Enqueue scaled input
    for (let i = 0; i < inp.length; i++)
      this._inRing[this._inW++ & M] = inp[i] * 32768;

    // Process complete 480-sample frames
    while (this._inW - this._inR >= FRAME) {
      for (let j = 0; j < FRAME; j++)
        hf[this._inOff + j] = this._inRing[(this._inR + j) & M];
      this._inR += FRAME;

      // Pass 1 — also yields voice-activity probability
      let vad = this._proc(this._state, this._outPtr, this._inPtr);

      if (ghoul) {
        // Pass 2 — feed pass-1 output back through for stronger suppression
        for (let j = 0; j < FRAME; j++) hf[this._inOff + j] = hf[this._outOff + j];
        const vad2 = this._proc(this._state2, this._outPtr, this._inPtr);
        vad = Math.max(vad, vad2);

        // VAD gate with hysteresis — kills keyboard/clicks in pauses, keeps speech
        if (vad >= this._vadOpen)  this._gateOpen = true;
        else if (vad <= this._vadClose) this._gateOpen = false;
        const target = this._gateOpen ? 1 : 0;

        for (let j = 0; j < FRAME; j++) {
          const coeff = target > this._gate ? this._attack : this._release;
          this._gate += (target - this._gate) * coeff;
          this._outRing[this._outW++ & M] = hf[this._outOff + j] * this._gate;
        }
      } else {
        for (let j = 0; j < FRAME; j++)
          this._outRing[this._outW++ & M] = hf[this._outOff + j];
      }
    }

    // Dequeue output block
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
