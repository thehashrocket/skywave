// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@/lib/kiwi-list";
import type { RadioStatus } from "@/lib/use-radio";

const radio = {
  status: { state: "idle" } as RadioStatus,
  meter: null,
  tune: vi.fn(async () => {}),
  retune: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
  onSpectrum: () => () => {},
};

vi.mock("@/lib/use-radio", () => ({ useRadio: () => radio }));
// These talk to tRPC or draw on a canvas; the page's own wiring is what's under test.
vi.mock("@/components/Presets", () => ({ Presets: () => null }));
vi.mock("@/components/Waterfall", () => ({ Waterfall: () => null }));

const listed: Receiver = {
  id: "k1vl",
  name: "K1VL",
  location: "Vermont",
  antenna: "doublet",
  host: "sdr.k1vl.com",
  port: 8076,
  users: 1,
  usersMax: 8,
  snr: 30,
  minKhz: 0,
  maxKhz: 30_000,
};
const backup: Receiver = { ...listed, id: "backup", name: "Backup", host: "backup.example", port: 8073 };

vi.mock("@/components/ReceiverPicker", () => ({
  ReceiverPicker: ({
    open,
    onChoose,
    onPickBest,
    onStopPicking,
  }: {
    open: boolean;
    onChoose: (r: Receiver) => void;
    onPickBest: (r: Receiver[]) => void;
    onStopPicking: () => void;
  }) => (
    <>
      <output aria-label="browse">{open ? "open" : "closed"}</output>
      <button type="button" onClick={() => onChoose(listed)}>
        choose listed
      </button>
      <button type="button" onClick={() => onPickBest([listed, backup])}>
        pick best
      </button>
      <button type="button" onClick={onStopPicking}>
        stop picking
      </button>
    </>
  ),
}));

const { default: ListenPage } = await import("./page");

beforeEach(() => {
  localStorage.clear();
  radio.status = { state: "idle" };
  radio.tune.mockClear();
  radio.stop.mockClear();
});

afterEach(cleanup);

