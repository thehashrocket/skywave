import { beforeAll, describe, expect, it } from "vitest";

// Drives public/worklets/radio-player.js the way the browser does: messages in
// through its port, 128-frame render calls out. The globals below are the
// AudioWorkletGlobalScope pieces it uses. Input and output both run at 1 kHz,
// so a 0.3 s target is 300 samples and the 4 s ring holds 4000.

type Player = {
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
};

let RadioPlayer: new () => Player;

beforeAll(async () => {
  const scope = globalThis as Record<string, unknown>;
  scope.AudioWorkletProcessor = class {
    port = { postMessage() {}, onmessage: null };
  };
  scope.registerProcessor = (_name: string, cls: typeof RadioPlayer) => {
    RadioPlayer = cls;
  };
  scope.sampleRate = 1000;
  scope.currentTime = 0;
  // @ts-expect-error: plain worklet script, no type declarations
  await import("../../public/worklets/radio-player.js");
});

function player() {
  const p = new RadioPlayer();
  p.port.onmessage({ data: { type: "rate", rate: 1000 } });
  return p;
}

const send = (p: Player, samples: ArrayLike<number>) =>
  p.port.onmessage({ data: { type: "samples", data: Float32Array.from(samples) } });

const ramp = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function render(p: Player) {
  const out = new Float32Array(128);
  p.process([], [[out]]);
  return out;
}

describe("radio-player worklet", () => {
  it("stays silent until 0.3 s is buffered, then plays in order", () => {
    const p = player();
    send(p, ramp(299));
    expect(render(p).every((s) => s === 0)).toBe(true);
    send(p, [300]);
    const out = render(p);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeCloseTo(2, 1);
  });

  it("drops the oldest samples when the ring overflows", () => {
    const p = player();
    send(p, ramp(5000)); // 4000-slot ring keeps the newest 3998
    expect(render(p)[0]).toBe(5000 - 3998 + 1);
  });

  it("fades out on underrun instead of clicking, then waits to re-prime", () => {
    const p = player();
    send(p, new Array(300).fill(0.5));
    render(p);
    render(p);
    const out = render(p); // runs dry partway through
    const firstFade = out.findIndex((s) => s < 0.5 - 1e-6);
    expect(firstFade).toBeGreaterThan(0);
    const tail = Array.from(out.slice(firstFade));
    expect(tail.every((s, i) => s > 0 && (i === 0 || s < tail[i - 1]!))).toBe(true);

    expect(render(p).every((s) => s === 0)).toBe(true); // not re-primed yet
    send(p, new Array(300).fill(0.5));
    expect(render(p)[0]).toBeCloseTo(0.5, 5);
  });

  it("speeds up by at most 2% when the buffer runs deep", () => {
    const p = player();
    send(p, ramp(3000)); // 10x the target depth
    const out = render(p);
    // Ramp values equal read position + 1, so the slope is the playback step.
    expect((out[127]! - out[0]!) / 127).toBeCloseTo(1.02, 6);
  });
});
