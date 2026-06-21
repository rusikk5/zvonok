'use strict';

const FRAME = 480;  // RNNoise processes 480 samples at 48 kHz (~10 ms)
const CAP   = 8192; // ring-buffer capacity (must be power of 2)

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready   = false;
    this._enabled = true;
    // Ring buffers (samples scaled to [-32768, 32767])
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
    try {
      const sharedMem = new WebAssembly.Memory({ initial: 64, maximum: 256 });
      const { instance } = await WebAssembly.instantiate(buffer, {
        env: { memory: sharedMem }
      });
      const exp = instance.exports;
      const mem = exp.memory || sharedMem;

      this._state   = exp.rnnoise_create(0);
      this._inPtr   = exp.malloc(FRAME * 4);
      this._outPtr  = exp.malloc(FRAME * 4);
      this._heapIn  = new Float32Array(mem.buffer, this._inPtr,  FRAME);
      this._heapOut = new Float32Array(mem.buffer, this._outPtr, FRAME);
      this._process = exp.rnnoise_process_frame;
      this._ready   = true;
      this.port.postMessage({ type: 'ready' });
    } catch {
      // Stays in passthrough mode if WASM init fails
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

    const M = CAP - 1;

    // Enqueue scaled input
    for (let i = 0; i < inp.length; i++)
      this._inRing[this._inW++ & M] = inp[i] * 32768;

    // Process complete 480-sample frames
    while (this._inW - this._inR >= FRAME) {
      for (let j = 0; j < FRAME; j++)
        this._heapIn[j] = this._inRing[(this._inR + j) & M];
      this._inR += FRAME;
      this._process(this._state, this._outPtr, this._inPtr);
      for (let j = 0; j < FRAME; j++)
        this._outRing[this._outW++ & M] = this._heapOut[j];
    }

    // Dequeue 128 output samples
    if (this._outW - this._outR >= out.length) {
      for (let i = 0; i < out.length; i++)
        out[i] = this._outRing[this._outR++ & M] / 32768;
    } else {
      out.set(inp); // not enough buffered yet → pass through
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
