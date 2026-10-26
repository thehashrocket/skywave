// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_CLOSE_CODE, TOO_MANY_SOCKETS_CODE, useRadio, type Tuning } from "./use-radio";

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
  onclose: ((event: { code: number }) => void) | null = null;

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

  finishClose(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
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

  // Value: protects=the service hanging up an idle socket keeps the page's status (no "Lost the connection") and the next Listen opens a new socket; fails_when=onclose treats the idle close code like an outage, or keeps the closed socket for the next tune; why_new=the service now closes idle sockets; seam=none; no_claim=the service's idle timing (radio tests)
  it("treats an idle hang-up as quiet and reconnects on the next tune", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("stopped", { message: "Hit the 60-minute session limit. Press Listen to keep going." }));
    const before = result.current.status;
    act(() => ws!.finishClose(IDLE_CLOSE_CODE));
    expect(result.current.status).toEqual(before);
    await act(() => result.current.tune(tuning));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.sent.at(-1)).toEqual({ type: "tune", ...tuning });
  });

  // Value: protects=a Listen that crosses the service's idle hang-up isn't lost: the page sends it again on a new socket; fails_when=onclose drops a pending tune on the idle code; why_new=owner D2 (round 3a coverage audit); seam=none; no_claim=real network timing
  it("resends a tune that crossed an idle hang-up", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("stopped", { message: "Stopped." }));
    await act(() => result.current.tune(tuning)); // Listen again on the still-open socket
    await act(async () => ws!.finishClose(IDLE_CLOSE_CODE)); // the hang-up crosses it
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.sent.at(-1)).toEqual({ type: "tune", ...tuning });
    expect(result.current.tuning).toBe(true);
  });

  // Value: protects=the resend of a crossed tune carries the newest dial, not the frequency the Listen started with; fails_when=onclose resends the tune's original argument, or pendingRef (cleared just before); why_new=testing review; seam=none; no_claim=real network timing
  it("resends the newest dial for a tune that crossed an idle hang-up", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("stopped", { message: "Stopped." }));
    await act(() => result.current.tune(tuning));
    act(() => result.current.retune({ ...tuning, freqKhz: tuning.freqKhz + 5 }));
    await act(async () => ws!.finishClose(IDLE_CLOSE_CODE));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.sent.at(-1)).toEqual({ type: "tune", ...tuning, freqKhz: tuning.freqKhz + 5 });
  });

  // Value: protects=a Listen followed by Stop, then the idle hang-up, opens no new socket and stays stopped: the retry never restarts audio the listener just stopped; fails_when=stop() leaves the crossed tune pending for onclose; why_new=review (testing, state matrix closing x idle-close); seam=none; no_claim=none beyond protects
  it("does not resend a tune the listener stopped before the idle hang-up", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("stopped", { message: "Stopped." }));
    await act(() => result.current.tune(tuning));
    act(() => result.current.stop());
    await act(async () => ws!.finishClose(IDLE_CLOSE_CODE));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(result.current.status).toEqual({ state: "idle" });
  });

  // Value: protects=a page unmounted while a tune is pending doesn't reopen a socket when the idle hang-up arrives; fails_when=the idle retry ignores the unmount; why_new=review (state matrix: unmount x idle close with a pending tune); seam=none; no_claim=none beyond protects
  it("does not resend after unmount", async () => {
    const { result, unmount } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("stopped", { message: "Stopped." }));
    await act(() => result.current.tune(tuning));
    unmount();
    await act(async () => ws!.finishClose(IDLE_CLOSE_CODE));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  // Value: protects=a close of any kind after unmount, with nothing pending, opens no new socket and doesn't throw; a guard for a future reconnect-on-drop path, since none of these branches reconnects today; fails_when=a branch learns to reconnect without checking for unmount; why_new=state matrix close codes x after_unmount; seam=none; no_claim=React's handling of state set after unmount
  it.each([
    ["idle", IDLE_CLOSE_CODE],
    ["too-many", TOO_MANY_SOCKETS_CODE],
    ["any other", 1006],
  ])("opens nothing on a %s close after unmount", async (_label, code) => {
    const { result, unmount } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("listening"));
    unmount();
    expect(() => act(() => ws!.finishClose(code))).not.toThrow();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  // Value: protects=an idle hang-up landing after Stop, with nothing pending, leaves the page stopped and opens nothing; fails_when=the live-socket guard is dropped or moved below the idle branch; why_new=state matrix code_4000 (nothing pending) x after_stop; seam=none; no_claim=none beyond protects
  it("stays stopped on an idle hang-up after Stop", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("listening"));
    act(() => result.current.stop());
    act(() => ws!.finishClose(IDLE_CLOSE_CODE));
    expect(result.current.status).toEqual({ state: "idle" });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  // Value: protects=an idle hang-up with no tune pending opens no new socket; fails_when=the retry fires without a pending tune; why_new=owner D2; seam=none; no_claim=none beyond protects
  it("does not reconnect on an idle hang-up with nothing pending", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.status("stopped", { message: "Stopped." }));
    await act(async () => ws!.finishClose(IDLE_CLOSE_CODE));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  // Value: protects=a socket the service refuses for too many connections from this address explains that, instead of "Lost the connection"; fails_when=onclose treats the code like any drop; why_new=owner D3 (per-address socket cap); seam=none; no_claim=the service's counting (radio tests)
  it("explains a socket refused for too many connections", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => ws!.finishClose(TOO_MANY_SOCKETS_CODE));
    expect(result.current.status.state).toBe("error");
    expect(result.current.status.message).toMatch(/Too many radio connections/);
    expect(result.current.tuning).toBe(false);
  });

  // Value: protects=a too-many refusal that lands after Stop isn't reported: Stop lets go of the socket, so its late close is ignored like any other; fails_when=the live-socket guard in onclose is dropped or moved below the 4001 branch; why_new=coverage audit question (4001 after Stop); seam=none; no_claim=the service's counting
  it("does not explain a too-many refusal after Stop", async () => {
    const { result } = renderHook(() => useRadio());
    await act(() => result.current.tune(tuning));
    const [ws] = FakeSocket.instances;
    act(() => result.current.stop());
    const before = result.current.status;
    act(() => ws!.finishClose(TOO_MANY_SOCKETS_CODE));
    expect(result.current.status.message ?? "").not.toMatch(/Too many radio connections/);
    expect(result.current.status).toEqual(before);
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

  describe("tuning and heardAudio", () => {
    // Value: protects=the map waits for real sound and never mounts mid-connect; fails_when=tuning stays false while audio or the socket starts, or clears before the service answers; why_new=O2 idle gate and R7 first-audio gate; seam=workletReady; no_claim=real audio output
    it("is tuning from the click until the service answers", async () => {
      let finishAudio!: () => void;
      workletReady = new Promise((resolve) => (finishAudio = resolve));
      const { result } = renderHook(() => useRadio());
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.tune(tuning);
      });
      expect(result.current.tuning).toBe(true);
      expect(result.current.status.state).toBe("idle");
      await act(async () => {
        finishAudio();
        await pending;
      });
      expect(result.current.tuning).toBe(true);
      act(() => FakeSocket.instances[0]!.status("connecting"));
      expect(result.current.tuning).toBe(false);
    });

    it("stops tuning when Stop replaces the tune or the socket drops", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      expect(result.current.tuning).toBe(true);
      act(() => result.current.stop());
      expect(result.current.tuning).toBe(false);

      await act(() => result.current.tune(tuning));
      act(() => FakeSocket.instances[1]!.finishClose());
      expect(result.current.tuning).toBe(false);
    });

    // Value: protects=a switch stays "tuning" until the new receiver answers, and the old receiver's sound doesn't count; fails_when=any status (a late answer to a dial retune on the last receiver) ends the tune; why_new=red team R1, the map's mount gate relies on it; seam=none; no_claim=real service timing
    it("isn't ended by a late answer about the last receiver", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening", { host: "kiwi.example", port: 8073 }));

      await act(() => result.current.tune({ ...tuning, host: "other.example" }));
      act(() => ws.status("listening", { host: "kiwi.example", port: 8073 }));
      act(() => ws.frame(3, new Int16Array([1, 2])));
      expect(result.current.tuning).toBe(true);
      expect(result.current.heardAudio).toBe(false);

      // The old receiver dropping as we leave it (a coded error) doesn't end it...
      act(() => ws.status("error", { message: "gone", code: "down", host: "kiwi.example", port: 8073 }));
      expect(result.current.tuning).toBe(true);
      // ...but a rejected tune does, though the service names the old receiver on it.
      act(() => ws.status("error", { message: "bad", host: "kiwi.example", port: 8073 }));
      expect(result.current.tuning).toBe(false);

      await act(() => result.current.tune({ ...tuning, host: "other.example" }));
      act(() => ws.status("connecting", { host: "other.example", port: 8073 }));
      expect(result.current.tuning).toBe(false);
    });

    // Value: protects=the pending match ignores host case (the service lowercases it) but not the port; fails_when=the case fold is dropped (a mixed-case host never ends its tune) or the port is ignored (a late answer for the old port ends the new tune); why_new=testing review pass 2; seam=none; no_claim=none beyond protects
    it("matches the service's lowercased host, and tells ports apart", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune({ ...tuning, host: "KiwiSDR.Example" }));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening", { host: "kiwisdr.example", port: 8073 }));
      expect(result.current.tuning).toBe(false);

      await act(() => result.current.tune({ ...tuning, host: "kiwisdr.example", port: 8074 }));
      act(() => ws.status("listening", { host: "kiwisdr.example", port: 8073 }));
      expect(result.current.tuning).toBe(true);
      act(() => ws.status("listening", { host: "kiwisdr.example", port: 8074 }));
      expect(result.current.tuning).toBe(false);
    });
    // Value: protects=a tune that fails before the service answers stops counting as connecting, so the table's ring and the page's pending receiver clear on the error; fails_when=either catch in tune() (audio blocked, service unreachable) leaves tuning set; why_new=only Stop and a socket drop were checked; seam=FakeSocket subclass that errors instead of opening; no_claim=real browser autoplay or network errors
    it("stops tuning when audio is blocked or the service can't be reached", async () => {
      workletReady = Promise.reject(new Error("blocked"));
      workletReady.catch(() => {});
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      expect(result.current.status.message).toMatch(/blocked audio/);
      expect(result.current.tuning).toBe(false);

      workletReady = Promise.resolve();
      class Unreachable extends FakeSocket {
        constructor(url: string) {
          super(url);
          // Never opens: the queued open finds no handler, then the error lands.
          Object.defineProperty(this, "onopen", { get: () => null, set: () => {} });
          queueMicrotask(() => this.onerror?.());
        }
      }
      vi.stubGlobal("WebSocket", Unreachable);
      await act(() => result.current.tune(tuning));
      expect(result.current.status.message).toMatch(/Can't reach the radio service/);
      expect(result.current.tuning).toBe(false);
    });

    // Value: protects=a radio service that never answers ends in an error, not an endless "Connecting…"; fails_when=ensureSocket has no deadline of its own; why_new=Codex adversarial (PR 1); seam=a socket double that never opens, fake timers; no_claim=the browser's own network timeouts
    it("gives up on a radio service that never answers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        class Silent extends FakeSocket {
          #state = FakeSocket.CONNECTING;
          constructor(url: string) {
            super(url);
            Object.defineProperty(this, "onopen", { get: () => null, set: () => {} });
            // The double's queued open can't move it out of CONNECTING; close() still can.
            Object.defineProperty(this, "readyState", {
              get: () => this.#state,
              set: (v: number) => {
                if (v !== FakeSocket.OPEN) this.#state = v;
              },
            });
          }
        }
        vi.stubGlobal("WebSocket", Silent);
        const { result } = renderHook(() => useRadio());
        let pending!: Promise<void>;
        act(() => {
          pending = result.current.tune(tuning);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(9_999);
        });
        expect(result.current.tuning).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
          await pending;
        });
        expect(result.current.status.message).toMatch(/Can't reach the radio service/);
        expect(result.current.tuning).toBe(false);
        expect(FakeSocket.instances[0]!.readyState).toBe(FakeSocket.CLOSING);
      } finally {
        vi.useRealTimers();
      }
    });

    // Value: protects=a second tune waiting on a socket that never opens also gives up; fails_when=a waiter on a CONNECTING socket listens only for open/error and the timeout's close() fires just "close"; why_new=Codex adversarial + structured review (PR 2a); seam=a socket double whose close() fires only "close", fake timers; no_claim=which events a given browser fires
    it("gives up on every tune waiting for a radio service that never answers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        class Silent extends FakeSocket {
          #state = FakeSocket.CONNECTING;
          #closeListeners: (() => void)[] = [];
          constructor(url: string) {
            super(url);
            Object.defineProperty(this, "onopen", { get: () => null, set: () => {} });
            Object.defineProperty(this, "readyState", {
              get: () => this.#state,
              set: (v: number) => {
                if (v !== FakeSocket.OPEN) this.#state = v;
              },
            });
          }
          addEventListener(...[type, fn]: unknown[]) {
            if (type === "close") this.#closeListeners.push(fn as () => void);
          }
          close() {
            super.close();
            for (const fn of this.#closeListeners) fn();
          }
        }
        vi.stubGlobal("WebSocket", Silent);
        const { result } = renderHook(() => useRadio());
        let first!: Promise<void>;
        let second!: Promise<void>;
        // The first tune opens the socket; the second arrives while it's still connecting.
        await act(async () => {
          first = result.current.tune(tuning);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(FakeSocket.instances).toHaveLength(1);
        await act(async () => {
          second = result.current.tune({ ...tuning, host: "other.example" });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(FakeSocket.instances).toHaveLength(1);
        let settled = false;
        void second.finally(() => (settled = true));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
          await first;
        });
        expect(settled).toBe(true);
        expect(result.current.tuning).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    // Value: protects=a newer service's unknown error code still ends a tune it rejects; fails_when=the rejection check reads the raw code instead of the codes this build knows; why_new=Claude + Codex review (PR 1); seam=none; no_claim=which codes a future service sends
    it("treats a rejection with an unknown code as ending the tune", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening", { host: "kiwi.example", port: 8073 }));
      await act(() => result.current.tune({ ...tuning, host: "other.example" }));
      act(() => ws.status("error", { message: "new rule", code: "brand_new_code", host: "kiwi.example", port: 8073 }));
      expect(result.current.tuning).toBe(false);
    });

    // Value: protects=dial moves while a tune starts reach the service; fails_when=tune() sends the frequency from the click, or retune drops changes before the socket opens; why_new=red team (PR 1): cold-start dial changes were lost; seam=workletReady; no_claim=the service's own retune handling
    it("sends the latest frequency when the dial moves while a tune starts", async () => {
      let finishAudio!: () => void;
      workletReady = new Promise((resolve) => (finishAudio = resolve));
      const { result } = renderHook(() => useRadio());
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.tune(tuning);
      });
      act(() => result.current.retune({ ...tuning, freqKhz: 7_100, mode: "lsb" }));
      // A retune for some other receiver doesn't rewrite this tune.
      act(() => result.current.retune({ ...tuning, host: "elsewhere.example", freqKhz: 1 }));
      await act(async () => {
        finishAudio();
        await pending;
      });
      const [ws] = FakeSocket.instances;
      expect(ws!.sent).toEqual([{ type: "tune", ...tuning, freqKhz: 7_100, mode: "lsb" }]);
    });

    // Value: protects=a dial move made while a switch waits on audio, and already answered by the service, isn't undone by the switch's own late send; fails_when=tune() sends its click-time tuning after its tune was answered; why_new=Claude adversarial (PR 2a /ship), TODO "Don't let a late tune undo a dial move made mid-switch"; seam=a stalled AudioContext.resume; no_claim=how often browsers stall resume
    it("doesn't undo a dial move the service already answered mid-switch", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening", { host: tuning.host, port: tuning.port }));

      let finishResume!: () => void;
      vi.spyOn(FakeAudioContext.prototype, "resume").mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishResume = resolve)),
      );
      const other = { ...tuning, host: "other.example" };
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.tune(other);
      });
      // The dial moves while audio wakes; the socket is open, so it goes at once and is answered.
      act(() => result.current.retune({ ...other, freqKhz: 7_100 }));
      act(() => ws.status("listening", { host: "other.example", port: tuning.port }));
      await act(async () => {
        finishResume();
        await pending;
      });
      expect(ws.sent.at(-1)).toEqual({ type: "tune", ...other, freqKhz: 7_100 });
    });

    // Value: protects=a switch whose socket dropped still tunes on the new one, at the dial's newest frequency; fails_when=the skip checks "a dial move went out" rather than "on this socket", or the dropped socket's cleanup loses the dial move so the click-time frequency goes out; why_new=the skip's per-socket condition was untested (PR 2b review); frequency from TODO "Keep a dial move made mid-switch when the connection drops"; seam=a stalled AudioContext.resume; no_claim=what the page shows for the dropped socket
    it("still tunes on a new socket, at the newest frequency, when the one a dial move went out on dropped", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening", { host: tuning.host, port: tuning.port }));

      let finishResume!: () => void;
      vi.spyOn(FakeAudioContext.prototype, "resume").mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishResume = resolve)),
      );
      const other = { ...tuning, host: "other.example" };
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.tune(other);
      });
      act(() => result.current.retune({ ...other, freqKhz: 7_100 }));
      act(() => ws.finishClose());
      await act(async () => {
        finishResume();
        await pending;
      });
      const fresh = FakeSocket.instances[1]!;
      expect(fresh.sent).toEqual([{ type: "tune", ...other, freqKhz: 7_100 }]);
    });

    // Value: protects=going back to a receiver still sends that tune when a late answer for it (from earlier dial moves) arrives mid-switch; fails_when=the late-send skip treats any answer naming the receiver as this tune's answer, so "Back to A" leaves the service on B; why_new=red team (PR 2b ship); seam=a stalled AudioContext.resume; no_claim=service ordering
    it("still sends a switch back when a stale answer for that receiver arrives first", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("listening", { host: tuning.host, port: tuning.port }));
      const other = { ...tuning, host: "other.example" };
      await act(() => result.current.tune(other));

      let finishResume!: () => void;
      vi.spyOn(FakeAudioContext.prototype, "resume").mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishResume = resolve)),
      );
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.tune(tuning);
      });
      // An answer to an earlier dial move on the first receiver, still in flight.
      act(() => ws.status("listening", { host: tuning.host, port: tuning.port }));
      await act(async () => {
        finishResume();
        await pending;
      });
      expect(ws.sent.at(-1)).toEqual({ type: "tune", ...tuning });
    });

    // Value: protects=first audio means sound from this receiver; fails_when=spectrum rows, junk frames or the last receiver's audio count; why_new=R7 first-audio gate; seam=none; no_claim=none beyond protects
    it("hears audio only after the service answers the latest tune", async () => {
      const { result } = renderHook(() => useRadio());
      await act(() => result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.frame(3, new Int16Array([1, 2])));
      expect(result.current.heardAudio).toBe(false);

      act(() => ws.status("listening"));
      act(() => ws.frame(4, new Uint8Array(4)));
      act(() => ws.frame(9, new Uint8Array(4)));
      expect(result.current.heardAudio).toBe(false);
      act(() => ws.frame(1, new Float32Array([0.1])));
      expect(result.current.heardAudio).toBe(true);

      // Switching receivers: the old one's audio still arriving doesn't count.
      await act(() => result.current.tune({ ...tuning, host: "other.example" }));
      expect(result.current.heardAudio).toBe(false);
      act(() => ws.frame(3, new Int16Array([1, 2])));
      expect(result.current.heardAudio).toBe(false);
      act(() => ws.status("connecting"));
      act(() => ws.status("listening"));
      act(() => ws.frame(3, new Int16Array([1, 2])));
      expect(result.current.heardAudio).toBe(true);
    });

    it("forgets the audio on an error, Stop or a drop", async () => {
      const { result } = renderHook(() => useRadio());
      const hear = async () => {
        await act(() => result.current.tune(tuning));
        const ws = FakeSocket.instances.at(-1)!;
        act(() => ws.status("listening"));
        act(() => ws.frame(3, new Int16Array([1])));
        expect(result.current.heardAudio).toBe(true);
        return ws;
      };
      const ws = await hear();
      act(() => ws.status("error", { message: "gone" }));
      expect(result.current.heardAudio).toBe(false);

      await hear();
      act(() => result.current.stop());
      expect(result.current.heardAudio).toBe(false);

      const third = await hear();
      act(() => third.finishClose());
      expect(result.current.heardAudio).toBe(false);
    });
  });

  describe("band scan", () => {
    const at = { host: tuning.host, port: tuning.port };
    const scanReply = (ws: FakeSocket, payload: Record<string, unknown>) =>
      ws.onmessage?.({ data: JSON.stringify({ type: "scan", ...at, ...payload }) });
    const done = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      state: "done",
      signals: [{ freqKhz: 9_420, snrDb: 30, band: "31m" }],
      hidden: 1,
      bandsDone: 15,
      bandsTotal: 15,
      partial: false,
      atMs: 1,
      ...extra,
    });

    // null: a service from before the scan, whose statuses have no features field.
    async function listening(features: string[] | null = ["scan"]) {
      const hook = renderHook(() => useRadio());
      await act(() => hook.result.current.tune(tuning));
      const ws = FakeSocket.instances.at(-1)!;
      act(() => ws.status("listening", { ...at, ...(features && { features }) }));
      return { ...hook, ws };
    }

    // Value: protects=a service that doesn't list "scan" is never sent one (it would answer with a status error and stop the page listening); fails_when=startScan ignores features; why_new=mixed-version deploys (eng review D13, Codex O3); seam=none; no_claim=deploy timing
    it("asks only a service that says it can scan", async () => {
      const old = await listening(null);
      expect(old.result.current.canScan).toBe(false);
      act(() => old.result.current.startScan());
      expect(old.ws.sent.filter((m) => m.type === "scan")).toEqual([]);

      const fresh = await listening();
      expect(fresh.result.current.canScan).toBe(true);
      act(() => fresh.result.current.startScan(true));
      expect(fresh.ws.sent.at(-1)).toEqual({ type: "scan", id: expect.any(Number), fresh: true });
      expect(fresh.result.current.scan).toEqual({ state: "scanning", ...at });
    });

    // Value: protects=the reply for the newest request and receiver fills the list; older or other-receiver replies are ignored (D16); fails_when=replies are applied without the id and host/port checks; why_new=Codex O6; seam=none; no_claim=network ordering
    it("applies only the newest request's reply for this receiver", async () => {
      const { result, ws } = await listening();
      act(() => result.current.startScan());
      const first = ws.sent.at(-1)!.id as number;
      act(() => result.current.startScan(true));
      const second = ws.sent.at(-1)!.id as number;
      act(() => scanReply(ws, done(first)));
      expect(result.current.scan?.state).toBe("scanning");
      act(() => scanReply(ws, { ...done(second), host: "other.example" }));
      expect(result.current.scan?.state).toBe("scanning");
      act(() => scanReply(ws, done(second)));
      expect(result.current.scan).toMatchObject({ state: "done", hidden: 1, signals: [{ freqKhz: 9_420 }] });
      act(() => scanReply(ws, { id: second, state: "error", message: "nope" }));
      expect(result.current.scan).toEqual({ state: "error", ...at, message: "nope" });
    });

    // Value: protects=a done reply's malformed signal rows are dropped and missing counts default, and one with no signals list is ignored; fails_when=the row filter or defaults go, so the list renders undefined frequencies or NaN counts, or a bare done clears Scanning…; why_new=only well-formed replies were tested; seam=none; no_claim=what an older or buggy service actually sends
    it("keeps only well-formed signals from a done reply", async () => {
      const { result, ws } = await listening();
      act(() => result.current.startScan());
      const id = ws.sent.at(-1)!.id as number;
      act(() => scanReply(ws, { id, state: "done" }));
      expect(result.current.scan).toEqual({ state: "scanning", ...at });
      act(() =>
        scanReply(ws, {
          id,
          state: "done",
          signals: [{ freqKhz: 9_420, snrDb: 30, band: "31m" }, { freqKhz: "9425", snrDb: 20, band: "31m" }, null],
        }),
      );
      expect(result.current.scan).toEqual({
        state: "done",
        ...at,
        signals: [{ freqKhz: 9_420, snrDb: 30, band: "31m" }],
        hidden: 0,
        bandsDone: 0,
        bandsTotal: 0,
        partial: false,
      });
    });

    // Value: protects=a scan error never touches the radio status (D5); fails_when=scan errors are routed into setStatus; why_new=D5; seam=none; no_claim=service behaviour
    it("keeps listening when a scan fails", async () => {
      const { result, ws } = await listening();
      act(() => result.current.startScan());
      act(() => scanReply(ws, { id: ws.sent.at(-1)!.id, state: "error", message: "Couldn't scan" }));
      expect(result.current.status.state).toBe("listening");
      expect(result.current.scan?.state).toBe("error");
    });

    // Value: protects=a scan the service dropped with its receiver connection doesn't linger: after an error or stop and a reconnect to the same receiver the list is clear, so a new scan can start; fails_when=only a switch to another receiver clears it, leaving "Scanning…" for good; why_new=bug review; seam=none; no_claim=service timing
    it("clears a scan whose receiver stopped listening, even when the same receiver comes back", async () => {
      const { result, ws } = await listening();
      act(() => result.current.startScan());
      act(() => ws.status("error", { ...at, code: "closed", features: ["scan"] }));
      expect(result.current.scan).toBeNull();
      act(() => ws.status("listening", { ...at, features: ["scan"] }));
      expect(result.current.scan).toBeNull();
      act(() => result.current.startScan());
      const id = ws.sent.at(-1)!.id as number;
      act(() => scanReply(ws, done(id)));
      act(() => ws.status("stopped", { ...at, features: ["scan"] }));
      expect(result.current.scan).toBeNull();
    });

    // Value: protects=switching receivers, stopping or losing the service clears the list, and a late reply can't bring it back; fails_when=the list survives a switch, so its stations look like the new receiver's; why_new=D16; seam=none; no_claim=none beyond protects
    it("clears the list on a switch, a stop and a dropped connection", async () => {
      const { result, ws } = await listening();
      act(() => result.current.startScan());
      const id = ws.sent.at(-1)!.id as number;
      act(() => scanReply(ws, done(id)));
      await act(() => result.current.tune({ ...tuning, freqKhz: 9_420 }));
      expect(result.current.scan?.state).toBe("done"); // a retune of the same receiver keeps it
      await act(() => result.current.tune({ ...tuning, host: "other.example" }));
      expect(result.current.scan).toBeNull();
      act(() => scanReply(ws, done(id)));
      expect(result.current.scan).toBeNull();

      const again = await listening();
      act(() => again.result.current.startScan());
      act(() => again.result.current.stop());
      expect(again.result.current.scan).toBeNull();
      expect(again.result.current.canScan).toBe(true);

      const third = await listening();
      act(() => third.result.current.startScan());
      act(() => third.ws.finishClose());
      expect(third.result.current.scan).toBeNull();
      expect(third.result.current.canScan).toBe(false);
    });
  });

  describe("the service's settled tuning", () => {
    const on = { host: "kiwi.example", port: 8073 };
    async function playing() {
      const hook = renderHook(() => useRadio());
      await act(() => hook.result.current.tune(tuning));
      const ws = FakeSocket.instances[0]!;
      act(() => ws.status("connecting", on));
      act(() => ws.status("listening", { ...on, freqKhz: 10_000, mode: "am" }));
      return { ...hook, ws };
    }

    // Value: protects=a status's tuning reaches the page only when it is usable (a finite number in tuning range, a known mode); fails_when=handleText passes junk the dial would show; why_new=web dial revert (Codex: unchecked freqKhz); seam=FakeSocket; no_claim=what the service sends
    it("passes a status's tuning on, dropping values it can't use", async () => {
      const { result, ws } = await playing();
      expect(result.current.status).toMatchObject({ freqKhz: 10_000, mode: "am" });
      act(() => ws.status("listening", { ...on, freqKhz: "9535", mode: "fm" }));
      expect(result.current.status.freqKhz).toBeUndefined();
      expect(result.current.status.mode).toBeUndefined();
      act(() => ws.status("listening", { ...on, freqKhz: 99_999 }));
      expect(result.current.status.freqKhz).toBeUndefined();
    });

    // Value: protects=after a refused retune (an uncoded error, then the status still playing) or a failed one (just the status), the settled tuning is the one still playing, and after a retune it took it is the new one; a status nobody asked for settles nothing; fails_when=the hook settles before every tune is answered, resets on a refusal's error, or settles on the service's own start-up status; why_new=TODO "Revert the web dial when the service refuses a retune" and owner D1 (round 3d); seam=FakeSocket; no_claim=the service's answers (radio tests)
    it.each([
      ["refused", [["error", { message: "Port must be between 1 and 65535." }], ["listening", { freqKhz: 10_000, mode: "am" }]], 10_000],
      ["failed", [["listening", { freqKhz: 10_000, mode: "am" }]], 10_000],
      ["taken", [["listening", { freqKhz: 9_535, mode: "am" }]], 9_535],
    ] as const)("settles on the service's tuning after a %s retune", async (_, answers, khz) => {
      const { result, ws } = await playing();
      expect(result.current.settled).toBeNull();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_535 }));
      for (const [state, extra] of answers) act(() => ws.status(state, { ...on, ...extra }));
      expect(result.current.settled).toEqual({ freqKhz: khz, mode: "am" });
    });

    // Value: protects=two refused retunes in a row each settle back on the playing tuning (each error is followed by its status, so neither is taken for an ending); fails_when=the refusal flag outlives the status that answers it; why_new=round 3d web review pass 2 (mutation survived); seam=FakeSocket; no_claim=none beyond protects
    it("settles after each of two refusals in a row", async () => {
      const { result, ws } = await playing();
      for (const khz of [9_535, 9_540]) {
        act(() => result.current.retune({ ...tuning, freqKhz: khz }));
        act(() => ws.status("error", { ...on, message: "refused" }));
        act(() => ws.status("listening", { ...on, freqKhz: 10_000 + khz - 9_535, mode: "am" }));
        expect(result.current.settled).toEqual({ freqKhz: 10_000 + khz - 9_535, mode: "am" });
      }
    });

    // Value: protects=answers are counted per message, so two that arrive together (one render) still settle exactly once, on the last; fails_when=counting moves back into a per-render effect; why_new=round 3d web review (React batching lost a decrement); seam=FakeSocket, two statuses in one act; no_claim=real browser batching
    it("counts answers per message, even two in one render", async () => {
      const { result, ws } = await playing();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_535 }));
      act(() => result.current.retune({ ...tuning, freqKhz: 9_540 }));
      act(() => ws.status("listening", { ...on, freqKhz: 9_535, mode: "am" }));
      expect(result.current.settled).toBeNull(); // one still owed
      act(() => {
        result.current.retune({ ...tuning, freqKhz: 9_545 });
        ws.status("listening", { ...on, freqKhz: 9_540, mode: "am" });
        ws.status("listening", { ...on, freqKhz: 10_000, mode: "am" });
      });
      expect(result.current.settled).toEqual({ freqKhz: 10_000, mode: "am" });
    });

    // Value: protects=a tune of the receiver already playing (a list click, Pick best) is owed an answer like a dial retune, so an older retune's answer can't settle the dial before it; fails_when=only retune() counts; why_new=round 3d web review (a stale answer overwrote a newer tune); seam=FakeSocket; no_claim=none beyond protects
    it("counts a tune of the playing receiver too", async () => {
      const { result, ws } = await playing();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_535 }));
      await act(() => result.current.tune({ ...tuning, freqKhz: 9_540 }));
      act(() => ws.status("listening", { ...on, freqKhz: 9_535, mode: "am" }));
      expect(result.current.settled).toBeNull();
      act(() => ws.status("listening", { ...on, freqKhz: 9_540, mode: "am" }));
      expect(result.current.settled).toEqual({ freqKhz: 9_540, mode: "am" });
    });

    // Value: protects=nothing is owed for a tune sent while the service wasn't playing (its start-up "listening" answers nothing), and a coded ending, a new connection or a dropped socket forgets what was owed, so a later session's first status can't settle the dial; fails_when=the count survives those or counts tunes sent while connecting; why_new=web dial revert; seam=FakeSocket; no_claim=none beyond protects
    it.each([
      ["a coded ending", (ws: FakeSocket) => ws.status("error", { ...on, code: "closed", message: "x" })],
      ["a new connection", (ws: FakeSocket) => ws.status("connecting", on)],
      ["a stop", (ws: FakeSocket) => ws.status("stopped", on)],
    ])("owes nothing after %s", async (_, end) => {
      const { result, ws } = await playing();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_535 }));
      act(() => end(ws));
      act(() => result.current.retune({ ...tuning, freqKhz: 9_540 })); // not playing: owed nothing
      act(() => ws.status("listening", { ...on, freqKhz: 7_000, mode: "am" }));
      expect(result.current.settled).toBeNull();
      // Only the next retune is owed, so its answer settles at once.
      act(() => result.current.retune({ ...tuning, freqKhz: 9_545 }));
      act(() => ws.status("listening", { ...on, freqKhz: 7_000, mode: "am" }));
      expect(result.current.settled).toEqual({ freqKhz: 7_000, mode: "am" });
    });

    // Value: protects=an uncoded error that nothing follows (an ending, or a refused Listen with nothing playing) and Stop both forget what was owed, so a later "listening" can't settle on it; only a status right after the error counts as a refusal's answer; fails_when=the count survives an uncoded error followed by something else, or Stop; why_new=round 3d web review pass 2 (Claude, Codex); seam=FakeSocket; no_claim=none beyond protects
    it.each([
      ["an uncoded error nothing follows", (ws: FakeSocket) => {
        ws.status("error", { message: "Something broke in the radio service. Check its logs." });
        ws.status("error", { message: "The radio service is at its listener limit." });
      }],
      ["Stop", (_: FakeSocket, stop: () => void) => stop()],
    ])("owes nothing after %s", async (_, end) => {
      const { result, ws } = await playing();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_535 }));
      act(() => end(ws, result.current.stop));
      await act(() => result.current.tune(tuning)); // nothing playing: owed nothing
      const live = FakeSocket.instances.at(-1)!;
      act(() => live.status("listening", { ...on, freqKhz: 10_000, mode: "am" }));
      expect(result.current.settled).toBeNull();
      // The next retune is the only one owed, so its answer settles at once.
      act(() => result.current.retune({ ...tuning, freqKhz: 9_540 }));
      act(() => live.status("listening", { ...on, freqKhz: 10_000, mode: "am" }));
      expect(result.current.settled).toEqual({ freqKhz: 10_000, mode: "am" });
    });

    // Value: protects=a dropped socket forgets what was owed; fails_when=onclose leaves the count; why_new=web dial revert; seam=FakeSocket; no_claim=none beyond protects
    it("owes nothing after the socket drops", async () => {
      const { result, ws } = await playing();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_535 }));
      act(() => ws.finishClose());
      await act(() => result.current.tune(tuning));
      const next = FakeSocket.instances[1]!;
      act(() => next.status("listening", { ...on, freqKhz: 10_000, mode: "am" }));
      expect(result.current.settled).toBeNull();
      act(() => result.current.retune({ ...tuning, freqKhz: 9_540 }));
      act(() => next.status("listening", { ...on, freqKhz: 10_000, mode: "am" }));
      expect(result.current.settled).toEqual({ freqKhz: 10_000, mode: "am" });
    });
  });
});