describe("ListenPage", () => {
  it("normalizes a pasted URL, tunes it, and remembers it once it plays", () => {
    const view = render(<ListenPage />);
    const host = screen.getByLabelText("Receiver") as HTMLInputElement;
    fireEvent.change(host, { target: { value: "http://f4kiy.ddns.net:8074/" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));

    expect(radio.tune).toHaveBeenCalledWith({ host: "f4kiy.ddns.net", port: 8074, freqKhz: 10_000, mode: "am" });
    expect(host.value).toBe("f4kiy.ddns.net");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("8074");
    // A typo or dead receiver shouldn't become the saved default.
    expect(localStorage.getItem("skywave.receiver")).toBeNull();

    radio.status = { state: "listening", host: "f4kiy.ddns.net", port: 8074 };
    view.rerender(<ListenPage />);
    expect(JSON.parse(localStorage.getItem("skywave.receiver")!)).toEqual({ host: "f4kiy.ddns.net", port: "8074" });
  });

  it("tunes a receiver chosen from the list, even while listening, and saves it once it plays", () => {
    radio.status = { state: "listening", host: "f4kiy.ddns.net", port: 8073 };
    const view = render(<ListenPage />);
    localStorage.clear();
    fireEvent.click(screen.getByRole("button", { name: "choose listed" }));

    expect(radio.tune).toHaveBeenCalledWith({
      host: "sdr.k1vl.com",
      port: 8076,
      freqKhz: 10_000,
      mode: "am",
      source: "list",
    });
    expect((screen.getByLabelText("Receiver") as HTMLInputElement).value).toBe("sdr.k1vl.com");
    expect(localStorage.getItem("skywave.receiver")).toBeNull();

    radio.status = { state: "listening", host: "sdr.k1vl.com", port: 8076 };
    view.rerender(<ListenPage />);
    expect(JSON.parse(localStorage.getItem("skywave.receiver")!)).toEqual({
      host: "sdr.k1vl.com",
      port: "8076",
      fromList: true,
    });
  });

  // Value: protects=a failed Pick best run leaves no dead receiver saved; fails_when=tuneReceiver saves before the receiver plays; why_new=no test covered a chain that fails; seam=none; no_claim=real browser storage
  it("doesn't save receivers that Pick best tried and abandoned", () => {
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);
    expect(localStorage.getItem("skywave.receiver")).toBeNull();
  });

  // Value: protects=choosing from the list ends a running Pick best chain; fails_when=onChoose stops calling pickBest.cancel(), so a late busy overrides the user's choice; why_new=Stop was the only cancel path tested; seam=none; no_claim=real socket ordering
  it("choosing from the list ends Pick best, so a late failure doesn't override the choice", () => {
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
    radio.tune.mockClear();
    radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);
    expect(radio.tune).not.toHaveBeenCalled();
  });

  // Value: protects=a first-time visitor sees the receiver list open, a returning one doesn't get it in the way; fails_when=the first-visit setBrowseOpen(!host) is dropped or inverted; why_new=the picker mock ignored `open`; seam=none; no_claim=the details element's own toggle
  it("opens the receiver list on a first visit only", () => {
    render(<ListenPage />);
    expect(screen.getByLabelText("browse").textContent).toBe("open");
    cleanup();

    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "f4kiy.ddns.net", port: "8073" }));
    render(<ListenPage />);
    expect(screen.getByLabelText("browse").textContent).toBe("closed");
  });

  it("tunes Pick best's choice", () => {
    render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    expect(radio.tune).toHaveBeenCalledWith({
      host: "sdr.k1vl.com",
      port: 8076,
      freqKhz: 10_000,
      mode: "am",
      source: "list",
    });
  });

  // Value: protects=Pick best wired to live radio status in the page; fails_when=page stops feeding status to usePickBest or tuneReceiver drops the retry; why_new=hook test mocks tune, page test never changed status; seam=none; no_claim=real socket or server codes
  it("moves Pick best to the next receiver when the first is full", () => {
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);

    expect((radio.tune.mock.calls as unknown as [{ host: string }][]).map(([t]) => t.host)).toEqual([
      listed.host,
      backup.host,
    ]);
  });

  // Value: protects=Stop ends a running Pick best chain; fails_when=pickBest.cancel() is dropped from the form submit, so a late busy error tunes another receiver after Stop; why_new=no test pressed Stop mid-chain; seam=none; no_claim=server-side stop
  it("Stop ends Pick best, so a late failure doesn't tune another receiver", () => {
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    radio.status = { state: "connecting", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);

    expect(radio.stop).toHaveBeenCalledTimes(1);
    expect(radio.tune).toHaveBeenCalledTimes(1);
  });

  // Value: protects=a dial retune queued before a list choice can't switch the service back; fails_when=tuneReceiver stops clearing the retune timer; why_new=adversarial review found the race; seam=none; no_claim=real timer jitter
  it("drops a pending dial retune when a receiver is chosen from the list", () => {
    vi.useFakeTimers();
    try {
      radio.status = { state: "listening", host: "f4kiy.ddns.net", port: 8073 };
      render(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).not.toHaveBeenCalled();
      expect(radio.tune).toHaveBeenCalledWith(expect.objectContaining({ host: "sdr.k1vl.com" }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=Stop picking with nothing to go back to really stops; fails_when=stop only clears the chain and the first attempt connects later; why_new=Codex P1; seam=none; no_claim=server-side cancel timing
  it("Stop picking stops the attempt when nothing was playing before", () => {
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    radio.status = { state: "connecting", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "stop picking" }));
    expect(radio.stop).toHaveBeenCalledTimes(1);
  });

  // Value: protects=a list receiver stays public-only through Listen, a reload and dial retunes; fails_when=fromList isn't carried in state, storage or retune; why_new=adversarial review: the tag was lost through the host field; seam=none; no_claim=server enforcement (radio tests)
  it("keeps a list receiver tagged through Listen, reloads and retunes, until it's edited", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "sdr.k1vl.com", port: "8076", fromList: true }));
      const view = render(<ListenPage />);
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "sdr.k1vl.com", source: "list" }));

      radio.status = { state: "listening", host: "sdr.k1vl.com", port: 8076 };
      view.rerender(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).toHaveBeenCalledWith(expect.objectContaining({ source: "list" }));

      radio.status = { state: "idle" };
      view.rerender(<ListenPage />);
      // Retyping the address makes it the user's own.
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "sdr.k1vl.co" } });
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "sdr.k1vl.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      expect(radio.tune).toHaveBeenLastCalledWith({ host: "sdr.k1vl.com", port: 8076, freqKhz: 10_001, mode: "am" });
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a failed attempt isn't redialed by a dial retune queued just before it failed; fails_when=the timer stops re-checking that a tune is live; why_new=pass-3 red team; seam=none; no_claim=real socket timing
  it("drops a queued dial retune when the attempt fails first", () => {
    vi.useFakeTimers();
    try {
      radio.status = { state: "connecting", host: "f4kiy.ddns.net", port: 8073 };
      const view = render(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      radio.status = { state: "error", code: "blocked", message: "x", host: "f4kiy.ddns.net", port: 8073 };
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=Stop picking returns to a playing list receiver outside the candidates with its list tag; fails_when=the page stops passing wasListed or compares ports wrongly; why_new=pass-2 review: the hook test pointed at a page test that didn't exist; seam=none; no_claim=server enforcement
  it("goes back to a list receiver the candidates don't include, still tagged", () => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "far.example", port: "8073", fromList: true }));
    radio.status = { state: "listening", host: "far.example", port: 8073 };
    render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    fireEvent.click(screen.getByRole("button", { name: "stop picking" }));
    expect(radio.tune).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "far.example", port: 8073, source: "list" }),
    );
  });

  // Value: protects=a typed receiver's dial retunes carry no list tag; fails_when=fromList leaks into typed retunes; why_new=state matrix typed x dial-retune; seam=none; no_claim=server enforcement
  it("retunes a typed receiver without the list tag", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "f4kiy.ddns.net", port: "8073" }));
      radio.status = { state: "listening", host: "f4kiy.ddns.net", port: 8073 };
      render(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).toHaveBeenCalledWith({ host: "f4kiy.ddns.net", port: 8073, freqKhz: 10_001, mode: "am" });
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a dial retune queued just before Stop isn't sent after it; fails_when=the timer stops re-checking that a tune is live; why_new=state matrix pending-retune x stop; seam=none; no_claim=real timer jitter
  it("drops a queued dial retune when Stop is pressed", () => {
    vi.useFakeTimers();
    try {
      radio.status = { state: "listening", host: "f4kiy.ddns.net", port: 8073 };
      const view = render(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      radio.status = { state: "idle" };
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(500));
      expect(radio.stop).toHaveBeenCalledTimes(1);
      expect(radio.retune).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=leaving the host field splits a pasted URL and keeps a typed port; fails_when=onBlur normalize is removed or a port-less URL resets the port to 8073; why_new=existing test only covers Listen; seam=none; no_claim=server validation
  it("splits a pasted URL on blur and keeps the port when the URL has none", () => {
    render(<ListenPage />);
    const host = screen.getByLabelText("Receiver") as HTMLInputElement;
    const port = screen.getByLabelText("Port") as HTMLInputElement;
    fireEvent.change(port, { target: { value: "8074" } });
    fireEvent.change(host, { target: { value: "http://F4KIY.ddns.net/" } });
    fireEvent.blur(host);
    expect(host.value).toBe("f4kiy.ddns.net");
    expect(port.value).toBe("8074");

    fireEvent.change(host, { target: { value: "http://f4kiy.ddns.net:8075/" } });
    fireEvent.blur(host);
    expect(host.value).toBe("f4kiy.ddns.net");
    expect(port.value).toBe("8075");
    expect(radio.tune).not.toHaveBeenCalled();
  });
});
