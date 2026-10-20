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
    expect(result.current.status.message).toBe("kiwi.example is full.");
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
});
