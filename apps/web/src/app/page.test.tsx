// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@/lib/kiwi-list";
import type { RadioStatus, ScanState } from "@/lib/use-radio";

const radio = {
  status: { state: "idle" } as RadioStatus,
  meter: null,
  tuning: false,
  heardAudio: false,
  canScan: false,
  scan: null as ScanState | null,
  startScan: vi.fn(),
  tune: vi.fn(async () => {}),
  retune: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
  onSpectrum: () => () => {},
};

vi.mock("@/lib/use-radio", () => ({ useRadio: () => radio }));
// These talk to tRPC or draw on a canvas; the page's own wiring is what's under test.
vi.mock("@/components/Presets", () => ({ Presets: () => <output aria-label="presets" /> }));
vi.mock("@/components/Waterfall", () => ({ Waterfall: () => <output aria-label="waterfall" /> }));
vi.mock("@/components/MapPanel", () => ({
  MapPanel: ({
    admitted,
    last,
    onListen,
    onBrowse,
  }: {
    admitted: boolean;
    last: { host: string; port: number } | null;
    onListen: (r: Receiver) => void;
    onBrowse: () => void;
  }) => (
    <>
      <output aria-label="map admitted">{admitted ? "yes" : "no"}</output>
      <output aria-label="map last">{last ? `${last.host}:${last.port}` : "none"}</output>
      <button type="button" onClick={() => onListen(listed)}>
        map listen
      </button>
      <button type="button" onClick={onBrowse}>
        map browse
      </button>
    </>
  ),
}));

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
    current,
    sun,
    onChoose,
    onPickBest,
    onStopPicking,
    children,
    map,
  }: {
    open: boolean;
    current: { host: string; port: number; phase: string } | null;
    sun: unknown;
    children?: React.ReactNode;
    onChoose: (r: Receiver) => void;
    onPickBest: (r: Receiver[]) => void;
    onStopPicking: () => void;
    map?: (list: { receivers: Receiver[]; ageMs: number; failed: boolean; retry: () => void }) => React.ReactNode;
  }) => (
    <>
      <output aria-label="browse">{open ? "open" : "closed"}</output>
      <output aria-label="tuned">{current ? `${current.host}:${current.port}` : "none"}</output>
      <output aria-label="phase">{current?.phase ?? "none"}</output>
      <output aria-label="sun">{sun ? "set" : "none"}</output>
      <button type="button" onClick={() => onChoose(listed)}>
        choose listed
      </button>
      <button type="button" onClick={() => onPickBest([listed, backup])}>
        pick best
      </button>
      <button type="button" onClick={onStopPicking}>
        stop picking
      </button>
      {children}
      {map?.({ receivers: [listed, backup], ageMs: 0, failed: false, retry: () => {} })}
    </>
  ),
}));

const { default: ListenPage } = await import("./page");

