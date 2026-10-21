// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRadio, type Tuning } from "./use-radio";

/** A WebSocket whose close completes only when the test says so, like a real close handshake. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  sent: Record<string, unknown>[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  addEventListener() {}

  close() {
    this.readyState = FakeSocket.CLOSING;
  }

  finishClose() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  frame(tag: number, payload: ArrayBufferView) {
    const buf = new Uint8Array(1 + payload.byteLength);
    buf[0] = tag;
    buf.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), 1);
    this.onmessage?.({ data: buf.buffer });
  }

  status(state: string, extra: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ type: "status", state, sampleRate: 12000, ...extra }) });
  }
}

const workletMessages = vi.fn();

// Tests that need audio setup to stall replace this with a promise they resolve.
let workletReady: Promise<void> = Promise.resolve();

class FakeAudioContext {
  audioWorklet = { addModule: () => workletReady };
  destination = {};
  currentTime = 0;
  createGain() {
    return { gain: { value: 1, setTargetAtTime() {} }, connect: (next: unknown) => next };
  }
  async resume() {}
  async close() {}
}

class FakeWorkletNode {
  port = { postMessage: workletMessages };
  connect(next: unknown) {
    return next;
  }
}

const tuning: Tuning = { host: "kiwi.example", port: 8073, freqKhz: 10_000, mode: "am" };
const resets = () => workletMessages.mock.calls.filter(([msg]) => msg?.type === "reset").length;

beforeEach(() => {
  FakeSocket.instances = [];
  workletMessages.mockClear();
  workletReady = Promise.resolve();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useRadio", () => {
  it("ignores the old socket's close after Stop and a quick Listen", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [old] = FakeSocket.instances;
    act(() => old!.status("listening"));

    act(() => result.current.stop());
    await act(() => result.current.tune(tuning));
    const fresh = FakeSocket.instances[1]!;
    act(() => fresh.status("listening"));
    workletMessages.mockClear();

    act(() => old!.finishClose()); // the old close handshake lands late

    expect(result.current.status.state).toBe("listening");
    expect(result.current.status.message).toBeUndefined();
    expect(resets()).toBe(0);
  });

  it("still reports a drop of the live socket", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [live] = FakeSocket.instances;
    act(() => live!.status("listening"));
    workletMessages.mockClear();

    act(() => live!.finishClose());

    expect(result.current.status.state).toBe("error");
    expect(result.current.status.message).toMatch(/Lost the connection/);
    expect(resets()).toBe(1);
  });

  // Value: protects=a code from a newer radio service can't read as "X undefined" in Pick best; fails_when=handleText casts any string to a code; why_new=TODOS unknown codes; seam=none; no_claim=which codes a future service adds
  it("treats an error code this build doesn't know as uncoded, and keeps a retry hint", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [live] = FakeSocket.instances;

    act(() => live!.status("error", { message: "Something new.", code: "brand_new", retryAfterMs: 5000 }));

    expect(result.current.status.code).toBeUndefined();
    expect(result.current.status.retryAfterMs).toBe(5000);
  });

  it("passes the error code through and keeps the other status fields", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [live] = FakeSocket.instances;

    act(() =>
      live!.status("error", { message: "kiwi.example is full.", code: "busy", host: "kiwi.example", port: 8073 }),
    );

    expect(result.current.status).toEqual({
      state: "error",
      message: "kiwi.example is full.",
      code: "busy",
      sampleRate: 12000,
      host: "kiwi.example",
      port: 8073,
    });
  });

  it("doesn't send a tune when Stop lands while audio is still starting", async () => {
    let finishAudio!: () => void;
    workletReady = new Promise((resolve) => (finishAudio = resolve));
    const { result } = renderHook(() => useRadio());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.tune(tuning);
    });
    act(() => result.current.stop());
    await act(async () => {
      finishAudio();
      await pending;
    });

    expect(FakeSocket.instances).toHaveLength(0);
    expect(result.current.status.state).toBe("idle");
  });

  // Value: protects=Stop while connecting tells the service, goes idle and ignores the old socket's late error; fails_when=stop() skips the stop frame or onmessage stops checking the socket; why_new=state matrix connecting x stop; seam=none; no_claim=server-side cancel
  it("stops cleanly while connecting and ignores the old socket's late error", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("connecting", { host: "kiwi.example" }));
    act(() => result.current.stop());
    act(() => ws!.status("error", { host: "kiwi.example", code: "busy", message: "full" }));

    expect(ws!.sent.at(-1)).toEqual({ type: "stop" });
    expect(result.current.status).toEqual({ state: "idle" });
  });

  // Value: protects=switching receivers while listening reuses the open socket; fails_when=tune() opens a new socket per call; why_new=state matrix listening x tune; seam=none; no_claim=server switch
  it("switches receivers on the open socket while listening", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("listening", { host: "kiwi.example" }));
    await act(() => result.current.tune({ ...tuning, host: "other.example" }));

    expect(FakeSocket.instances).toHaveLength(1);
    expect(ws!.sent.at(-1)).toEqual({ type: "tune", ...tuning, host: "other.example" });
  });

  // Value: protects=a tune superseded by Stop can't report its own late failure over the new state; fails_when=the generation check in tune()'s ensureAudio catch is removed; why_new=only the success branches were tested; seam=none; no_claim=real AudioContext errors
  it("doesn't report a failure from a tune that Stop already replaced", async () => {
    let failAudio!: (e: Error) => void;
    workletReady = new Promise((_, reject) => (failAudio = reject));
    const { result } = renderHook(() => useRadio());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.tune(tuning);
    });
    act(() => result.current.stop());
    await act(async () => {
      failAudio(new Error("blocked"));
      await pending;
    });

    expect(result.current.status.state).toBe("idle");
  });

  // Value: protects=quick back-to-back tunes (Pick best, list clicks) send only the latest; fails_when=the generation check after ensureAudio is removed; why_new=only Stop-vs-tune was covered; seam=none; no_claim=real browser audio timing
  it("sends only the newer tune when one replaces another during startup", async () => {
    let finishAudio!: () => void;
    workletReady = new Promise((resolve) => (finishAudio = resolve));
    const { result } = renderHook(() => useRadio());

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.tune(tuning);
      second = result.current.tune({ ...tuning, host: "newer.example" });
    });
    await act(async () => {
      finishAudio();
      await Promise.all([first, second]);
    });

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.sent).toEqual([{ type: "tune", ...tuning, host: "newer.example" }]);
  });

  // Value: protects=a dropped socket ends anything waiting on it, like a Pick best chain; fails_when=onclose keeps the old coded error object; why_new=only a drop while listening was covered; seam=none; no_claim=real server restarts
  it("turns a coded error into a fresh uncoded one when the socket drops, keeping its message", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [live] = FakeSocket.instances;
    act(() => live!.status("error", { message: "kiwi.example is full.", code: "busy", host: "kiwi.example" }));
    const before = result.current.status;

    act(() => live!.finishClose());

    expect(result.current.status).not.toBe(before);
    expect(result.current.status.code).toBeUndefined();
    expect(result.current.status.host).toBeUndefined();
    // The receiver's explanation is still true, and so is the service going away.
    expect(result.current.status.message).toBe(
      "kiwi.example is full. The connection to the radio service was lost too.",
    );
  });

  it("ignores a late status from a socket that was replaced", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [old] = FakeSocket.instances;
    act(() => result.current.stop());
    await act(() => result.current.tune({ ...tuning, host: "other.example" }));
    const fresh = FakeSocket.instances[1]!;
    act(() => fresh.status("connecting", { host: "other.example" }));

    act(() => old!.status("error", { message: "kiwi.example is full.", code: "busy", host: "kiwi.example" }));

    expect(result.current.status.state).toBe("connecting");
    expect(result.current.status.host).toBe("other.example");
    expect(fresh.sent).toEqual([{ type: "tune", ...tuning, host: "other.example" }]);
  });

  // Value: protects=after a receiver error the same socket takes the next tune; fails_when=an error status leaves the socket unusable or opens a second one; why_new=state matrix error x tune; seam=none; no_claim=server behaviour
  it("tunes again on the same socket after an error", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("error", { message: "full", code: "busy", host: "kiwi.example", port: 8073 }));
    await act(() => result.current.tune({ ...tuning, host: "other.example" }));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(ws!.sent.at(-1)).toEqual({ type: "tune", ...tuning, host: "other.example" });
  });

  // Value: protects=the service sends a wss tune when the receiver is secure; fails_when=Tuning drops `secure` on the way to the socket; why_new=wss dialing; seam=none; no_claim=the service's TLS
  it("sends secure on the tune when the receiver needs wss", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune({ ...tuning, secure: true }));
    expect(FakeSocket.instances[0]!.sent.at(-1)).toEqual({ type: "tune", ...tuning, secure: true });
  });

  // Value: protects=a second Stop is harmless and leaves the radio idle; fails_when=stop() assumes a live socket; why_new=state matrix stopped x stop; seam=none; no_claim=none beyond protects
  it("treats Stop when already stopped as a no-op", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    act(() => result.current.stop());
    act(() => result.current.stop());
    expect(result.current.status).toEqual({ state: "idle" });
    expect(FakeSocket.instances[0]!.sent.filter((m) => m.type === "stop")).toHaveLength(1);
  });

  // Value: protects=a drop after Stop isn't reported as a problem; fails_when=onclose ignores stoppingRef; why_new=state matrix idle x socket-drop; seam=none; no_claim=none beyond protects
  it("stays quiet when the socket closes after Stop", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => result.current.stop());
    act(() => ws!.finishClose());
    expect(result.current.status).toEqual({ state: "idle" });
  });

  // Value: protects=switching receivers before the first one connects reuses the socket; fails_when=tune() opens a socket per call while one is in use; why_new=state matrix connecting x tune; seam=none; no_claim=the service cancelling the first attempt (radio tests)
  it("switches receivers on the open socket while still connecting", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("connecting", { host: "kiwi.example" }));
    await act(() => result.current.tune({ ...tuning, host: "other.example" }));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(ws!.sent.at(-1)).toEqual({ type: "tune", ...tuning, host: "other.example" });
  });

  // Value: protects=Stop after a receiver error tells the service and clears the error; fails_when=stop() skips an errored session; why_new=state matrix error x stop; seam=none; no_claim=none beyond protects
  it("stops cleanly from an error", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("error", { message: "full", code: "busy", host: "kiwi.example", port: 8073 }));
    act(() => result.current.stop());
    expect(ws!.sent.at(-1)).toEqual({ type: "stop" });
    expect(result.current.status).toEqual({ state: "idle" });
  });

  describe("binary frames", () => {
    async function listening() {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening"));
      const rows: Float32Array[] = [];
      result.current.onSpectrum((row) => rows.push(row));
      workletMessages.mockClear();
      return { ws, rows };
    }
    const samples = () =>
      workletMessages.mock.calls.filter(([msg]) => msg?.type === "samples").map(([msg]) => msg.data as Float32Array);

    // Value: protects=int16 audio plays at the right level; fails_when=the decoder reads the bytes as Float32 or skips the /32768 scale; why_new=no test fed binary frames to useRadio; seam=none; no_claim=AudioWorklet playback in a real browser
    it("plays int16 audio frames as floats", async () => {
      const { ws } = await listening();
      act(() => ws.frame(3, new Int16Array([32767, -32768, 0, 16384])));
      expect(Array.from(samples()[0]!)).toEqual([32767 / 32768, -1, 0, 0.5]);
    });

    // Value: protects=uint8 spectrum rows decode to dB around their base; fails_when=the base is dropped or the 0.5 dB step changes on one side; why_new=no binary decode test; seam=none; no_claim=waterfall rendering
    it("decodes uint8 spectrum rows against their base level", async () => {
      const { ws, rows } = await listening();
      const payload = new Uint8Array(4 + 512);
      new DataView(payload.buffer).setFloat32(0, -150, true);
      payload.set([0, 40, 255], 4);
      act(() => ws.frame(4, payload));
      expect(rows[0]).toHaveLength(512);
      expect(Array.from(rows[0]!.slice(0, 4))).toEqual([-150, -130, -22.5, -150]);
    });

    // Value: protects=a radio service from before the switch still plays, so the web app can deploy first; fails_when=the float32 branches are deleted early; why_new=D6 deploy-order guarantee; seam=none; no_claim=none beyond protects
    it("still reads float32 frames from an older radio service", async () => {
      const { ws, rows } = await listening();
      act(() => ws.frame(1, new Float32Array([0.25, -0.5])));
      const legacyRow = new Float32Array(512).fill(-120);
      legacyRow[1] = -60;
      act(() => ws.frame(2, legacyRow));
      expect(Array.from(samples()[0]!)).toEqual([0.25, -0.5]);
      expect(Array.from(rows[0]!.slice(0, 3))).toEqual([-120, -60, -120]);
    });

    // Value: protects=a frame tag from a newer service is dropped, not played as noise or drawn as a row; fails_when=handleBinary treats unknown tags as audio; why_new=the tag switch had no unknown-tag case; seam=none; no_claim=what a newer service would send
    it("ignores frames with a tag it doesn't know", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ws, rows } = await listening();
      act(() => ws.frame(9, new Uint8Array([1, 2, 3, 4])));
      act(() => ws.frame(9, new Uint8Array([1, 2, 3, 4])));
      expect(samples()).toHaveLength(0);
      expect(rows).toHaveLength(0);
      // Value: protects=a tag mismatch is visible in dev tools, once per socket; fails_when=the warning is dropped or fires per frame; why_new=unknown tags were silent; seam=none; no_claim=what listeners see on the page
      expect(warn).toHaveBeenCalledTimes(1);
    });

    // Value: protects=each new connection warns again about unreadable frames; fails_when=the warned flag isn't reset for a new socket; why_new=only one socket was tested; seam=none; no_claim=none beyond protects
    it("warns again on a new connection", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const first = FakeSocket.instances[0]!;
      act(() => first.status("listening"));
      act(() => first.frame(9, new Uint8Array([1])));
      act(() => result.current.stop());
      act(() => first.finishClose());
      await act(() => result.current.tune(tuning));
      const second = FakeSocket.instances[1]!;
      act(() => second.status("listening"));
      act(() => second.frame(9, new Uint8Array([1])));
      expect(warn).toHaveBeenCalledTimes(2);
    });

    // Value: protects=a frame too short for its tag is skipped, not thrown inside onmessage; fails_when=the length checks are dropped; why_new=only well-formed frames were tested; seam=none; no_claim=what a buggy service would actually send
    it("skips frames whose payload doesn't fit their tag", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ws, rows } = await listening();
      expect(() => act(() => ws.frame(3, new Uint8Array([1, 2, 3])))).not.toThrow();
      expect(() => act(() => ws.frame(4, new Uint8Array([0, 0])))).not.toThrow();
      act(() => ws.frame(4, new Uint8Array(4))); // a base with no bins would make the waterfall's floor NaN
      act(() => ws.frame(3, new Uint8Array(0))); // tag only
      act(() => ws.onmessage?.({ data: new ArrayBuffer(0) }));
      expect(samples()).toHaveLength(0);
      expect(rows).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    // Value: protects=spectrum rows of the wrong length, or with a value that is NaN, infinite or far outside real dB, never reach the waterfall, in either format; fails_when=the 512-bin or value checks are dropped, or only the base is checked (a huge finite base stays finite, and drags the waterfall's floor for minutes); why_new=huge finite bases and legacy rows went unchecked; seam=none; no_claim=what a broken service would send
    it("skips spectrum rows of the wrong length or with an out-of-range value", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ws, rows } = await listening();
      act(() => ws.frame(4, new Uint8Array(4 + 511)));
      act(() => ws.frame(4, new Uint8Array(4 + 100_000)));
      for (const bad of [NaN, Infinity, -Infinity, 3.4e38, -301]) {
        const payload = new Uint8Array(4 + 512);
        new DataView(payload.buffer).setFloat32(0, bad, true);
        act(() => ws.frame(4, payload));
      }
      act(() => ws.frame(2, new Float32Array(511)));
      for (const bad of [NaN, 3.4e38]) {
        const legacy = new Float32Array(512).fill(-120);
        legacy[7] = bad;
        act(() => ws.frame(2, legacy));
      }
      expect(rows).toHaveLength(0);
    });

    // Value: protects=rows at the edge of the dB range still reach the waterfall, in both formats; fails_when=MAX_ABS_DB is tightened below what real rows can hold (weak bands sit near -200 dB); why_new=only rejected values were tested; seam=none; no_claim=none beyond protects
    it("keeps spectrum rows at the edge of the dB range", async () => {
      const { ws, rows } = await listening();
      const payload = new Uint8Array(4 + 512);
      new DataView(payload.buffer).setFloat32(0, -300, true);
      act(() => ws.frame(4, payload));
      const legacy = new Float32Array(512).fill(-200);
      legacy[0] = 300;
      legacy[1] = -300;
      act(() => ws.frame(2, legacy));
      expect(rows).toHaveLength(2);
    });

    // Value: protects=audio frames up to the most the radio service can send (2**18 samples) play and bigger ones are skipped; fails_when=the cap is dropped or set below what kiwi.py's MAX_FRAME_BYTES allows; why_new=frame size had no bound; seam=none; no_claim=what a broken service would send
    it("plays audio frames up to the service's largest and skips bigger ones", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ws } = await listening();
      act(() => ws.frame(3, new Int16Array(2 ** 18 + 1)));
      act(() => ws.frame(1, new Float32Array(2 ** 18 + 1)));
      act(() => ws.frame(3, new Int16Array(2 ** 18)));
      // Extended: protects=the float32 cap allows exactly 2**18 too; fails_when=only that branch's bound is off by one; why_new=only int16 hit the boundary
      act(() => ws.frame(1, new Float32Array(2 ** 18)));
      expect(samples().map((s) => s.length)).toEqual([2 ** 18, 2 ** 18]);
    });

    // Value: protects=an empty frame's warning reads as an empty frame, not "type undefined, -1 bytes"; fails_when=the empty case loses its own wording; why_new=only the warning count was checked; seam=none; no_claim=none beyond protects
    it("names an empty frame in its warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ws } = await listening();
      act(() => ws.onmessage?.({ data: new ArrayBuffer(0) }));
      expect(warn).toHaveBeenCalledWith("The radio service sent an empty frame. Try reloading.");
    });

    // Value: protects=a float32 frame from an older service whose payload isn't a multiple of 4 bytes is skipped, not thrown inside onmessage; fails_when=the size % 4 checks on tags 1/2 are dropped (new Float32Array throws RangeError); why_new=the misaligned test covers only tags 3/4; seam=none; no_claim=what an older service would actually send
    it("skips legacy float32 frames whose payload isn't whole floats", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ws, rows } = await listening();
      expect(() => act(() => ws.frame(1, new Uint8Array([1, 2, 3])))).not.toThrow();
      expect(() => act(() => ws.frame(2, new Uint8Array([1, 2, 3, 4, 5])))).not.toThrow();
      expect(samples()).toHaveLength(0);
      expect(rows).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
