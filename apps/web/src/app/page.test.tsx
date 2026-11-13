// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "@/lib/eibi";
import type { Receiver } from "@/lib/kiwi-list";
import type { RadioStatus, ScanState, Settled } from "@/lib/use-radio";

const radio = {
  status: { state: "idle" } as RadioStatus,
  settled: null as Settled | null,
  meter: null,
  tuning: false,
  heardAudio: false,
  canScan: false,
  scan: null as ScanState | null,
  startScan: vi.fn(),
  canView: false,
  viewError: null as string | null,
  showView: vi.fn(),
  onWideFrame: () => () => {},
  tune: vi.fn(async () => {}),
  retune: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
  onSpectrum: () => () => {},
};

vi.mock("@/lib/use-radio", () => ({ useRadio: () => radio }));
// These talk to tRPC or draw on a canvas; the page's own wiring is what's under test.
vi.mock("@/components/Presets", () => ({
  Presets: ({ onSelect }: { onSelect: (p: { freqKhz: number; mode: "am" }) => void }) => {
    presetSelect.current = onSelect;
    return <output aria-label="presets" />;
  },
}));
vi.mock("@/components/Waterfall", () => ({
  Waterfall: ({ expanded, onClickOffset }: { expanded: boolean; onClickOffset: (hz: number) => void }) => {
    waterfallClick.current = onClickOffset;
    return <output aria-label="waterfall">{expanded ? "open" : "strip"}</output>;
  },
}));
vi.mock("@/components/WideWaterfall", async () => {
  const { useState } = await import("react");
  return {
    WideWaterfall: (props: WideProps) => {
      // Which mount this is: a new receiver must get a new one (a blank picture).
      const [mount] = useState(() => ++wide.mounts);
      wide.current = { ...props, mount };
      return (
        <output aria-label="wide waterfall">
          {props.view.zoom} {props.view.cfKhz} {props.frozen ? "frozen" : ""} {props.error ?? ""}
        </output>
      );
    },
  };
});
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

// The public list as the page sees it; tests swap in loading or failed.
const waterfallClick: { current?: (hz: number) => void } = {};
type WideProps = {
  view: { zoom: number; cfKhz: number };
  stations?: { khz: number; label: string }[];
  frozen: boolean;
  error: string | null;
  passband: [number, number];
  onTune: (khz: number) => void;
};
const wide: { current?: WideProps & { mount: number }; mounts: number } = { mounts: 0 };
const presetSelect: { current?: (p: { freqKhz: number; mode: "am" }) => void } = {};
const receiverList: { data?: { receivers: Receiver[] }; errorUpdatedAt: number } = { errorUpdatedAt: 0 };
const schedule: { data?: { season: string; bundled: boolean; broadcasts: Broadcast[] } } = {};
vi.mock("@/lib/use-schedule", () => ({ useSchedule: () => schedule }));
vi.mock("@/lib/use-receiver-list", async (actual) => ({
  ...(await actual<typeof import("@/lib/use-receiver-list")>()),
  useReceiverList: () => receiverList,
}));

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

/** A receiver the listener pinned on an earlier visit, as the page saves it. */
function savePin(p: { host: string; port: number; fromList?: boolean; secure?: boolean; label?: string }) {
  localStorage.setItem("skywave.pin", JSON.stringify({ label: p.host, ...p }));
}

beforeEach(() => {
  localStorage.clear();
  receiverList.data = { receivers: [listed, backup] };
  receiverList.errorUpdatedAt = 0;
  radio.status = { state: "idle" };
  radio.settled = null;
  radio.tuning = false;
  radio.heardAudio = false;
  radio.canScan = false;
  radio.scan = null;
  radio.canView = false;
  radio.viewError = null;
  schedule.data = undefined;
  radio.showView.mockClear();
  radio.startScan.mockClear();
  radio.tune.mockClear();
  radio.stop.mockClear();
});

afterEach(cleanup);

