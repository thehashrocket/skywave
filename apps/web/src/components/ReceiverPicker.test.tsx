// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@/lib/kiwi-list";
import { TRPCProvider } from "@/lib/trpc";
import type { AppRouter } from "@/server/root";
import { ReceiverPicker, ReceiverTable } from "./ReceiverPicker";

afterEach(cleanup);

function rx(name: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: name,
    name,
    location: `${name} town`,
    antenna: "dipole",
    host: `${name.toLowerCase()}.example`,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    ...over,
  };
}

const receivers = [
  rx("Alpha", { snr: 10 }),
  rx("Bravo", { snr: 40, users: 8 }),
  rx("Charlie", { snr: 30, antenna: "mini-whip" }),
  rx("Delta", { snr: 50, minKhz: 110_000, maxKhz: 142_000 }),
];

function setup() {
  const onChoose = vi.fn();
  render(
    <ReceiverTable receivers={receivers} freqKhz={10_000} current={{ host: "", port: 8073 }} onChoose={onChoose} />,
  );
  const names = () =>
    within(screen.getByRole("table"))
      .queryAllByRole("button", { name: /\.example:8073/ })
      .map((b) => b.querySelector(".receiver-name")!.textContent);
  return { onChoose, names };
}

describe("ReceiverTable", () => {
  it("starts in best-first order, hiding receivers that can't tune the frequency", () => {
    const { names } = setup();
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("shows everything when the frequency filter is off", () => {
    const { names } = setup();
    fireEvent.click(screen.getByLabelText(/Covers 10,000 kHz/));
    expect(names()).toContain("Delta");
  });

  it("filters to receivers with a free slot", () => {
    const { names } = setup();
    fireEvent.click(screen.getByLabelText("Has a free slot"));
    expect(names()).toEqual(["Charlie", "Alpha"]);
  });

  it("searches name, place and antenna", () => {
    const { names } = setup();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "whip" } });
    expect(names()).toEqual(["Charlie"]);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "nothing like it" } });
    expect(screen.getByText(/No receivers match/)).toBeTruthy();
  });

  it("sorts by a column, flipping on a second click", () => {
    const { names } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Receiver" }));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    fireEvent.click(screen.getByRole("button", { name: "Receiver" }));
    expect(names()).toEqual(["Charlie", "Bravo", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "SNR" }));
    expect(names()).toEqual(["Bravo", "Charlie", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by best" }));
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  // Value: protects=the tuned receiver is marked for assistive tech, not by color alone; fails_when=aria-current or the marker is dropped; why_new=the highlight was a data attribute only; seam=none; no_claim=visual contrast
  it("marks the receiver you're tuned to", () => {
    render(
      <ReceiverTable
        receivers={receivers}
        freqKhz={10_000}
        current={{ host: "charlie.example", port: 8073 }}
        onChoose={() => {}}
      />,
    );
    const tuned = screen.getByRole("button", { name: /charlie\.example:8073/ });
    expect(tuned.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /alpha\.example:8073/ }).getAttribute("aria-current")).toBeNull();
  });

  // Value: protects=clicking any cell of a row chooses it; fails_when=the row-level click handler is dropped; why_new=only the name button was clickable; seam=none; no_claim=pointer hit areas
  it("chooses a receiver when any cell of its row is clicked", () => {
    const { onChoose } = setup();
    fireEvent.click(screen.getByText("Charlie town"));
    expect(onChoose).toHaveBeenCalledWith(receivers[2]);
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("labels the default order and swaps the label for a reset link once sorted", () => {
    setup();
    expect(screen.getByText("Best first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SNR" }));
    expect(screen.queryByText("Best first")).toBeNull();
    expect(screen.getByRole("button", { name: "Sort by best" })).toBeTruthy();
  });

  // Value: protects=an over-filtered list can be recovered in one click; fails_when=Clear filters stops resetting the search or checkboxes; why_new=the empty state had no recovery; seam=none; no_claim=none beyond protects
  it("clears every filter from the empty state", () => {
    const { names } = setup();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "nothing like it" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("");
    expect(names()).toContain("Delta"); // the frequency filter is off too
  });

  // Value: protects=the name button (keyboard path) chooses exactly once; fails_when=an onClick returns to the button and the bubbled row click tunes twice; why_new=the row now owns the click; seam=none; no_claim=real keyboard activation
  it("chooses once when the name button is clicked", () => {
    const { onChoose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /charlie\.example:8073/ }));
    expect(onChoose).toHaveBeenCalledWith(receivers[2]);
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  const selection = (inRow: boolean) =>
    vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false, containsNode: () => inRow } as unknown as Selection);

  it("doesn't choose a row when the click ends a text selection in it", () => {
    const { onChoose } = setup();
    const spy = selection(true);
    fireEvent.click(screen.getByText("Charlie town"), { detail: 1 });
    spy.mockRestore();
    expect(onChoose).not.toHaveBeenCalled();
  });

  // Value: protects=leftover selected text elsewhere, or a keyboard press, still chooses; fails_when=the guard checks any page selection; why_new=pass-3 and Codex: rows went dead after selecting unrelated text; seam=none; no_claim=real browser selection
  it("still chooses with text selected elsewhere, or from the keyboard", () => {
    const { onChoose } = setup();
    let spy = selection(false);
    fireEvent.click(screen.getByText("Charlie town"), { detail: 1 });
    spy.mockRestore();
    spy = selection(true);
    fireEvent.click(screen.getByRole("button", { name: /charlie\.example:8073/ }), { detail: 0 });
    spy.mockRestore();
    expect(onChoose).toHaveBeenCalledTimes(2);
  });

  // Value: protects=the footer tells listeners how old the list (and its listener counts) is; fails_when=ago() thresholds or units change, or a missing fetchedAt prints "NaN"; why_new=no test rendered fetchedAt (TODOS.md gap); seam=none; no_claim=server clock skew
  it.each([
    [20_000, "List fetched just now from"],
    [5 * 60_000, "List fetched 5 min ago from"],
    [3 * 60 * 60_000, "List fetched 3 h ago from"],
    [undefined, "List fetched from"],
  ])("says how old the list is (%s ms)", (age, text) => {
    render(
      <ReceiverTable
        receivers={receivers}
        fetchedAt={age === undefined ? undefined : Date.now() - age}
        freqKhz={10_000}
        current={{ host: "", port: 8073 }}
        onChoose={() => {}}
      />,
    );
    expect(document.querySelector(".receivers-credit")!.textContent).toMatch(new RegExp(`^${text} `));
  });

  it("shows 50 rows until asked for all", () => {
    const many = Array.from({ length: 60 }, (_, i) => rx(`R${String(i).padStart(2, "0")}`));
    render(<ReceiverTable receivers={many} freqKhz={10_000} current={{ host: "", port: 8073 }} onChoose={() => {}} />);
    expect(screen.getAllByRole("row")).toHaveLength(51); // plus the header
    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));
    expect(screen.getAllByRole("row")).toHaveLength(61);
  });
});

