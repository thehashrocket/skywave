// Plays a stream of mono Float32 samples arriving over the network.
//
// The radio's sample rate (around 12 kHz) rarely matches the sound card, and
// the two clocks drift. So we keep a ring buffer, resample with linear
// interpolation, and nudge the playback rate by up to 2% to hold the buffer
// near a target depth. On underrun we go quiet and re-prime.

const TARGET_SECONDS = 0.3;
const CAPACITY_SECONDS = 4;

class RadioPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.setRate(12000);
    this.lastReport = 0;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "samples") this.push(msg.data);
      else if (msg.type === "rate") this.setRate(msg.rate);
      else if (msg.type === "reset") this.reset();
    };
  }

  setRate(rate) {
    this.inputRate = rate;
    this.capacity = Math.ceil(rate * CAPACITY_SECONDS);
    this.buf = new Float32Array(this.capacity);
    this.reset();
  }

  reset() {
    this.read = 0;
    this.write = 0;
    this.fill = 0;
    this.primed = false;
    this.lastSample = 0;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i];
      this.write = (this.write + 1) % this.capacity;
      if (this.fill < this.capacity - 2) {
        this.fill++;
      } else {
        // Overflow: drop the oldest sample.
        this.read = (this.read + 1) % this.capacity;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const target = this.inputRate * TARGET_SECONDS;

    if (!this.primed) {
      if (this.fill >= target) {
        this.primed = true;
      } else {
        out.fill(0);
        return true;
      }
    }

    const base = this.inputRate / sampleRate;
    const error = (this.fill - target) / target;
    const step = base * (1 + Math.max(-0.02, Math.min(0.02, error * 0.02)));

    for (let i = 0; i < out.length; i++) {
      if (this.fill < 2) {
        // Underrun: fade the last sample out instead of clicking, then wait.
        for (let j = i; j < out.length; j++) {
          this.lastSample *= 0.95;
          out[j] = this.lastSample;
        }
        this.primed = false;
        break;
      }
      const i0 = Math.floor(this.read);
      const frac = this.read - i0;
      const a = this.buf[i0 % this.capacity];
      const b = this.buf[(i0 + 1) % this.capacity];
      const sample = a + (b - a) * frac;
      out[i] = sample;
      this.lastSample = sample;

      this.read += step;
      const consumed = Math.floor(this.read) - i0;
      this.fill -= consumed;
      if (this.read >= this.capacity) this.read -= this.capacity;
    }

    if (currentTime - this.lastReport > 0.5) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: "buffer", seconds: this.fill / this.inputRate });
    }
    return true;
  }
}

registerProcessor("radio-player", RadioPlayer);