describe("ListenPage", () => {
  // Value: protects=the "How skywave uses it" link to /owners opens a new tab, so reading it never unmounts the player and cuts the audio; fails_when=target="_blank" is dropped or the link is swapped for a same-tab next/link; why_new=new link on the listening page; seam=none; no_claim=browser tab behavior (jsdom doesn't navigate)
  it("opens the owners page in a new tab so what's playing keeps playing", () => {
    render(<ListenPage />);
    const link = screen.getByRole("link", { name: "How skywave uses it" });
    expect(link.getAttribute("href")).toBe("/owners");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  // Value: protects=the listening page renders its footer in player mode (new-tab links), so the credit can't cut the audio; fails_when=page.tsx drops onPlayer from <SiteFooter>; why_new=new footer; seam=SiteFooter's own new-tab rule is tested in SiteFooter.test.tsx; no_claim=footer layout
  it("renders the credit footer with links that leave what's playing alone", () => {
    render(<ListenPage />);
    expect(screen.getByRole("link", { name: "For Kiwi owners" }).getAttribute("target")).toBe("_blank");
  });

  // Value: protects=the Receiver field is named by its label and described by the choice (Auto or the pinned receiver) plus the visible typing hint (PR #36: visible, and kept once a host is typed), which stay once a host is typed; fails_when=the hint goes back to a placeholder (gone once typed), is hidden, or aria-describedby is dropped or mispointed; why_new=Auto chip replaced the "blank picks the best" hint; seam=none; no_claim=how the chip looks beside the label (jsdom applies no CSS)
  it("describes the Receiver field with the receiver choice and the typing hint", () => {
    render(<ListenPage />);
    const auto = {
      name: "Receiver",
      description: "Auto (best for this frequency) or type an address",
    };
    const host = screen.getByRole("textbox", auto) as HTMLInputElement;
    fireEvent.change(host, { target: { value: "kiwi.example" } });
    expect(screen.getByRole("textbox", auto)).toBe(host);
    expect(host.placeholder).toBe("");
    expect(document.getElementById("host-hint")!.className).not.toContain("visually-hidden");
    fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
    expect(screen.getByRole("textbox", { name: "Receiver", description: "K1VL or type an address" })).toBe(host);
  });

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
      // The map also waits for the drawer to have opened once; open it, so only audio is left.
      fireEvent.click(screen.getByRole("button", { name: "Change receiver" }));
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

  // Value: protects=a first-time visitor who opens the drawer finds the receiver list already open, a returning one doesn't get it in the way; fails_when=the first-visit setBrowseOpen(!host) is dropped or inverted; why_new=the picker mock ignored `open`; seam=none; no_claim=the details element's own toggle
  it("opens the receiver list on a first visit only", () => {
    render(<ListenPage />);
    expect(screen.getByLabelText("browse").textContent).toBe("open");
    cleanup();

    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "f4kiy.ddns.net", port: "8073" }));
    render(<ListenPage />);
    expect(screen.getByLabelText("browse").textContent).toBe("closed");
  });

  // Value: protects=a shared link opens the page tuned to its frequency, mode and receiver, ready for Listen, and is applied once; fails_when=the link is ignored, starts a first visit's drawer, or stays in the URL; why_new=deep links for launch; seam=none; no_claim=clipboard permissions in real browsers
  it("opens tuned from a shared link, dialing its receiver public-only", () => {
    window.history.replaceState(null, "", "/?f=9580&m=usb&rx=kiwi.example:8074");
    render(<ListenPage />);
    expect(window.location.search).toBe("");
    expect(screen.getByLabelText("browse").textContent).toBe("closed");
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(radio.tune).toHaveBeenCalledWith({
      host: "kiwi.example",
      port: 8074,
      freqKhz: 9580,
      mode: "usb",
      source: "list",
    });
    // Saved as the pin only once it plays, like any other choice.
    expect(localStorage.getItem("skywave.pin")).toBeNull();
  });

  // Value: protects=Copy link puts where the dial is, and the tuned receiver, on the clipboard; fails_when=the link leaves out the receiver or the tuning; why_new=deep links for launch; seam=navigator.clipboard; no_claim=real clipboard permissions
  it("copies a link to the current tuning", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    savePin({ host: "kiwi.example", port: 8073 });
    render(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?f=10000&m=am&rx=kiwi.example%3A8073`);
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
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

  // Value: protects=a pinned list receiver stays public-only through Listen, a reload and dial retunes; fails_when=fromList isn't carried in the pin, the draft, storage or retune; why_new=adversarial review: the tag was lost through the host field; seam=none; no_claim=server enforcement (radio tests)
  it("keeps a list receiver tagged through Listen, reloads and retunes, until it's edited", () => {
    vi.useFakeTimers();
    try {
      savePin({ host: "sdr.k1vl.com", port: 8076, fromList: true, label: "K1VL" });
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

  // Value: protects=once the service has answered every tune, the dial and mode move to the tuning it kept (a refused or failed retune puts them back), but not while a newer move is queued, and a settle missing a field leaves that field; fails_when=the page ignores settled, applies it over a queued move, or writes undefined; why_new=TODO "Revert the web dial when the service refuses a retune"; seam=mocked radio hook; no_claim=the hook's counting (use-radio tests)
  it("moves the dial to the service's settled tuning unless a move is queued", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "kiwi.example", port: "8073" }));
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      const view = render(<ListenPage />);
      const slider = screen.getByRole("slider", { name: "Tuning dial" });
      const at = () => slider.getAttribute("aria-valuenow");
      fireEvent.keyDown(slider, { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(500));
      expect(at()).toBe("10001");

      radio.settled = { freqKhz: 10_000, mode: "usb" };
      view.rerender(<ListenPage />);
      expect(at()).toBe("10000");
      expect((screen.getByRole("radio", { name: "USB" }) as HTMLInputElement).checked).toBe(true);

      fireEvent.keyDown(slider, { key: "ArrowUp" }); // queued, not yet sent
      radio.settled = { freqKhz: 9_000, mode: "usb" };
      view.rerender(<ListenPage />);
      expect(at()).toBe("10001");
      act(() => vi.advanceTimersByTime(500));

      radio.settled = {};
      view.rerender(<ListenPage />);
      expect(at()).toBe("10001");
      expect((screen.getByRole("radio", { name: "USB" }) as HTMLInputElement).checked).toBe(true);
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
      savePin({ host: "f4kiy.ddns.net", port: 8073 });
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

  // Value: protects=the fields stay open while a tune connects or plays, yet typing in them changes nothing until it's committed: dial retunes, the table's ring and saving follow the receiver tuned (red team R3, why the fields used to lock); fails_when=the inputs bind to the tuned receiver again, or lock again; why_new=switching receivers while listening; seam=none; no_claim=none beyond protects
  it("keeps the receiver fields open while busy, without moving where retunes go", () => {
    vi.useFakeTimers();
    try {
      savePin({ host: "kiwi.example", port: 8073 });
      radio.tuning = true;
      const view = render(<ListenPage />);
      const host = screen.getByLabelText("Receiver") as HTMLInputElement;
      expect(host.disabled).toBe(false);
      expect((screen.getByLabelText("Port") as HTMLInputElement).disabled).toBe(false);
      radio.tuning = false;
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      view.rerender(<ListenPage />);
      fireEvent.change(host, { target: { value: "half.typ" } });
      radio.retune.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(500));
      expect(radio.retune).toHaveBeenCalledWith(expect.objectContaining({ host: "kiwi.example", freqKhz: 10_001 }));
      expect(screen.getByLabelText("tuned").textContent).toBe("kiwi.example:8073");
      expect(radio.tune).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  // Value: protects=a saved port that isn't plain digits is dialed as the default, not read as hex or an exponent; fails_when=validPort is skipped when the last receiver seeds Back; why_new=PR 2a review; the field strips non-digits, so only a stored value can carry these (Codex, eng review 2026-10-21); seam=none; no_claim=none beyond protects
  it.each(["0x1F90", "1e3"])("dials the default port for a saved port %s", (stored) => {
    localStorage.setItem("skywave.receiver", JSON.stringify({ host: "kiwi.example", port: stored }));
    render(<ListenPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to kiwi.example" }));
    expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "kiwi.example", port: 8073 }));
  });

  // Value: protects=dial moves while a first connection starts reach the radio; fails_when=sendRetune only runs once the service says connecting; why_new=red team (PR 1); seam=fake timers; no_claim=use-radio's handling (use-radio.test)
  it("retunes from the dial while a tune is starting", () => {
    vi.useFakeTimers();
    try {
      radio.tuning = true;
      savePin({ host: "kiwi.example", port: 8073 });
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
      savePin({ host: "f4kiy.ddns.net", port: 8073 });
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
      const keys = setItem.mock.calls.map(([key]) => key);
      expect(keys.filter((k) => k === "skywave.receiver")).toHaveLength(1);
      expect(keys.filter((k) => k === "skywave.pin")).toHaveLength(1);
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

  // Value: protects=the receiver choice sits at the top, collapsed into the header strip with its drawer right under it (UI critique), and the instrument and its live output still sit together after it, reached by heading (D19); fails_when=the drawer moves back below the waterfall, or between the radio and the waterfall, or the hidden headings go; why_new=the header strip replaced design D3's receivers-last order; seam=picker, waterfall and presets mocked; no_claim=visual spacing (browser check)
  it("puts the receiver drawer under the strip, then the instrument, waterfall and presets", () => {
    render(<ListenPage />);
    const order = [
      screen.getByRole("button", { name: "Change receiver" }),
      screen.getByLabelText("browse"),
      screen.getByText(/run by volunteers/),
      screen.getByRole("heading", { name: "Tuner" }),
      screen.getByRole("slider", { name: "Tuning dial" }),
      screen.getByText("Not listening"),
      screen.getByRole("heading", { name: "Waterfall" }),
      screen.getByLabelText("waterfall"),
      screen.getByLabelText("presets"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  describe("header strip and drawer", () => {
    const change = () => screen.getByRole("button", { name: "Change receiver" });
    const drawer = () => document.getElementById("receiver-drawer")!;

    // Value: protects=the drawer starts shut on every visit, a first one included, so the dial and Listen are on the first screen rather than under the map and a 690-row table, with "change" saying so and the closed drawer out of reach (inert); fails_when=a first visit opens the drawer again, aria-expanded drifts from the drawer, or a closed drawer stays reachable; why_new=r/shortwave feedback: a new visitor couldn't find the tuner; seam=none; no_claim=where the dial lands on screen (CSS, browser check)
    it("starts shut, a first visit included, and change toggles it", () => {
      render(<ListenPage />);
      expect(change().getAttribute("aria-expanded")).toBe("false");
      expect(drawer().hasAttribute("inert")).toBe(true);
      cleanup();

      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "old.example", port: "8073" }));
      render(<ListenPage />);
      expect(change().getAttribute("aria-expanded")).toBe("false");
      expect(drawer().hasAttribute("inert")).toBe(true);
      fireEvent.click(change());
      expect(change().getAttribute("aria-expanded")).toBe("true");
      expect(drawer().hasAttribute("inert")).toBe(false);
    });

    // Value: protects=choosing a receiver in the drawer (table, map, typed + Switch/Enter, Pick best) closes it and puts focus on "change" rather than dropping it with the drawer; fails_when=a choice path skips closeDrawer or focus isn't moved; why_new=drawer; seam=picker and map mocked; no_claim=real focus rings
    it("closes after a choice, leaving focus on change", () => {
      render(<ListenPage />);
      fireEvent.click(change());
      const choose = screen.getByRole("button", { name: "choose listed" });
      act(() => choose.focus());
      fireEvent.click(choose);
      expect(drawer().hasAttribute("inert")).toBe(true);
      expect(document.activeElement).toBe(change());

      fireEvent.click(change());
      act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
      expect(drawer().hasAttribute("inert")).toBe(true);

      fireEvent.click(change());
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "typed.example" } });
      fireEvent.keyDown(screen.getByLabelText("Receiver"), { key: "Enter" });
      fireEvent.submit(document.getElementById("receiver-form")!);
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "typed.example" }));
      expect(drawer().hasAttribute("inert")).toBe(true);
    });

    // Value: protects=a blank Listen that can't pick (the list still loading or failed) opens the drawer, since its message points at the Receiver field and Try again inside it; fails_when=the drawer stays shut over the controls the message names; why_new=review: the message pointed into a closed drawer; seam=list hook mocked; no_claim=the message text (design-pass tests)
    it("opens the drawer when a blank Listen has no list to pick from", () => {
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "old.example", port: "8073" }));
      receiverList.data = undefined;
      render(<ListenPage />);
      expect(drawer().hasAttribute("inert")).toBe(true);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Listen" })));
      expect(radio.tune).not.toHaveBeenCalled();
      expect(drawer().hasAttribute("inert")).toBe(false);
    });

    // Value: protects=the strip's Listen still submits the receiver form it sits outside of (form=), so a blank Listen runs Auto and a typed one tunes it; fails_when=the form attribute or the form's id drifts, so Listen does nothing; why_new=Listen moved out of the form into the strip; seam=list hook mocked; no_claim=browser implicit submission beyond jsdom
    it("submits the drawer's form from the strip's Listen", () => {
      receiverList.data = { receivers: [listed, { ...backup, snr: 10 }] };
      render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Listen" })));
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: listed.host }));
    });

    // Value: protects=the map stays unloaded until the drawer has been opened once (a map loading unseen can't be checked for drawing), and stays admitted after it closes; fails_when=admission ignores the drawer or is lost on close; why_new=the map moved into the drawer; seam=MapPanel mocked, fake timers; no_claim=MapLibre's own sizing
    it("admits the map once the drawer has been opened, and keeps it", () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem("skywave.receiver", JSON.stringify({ host: "old.example", port: "8073" }));
        render(<ListenPage />);
        act(() => vi.advanceTimersByTime(30_000));
        expect(screen.getByLabelText("map admitted").textContent).toBe("no");
        fireEvent.click(change());
        expect(screen.getByLabelText("map admitted").textContent).toBe("yes");
        fireEvent.click(change());
        expect(screen.getByLabelText("map admitted").textContent).toBe("yes");
      } finally {
        vi.useRealTimers();
      }
    });

    // Value: protects=the dial goes compact with the waterfall's opening (the visit's first audio) and stays compact through Stop; fails_when=compact follows busy or heardAudio (a resize on every Listen/Stop) or isn't passed; why_new=compact dial; seam=none; no_claim=the compact geometry (globals.test, Dial.test)
    it("makes the dial compact on first audio, and keeps it", () => {
      const dial = () => document.querySelector(".dial")!;
      const view = render(<ListenPage />);
      expect(dial().hasAttribute("data-compact")).toBe(false);
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      radio.heardAudio = true;
      view.rerender(<ListenPage />);
      expect(dial().hasAttribute("data-compact")).toBe(true);
      radio.status = { state: "stopped" };
      radio.heardAudio = false;
      view.rerender(<ListenPage />);
      expect(dial().hasAttribute("data-compact")).toBe(true);
    });

    // Value: protects=wheel tuning steps an AM medium wave channel by where the receiver playing is: 10 kHz in the Americas, 9 elsewhere or unknown; fails_when=the page passes no step, ignores the receiver's longitude, or the region test is inverted; why_new=wheel tuning; seam=list hook mocked, fake timers; no_claim=the step table itself (radio-types tests)
    it("steps medium wave by the playing receiver's region", () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem("skywave.tuning", JSON.stringify({ freqKhz: 1_000, mode: "am" }));
        receiverList.data = {
          receivers: [
            { ...listed, lon: -72.6 },
            { ...backup, lon: 6.5 },
          ],
        };
        savePin({ host: listed.host, port: listed.port, fromList: true });
        radio.status = { state: "listening", host: listed.host, port: listed.port };
        const view = render(<ListenPage />);
        const readout = screen.getByLabelText("Frequency in kilohertz");
        radio.retune.mockClear();
        fireEvent.pointerEnter(readout);
        act(() => vi.advanceTimersByTime(500)); // the pointer rests on the number
        fireEvent.wheel(readout, { deltaY: -100 });
        act(() => vi.advanceTimersByTime(200));
        expect(radio.retune).toHaveBeenLastCalledWith(expect.objectContaining({ freqKhz: 1_010 }));

        radio.status = { state: "listening", host: backup.host, port: backup.port };
        view.rerender(<ListenPage />);
        fireEvent.wheel(readout, { deltaY: -100 });
        act(() => vi.advanceTimersByTime(200));
        expect((readout as HTMLInputElement).value).toBe("1,017.00"); // 1,010 is off the 9 kHz grid: next channel up is 1,017
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Auto and pinned receivers", () => {
    // Rankable without a tie: equal receivers rank in a per-browser random order.
    beforeEach(() => {
      receiverList.data = { receivers: [listed, { ...backup, snr: 10 }] };
    });
    const chip = () => document.getElementById("host-choice")!.textContent;
    const field = () => screen.getByLabelText("Receiver") as HTMLInputElement;
    const listening = (view: ReturnType<typeof render>, host: string, port: number) => {
      radio.status = { state: "listening", host, port };
      view.rerender(<ListenPage />);
    };

    // Value: protects=a receiver saved before pins existed doesn't pin (owner: start in Auto); it's only offered by Back, and Listen picks the best instead of redialing it; fails_when=loadReceiver fills the fields or the tuned receiver again; why_new=Auto default; seam=list hook mocked; no_claim=none beyond protects
    it("starts in Auto with an old saved receiver, offering it only through Back", () => {
      localStorage.setItem("skywave.receiver", JSON.stringify({ host: "old.example", port: "8073" }));
      render(<ListenPage />);
      expect(chip()).toBe("Auto (best for this frequency)");
      expect(field().value).toBe("");
      expect(screen.getByRole("button", { name: "Back to old.example" })).toBeTruthy();
      act(() => fireEvent.click(screen.getByRole("button", { name: "Listen" })));
      expect(radio.tune).toHaveBeenCalledTimes(1);
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: listed.host, source: "list" }));
    });

    // Value: protects=a pin survives a reload: the chip names it, the fields hold it, Listen redials it as it was dialed, and the list stays closed; fails_when=loadPin is dropped, mis-validated, or loses fromList; why_new=pins; seam=none; no_claim=none beyond protects
    it("restores a saved pin, and Listen redials it", () => {
      savePin({ host: listed.host, port: listed.port, fromList: true, label: "K1VL" });
      render(<ListenPage />);
      expect(chip()).toBe("K1VL");
      expect(field().value).toBe(listed.host);
      expect(screen.getByLabelText("browse").textContent).toBe("closed");
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      expect(radio.tune).toHaveBeenLastCalledWith({
        host: listed.host,
        port: listed.port,
        freqKhz: 10_000,
        mode: "am",
        source: "list",
      });
    });

    // Value: protects=a pin from a version we didn't write (or a bad value) reads as Auto, not a crash or a half pin; fails_when=loadPin trusts storage; why_new=pins; seam=none; no_claim=none beyond protects
    it.each([
      '{"host":"a.example","port":"8073"}',
      '{"host":"a.example","port":0}',
      '{"host":"a.example","port":80.5}',
      '{"host":"","port":8073}',
      '"a.example"',
      "{not json",
    ])("treats a saved pin %s as Auto", (raw) => {
      localStorage.setItem("skywave.pin", raw);
      render(<ListenPage />);
      expect(chip()).toBe("Auto (best for this frequency)");
      expect(field().value).toBe("");
    });

    // Value: protects=Auto landing on a receiver keeps Auto (the field stays blank, no pin is saved), while the last-heard receiver is still saved for Back; fails_when=tuneReceiver writes the fields or pickFrom pins; why_new=owner: only an explicit choice pins; seam=list hook mocked; no_claim=none beyond protects
    it("stays in Auto when Pick best lands on a receiver", () => {
      const view = render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Listen" })));
      listening(view, listed.host, listed.port);
      expect(chip()).toBe("Auto (best for this frequency)");
      expect(field().value).toBe("");
      expect(localStorage.getItem("skywave.pin")).toBeNull();
      expect(localStorage.getItem("skywave.receiver")).not.toBeNull();
    });

    // Value: protects=choosing from the table or map pins that receiver, but the pin is saved only once it plays, and a no_apps refusal drops it to Auto; fails_when=the pin is saved on click (a dead receiver would come back next visit) or survives no_apps in storage or on the chip; why_new=pins; seam=none; no_claim=none beyond protects
    it("pins a chosen receiver, saving it once it plays and dropping it to Auto on no_apps", () => {
      const view = render(<ListenPage />);
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      expect(chip()).toBe("K1VL");
      expect(localStorage.getItem("skywave.pin")).toBeNull();
      listening(view, listed.host, listed.port);
      expect(JSON.parse(localStorage.getItem("skywave.pin")!)).toEqual({
        host: listed.host,
        port: listed.port,
        label: "K1VL",
        fromList: true,
      });
      radio.status = { state: "error", code: "no_apps", message: "own page", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      expect(localStorage.getItem("skywave.pin")).toBeNull();
      // It would refuse every Listen, so the choice goes back to Auto too.
      expect(chip()).toBe("Auto (best for this frequency)");
    });

    // Value: protects=while listening, a typed address switches by Enter or Switch with no Stop in between (the service hands the slot over), Enter with nothing new does nothing rather than Stop, and Stop still stops; fails_when=submit-while-busy means Stop for Enter again, or Switch shows when nothing changed; why_new=switching receivers while listening; seam=none; no_claim=the service's handover (radio tests)
    it("switches to a typed address while listening, by Enter or Switch, without stopping", () => {
      savePin({ host: "kiwi.example", port: 8073 });
      radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
      const view = render(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Switch" })).toBeNull();
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(radio.stop).not.toHaveBeenCalled();
      expect(radio.tune).not.toHaveBeenCalled();

      fireEvent.change(field(), { target: { value: "http://other.example:8074/" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(radio.tune).toHaveBeenLastCalledWith({ host: "other.example", port: 8074, freqKhz: 10_000, mode: "am" });
      expect(chip()).toBe("other.example");
      listening(view, "other.example", 8074);

      fireEvent.change(field(), { target: { value: "third.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "third.example", port: 8074 }));
      expect(radio.stop).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(radio.stop).toHaveBeenCalledTimes(1);
    });

    // Value: protects=unpinning while listening keeps the audio (no stop, no tune), keeps dial retunes on the receiver playing, forgets the saved pin and leaves focus in the field; fails_when=clearPin touches the tuned receiver, sends anything, or drops focus to the page; why_new=pins; seam=fake timers; no_claim=none beyond protects
    it("unpins without touching what plays", () => {
      vi.useFakeTimers();
      try {
        savePin({ host: "kiwi.example", port: 8073 });
        radio.status = { state: "listening", host: "kiwi.example", port: 8073 };
        render(<ListenPage />);
        fireEvent.click(screen.getByRole("button", { name: "Unpin kiwi.example and use Auto" }));
        expect(chip()).toBe("Auto (best for this frequency)");
        expect(field().value).toBe("");
        expect(document.activeElement).toBe(field());
        expect(localStorage.getItem("skywave.pin")).toBeNull();
        expect(radio.stop).not.toHaveBeenCalled();
        expect(radio.tune).not.toHaveBeenCalled();
        radio.retune.mockClear();
        fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
        act(() => vi.advanceTimersByTime(500));
        expect(radio.retune).toHaveBeenCalledWith({ host: "kiwi.example", port: 8073, freqKhz: 10_001, mode: "am" });
      } finally {
        vi.useRealTimers();
      }
    });

    // Value: protects=asking skywave to choose ends a pin (owner: drop to Auto), but only when a run starts; fails_when=pickFrom doesn't clear the pin, or clears it when nothing could be tried; why_new=owner decision on pin vs Pick best; seam=list hook mocked; no_claim=none beyond protects
    it("drops a pin to Auto when Pick best starts a run", () => {
      savePin({ host: "kiwi.example", port: 8073 });
      receiverList.data = { receivers: [] };
      const view = render(<ListenPage />);
      // A blank Listen with nothing that covers the frequency starts no run: the pin stays.
      fireEvent.change(field(), { target: { value: "" } });
      act(() => fireEvent.click(screen.getByRole("button", { name: "Listen" })));
      expect(radio.tune).not.toHaveBeenCalled();
      expect(chip()).toBe("kiwi.example");
      view.rerender(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
      expect(chip()).toBe("Auto (best for this frequency)");
      expect(localStorage.getItem("skywave.pin")).toBeNull();
    });

    // Value: protects=Back is undo, not a choice (owner): in Auto it stays Auto, and with a pin the pin moves to where Back goes; fails_when=Back always pins or never moves a pin; why_new=owner decision on Back; seam=none; no_claim=none beyond protects
    it("keeps the mode on Back: Auto stays Auto, a pin moves", () => {
      const view = render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Listen" }))); // Auto lands on K1VL
      listening(view, listed.host, listed.port);
      act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
      radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      listening(view, backup.host, backup.port);
      fireEvent.click(screen.getByRole("button", { name: "Back to K1VL" }));
      expect(chip()).toBe("Auto (best for this frequency)");
      cleanup();

      radio.status = { state: "idle" };
      const pinned = render(<ListenPage />);
      fireEvent.change(field(), { target: { value: "kiwi.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      listening(pinned, "kiwi.example", 8073);
      fireEvent.click(screen.getByRole("button", { name: "choose listed" }));
      listening(pinned, listed.host, listed.port);
      fireEvent.click(screen.getByRole("button", { name: "Back to kiwi.example" }));
      expect(chip()).toBe("kiwi.example");
    });
  });

  describe("Switch to a better receiver?", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // K1VL tunes only up to 10 MHz here, so the dial above that is out of its range.
    const narrow = { ...listed, maxKhz: 10_000 };
    const prompt = () => document.querySelector(".switch-prompt")!;

    function playingNarrow() {
      receiverList.data = { receivers: [narrow, backup] };
      savePin({ host: listed.host, port: listed.port, fromList: true, label: "K1VL" });
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      const view = render(<ListenPage />);
      const readout = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
      act(() => readout.focus());
      fireEvent.change(readout, { target: { value: "15000" } });
      fireEvent.submit(readout.form!);
      return view;
    }

    // Value: protects=the offer comes only once the dial rests, never tunes by itself, and its button switches through Pick best (leaving out the receiver playing) and drops the pin to Auto; fails_when=the prompt auto-switches, shows mid-move, or its button dials directly or keeps the pin; why_new=switch prompt (owner: ask, don't switch); seam=fake timers, list hook mocked; no_claim=the rule's thresholds (better-receiver tests)
    it("asks once the dial rests, and switches only on a click", () => {
      playingNarrow();
      expect(prompt().textContent).toBe("");
      act(() => vi.advanceTimersByTime(1_500));
      expect(prompt().textContent).toContain("K1VL can't tune 15,000 kHz. Switch to a better receiver?");
      act(() => vi.advanceTimersByTime(60_000));
      expect(radio.tune).not.toHaveBeenCalled();

      act(() => fireEvent.click(screen.getByRole("button", { name: "Switch to Backup" })));
      expect(radio.tune).toHaveBeenCalledTimes(1);
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: backup.host, freqKhz: 15_000 }));
      expect(document.getElementById("host-choice")!.textContent).toBe("Auto (best for this frequency)");
      expect(prompt().textContent).toBe("");
    });

    // Value: protects=the button tunes the receiver it names, never a better-ranked one the listener already declined; fails_when=the switch passes Pick best the plain ranking, whose first entry is the declined receiver (Claude review: a switch to a receiver the listener said no to, cutting audio); why_new=switch prompt; seam=fake timers, list hook mocked; no_claim=Pick best's later candidates
    it("switches to the receiver it names, past one already declined", () => {
      receiverList.data = {
        receivers: [narrow, backup, { ...backup, id: "third", name: "Third", host: "third.example", snr: 20 }],
      };
      savePin({ host: listed.host, port: listed.port, fromList: true, label: "K1VL" });
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      render(<ListenPage />);
      const readout = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
      act(() => readout.focus());
      fireEvent.change(readout, { target: { value: "15000" } });
      fireEvent.submit(readout.form!);
      act(() => vi.advanceTimersByTime(1_500));
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(1_500));
      act(() => fireEvent.click(screen.getByRole("button", { name: "Switch to Third" })));
      expect(radio.tune).toHaveBeenCalledTimes(1);
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: "third.example" }));
      expect(document.activeElement).toBe(document.querySelector("div.status"));
    });

    // Value: protects=Not now hides the offer, keeps focus on the page (status row), and the offer doesn't come back for the same receiver on the next rest; fails_when=dismiss isn't remembered or focus drops to the body; why_new=switch prompt; seam=fake timers; no_claim=none beyond protects
    it("stays away after Not now", () => {
      playingNarrow();
      act(() => vi.advanceTimersByTime(1_500));
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(prompt().textContent).toBe("");
      // The button went away; focus waits on the status row rather than dropping to the page.
      expect(document.activeElement).toBe(document.querySelector("div.status"));
      fireEvent.keyDown(screen.getByRole("slider", { name: "Tuning dial" }), { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(5_000));
      expect(prompt().textContent).toBe("");
      expect(radio.tune).not.toHaveBeenCalled();
    });
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

    // Value: protects=a quick switch restarts the 10 s wait, so the new receiver gets its own full wait; fails_when=the timer isn't reset when the playing receiver changes and fires a few seconds into the next one; why_new=only a single receiver was tested; seam=useRadio mocked; no_claim=service behaviour
    it("restarts the wait when the receiver changes before it scans", () => {
      radio.canScan = true;
      const view = render(<ListenPage />);
      playing(view);
      act(() => vi.advanceTimersByTime(6_000));
      playing(view, "other.example", 8073);
      act(() => vi.advanceTimersByTime(9_999));
      expect(radio.startScan).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
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
      savePin({ host: listed.host, port: listed.port, fromList: true });
      const view = render(<ListenPage />);
      playing(view);
      expect(screen.getByText("Scanned 9 of 15 bands.", { exact: false })).toBeTruthy();
      expect(screen.getByText("2 digital or noise signals aren't listed.", { exact: false })).toBeTruthy();
      act(() => fireEvent.click(screen.getByRole("button", { name: /9,420\s*31m/ })));
      act(() => vi.advanceTimersByTime(200));
      expect(radio.retune).toHaveBeenLastCalledWith(expect.objectContaining({ freqKhz: 9_420, mode: "am" }));
      act(() => fireEvent.click(screen.getByRole("button", { name: "Scan again" })));
      expect(radio.startScan).toHaveBeenLastCalledWith(true);
    });
  });
  describe("design pass", () => {
    // Rankable without a tie: equal receivers rank in a per-browser random order.
    beforeEach(() => {
      receiverList.data = { receivers: [listed, { ...backup, snr: 10 }] };
    });
    const message = () => document.querySelector(".status-message")?.textContent ?? null;
    const listen = () => fireEvent.click(screen.getByRole("button", { name: "Listen" }));

    // Value: protects=a blank Receiver field makes Listen run Pick best on the ranked list (design D4) instead of failing validation; fails_when=the blank case falls through to tune("") or validation; why_new=Listen needed a hostname; seam=list hook mocked; no_claim=the ranking itself (kiwi-list tests)
    it("runs Pick best from a blank Listen", () => {
      render(<ListenPage />);
      expect((screen.getByLabelText("Receiver") as HTMLInputElement).required).toBe(false);
      act(listen);
      expect(radio.tune).toHaveBeenCalledWith(expect.objectContaining({ host: listed.host, source: "list" }));
    });

    // Value: protects=a blank Listen before the list has loaded, or after it failed, says why and starts nothing (eng review R2); fails_when=Pick best runs on an empty list ("No listed receiver covers") or nothing is said; why_new=blank Listen is new; seam=list hook mocked; no_claim=real list outage
    it.each([
      ["loading", 0, "The receiver list is still loading. Press Listen again in a moment."],
      ["failed", 1, "Couldn't load the public receiver list. Paste a receiver address, or try again below."],
    ])("explains a blank Listen while the list is %s", (_, errorUpdatedAt, text) => {
      receiverList.data = undefined;
      receiverList.errorUpdatedAt = errorUpdatedAt;
      const view = render(<ListenPage />);
      act(listen);
      expect(radio.tune).not.toHaveBeenCalled();
      expect(message()).toBe(text);
      // The list arriving answers it.
      receiverList.data = { receivers: [listed] };
      view.rerender(<ListenPage />);
      expect(message()).toBeNull();
    });

    // Value: protects=a waterfall click near the bottom of the band can't tune below 10 kHz (Codex structured review); fails_when=onWaterfallClick skips clampKhz; why_new=the 10 kHz floor arrived with this pass; seam=Waterfall mocked; no_claim=the click-to-offset math (Waterfall)
    it("keeps waterfall clicks within the tuning range", () => {
      render(<ListenPage />);
      const input = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "12" } });
      fireEvent.submit(input.form!);
      act(() => input.blur());
      act(() => waterfallClick.current!(-6_000));
      expect(input.value).toBe("10.00");
    });

    // Value: protects=the scan note counts Pick best's check when Pick best chose the receiver, and not otherwise (testing review); fails_when=scanDelayMs or checking is wired to the wrong side of pickBest.settled; why_new=only SignalList's own text was tested; seam=radio mocked; no_claim=the scan timer itself
    it("tells the scan wait, counting Pick best's check only when it picked", () => {
      radio.canScan = true;
      const view = render(<ListenPage />);
      act(listen); // blank: Pick best picks
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      expect(screen.getByText(/once Pick best has finished checking this receiver, about 25 seconds in/)).toBeTruthy();
      cleanup();

      render(<ListenPage />); // a receiver someone else chose: no check to wait for
      expect(screen.getByText(/about 10 seconds after a receiver starts playing/)).toBeTruthy();
    });

    // Value: protects=a "still loading" explanation turns into the failure text when the list then fails (adversarial review); fails_when=the message text is fixed when Listen is pressed; why_new=the text was frozen at press time; seam=list hook mocked; no_claim=real list outage
    it("updates a blank Listen's explanation when the list then fails", () => {
      receiverList.data = undefined;
      receiverList.errorUpdatedAt = 0;
      const view = render(<ListenPage />);
      act(listen);
      expect(message()).toBe("The receiver list is still loading. Press Listen again in a moment.");
      receiverList.errorUpdatedAt = 1;
      view.rerender(<ListenPage />);
      expect(message()).toBe("Couldn't load the public receiver list. Paste a receiver address, or try again below.");
    });

    // Value: protects=during a run the status row shows Pick best's note, not the bare refusal, and the error link stays hidden until nothing is handling the error (eng review R4/R7, R5); fails_when=the service message wins mid-run or the link ignores pickBest.settled; why_new=the note and link moved into the status row; seam=list hook mocked; no_claim=real refusal timing
    it("shows Pick best's note mid-run and offers Pick best only once it's settled", () => {
      const view = render(<ListenPage />);
      act(listen);
      radio.status = { state: "error", code: "busy", message: "full", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      expect(message()).toBe("K1VL was full; trying Backup…");
      expect(document.querySelector(".status-message")!.getAttribute("data-tone")).toBeNull(); // mid-run: not a failure
      expect(screen.queryByRole("button", { name: "Pick best receiver" })).toBeNull();
      // A typed receiver that fails with nothing else going on.
      act(() => fireEvent.click(screen.getByRole("button", { name: "stop picking" })));
      radio.status = { state: "error", code: "busy", message: "full", host: "typed.example", port: 8073 };
      view.rerender(<ListenPage />);
      expect(message()).toBe("full");
      radio.tune.mockClear();
      act(() => fireEvent.click(screen.getByRole("button", { name: "Pick best receiver" })));
      // K1VL said it was full a moment ago, so the new run starts on Backup.
      expect(radio.tune).toHaveBeenCalledWith(expect.objectContaining({ host: backup.host }));
    });

    // Value: protects=after an error, choosing a receiver hides the error link while that tune starts, so Pick best can't override the choice (red-team review); fails_when=the link ignores starting; why_new=review finding; seam=list hook mocked; no_claim=none beyond protects
    it("hides the error link while a chosen receiver connects", () => {
      radio.status = { state: "error", code: "busy", message: "full", host: "typed.example", port: 8073 };
      const view = render(<ListenPage />);
      expect(screen.getByRole("button", { name: "Pick best receiver" })).toBeTruthy();
      radio.tuning = true;
      act(() => fireEvent.click(screen.getByRole("button", { name: "choose listed" })));
      view.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Pick best receiver" })).toBeNull();
    });

    // Value: protects=the error link ignores the second click of a double-click, so one double-click starts one Pick best run (review finding); fails_when=the e.detail guard is dropped; why_new=the link is new; seam=list hook mocked; no_claim=real mouse timing
    it("starts one run from a double-click on the error link", () => {
      radio.status = { state: "error", code: "busy", message: "full", host: "typed.example", port: 8073 };
      render(<ListenPage />);
      const link = screen.getByRole("button", { name: "Pick best receiver" });
      act(() => {
        fireEvent.click(link, { detail: 1 });
        fireEvent.click(link, { detail: 2 });
      });
      expect(radio.tune).toHaveBeenCalledTimes(1);
    });

    // Value: protects=a run that ends back on a playing receiver shows its note in the neutral tone, not as a failure (eng review R7 tone rule); fails_when=the note's danger tone ignores whether something plays; why_new=only failed-run notes were tested; seam=list hook mocked; no_claim=none beyond protects
    it("shows a run that ended back on a playing receiver without the danger tone", () => {
      const view = render(<ListenPage />);
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "typed.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Listen" }));
      radio.status = { state: "listening", host: "typed.example", port: 8073 };
      view.rerender(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "pick best" })));
      for (const r of [listed, backup]) {
        radio.status = { state: "error", code: "busy", message: "full", host: r.host, port: r.port };
        view.rerender(<ListenPage />);
      }
      // Going back: the lamp says Connecting, and recovering isn't a failure either.
      radio.tuning = true;
      view.rerender(<ListenPage />);
      expect(message()).toMatch(/Going back to typed\.example…$/);
      expect(document.querySelector(".status-message")!.getAttribute("data-tone")).toBeNull();
      radio.tuning = false;
      radio.status = { state: "listening", host: "typed.example", port: 8073 };
      view.rerender(<ListenPage />);
      const note = document.querySelector(".status-message")!;
      expect(note.textContent).toMatch(/Back on typed\.example\.$/);
      expect(note.getAttribute("data-tone")).toBeNull();
    });

    // Value: protects=a late refusal inside Pick best's 15 s watch shows no error link, because Pick best moves on by itself (eng review R5); fails_when=the link shows on any error regardless of Pick best; why_new=plan audit: the watch case was untested; seam=list hook mocked; no_claim=settled vs running (every error the watch leaves unhandled ends it, so the two read the same)
    it("keeps the error link hidden during Pick best's watch", () => {
      const view = render(<ListenPage />);
      act(listen);
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      // A late refusal from the receiver Pick best chose, inside its watch: Pick best moves on by itself.
      radio.status = { state: "error", code: "no_apps", message: "apps only", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Pick best receiver" })).toBeNull();
    });

    // Value: protects=a browser that blocks storage still gets a working page on the default tuning, and saving fails quietly (design D10); fails_when=loadTuning or saveTuning lose their try/catch; why_new=plan audit: blocked storage was untested; seam=Storage.prototype spied; no_claim=a real private-mode browser
    it("starts on the default tuning when storage is blocked", () => {
      vi.useFakeTimers();
      const blocked = () => {
        throw new Error("storage blocked");
      };
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
      try {
        render(<ListenPage />);
        expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("10,000.00");
        act(() => fireEvent.click(screen.getByRole("radio", { name: "USB" })));
        act(() => vi.advanceTimersByTime(1_000)); // the save throws inside its try
        expect((screen.getByRole("radio", { name: "USB" }) as HTMLInputElement).checked).toBe(true);
      } finally {
        get.mockRestore();
        set.mockRestore();
        vi.useRealTimers();
      }
    });

    // Value: protects=Pick best after a receiver's error never tries that same receiver first, so a no_apps Kiwi isn't redialed to cut the listener off again (adversarial review); fails_when=startPickBest ranks the failed host:port; why_new=the list's copy can be 15 min old; seam=none; no_claim=real refusal timing
    it("leaves out the receiver that just failed when the error link picks", () => {
      receiverList.data = { receivers: [listed, { ...backup, snr: 10 }] };
      radio.status = { state: "error", code: "no_apps", message: "no room", host: "SDR.K1VL.com", port: listed.port };
      render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Pick best receiver" }), { detail: 1 }));
      expect(radio.tune).toHaveBeenCalledTimes(1);
      expect(radio.tune).toHaveBeenLastCalledWith(expect.objectContaining({ host: backup.host }));
    });

    // Value: protects=a saved preset outside 10 to 30,000 kHz (the server accepts up to 32,000) tunes inside the range (Codex adversarial review); fails_when=preset select skips clampKhz; why_new=the range is new on this branch; seam=Presets mocked; no_claim=how presets are stored
    it("keeps a preset inside the tuning range", () => {
      render(<ListenPage />);
      act(() => presetSelect.current!({ freqKhz: 31_000, mode: "am" }));
      expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("30,000.00");
      act(() => presetSelect.current!({ freqKhz: 5, mode: "am" }));
      expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("10.00");
    });

    // Value: protects=an error that isn't the receiver's own (service down, audio blocked, the service rejecting a tune) offers no Pick best link, so the typed receiver isn't swapped for a public one (Codex adversarial review); fails_when=the link ignores status.host or status.code; why_new=the link showed on every error; seam=radio mocked; no_claim=the service's own error texts
    it("offers Pick best only for a receiver's own error", () => {
      radio.status = { state: "error", message: "Can't reach the radio service." };
      const view = render(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Pick best receiver" })).toBeNull();
      // The service rejecting a tune still names the receiver, but carries no code.
      radio.status = { state: "error", message: "listener limit", host: "typed.example", port: 8073 };
      view.rerender(<ListenPage />);
      expect(screen.queryByRole("button", { name: "Pick best receiver" })).toBeNull();
      radio.status = { state: "error", code: "busy", message: "full", host: "typed.example", port: 8073 };
      view.rerender(<ListenPage />);
      expect(screen.getByRole("button", { name: "Pick best receiver" })).toBeTruthy();
    });

    // Value: protects=a blank Listen's "still loading" note goes away once the listener tunes a typed or listed receiver instead; fails_when=listen() or tuneReceiver() stop clearing pageMessage, so the stale note sits over the new tune; why_new=only the list arriving was tested as clearing it; seam=list hook mocked; no_claim=real list timing
    it("drops a blank Listen's explanation once a receiver is tuned another way", () => {
      receiverList.data = undefined;
      render(<ListenPage />);
      act(listen);
      expect(message()).toBe("The receiver list is still loading. Press Listen again in a moment.");
      fireEvent.change(screen.getByLabelText("Receiver"), { target: { value: "typed.example" } });
      act(listen);
      expect(radio.tune).toHaveBeenCalledWith(expect.objectContaining({ host: "typed.example" }));
      expect(message()).toBeNull();
      cleanup();

      render(<ListenPage />);
      act(listen);
      expect(message()).toBe("The receiver list is still loading. Press Listen again in a moment.");
      act(() => fireEvent.click(screen.getByRole("button", { name: "choose listed" })));
      expect(message()).toBeNull();
    });

    // Value: protects=pressing the error link moves focus to the status row, since the run hides the link and focus would drop to the page; fails_when=the statusRef focus call is dropped or runs when the link stays (no list); why_new=no test read focus after the link; seam=list hook mocked; no_claim=how a real screen reader announces the row
    it("moves focus to the status row when the error link starts a run, and leaves it when it can't", () => {
      radio.status = { state: "error", code: "busy", message: "full", host: "typed.example", port: 8073 };
      render(<ListenPage />);
      const link = screen.getByRole("button", { name: "Pick best receiver" });
      act(() => link.focus());
      act(() => fireEvent.click(link, { detail: 1 }));
      expect(radio.tune).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(document.querySelector("div.status"));
      cleanup();

      // No list: the link stays to press again, so focus stays on it.
      receiverList.data = undefined;
      render(<ListenPage />);
      const again = screen.getByRole("button", { name: "Pick best receiver" });
      act(() => again.focus());
      act(() => fireEvent.click(again, { detail: 1 }));
      expect(document.activeElement).toBe(again);
      cleanup();

      // A list where nothing covers the frequency: no run starts, so focus stays too (Codex review).
      receiverList.data = { receivers: [{ ...listed, minKhz: 20_000, maxKhz: 30_000 }] };
      render(<ListenPage />);
      const none = screen.getByRole("button", { name: "Pick best receiver" });
      act(() => none.focus());
      act(() => fireEvent.click(none, { detail: 1 }));
      expect(document.activeElement).toBe(none);
    });

    // Value: protects=the error link checks the list like blank Listen does, instead of reporting that nothing covers the frequency (eng review R8); fails_when=the link calls Pick best with no list; why_new=the link is new; seam=list hook mocked; no_claim=none beyond protects
    it.each([
      // Listen would redial the receiver that just failed, so it names the link (adversarial review).
      ["loading", 0, "The receiver list is still loading. Press Pick best receiver again in a moment."],
      ["failed", 1, "Couldn't load the public receiver list. Paste a receiver address, or try again below."],
    ])("explains the error link while the list is %s", (_, errorUpdatedAt, text) => {
      receiverList.data = undefined;
      receiverList.errorUpdatedAt = errorUpdatedAt;
      radio.status = { state: "error", code: "busy", message: "full", host: "typed.example", port: 8073 };
      render(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Pick best receiver" })));
      expect(radio.tune).not.toHaveBeenCalled();
      expect(message()).toBe(text);
    });

    // Value: protects=the newest message wins: a finished run's note gives way to a later service message, and a new press isn't hidden by an older failure (eng review R7); fails_when=fixed precedence returns; why_new=Codex O2; seam=list hook mocked; no_claim=none beyond protects
    it("shows the newest message, whichever said it", () => {
      receiverList.data = { receivers: [] };
      const view = render(<ListenPage />);
      act(listen);
      expect(message()).toBe("No listed receiver covers this frequency.");
      radio.status = {
        state: "error",
        code: "closed",
        message: "The receiver hung up.",
        host: "typed.example",
        port: 8073,
      };
      view.rerender(<ListenPage />);
      expect(message()).toBe("The receiver hung up.");
      receiverList.data = undefined;
      view.rerender(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Pick best receiver" })));
      expect(message()).toBe("The receiver list is still loading. Press Pick best receiver again in a moment.");
    });

    // Value: protects=only failures read in the danger tone: a service error and a finished run that found nothing, not the page's own "still loading" explanation (eng review R7); fails_when=messageTone is dropped, inverted, or applied to every message; why_new=the tone arrived with the merged status row and no test read it; seam=list hook mocked; no_claim=the color itself (CSS, browser check)
    it("marks failures, not explanations, in the danger tone", () => {
      const tone = () => document.querySelector(".status-message")?.getAttribute("data-tone") ?? null;
      receiverList.data = { receivers: [] };
      const view = render(<ListenPage />);
      act(listen);
      expect(message()).toBe("No listed receiver covers this frequency.");
      expect(tone()).toBe("danger");
      radio.status = {
        state: "error",
        code: "closed",
        message: "The receiver hung up.",
        host: "typed.example",
        port: 8073,
      };
      view.rerender(<ListenPage />);
      expect(tone()).toBe("danger");
      receiverList.data = undefined;
      view.rerender(<ListenPage />);
      act(() => fireEvent.click(screen.getByRole("button", { name: "Pick best receiver" })));
      expect(message()).toBe("The receiver list is still loading. Press Pick best receiver again in a moment.");
      expect(tone()).toBeNull();
    });

    // Value: protects=the header strip names where a listed receiver is (then its host), and falls back to the host when the list doesn't know it (design D9, moved up from the status row), and the status live region says where too so a switch is announced; fails_when=the place lookup misses or prints nothing useful; why_new=the strip replaced the status detail; seam=list hook mocked; no_claim=how volunteers write locations (placeName tests)
    it("says where a listed receiver is", () => {
      const strip = () => document.querySelector(".tuned-to-text");
      const view = render(<ListenPage />);
      expect(strip()).toBeNull(); // nothing playing: the strip shows the receiver choice instead
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      view.rerender(<ListenPage />);
      expect(strip()!.textContent).toBe(`Listening via Vermont · ${listed.host}`);
      // The strip isn't a live region; the status row says where too, so a switch is heard.
      expect(document.querySelector('div.status[role="status"]')!.textContent).toContain("Listening via Vermont");
      radio.status = { state: "listening", host: "typed.example", port: 8073 };
      view.rerender(<ListenPage />);
      expect(strip()!.textContent).toBe("Listening via typed.example");
      // A status with no port means the Kiwi default, 8073.
      receiverList.data = {
        receivers: [
          { ...backup, location: "Ohio" },
          { ...listed, host: "quiet.example", location: "" },
        ],
      };
      radio.status = { state: "listening", host: backup.host };
      view.rerender(<ListenPage />);
      expect(strip()!.textContent).toBe(`Listening via Ohio · ${backup.host}`);
      // A listed receiver that gives no location reads like an unlisted one.
      radio.status = { state: "listening", host: "quiet.example", port: listed.port };
      view.rerender(<ListenPage />);
      expect(strip()!.textContent).toBe("Listening via quiet.example");
    });

    // Value: protects=a return visit comes back on the last frequency and mode, a bad stored value falls back, and the default never overwrites the saved value on load (design D10, eng review S6); fails_when=the restore is dropped or either field's check is skipped (each bad row breaks one field); no test can see the tuningRestored guard, since the restore's rerender clears the default's pending save; why_new=frequency wasn't stored; seam=none; no_claim=private-mode storage quirks
    it("remembers the last frequency and mode", () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem("skywave.tuning", JSON.stringify({ freqKhz: 9_420, mode: "usb" }));
        render(<ListenPage />);
        expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("9,420.00");
        expect((screen.getByRole("radio", { name: "USB" }) as HTMLInputElement).checked).toBe(true);
        act(() => vi.advanceTimersByTime(1_000));
        expect(JSON.parse(localStorage.getItem("skywave.tuning")!)).toEqual({ freqKhz: 9_420, mode: "usb" });
        act(() => fireEvent.click(screen.getByRole("radio", { name: "LSB" })));
        act(() => vi.advanceTimersByTime(499));
        expect(JSON.parse(localStorage.getItem("skywave.tuning")!).mode).toBe("usb");
        act(() => vi.advanceTimersByTime(1));
        expect(JSON.parse(localStorage.getItem("skywave.tuning")!)).toEqual({ freqKhz: 9_420, mode: "lsb" });
        cleanup();

        // Each bad row breaks one field only, so each check is needed on its own.
        for (const bad of [
          { freqKhz: -5, mode: "usb" },
          { freqKhz: 9_420, mode: "fm" },
          { freqKhz: "9420", mode: "usb" },
          { mode: "usb" },
        ]) {
          localStorage.setItem("skywave.tuning", JSON.stringify(bad));
          render(<ListenPage />);
          expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("10,000.00");
          expect((screen.getByRole("radio", { name: "AM" }) as HTMLInputElement).checked).toBe(true);
          cleanup();
        }

        // A value that isn't JSON at all still opens on the default rather than breaking the page.
        localStorage.setItem("skywave.tuning", "{not json");
        render(<ListenPage />);
        expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("10,000.00");
      } finally {
        vi.useRealTimers();
      }
    });

    // Value: protects=the waterfall opens on the visit's first audio and stays open through Stop (design D7); fails_when=it follows heardAudio, which drops on every tune; why_new=the strip is new; seam=Waterfall mocked; no_claim=the strip's height (browser check)
    it("opens the waterfall on first audio and keeps it open", () => {
      const view = render(<ListenPage />);
      expect(screen.getByLabelText("waterfall").textContent).toBe("strip");
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      radio.heardAudio = true;
      view.rerender(<ListenPage />);
      expect(screen.getByLabelText("waterfall").textContent).toBe("open");
      radio.status = { state: "stopped" };
      radio.heardAudio = false;
      view.rerender(<ListenPage />);
      expect(screen.getByLabelText("waterfall").textContent).toBe("open");
    });
  });

  describe("wide waterfall", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const width = () => screen.getByRole("group", { name: "Waterfall width" });
    const step = (name: string) => screen.getByRole("button", { name });

    /** A receiver playing, then past the scan's wait, which the wide view shares. */
    function playing(view: ReturnType<typeof render>, host = listed.host, port = listed.port) {
      radio.status = { state: "listening", host, port };
      radio.heardAudio = true;
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(10_000));
    }

    // Value: protects=the receiver's own waterfall is asked for only once the receiver has played 10 s, as the scan is (owner: same wait as the scan), the picker saying so meanwhile, and a switch starts the wait over; fails_when=the view opens with the first audio (a stream on every receiver Pick best tries or a quick switch leaves), the wait isn't shared, or a new receiver inherits the last one's; why_new=owner decision on review: the wide view skipped the scan's wait; seam=useRadio mocked, fake timers; no_claim=Pick best's own settling (its tests)
    it("waits as long as the scan before asking for the receiver's waterfall", () => {
      radio.canView = true;
      const view = render(<ListenPage />);
      radio.status = { state: "listening", host: listed.host, port: listed.port };
      radio.heardAudio = true;
      view.rerender(<ListenPage />);
      act(() => vi.advanceTimersByTime(9_999));
      expect(radio.showView).not.toHaveBeenCalledWith(expect.objectContaining({ zoom: 9 }));
      expect(screen.getByLabelText("waterfall")).toBeTruthy();
      expect(screen.getByText("The receiver's waterfall starts in a few seconds.")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(radio.showView).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 9 }));
      expect(screen.queryByText("The receiver's waterfall starts in a few seconds.")).toBeNull();
      // Another receiver waits its own 10 s, back on the audio waterfall meanwhile.
      radio.status = { state: "listening", host: backup.host, port: backup.port };
      view.rerender(<ListenPage />);
      expect(radio.showView).toHaveBeenLastCalledWith(null);
      expect(screen.getByLabelText("waterfall")).toBeTruthy();
      act(() => vi.advanceTimersByTime(10_000));
      expect(radio.showView).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 9 }));
    });

    // Value: protects=the EiBi schedule names stations in all three owner-chosen places: under the readout for the tuned frequency, on each Strong signals row, and to the wide waterfall for the frequencies around the view (and not ones far outside it); and nothing until the schedule has loaded; fails_when=a spot is left unwired, gets another frequency's name, or the wide view is handed the whole season; why_new=owner decision: names in three places; seam=useRadio, useSchedule and both waterfalls mocked; no_claim=the matching rules (eibi tests)
    it("names scheduled stations under the readout, in the signals and on the wide waterfall", () => {
      localStorage.setItem("skywave.tuning", JSON.stringify({ freqKhz: 9_650, mode: "am" }));
      const daily = (khz: number, station: string) => ({
        khz,
        start: 0,
        end: 1440,
        days: "",
        station,
        lang: "E",
        target: "Eu",
      });
      radio.canView = true;
      radio.canScan = true;
      radio.scan = {
        state: "done",
        host: listed.host,
        port: listed.port,
        signals: [{ freqKhz: 9_580, snrDb: 31, band: "31m" }],
        hidden: 0,
        bandsDone: 1,
        bandsTotal: 1,
        partial: false,
      };
      const view = render(<ListenPage />);
      expect(document.querySelector(".readout-station")).toBeNull();
      schedule.data = {
        season: "b26",
        bundled: false,
        broadcasts: [
          daily(5_000, "Far away"),
          daily(9_580, "KBS World Radio"),
          daily(9_620, "Nearby"),
          daily(9_650, "Radio Here"),
        ],
      };
      playing(view);
      expect(document.querySelector(".readout-station")!.textContent).toBe("Radio Here · English");
      expect(screen.getByRole("button", { name: /9,580\s*31m/ }).textContent).toContain("KBS World Radio · English");
      expect(wide.current!.stations!.map((x) => [x.khz, x.label])).toEqual([
        // Twice the ~59 kHz view around 9,650: 9,580 is past it.
        [9_620, "Nearby"],
        [9_650, "Radio Here"],
      ]);
    });

    // Value: protects=once audio has played on a service that streams it, the receiver's own waterfall opens 60 kHz wide around the dial (owner: open at ~60 kHz) and Audio goes back to the audio one, telling the service each time; fails_when=the default width changes, the view isn't asked for (or is asked for before audio or without the feature), or Audio leaves the wide view up; why_new=wideband waterfall; seam=useRadio and both waterfalls mocked; no_claim=what the service streams (radio tests)
    it("opens 60 kHz wide around the dial once audio plays, and Audio goes back", () => {
      localStorage.setItem("skywave.tuning", JSON.stringify({ freqKhz: 9_650, mode: "am" }));
      radio.canView = true;
      const view = render(<ListenPage />);
      expect(screen.queryByRole("group", { name: "Waterfall width" })).toBeNull();
      expect(radio.showView).not.toHaveBeenCalledWith(expect.objectContaining({ zoom: 9 }));
      playing(view);
      expect(step("60 kHz").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("wide waterfall").textContent).toContain("9 9650");
      expect(radio.showView).toHaveBeenLastCalledWith({ zoom: 9, cfKhz: 9_650 });
      expect(screen.queryByLabelText("waterfall")).toBeNull();
      fireEvent.click(step("Audio"));
      expect(screen.getByLabelText("waterfall")).toBeTruthy();
      expect(screen.queryByLabelText("wide waterfall")).toBeNull();
      expect(radio.showView).toHaveBeenLastCalledWith(null);
      fireEvent.click(step("230 kHz"));
      expect(radio.showView).toHaveBeenLastCalledWith({ zoom: 7, cfKhz: 9_650 });
    });

    // Value: protects=a service that can't stream the receiver's waterfall leaves only the audio view, the other widths disabled; fails_when=the wide view is asked for or shown without the feature; why_new=wideband waterfall; seam=useRadio mocked; no_claim=none
    it("keeps the audio view on a service that can't stream the receiver's waterfall", () => {
      const view = render(<ListenPage />);
      playing(view);
      expect(width()).toBeTruthy();
      expect((step("60 kHz") as HTMLButtonElement).disabled).toBe(true);
      expect((step("Audio") as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByLabelText("waterfall")).toBeTruthy();
      expect(radio.showView).not.toHaveBeenCalledWith(expect.objectContaining({ zoom: expect.any(Number) }));
    });

    // Value: protects=a click on the wide waterfall tunes to the nearest channel on the wheel's grid (5 kHz on shortwave AM) and the view holds still while the dial moves inside it, moving only near an edge; fails_when=clicks land between channels, or every tune repoints the receiver's waterfall; why_new=click-to-tune on the wide view; seam=useRadio and WideWaterfall mocked; no_claim=the pixel to frequency maths (WideWaterfall tests)
    it("tunes a click to the nearest channel and moves the view only near its edge", () => {
      localStorage.setItem("skywave.tuning", JSON.stringify({ freqKhz: 9_650, mode: "am" }));
      radio.canView = true;
      const view = render(<ListenPage />);
      playing(view);
      act(() => wide.current!.onTune(9_662.4));
      expect((screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement).value).toBe("9,660.00");
      expect(radio.showView).toHaveBeenLastCalledWith({ zoom: 9, cfKhz: 9_650 });
      // 60 kHz wide: 9,675 is past 40% of the span from the centre, so the view follows.
      act(() => wide.current!.onTune(9_675));
      expect(radio.showView).toHaveBeenLastCalledWith({ zoom: 9, cfKhz: 9_675 });
    });

    // Value: protects=the band width frames the dial's whole band (31m: 9,400 to 9,900 kHz) and falls back to 60 kHz when the dial leaves every band; fails_when=band picks a zoom that clips it, stays selected out of band, or names the wrong band; why_new=owner decision: a "Band" step for the meter band; seam=useRadio mocked; no_claim=the band table (radio-types)
    it("shows the dial's whole band, and falls back when it leaves the band", () => {
      localStorage.setItem("skywave.tuning", JSON.stringify({ freqKhz: 9_650, mode: "am" }));
      radio.canView = true;
      const view = render(<ListenPage />);
      playing(view);
      fireEvent.click(step("31m band"));
      // 30,000 / 2^5 = 937.5 kHz holds the band's 500; 2^6 (469) wouldn't.
      expect(radio.showView).toHaveBeenLastCalledWith({ zoom: 5, cfKhz: 9_650 });
      act(() => wide.current!.onTune(8_500));
      expect((step("Band") as HTMLButtonElement).disabled).toBe(true);
      expect(step("60 kHz").getAttribute("aria-pressed")).toBe("true");
      expect(radio.showView).toHaveBeenLastCalledWith({ zoom: 9, cfKhz: 8_500 });
    });

    // Value: protects=while a band scan sweeps, the wide view says so and holds still (owner: freeze with "Scanning…"), and a view error reaches it; fails_when=frozen or error isn't passed; why_new=wideband waterfall; seam=useRadio and WideWaterfall mocked; no_claim=the overlay's words (WideWaterfall tests)
    it("freezes for a scan and passes on a view error", () => {
      radio.canView = true;
      const view = render(<ListenPage />);
      playing(view);
      expect(wide.current!.frozen).toBe(false);
      radio.scan = { state: "scanning", host: listed.host, port: listed.port };
      radio.viewError = "Couldn't show this receiver's waterfall: busy";
      view.rerender(<ListenPage />);
      expect(wide.current!.frozen).toBe(true);
      expect(wide.current!.error).toBe("Couldn't show this receiver's waterfall: busy");
    });

    // Value: protects=after Stop or an error the audio waterfall comes back (saying what it waits for) instead of a wide picture that looks live, and a service without the stream shows Audio as the pressed width; fails_when=the wide view outlives listening, or the picker presses a disabled width; why_new=web review; seam=useRadio mocked; no_claim=none
    it("goes back to the audio waterfall when nothing plays", () => {
      radio.canView = true;
      const view = render(<ListenPage />);
      playing(view);
      expect(screen.getByLabelText("wide waterfall")).toBeTruthy();
      radio.status = { state: "error", message: "gone" };
      radio.heardAudio = false;
      view.rerender(<ListenPage />);
      expect(screen.queryByLabelText("wide waterfall")).toBeNull();
      expect(screen.getByLabelText("waterfall")).toBeTruthy();
      radio.canView = false;
      view.rerender(<ListenPage />);
      expect(step("Audio").getAttribute("aria-pressed")).toBe("true");
      expect(step("60 kHz").getAttribute("aria-pressed")).toBe("false");
    });

    // Value: protects=a switch to another receiver starts the wide view over (a blank picture saying it's opening) rather than leaving the last receiver's picture up, looking live, while a retune of the same one keeps it; fails_when=the wide waterfall isn't keyed on the receiver playing, or is keyed on something a retune changes; why_new=web review: the old picture stayed for up to 20 s after a switch; seam=WideWaterfall mocked (mount count); no_claim=the blank canvas itself (WideWaterfall's own mount)
    it("starts a new picture for a new receiver, not for a retune", () => {
      radio.canView = true;
      const view = render(<ListenPage />);
      playing(view);
      const first = wide.current!.mount;
      act(() => wide.current!.onTune(10_005));
      expect(wide.current!.mount).toBe(first);
      playing(view, backup.host, backup.port);
      expect(wide.current!.mount).toBeGreaterThan(first);
    });
  });
});