// Stands in for the network: answers receivers.list with whatever `load` settles to.
function renderPicker(
  load: Promise<unknown> | (() => Promise<unknown>),
  note: string | null = null,
  onStopPicking: (() => void) | null = null,
) {
  const link: TRPCLink<AppRouter> = () => () =>
    observable((obs) => {
      (typeof load === "function" ? load() : load).then(
        (data) => {
          obs.next({ result: { type: "data", data } });
          obs.complete();
        },
        (err: Error) => obs.error(TRPCClientError.from(err)),
      );
    });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({ links: [link] });
  const onPickBest = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <ReceiverPicker
          freqKhz={10_000}
          current={{ host: "", port: 8073 }}
          open={false}
          onOpenChange={() => {}}
          onChoose={() => {}}
          onPickBest={onPickBest}
          picking={onStopPicking !== null}
          onStopPicking={onStopPicking ?? (() => {})}
          note={note}
        />
      </TRPCProvider>
    </QueryClientProvider>,
  );
  return { onPickBest, button: () => screen.getByRole("button", { name: "Pick best receiver" }) as HTMLButtonElement };
}

describe("ReceiverPicker", () => {
  // Value: protects=Pick best hands the hook only receivers that cover the dial, best first; fails_when=onPickBest gets the raw list or ignores freqKhz, so an airband Kiwi is tried at HF; why_new=only ReceiverTable was tested; seam=none; no_claim=server fetch
  it("enables Pick best once the list loads and offers only covering receivers, best first", async () => {
    let resolve!: (v: unknown) => void;
    const { onPickBest, button } = renderPicker(new Promise((r) => (resolve = r)));
    expect(button().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);

    resolve({ receivers, fetchedAt: 0 });
    await screen.findByText(/Highest signal-to-noise/);
    expect(button().disabled).toBe(false);
    fireEvent.click(button());

    expect(onPickBest).toHaveBeenCalledTimes(1);
    expect((onPickBest.mock.calls[0]![0] as Receiver[]).map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  // Value: protects=a running Pick best can be stopped from the same button; fails_when=the picking branch is removed; why_new=the button looked idle mid-run; seam=none; no_claim=what stopping does to the radio (page/hook tests)
  it("turns the button into Stop picking while a run is in progress", async () => {
    const stop = vi.fn();
    renderPicker(Promise.resolve({ receivers, fetchedAt: 0 }), "A was full; trying B…", stop);
    const button = await screen.findByRole("button", { name: "Stop picking" });
    // The second click of a double-click on Pick best mustn't cancel the run it just started.
    fireEvent.click(button, { detail: 2 });
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(button, { detail: 1 });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Pick best receiver" })).toBeNull();
  });

  // Value: protects=a failed list load can be retried without reloading the page; fails_when=the Try again button or its refetch is dropped; why_new=the error state had no recovery; seam=none; no_claim=real mirror (fake link)
  it("explains a failed list load, keeps Pick best off, and retries on request", async () => {
    let calls = 0;
    const { button } = renderPicker(() =>
      ++calls === 1 ? Promise.reject(new Error("BAD_GATEWAY")) : Promise.resolve({ receivers, fetchedAt: 0 }),
    );
    await screen.findByText(/Couldn't load the public receiver list/);
    expect(button().disabled).toBe(true);
    expect(screen.queryByText(/public receivers$/)).toBeNull(); // no empty Browse section

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(calls).toBe(2);
    cleanup();

    renderPicker(new Promise(() => {}), "A was full; trying B…");
    expect(screen.getByRole("status").textContent).toBe("A was full; trying B…");
  });
});
