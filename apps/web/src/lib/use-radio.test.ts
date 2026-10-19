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

  send() {}
  addEventListener() {}

  close() {
    this.readyState = FakeSocket.CLOSING;
  }

  finishClose() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  status(state: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "status", state, sampleRate: 12000 }) });
  }
}

const workletMessages = vi.fn();

class FakeAudioContext {
  audioWorklet = { addModule: async () => {} };
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
});