beforeEach(() => {
  localStorage.clear();
  radio.status = { state: "idle" };
  radio.tuning = false;
  radio.heardAudio = false;
  radio.canScan = false;
  radio.scan = null;
  radio.startScan.mockClear();
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

  // Value: protects=a receiver that refuses apps after playing doesn't stay the saved default; fails_when=the no_apps check is dropped or forgets a receiver other than the saved one; why_new=Codex adversarial: the saved default kept refusing; seam=none; no_claim=what the fields show (they keep the host until the listener changes it)
  it("forgets the saved receiver when it refuses apps, but not for another receiver or another error", () => {
    const view = render(<ListenPage />);
    fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
    view.rerender(<ListenPage />);
    expect(JSON.parse(localStorage.getItem("skywave.receiver")!)).toEqual({ host: "kiwi.example", port: "8073" });

    radio.status = { state: "error", code: "busy", message: "full", host: "kiwi.example", port: 8073 };
    view.rerender(<ListenPage />);
    radio.status = { state: "error", code: "no_apps", message: "own page", host: "other.example", port: 8073 };
    view.rerender(<ListenPage />);
    expect(localStorage.getItem("skywave.receiver")).not.toBeNull();

    radio.status = { state: "error", code: "no_apps", message: "own page", host: "kiwi.example", port: 8073 };
    view.rerender(<ListenPage />);
    expect(localStorage.getItem("skywave.receiver")).toBeNull();
  });

  // Value: protects=a pasted https:// receiver is dialed over wss:// and stays secure after the field is normalized and saved; fails_when=normalizing a bare host drops the flag or typing a new host keeps it; why_new=wss dialing; seam=none; no_claim=the service's TLS (radio tests)
  it("dials a pasted https receiver securely, remembers that, and forgets it when the host is retyped", () => {
    const view = render(<ListenPage />);
    const host = screen.getByLabelText("Receiver") as HTMLInputElement;
    fireEvent.change(host, { target: { value: "https://kiwi.example.org/" } });
    fireEvent.blur(host);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(radio.tune).toHaveBeenLastCalledWith({
      host: "kiwi.example.org",
      port: 443,
      freqKhz: 10_000,
      mode: "am",
      secure: true,
    });

    radio.status = { state: "listening", host: "kiwi.example.org", port: 443 };
    view.rerender(<ListenPage />);
    expect(JSON.parse(localStorage.getItem("skywave.receiver")!)).toEqual({
      host: "kiwi.example.org",
      port: "443",
      secure: true,
    });

    radio.status = { state: "idle" };
    view.rerender(<ListenPage />);
    fireEvent.change(host, { target: { value: "other.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(radio.tune).toHaveBeenLastCalledWith({ host: "other.example", port: 443, freqKhz: 10_000, mode: "am" });
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

  // Value: protects=Listen on the map is a user choice like the table: it ends a running Pick best chain; fails_when=the map's onListen bypasses chooseReceiver (tuneReceiver directly), so a late busy tunes over the user's pick; why_new=R1; seam=MapPanel mocked; no_claim=the card itself (ReceiverMap tests)
  it("listening from the map ends Pick best, so a late failure doesn't override the choice", () => {
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    fireEvent.click(screen.getByRole("button", { name: "map listen" }));
    expect(radio.tune).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: listed.host, port: listed.port, source: "list" }),
    );
    radio.tune.mockClear();
    radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);
    expect(radio.tune).not.toHaveBeenCalled();
  });

  // Value: protects=the map stays out of the network between "listening" and the session's first audio, then loads; fails_when=the page gates on status instead of use-radio's heardAudio, or treats listening-without-audio as idle; why_new=R7; seam=fake timers, use-radio mocked; no_claim=idle-callback timing (hook tests)
  it("admits the map only once audio arrives", () => {
    vi.useFakeTimers();
    try {
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      const view = render(<ListenPage />);
      act(() => vi.advanceTimersByTime(30_000));
      expect(screen.getByLabelText("map admitted").textContent).toBe("no");
      radio.heardAudio = true;
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByLabelText("map admitted").textContent).toBe("yes");
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a map that can't draw still leaves a way to pick a receiver; fails_when=Browse receivers doesn't open the table; why_new=design state table (map failed); seam=MapPanel mocked; no_claim=focus/scroll in a real browser
  it("opens the receiver table from the map's Browse receivers", () => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "f4kiy.ddns.net", port: "8073" }));
    render(<ListenPage />);
    expect(screen.getByLabelText("browse").textContent).toBe("closed");
    fireEvent.click(screen.getByRole("button", { name: "map browse" }));
    expect(screen.getByLabelText("browse").textContent).toBe("open");
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

  // Value: protects=a pasted URL means what it says (no port is the scheme's port, as in the list) while a bare hostname keeps the typed port; fails_when=onBlur normalize is removed or portless URLs keep a stale port again; why_new=TODOS default ports; seam=none; no_claim=server validation
  it("splits a pasted URL on blur, using the scheme's port when it has none", () => {
    render(<ListenPage />);
    const host = screen.getByLabelText("Receiver") as HTMLInputElement;
    const port = screen.getByLabelText("Port") as HTMLInputElement;
    fireEvent.change(port, { target: { value: "8074" } });
    fireEvent.change(host, { target: { value: "f4kiy.ddns.net" } });
    fireEvent.blur(host);
    expect(port.value).toBe("8074");

    fireEvent.change(host, { target: { value: "http://F4KIY.ddns.net/" } });
    fireEvent.blur(host);
    expect(host.value).toBe("f4kiy.ddns.net");
    expect(port.value).toBe("80");

    fireEvent.change(host, { target: { value: "http://f4kiy.ddns.net:8075/" } });
    fireEvent.blur(host);
    expect(host.value).toBe("f4kiy.ddns.net");
    expect(port.value).toBe("8075");
    expect(radio.tune).not.toHaveBeenCalled();
  });

  // Value: protects=the table's dot marks what's actually playing, not what's typed in the field; fails_when=current is built from the host/port fields again; why_new=TODOS Pick best edges; seam=none; no_claim=the table's rendering (picker test)
  it("marks the receiver that's playing, not the one in the fields", () => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "f4kiy.ddns.net", port: "8073" }));
    const view = render(<ListenPage />);
    expect(screen.getByLabelText("tuned").textContent).toBe("none");

    radio.status = { state: "connecting", host: "f4kiy.ddns.net", port: 8073 };
    view.rerender(<ListenPage />);
    expect(screen.getByLabelText("tuned").textContent).toBe("f4kiy.ddns.net:8073");
    expect(screen.getByLabelText("phase").textContent).toBe("connecting");

    radio.status = { state: "listening", host: "sdr.k1vl.com", port: 8076 };
    view.rerender(<ListenPage />);
    expect(screen.getByLabelText("tuned").textContent).toBe("sdr.k1vl.com:8076");
    expect(screen.getByLabelText("phase").textContent).toBe("listening");

    // A new choice is marked from the click, before the service says anything.
    fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
    radio.status = { state: "listening", host: "f4kiy.ddns.net", port: 8073 };
    radio.tuning = true;
    view.rerender(<ListenPage />);
    expect(screen.getByLabelText("tuned").textContent).toBe("sdr.k1vl.com:8076");
    expect(screen.getByLabelText("phase").textContent).toBe("connecting");
  });

  // Value: protects=the fields can't change under a tune that's still connecting; fails_when=the fields unlock while tuning, so the ring and saving follow what was typed instead; why_new=red team R3; seam=none; no_claim=none beyond protects
  it("locks the receiver fields while a tune is in progress", () => {
    radio.tuning = true;
    render(<ListenPage />);
    expect((screen.getByLabelText("Receiver") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Port") as HTMLInputElement).disabled).toBe(true);
  });

  // Value: protects=a double-click on Listen starts listening and doesn't stop it again; fails_when=the submit button ignores the second click now that Listen turns into Stop at once; why_new=red team; seam=none; no_claim=real double-click timing
  it("ignores the second click of a double-click on Listen", () => {
    const view = render(<ListenPage />);
    fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen" }), { detail: 1 });
    expect(radio.tune).toHaveBeenCalledTimes(1);
    radio.tuning = true;
    view.rerender(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }), { detail: 2 });
    expect(radio.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }), { detail: 1 });
    expect(radio.stop).toHaveBeenCalledTimes(1);
  });

  // Value: protects=a port the service can't dial (0, out of range) becomes the Kiwi default before tuning; fails_when=validPort is bypassed, so the service quietly dials 8073 while the page waits on port 0; why_new=red team (PR 1); seam=none; no_claim=receivers on unusual ports
  it.each(["0", "70000"])("dials the default port for port %s", (typed) => {
    render(<ListenPage />);
    fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "kiwi.example", port: 8073 }));
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("8073");
  });

  // Value: protects=a saved port that isn't plain digits is dialed as the default, not read as hex or an exponent; fails_when=validPort parses with Number(); why_new=PR 2a review; the field strips non-digits, so only a stored value can carry these (Codex, eng review 2026-10-21); seam=none; no_claim=none beyond protects
  it.each(["0x1F90", "1e3"])("dials the default port for a saved port %s", (stored) => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "kiwi.example", port: stored }));
    render(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "kiwi.example", port: 8073 }));
  });

  // Value: protects=dial moves while a first connection starts reach the radio; fails_when=sendRetune only runs once the service says connecting; why_new=red team (PR 1); seam=fake timers; no_claim=use-radio's handling (use-radio.test)
  it("retunes from the dial while a tune is starting", () => {
    vi.useFakeTimers();
    try {
      radio.tuning = true;
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "kiwi.example", port: "8073" }));
      render(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).toHaveBeenCalledWith(expect.objectContaining({ host: "kiwi.example", freqKhz: 10_001 }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=Pick best's way back dials the old receiver as it was reached (https here), even after the page moved on to a new choice; fails_when=provenance only knows the receiver the page is tuned to; why_new=red team (PR 1); seam=none; no_claim=use-pick-best's ranking (its own tests)
  it("lets Pick best return to the old receiver over https after a click moved on", () => {
    const view = render(<ListenPage />);
    fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "https://kiwi.example.org/" } });
    fireEvent.blur(screen.getByLabelText("Receiver"));
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    radio.status = { state: "listening", host: "kiwi.example.org", port: 443 };
    view.rerender(<ListenPage />);
    // A table click, then Pick best before the service answers it.
    fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    for (const r of [listed, backup]) {
      radio.status = { state: "error", code: "busy", message: "full", host: r.host, port: r.port };
      view.rerender(<ListenPage />);
    }
    expect(radio.tune).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "kiwi.example.org", port: 443, secure: true }),
    );
  });

  // Value: protects=a tune started from idle or an error reads as connecting and can be stopped, matching the locked fields; fails_when=the button and status follow only the service's status; why_new=design review pass 2 (locked fields beside "Listen" and "Not listening"); seam=none; no_claim=how long the service takes to answer
  it("shows a tune that's starting as connecting, with Stop and no stale error", () => {
    radio.status = { state: "error", message: "This browser blocked audio. Click Listen again." };
    radio.tuning = true;
    render(<ListenPage />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    expect(screen.queryByText(/Click Listen again/)).toBeNull();
    expect(document.querySelector(".status")!.getAttribute("data-state")).toBe("connecting");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(radio.stop).toHaveBeenCalledTimes(1);
  });

  // Value: protects=the table's Night column gets the page's sun; fails_when=page passes no sun and every Night cell reads "–"; why_new=O6 shared clock; seam=picker mock; no_claim=the sun's position (solar.test)
  it("hands the picker the page's sun", () => {
    render(<ListenPage />);
    expect(screen.getByLabelText("sun").textContent).toBe("set");
  });

  // Value: protects=a bad saved value can't crash the page on load; fails_when=loadReceiver trusts storage again; why_new=TODOS small edges; seam=none; no_claim=other storage keys
  it.each(["null", '"kiwi.example"', '{"host":5,"port":"8073"}', "[]", "{not json"])(
    "starts fresh when the saved receiver is %s",
    (raw) => {
      localStorage.setItem("skywave.receiver", raw);
      render(<ListenPage />);
      expect((screen.getByLabelText("Receiver") as HTMLInputElement).value).toBe("");
      expect(screen.getByLabelText("browse").textContent).toBe("open");
    },
  );

  // Value: protects=dragging the dial doesn't rewrite storage on every retune; fails_when=the save effect stops skipping unchanged values; why_new=TODOS small edges; seam=none; no_claim=real storage cost
  it("writes the saved receiver once, not on every listening status", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "f4kiy.ddns.net", port: "8073" }));
      setItem.mockClear();
      const view = render(<ListenPage />);
      for (const freqKhz of [10_000, 10_001, 10_002]) {
        radio.status = {
          state: "listening",
          host: "f4kiy.ddns.net",
          port: 8073,
          sampleRate: 12000,
          freqKhz,
        } as RadioStatus;
        view.rerender(<ListenPage />);
      }
      expect(setItem).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });

  // Value: protects=a late "listening" from an attempt Pick best already left can't become the saved default, tagged wrong; fails_when=the save effect saves any listening status; why_new=TODOS provenance (pass-2/3 red team); seam=none; no_claim=real socket ordering
  it("saves only the receiver the page is tuned to", () => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "home.example", port: "8073" }));
    radio.status = { state: "listening", host: "home.example", port: 8073 };
    const view = render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    fireEvent.click(screen.getByRole("button", { name: "stop picking" })); // going back to home
    localStorage.clear();

    radio.status = { state: "listening", host: listed.host, port: listed.port };
    view.rerender(<ListenPage />);
    expect(localStorage.getItem("skywave.receiver")).toBeNull();

    radio.status = { state: "listening", host: "home.example", port: 8073 };
    view.rerender(<ListenPage />);
    expect(JSON.parse(localStorage.getItem("skywave.receiver")!)).toEqual({ host: "home.example", port: "8073" });
  });

  // Value: protects=Pick best goes back to an https-only receiver over wss and as typed; fails_when=the page's provenance drops the scheme; why_new=wss + provenance; seam=none; no_claim=the service's TLS
  it("goes back to a secure typed receiver securely", () => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "far.example", port: "443", secure: true }));
    radio.status = { state: "listening", host: "far.example", port: 443 };
    render(<ListenPage />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
    fireEvent.click(screen.getByRole("button", { name: "stop picking" }));
    expect(radio.tune).toHaveBeenLastCalledWith({
      host: "far.example",
      port: 443,
      freqKhz: 10_000,
      mode: "am",
      secure: true,
    });
  });

  // Value: protects=a dial retune queued during a Pick best run can't follow the run to its next receiver and switch back; fails_when=Pick best's next tune skips clearing the retune timer; why_new=state matrix pending-retune x Pick best next; seam=none; no_claim=real timer jitter
  it("drops a queued dial retune when Pick best moves on", () => {
    vi.useFakeTimers();
    try {
      const view = render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
      radio.status = { state: "connecting", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).not.toHaveBeenCalled();
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: backup.host }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=choosing a list row while a list receiver plays keeps both tagged; fails_when=a row choice loses the tag when the page was already on the list; why_new=state matrix listed x choose-row; seam=none; no_claim=server enforcement
  it("keeps the list tag when choosing a row while a list receiver plays", () => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "far.example", port: "8073", fromList: true }));
    radio.status = { state: "listening", host: "far.example", port: 8073 };
    render(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
    expect(radio.tune).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: listed.host, port: listed.port, source: "list" }),
    );
  });

  describe("Back to the previous receiver", () => {
    /** Plays a typed receiver, then the listed one, so Back has somewhere to go. */
    function heardTwo() {
      const view = render(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      view.rerender(<ListenPage />);
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      radio.tune.mockClear();
      return view;
    }

    // Value: protects=Back returns to the receiver exactly as it was dialed (list tag, scheme) and toggles, and the map's "last" ring marks the same receiver Back names; fails_when=Back reuses chooseReceiver's list-only path, forgets the previous on a switch, or lastPlace isn't passed (or follows another receiver); why_new=E1 Back path; map wiring untested (PR 2b review); seam=MapPanel mocked; no_claim=the ring's drawing (adapter tests)
    it("offers the receiver that played before, dialed the way it was, and toggles", () => {
      const view = render(<ListenPage />);
      expect(screen.queryByRole("button", { name: /^Back to/ })).toBeNull();
      expect(screen.getByLabelText("map last").textContent).toBe("none");
      cleanup();

      const two = heardTwo();
      expect(screen.getByLabelText("map last").textContent).toBe("kiwi.example:8073");
      const back = screen.getByRole("button", { name: "Back to kiwi.example" });
      // A live region would announce every new Back target.
      expect(back.closest('[role="status"]')).toBeNull();
      fireEvent.click(back);
      expect(radio.tune).toHaveBeenLastCalledWith({ host: "kiwi.example", port: 8073, freqKhz: 10_000, mode: "am" });
      // While it connects, Back offers the receiver just left, never itself.
      radio.status = { state: "connecting", host: "kiwi.example", port: 8073 };
      two.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Back to kiwi.example" })).toBeNull();
      expect(screen.getByRole("button", { name: "Back to K1VL" })).toBeTruthy();
      expect(screen.getByLabelText("map last").textContent).toBe("sdr.k1vl.com:8076");

      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      two.rerender(<ListenPage />);
      fireEvent.click(screen.getByRole("button", { name: "Back to K1VL" }));
      expect(radio.tune).toHaveBeenLastCalledWith({
        host: "sdr.k1vl.com",
        port: 8076,
        freqKhz: 10_000,
        mode: "am",
        source: "list",
      });
      view.unmount();
    });

    // Value: protects=Back to an https-only receiver dials it over wss again; fails_when=the remembered receiver drops its secure flag, so Back dials ws:// and the receiver never answers; why_new=the Back test only covers a plain typed receiver and a listed one; seam=none; no_claim=the service's TLS (radio tests)
    it("goes back to a secure receiver securely", () => {
      const view = render(<ListenPage />);
      const host = screen.getByLabelText("Receiver");
      fireEvent.change(host, { target: { value: "https://kiwi.example.org/" } });
      fireEvent.blur(host);
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "kiwi.example.org", port: 443 };
      view.rerender(<ListenPage />);
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);

      fireEvent.click(screen.getByRole("button", { name: "Back to kiwi.example.org" }));
      expect(radio.tune).toHaveBeenLastCalledWith({
        host: "kiwi.example.org",
        port: 443,
        freqKhz: 10_000,
        mode: "am",
        secure: true,
      });
    });

    // Value: protects=a double-click on Back switches once, not there and straight back; fails_when=Back's click ignores e.detail; why_new=red team (the button flips to the receiver just left); seam=none; no_claim=real double-click timing
    it("switches once on a double-click", () => {
      const view = heardTwo();
      fireEvent.click(screen.getByRole("button", { name: "Back to kiwi.example" }), { detail: 1 });
      radio.tuning = true;
      view.rerender(<ListenPage />);
      // The button now offers the receiver just left; the second click lands there.
      fireEvent.click(screen.getByRole("button", { name: "Back to K1VL" }), { detail: 2 });
      expect(radio.tune).toHaveBeenCalledTimes(1);
      expect(radio.tune).not.toHaveBeenCalledWith(expect.objectContaining({ host: "sdr.k1vl.com" }));
    });

    // Value: protects=Stop pressed while a switch connects keeps Back on the receiver you left; fails_when=Back ignores the receiver in the fields once nothing is playing; why_new=Codex structured P2 (PR 1); seam=none; no_claim=none beyond protects
    it("keeps Back on the receiver you left when Stop interrupts a switch", () => {
      const view = render(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      view.rerender(<ListenPage />);
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      radio.tuning = true;
      view.rerender(<ListenPage />);
      // Stop before the service answers.
      radio.tuning = false;
      radio.status = { state: "idle" };
      view.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
    });

    // Value: protects=when the radio service drops, Back offers the receiver before the one that dropped, not a retry of it; fails_when=a host-less error leaves Back pointing at the receiver just lost; why_new=Codex adversarial (PR 1); seam=none; no_claim=reconnecting by itself
    it("offers the receiver before when the service drops the current one", () => {
      const view = heardTwo();
      radio.status = { state: "error", message: "Lost the connection to the radio service. Is it running?" };
      view.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
    });

    // Value: protects=Back redials a receiver the way it was last reached (list tag, https); fails_when=the history keeps the flags from the first time it played; why_new=Codex adversarial (PR 1); seam=none; no_claim=server enforcement of source:"list"
    it("remembers how a receiver was last reached", () => {
      const view = render(<ListenPage />);
      // First typed by hand...
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "sdr.k1vl.com" } });
      fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8076" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      // ...then chosen from the list while it plays; the service answers again.
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      radio.status = { state: "idle" };
      view.rerender(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
      fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8073" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      view.rerender(<ListenPage />);
      radio.tune.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Back to K1VL" }));
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "sdr.k1vl.com", source: "list" }));
    });

    // Value: protects=a switch that fails offers Back to the receiver you were just hearing; fails_when=Back only learns a receiver once the next one plays; why_new=adversarial review (Claude + Codex, 3 sources); seam=none; no_claim=none beyond protects
    it("offers Back to the receiver you were hearing when a switch fails", () => {
      const view = render(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "kiwi.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      view.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: /^Back to/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
      cleanup();

      // Two receivers in, a third fails: Back goes to the second.
      const two = heardTwo();
      // The listed receiver is playing; stop it first so the fields unlock.
      radio.status = { state: "idle" };
      two.rerender(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "third.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "error", code: "down", message: "down", host: "third.example", port: 8076 };
      two.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Back to K1VL" })).toBeTruthy();
    });

    // Value: protects=Back keeps pointing at the earlier receiver through retunes and errors on this one; fails_when=previous updates on any listening status, not only a new receiver; why_new=testing specialist gap; seam=none; no_claim=none beyond protects
    it("keeps Back through a retune or an error on the current receiver", () => {
      const view = heardTwo();
      radio.status = { state: "error", message: "hiccup", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      radio.status = { state: "listening", host: listed.host, port: listed.port, freqKhz: 7_000 } as RadioStatus;
      view.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
    });

    // Value: protects=after Stop, Back still points where it did while playing, not at the receiver just stopped; fails_when=backTo's idle branch is dropped, so Stop flips Back to the receiver you just left; why_new=the Back tests set idle only to unlock the fields and never assert Back there; seam=none; no_claim=what Back shows before anything has played
    it("keeps Back pointing where it did after Stop", () => {
      const view = heardTwo();
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(radio.stop).toHaveBeenCalledTimes(1);
      radio.status = { state: "idle" };
      view.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Back to K1VL" })).toBeNull();
    });

    // Value: protects=from the click until the service answers, Back offers the receiver being left, never the one being tuned; fails_when=backTo reads the service's status (still the old receiver) instead of the pending choice; why_new=the Back tests only check the connecting phase once the service has named the new receiver, with tuning false; seam=none; no_claim=how long the service takes to answer
    it("offers the receiver being left while a switch waits on the service", () => {
      const view = heardTwo();
      fireEvent.click(screen.getByRole("button", { name: "Back to kiwi.example" }));
      // The service hasn't answered: its status still names the listed receiver.
      radio.tuning = true;
      view.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Back to kiwi.example" })).toBeNull();
      expect(screen.getByRole("button", { name: "Back to K1VL" })).toBeTruthy();
    });

    // Value: protects=Back never offers a receiver that refuses apps (it plays ~10 s first); fails_when=the no_apps handler leaves it as the last receiver heard; why_new=red team R2; seam=none; no_claim=the service's no_apps detection (radio tests)
    it("never offers Back to a receiver that refused apps", () => {
      const view = heardTwo();
      radio.status = { state: "error", code: "no_apps", message: "own page", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "third.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "third.example", port: 8076 };
      view.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Back to K1VL" })).toBeNull();
      expect(screen.getByRole("button", { name: "Back to kiwi.example" })).toBeTruthy();
    });

    // Value: protects=Back is a user choice like the table: it ends Pick best and drops a queued dial retune; fails_when=Back bypasses switchTo; why_new=E1/O1 shared switch path; seam=fake timers; no_claim=real socket ordering
    it("ends Pick best and drops a queued dial retune", () => {
      vi.useFakeTimers();
      try {
        const view = heardTwo();
        act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
        radio.retune.mockClear();
        fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
        fireEvent.click(screen.getByRole("button", { name: "Back to kiwi.example" }));
        act(() => vi.advanceTimersByTime(500));
        expect(radio.retune).not.toHaveBeenCalled();

        radio.tune.mockClear();
        radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
        view.rerender(<ListenPage />);
        expect(radio.tune).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Value: protects=the radio comes first and receivers sit between it and the waterfall; fails_when=the picker moves back above the dial; why_new=DT1 page order; seam=picker mock; no_claim=visual spacing
  it("puts the receivers between the radio and the waterfall", () => {
    render(<ListenPage />);
    const order = [
      screen.getByRole("slider", { name: "Tuning dial" }),
      screen.getByText("Not listening"),
      screen.getByLabelText("browse"),
      screen.getByText(/run by volunteers/),
      screen.getByLabelText("waterfall"),
      screen.getByLabelText("presets"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  describe("band scan", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function playing(view: ReturnType<typeof render>, host = listed.host, port = listed.port) {
      radio.status = { state: "listening", host, port };
      radio.heardAudio = true;
      view.rerender(<ListenPage />);
    }

    // Value: protects=a receiver's scan starts on its own 10 s after it plays, once (eng review D4); fails_when=the trigger fires at once, never, or repeatedly; why_new=no scan; seam=useRadio mocked; no_claim=service behaviour
    it("scans a receiver 10 s after it starts playing, once", () => {
      radio.canScan = true;
      const view = render(<ListenPage />);
      playing(view);
      act(() => vi.advanceTimersByTime(9_999));
      expect(radio.startScan).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(radio.startScan).toHaveBeenCalledTimes(1);
      radio.scan = { state: "scanning", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(60_000));
      expect(radio.startScan).toHaveBeenCalledTimes(1);
    });

    // Value: protects=no scan while Pick best might still drop the receiver (D14); fails_when=the trigger watches running instead of settled; why_new=Codex O4; seam=useRadio mocked; no_claim=real refusal timing
    it("waits for Pick best's watch to end before scanning", () => {
      radio.canScan = true;
      const view = render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
      playing(view);
      act(() => vi.advanceTimersByTime(14_999));
      expect(radio.startScan).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1)); // the watch ends: settled
      act(() => vi.advanceTimersByTime(9_999));
      expect(radio.startScan).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(radio.startScan).toHaveBeenCalledTimes(1);
    });

    // Value: protects=an older radio service is never asked to scan, and the list stays hidden (D13); fails_when=the page ignores canScan; why_new=Codex O3; seam=useRadio mocked; no_claim=none beyond protects
    it("leaves an older radio service alone", () => {
      const view = render(<ListenPage />);
      playing(view);
      act(() => vi.advanceTimersByTime(30_000));
      expect(radio.startScan).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Strong signals now" })).toBeNull();
    });

    // Value: protects=a listed signal tunes in AM and Scan again asks for a fresh scan; fails_when=clicks keep the current mode or Scan again reuses the cache; why_new=no list; seam=useRadio mocked; no_claim=real retune timing
    it("tunes a listed signal in AM, and Scan again asks for a fresh scan", () => {
      radio.canScan = true;
      radio.scan = {
        state: "done",
        host: listed.host,
        port: listed.port,
        signals: [{ freqKhz: 9_420, snrDb: 31, band: "31m" }],
        hidden: 2,
        bandsDone: 9,
        bandsTotal: 15,
        partial: true,
      };
      const view = render(<ListenPage />);
      playing(view);
      expect(screen.getByText("Scanned 9 of 15 bands before the time limit.", { exact: false })).toBeTruthy();
      expect(screen.getByText("2 digital or noise signals aren't listed.", { exact: false })).toBeTruthy();
      act(() => fireEvent.click(screen.getByRole("button", { name: /9,420\s*31m/ })));
      act(() => vi.advanceTimersByTime(200));
      expect(radio.retune).toHaveBeenLastCalledWith(expect.objectContaining({ freqKhz: 9_420, mode: "am" }));
      act(() => fireEvent.click(screen.getByRole("button", { name: "Scan again" })));
      expect(radio.startScan).toHaveBeenLastCalledWith(true);
    });
  });
});
