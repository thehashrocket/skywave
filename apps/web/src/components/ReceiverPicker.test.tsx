// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@/lib/kiwi-list";
import { sunPosition } from "@/lib/solar";
import { TRPCProvider } from "@/lib/trpc";
import type { AppRouter } from "@/server/root";
import type { MapList } from "./MapPanel";
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
    <ReceiverTable
      receivers={receivers}
      freqKhz={10_000}
      current={{ host: "", port: 8073, phase: "listening" }}
      sun={null}
      onChoose={onChoose}
    />,
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
        current={{ host: "charlie.example", port: 8073, phase: "listening" }}
        sun={null}
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
    fireEvent.click(screen.getByText("Charlie town", { selector: ".location-text" }));
    expect(onChoose).toHaveBeenCalledWith(receivers[2]);
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  // Value: protects=phone rows keep a place to choose by (eng review R10, the Location column is hidden there) and the sort note sits with the table it describes (design D5); fails_when=the place line or the caption is dropped or moved back among the filters; why_new=both are new; seam=none; no_claim=which line shows at which width (CSS, browser check)
  it("puts the place in each row's button and the sort note in the table's caption", () => {
    setup();
    const row = screen.getByRole("button", { name: /charlie\.example:8073/ });
    expect(row.querySelector(".receiver-place")?.textContent).toBe("Charlie town");
    // A volunteer who gave no location gets no empty place line.
    cleanup();
    render(
      <ReceiverTable
        receivers={[rx("Delta", { location: " | " })]}
        freqKhz={10_000}
        current={null}
        sun={null}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /delta\.example:8073/ }).querySelector(".receiver-place")).toBeNull();
    expect(screen.getByText("Best first").closest("caption")).toBeTruthy();
    expect(screen.getByText("Best first").closest(".receivers-filters")).toBeNull();
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
    fireEvent.click(screen.getByText("Charlie town", { selector: ".location-text" }), { detail: 1 });
    spy.mockRestore();
    expect(onChoose).not.toHaveBeenCalled();
  });

  // Value: protects=leftover selected text elsewhere, or a keyboard press, still chooses; fails_when=the guard checks any page selection; why_new=pass-3 and Codex: rows went dead after selecting unrelated text; seam=none; no_claim=real browser selection
  it("still chooses with text selected elsewhere, or from the keyboard", () => {
    const { onChoose } = setup();
    let spy = selection(false);
    fireEvent.click(screen.getByText("Charlie town", { selector: ".location-text" }), { detail: 1 });
    spy.mockRestore();
    spy = selection(true);
    fireEvent.click(screen.getByRole("button", { name: /charlie\.example:8073/ }), { detail: 0 });
    spy.mockRestore();
    expect(onChoose).toHaveBeenCalledTimes(2);
  });

  // Value: protects=the footer tells listeners how old the list (and its listener counts) is; fails_when=ago() thresholds or units change, or a missing age prints "NaN"; why_new=no test rendered the age (TODOS.md gap); seam=none; no_claim=server clock skew (its own test)
  it.each([
    [20_000, "List fetched just now from"],
    [5 * 60_000, "List fetched 5 min ago from"],
    [3 * 60 * 60_000, "List fetched 3 h ago from"],
    [undefined, "List fetched from"],
  ])("says how old the list is (%s ms)", (age, text) => {
    render(
      <ReceiverTable
        receivers={receivers}
        serverAgeMs={age}
        receivedAt={age === undefined ? undefined : Date.now()}
        freqKhz={10_000}
        current={{ host: "", port: 8073, phase: "listening" }}
        sun={null}
        onChoose={() => {}}
      />,
    );
    expect(document.querySelector(".receivers-credit")!.textContent).toMatch(new RegExp(`^${text} `));
  });

  it("shows 50 rows until asked for all", () => {
    const many = Array.from({ length: 60 }, (_, i) => rx(`R${String(i).padStart(2, "0")}`));
    render(
      <ReceiverTable
        receivers={many}
        freqKhz={10_000}
        current={{ host: "", port: 8073, phase: "listening" }}
        sun={null}
        onChoose={() => {}}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(51); // plus the header
    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));
    expect(screen.getAllByRole("row")).toHaveLength(61);
  });
});

describe("ReceiverTable list age", () => {
  const table = (list: Receiver[], serverAgeMs: number, receivedAt: number) => (
    <ReceiverTable
      receivers={list}
      serverAgeMs={serverAgeMs}
      receivedAt={receivedAt}
      freqKhz={10_000}
      current={null}
      sun={null}
      onChoose={() => {}}
    />
  );
  const credit = () => document.querySelector(".receivers-credit")!.textContent;

  // Value: protects=a poll that brings the same rows still updates "fetched N ago"; fails_when=the shown age only changes with a new receivers array (react-query keeps the old one for identical rows); why_new=PR 2a review: the credit froze; seam=rerender with the same array; no_claim=react-query's structural sharing itself
  it("takes a newer age for the same rows at once", () => {
    const view = render(table(receivers, 40 * 60_000, Date.now()));
    expect(credit()).toMatch(/^List fetched 40 min ago/);
    view.rerender(table(receivers, 2 * 60_000, Date.now()));
    expect(credit()).toMatch(/^List fetched 2 min ago/);
    expect(screen.queryByRole("button", { name: "Show it" })).toBeNull();
  });

  // Value: protects=while a changed list waits behind "List updated", the credit describes the rows on show, then the new ones once taken; fails_when=the credit reads the latest copy's age while showing the held rows; why_new=Codex outside review (eng review 2026-10-21); seam=rerender with a new list; no_claim=none beyond protects
  it("keeps the held rows' age until the new list is shown", () => {
    const view = render(table(receivers, 40 * 60_000, Date.now()));
    view.rerender(table([...receivers].reverse(), 1 * 60_000, Date.now()));
    expect(credit()).toMatch(/^List fetched 40 min ago/);
    fireEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(credit()).toMatch(/^List fetched 1 min ago/);
  });

  // Value: protects=a held list reports the age of the freshest poll that confirmed the rows on show; fails_when=an identical-rows poll updates the shown age but not the held copy, so a later change makes the credit jump back; why_new=feature review (2026-10-21); seam=rerender with the same array, then a new one; no_claim=none beyond protects
  it("doesn't go back to an older age when a changed list is held after an identical poll", () => {
    const view = render(table(receivers, 40 * 60_000, Date.now()));
    view.rerender(table(receivers, 2 * 60_000, Date.now() + 1));
    view.rerender(table([...receivers].reverse(), 0, Date.now() + 2));
    expect(screen.getByRole("button", { name: "Show it" })).toBeTruthy();
    expect(credit()).toMatch(/^List fetched 2 min ago/);
  });
});

// Stands in for the network: answers receivers.list with whatever `load` settles to.
function renderPicker(
  load: Promise<unknown> | (() => Promise<unknown>),
  onStopPicking: (() => void) | null = null,
  children: React.ReactNode = null,
  map?: (list: MapList) => React.ReactNode,
  open = false,
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
          current={{ host: "", port: 8073, phase: "listening" }}
          sun={null}
          open={open}
          onOpenChange={() => {}}
          onChoose={() => {}}
          onPickBest={onPickBest}
          picking={onStopPicking !== null}
          onStopPicking={onStopPicking ?? (() => {})}
          map={map}
        >
          {children}
        </ReceiverPicker>
      </TRPCProvider>
    </QueryClientProvider>,
  );
  return {
    onPickBest,
    queryClient,
    button: () => screen.getByRole("button", { name: "Pick best receiver" }) as HTMLButtonElement,
  };
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
    renderPicker(Promise.resolve({ receivers, fetchedAt: 0 }), stop);
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
    expect(screen.queryByText(/^All receivers/)).toBeNull(); // no empty Browse section

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(calls).toBe(2);
    cleanup();

    // The list's own state stays announced here; Pick best's note lives in the page's status line.
    renderPicker(new Promise(() => {}));
    expect(screen.getByRole("status").textContent).toBe("Loading the public receiver list…");
  });

  // Value: protects=the map is told the list failed only after a load fails (not while loading), can retry it, and gets the list's age; fails_when=failed keys on !receivers alone or retry/ageMs are miswired; why_new=page and MapPanel tests mock the picker/list, so this derivation was unexercised; seam=none; no_claim=MapPanel's rendering of these (its own tests)
  it("hands the map slot the list, its failure state, a retry and its age", async () => {
    let calls = 0;
    const seen: MapList[] = [];
    let resolveFirst!: (e: unknown) => void;
    renderPicker(
      () =>
        ++calls === 1
          ? new Promise((_, reject) => (resolveFirst = reject))
          : Promise.resolve({ receivers, fetchedAt: 0, ageMs: 3 * 60_000 }),
      null,
      null,
      (list) => {
        seen.push(list);
        return null;
      },
    );
    // Still loading: no list, but not a failure either.
    expect(seen.at(-1)).toMatchObject({ receivers: undefined, ageMs: undefined, failed: false });
    resolveFirst(new Error("BAD_GATEWAY"));
    await waitFor(() => expect(seen.at(-1)!.failed).toBe(true));

    seen.at(-1)!.retry();
    await waitFor(() => expect(seen.at(-1)!.receivers).toHaveLength(4));
    expect(calls).toBe(2);
    expect(seen.at(-1)!.failed).toBe(false);
    // The server's age plus this browser's time since the answer.
    expect(seen.at(-1)!.ageMs).toBeGreaterThanOrEqual(3 * 60_000);
    expect(seen.at(-1)!.ageMs).toBeLessThan(3 * 60_000 + 5_000);
  });

  // Value: protects=the second click of a double-click on Stop picking can't start a new run on the restored button; fails_when=the Pick button loses its detail guard; why_new=TODOS Pick best edges; seam=none; no_claim=real browser click timing
  it("ignores the second click of a double-click landing on Pick best", async () => {
    const { onPickBest, button } = renderPicker(Promise.resolve({ receivers, fetchedAt: 0, stale: false }));
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button(), { detail: 2 });
    expect(onPickBest).not.toHaveBeenCalled();
    fireEvent.click(button(), { detail: 1 });
    expect(onPickBest).toHaveBeenCalledTimes(1);
  });

  // Value: protects=a failed background refetch doesn't claim the list is gone while it's still shown and usable; fails_when=the note keys on isError alone; why_new=TODOS small edges; seam=none; no_claim=react-query's retention of data on error (relied on)
  it("keeps Pick best usable and quiet when a refetch fails but the list is still there", async () => {
    let calls = 0;
    const { queryClient, button } = renderPicker(() =>
      ++calls === 1
        ? Promise.resolve({ receivers, fetchedAt: 0, stale: false })
        : Promise.reject(new Error("BAD_GATEWAY")),
    );
    await waitFor(() => expect(button().disabled).toBe(false));
    await queryClient.refetchQueries();
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("status").textContent).toMatch(/Highest signal-to-noise/);
    expect(button().disabled).toBe(false);
  });

  // Value: protects=an old list served through a mirror outage says how old it is; fails_when=the stale flag isn't shown; why_new=D7 serves stale lists; seam=none; no_claim=server staleness rule (receivers.test)
  it("says when the list is an old copy", async () => {
    renderPicker(
      Promise.resolve({ receivers, fetchedAt: Date.now() - 3 * 60 * 60_000, ageMs: 3 * 60 * 60_000, stale: true }),
    );
    await screen.findByText(/isn't answering, so this is the copy from 3 h ago/);
  });

  // Value: protects=list ages come from the server's own age, so a browser clock that's off doesn't change them; fails_when=the stale note or the credit subtracts the server's fetchedAt from Date.now(); why_new=earlier tests had the two clocks agree; seam=none; no_claim=network latency
  it("tells the list's age by the server's clock, not this browser's", async () => {
    // This browser runs an hour ahead of the server.
    const serverNow = Date.now() - 60 * 60_000;
    renderPicker(
      Promise.resolve({ receivers, fetchedAt: serverNow - 2 * 60 * 60_000, ageMs: 2 * 60 * 60_000, stale: true }),
      null,
      null,
      undefined,
      true,
    );
    await screen.findByText(/isn't answering, so this is the copy from 2 h ago/);
    expect(document.querySelector(".receivers-credit")!.textContent).toMatch(/^List fetched 2 h ago from /);
  });

  // Value: protects=Try again shows it's working and stays the same focused button, and a repeat failure is said again; fails_when=the button unmounts while the query is pending (react-query resets a no-data query to pending), or the sentence doesn't change back; why_new=the retry test only checks the refetch happens; seam=none; no_claim=screen reader announcement timing
  it("says it's trying again and keeps the button through a manual retry", async () => {
    let calls = 0;
    let failSecond!: (e: Error) => void;
    renderPicker(() =>
      ++calls === 1 ? Promise.reject(new Error("BAD_GATEWAY")) : new Promise((_, reject) => (failSecond = reject)),
    );
    await screen.findByText(/Couldn't load the public receiver list/);
    const tryAgain = screen.getByRole("button", { name: "Try again" });
    tryAgain.focus();
    fireEvent.click(tryAgain);

    await screen.findByText(/Trying again…/);
    expect(screen.getByRole("button", { name: "Try again" })).toBe(tryAgain);
    expect(tryAgain.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(tryAgain);

    failSecond(new Error("BAD_GATEWAY"));
    await screen.findByText(/Couldn't load the public receiver list/);
    expect(screen.getByRole("button", { name: "Try again" })).toBe(tryAgain);
    expect(tryAgain.hasAttribute("aria-busy")).toBe(false);
    expect(document.activeElement).toBe(tryAgain);
  });

  // Value: protects=a retry started from the map's "Retry receiver list" is a retry the listener asked for, so the picker says "Trying again…" too; fails_when=the map slot gets a plain refetch again; why_new=ship review (maintainability); seam=none; no_claim=MapPanel's own overlay (its tests)
  it("says it's trying again when the map asks for the list again", async () => {
    let calls = 0;
    const seen: MapList[] = [];
    renderPicker(
      () => (++calls === 1 ? Promise.reject(new Error("BAD_GATEWAY")) : new Promise(() => {})),
      null,
      null,
      (list) => {
        seen.push(list);
        return null;
      },
    );
    await waitFor(() => expect(seen.at(-1)!.failed).toBe(true));
    act(() => seen.at(-1)!.retry());
    expect(await screen.findByText(/^Trying again…/)).toBeTruthy();
  });

  // Value: protects=a background poll after a failure neither removes the focused Try again nor claims a retry the listener didn't ask for, and the map keeps its "Receiver list unavailable" overlay through it; fails_when=the failure branch (note or the map's failed) keys on isPending, or polls drive "Trying again…"; why_new=Codex outside review (eng review 2026-10-21); map slot added by ship coverage audit (feat/web-follow-ups); seam=queryClient.refetchQueries stands in for the interval; no_claim=react-query's timer itself
  it("keeps Try again in place, without a progress note, through a background poll", async () => {
    let calls = 0;
    const seen: MapList[] = [];
    const { queryClient } = renderPicker(
      () => (++calls === 1 ? Promise.reject(new Error("BAD_GATEWAY")) : new Promise(() => {})),
      null,
      null,
      (list) => {
        seen.push(list);
        return null;
      },
    );
    await screen.findByText(/Couldn't load the public receiver list/);
    const tryAgain = screen.getByRole("button", { name: "Try again" });
    void queryClient.refetchQueries();
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("button", { name: "Try again" })).toBe(tryAgain);
    expect(screen.getByRole("status").textContent).toMatch(/^Couldn't load the public receiver list/);
    expect(tryAgain.hasAttribute("aria-busy")).toBe(false);
    expect(seen.at(-1)!.failed).toBe(true);
  });

  // Value: protects=the page's help text shows inside the receivers section, under its heading and above Pick best; fails_when=ReceiverPicker stops rendering children (the page test mocks the picker, so it can't see this); why_new=DT1 children slot; seam=none; no_claim=the help text's wording (page test)
  it("shows its children under the heading, above Pick best", async () => {
    const { button } = renderPicker(Promise.resolve({ receivers, fetchedAt: 0 }), null, <p>help text</p>);
    const help = screen.getByText("help text");
    const heading = screen.getByRole("heading", { name: "Receivers" });
    expect(heading.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.compareDocumentPosition(button()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  // Value: protects=the folded table says what it holds, and the list refreshes just after the server's copy expires; fails_when=the summary text is dropped or the poll ignores fetchedAt; why_new=DT1 fold, R8 refetch, adversarial review (polls ran a full TTL late); seam=react-query observer options; no_claim=react-query's timer itself
  it("folds the table under All receivers (N) and polls just after the server's copy expires", async () => {
    // The server's clock is an hour off; only the age it reports matters.
    const { queryClient } = renderPicker(
      Promise.resolve({ receivers, fetchedAt: Date.now() + 60 * 60_000, ageMs: 10 * 60_000 }),
    );
    await screen.findByText("All receivers (4)");
    const [query] = queryClient.getQueryCache().getAll();
    const interval = query!.observers[0]!.options.refetchInterval as (q: typeof query) => number;
    // A copy 10 min old: the next poll comes just after its 15 min run out.
    expect(interval(query)).toBeGreaterThan(5 * 60_000 - 1_000);
    expect(interval(query)).toBeLessThanOrEqual(5 * 60_000 + 5_000);
  });
});

describe("ReceiverTable tuned mark", () => {
  // Value: protects=the dot marks only what's playing; fails_when=the table can't take "nothing playing"; why_new=the dot followed the host field; seam=none; no_claim=what the page passes (page test)
  it("marks nothing when nothing is playing", () => {
    render(<ReceiverTable receivers={receivers} freqKhz={10_000} current={null} sun={null} onChoose={() => {}} />);
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  // Value: protects=connecting and playing look different in the table, as on the map and status lamp; fails_when=the phase is ignored or the connecting cue is visual only; why_new=O3 phase prop; seam=none; no_claim=colors
  it("rings a receiver that's connecting and fills the dot once it plays", () => {
    const view = render(
      <ReceiverTable
        receivers={receivers}
        freqKhz={10_000}
        current={{ host: "charlie.example", port: 8073, phase: "connecting" }}
        sun={null}
        onChoose={() => {}}
      />,
    );
    const charlie = () => screen.getByRole("button", { name: /charlie\.example:8073/ });
    expect(charlie().getAttribute("aria-current")).toBe("true");
    expect(charlie().textContent).toMatch(/^○ Charlie \(connecting\)/);

    view.rerender(
      <ReceiverTable
        receivers={receivers}
        freqKhz={10_000}
        current={{ host: "charlie.example", port: 8073, phase: "listening" }}
        sun={null}
        onChoose={() => {}}
      />,
    );
    expect(charlie().textContent).toMatch(/^● Charlie[^(]/);
  });
});

describe("ReceiverTable Night column", () => {
  const noon = sunPosition(Date.parse("2026-10-20T12:00:00Z")); // sun over the Atlantic
  const midnight = sunPosition(Date.parse("2026-10-21T00:00:00Z")); // sun over the Pacific
  const placed = [
    rx("Alpha", { snr: 10, lat: 0, lon: 0 }),
    rx("Bravo", { snr: 40 }), // no position
    rx("Charlie", { snr: 30, lat: 0, lon: 180 }),
  ];
  const table = (list: Receiver[], sun: ReturnType<typeof sunPosition> | null) => (
    <ReceiverTable receivers={list} freqKhz={10_000} current={null} sun={sun} onChoose={() => {}} />
  );
  const night = (name: string) =>
    screen
      .getByRole("button", { name: new RegExp(`${name.toLowerCase()}\\.example`) })
      .closest("tr")!
      .querySelector(".col-night")!.textContent;
  const names = () =>
    within(screen.getByRole("table"))
      .queryAllByRole("button", { name: /\.example:8073/ })
      .map((b) => b.querySelector(".receiver-name")!.textContent);

  // Value: protects=the table says which receivers are in darkness, from the page clock, and says so in text; fails_when=lat/lon or the sun prop is ignored; why_new=D15 Night indicator; seam=none; no_claim=solar accuracy (solar.test)
  it("says Night, Day or – for each receiver", () => {
    render(table(placed, noon));
    expect([night("Alpha"), night("Bravo"), night("Charlie")]).toEqual(["Day", "–", "Night"]);
  });

  // Value: protects=sorting by Night doesn't reshuffle rows under the reader each minute; fails_when=the comparator reads the live clock; why_new=E3 frozen sort; seam=rerender with a new sun; no_claim=none beyond protects
  it("sorts night first with unknowns last, and holds that order as the clock moves", () => {
    const view = render(table(placed, noon));
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    expect(names()).toEqual(["Alpha", "Charlie", "Bravo"]);
    fireEvent.click(screen.getByRole("button", { name: "Night" }));

    view.rerender(table(placed, midnight));
    expect([night("Alpha"), night("Charlie")]).toEqual(["Night", "Day"]);
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);

    // A fresh list waits until it's taken, then sorts by the sun now.
    view.rerender(table([...placed], midnight));
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
    fireEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(names()).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  // Value: protects=choosing the Night sort uses the sun now, not the sun from when the table opened; fails_when=sortBy stops refreshing the frozen sun, so a table left open for hours sorts by stale daylight; why_new=the frozen-sort test only covers holding, not refreshing on a click; seam=rerender with a new sun; no_claim=solar accuracy (solar.test)
  it("sorts by the sun at the time Night is clicked", () => {
    const view = render(table(placed, noon));
    view.rerender(table(placed, midnight));
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    expect(names()).toEqual(["Alpha", "Charlie", "Bravo"]);
  });
});

describe("ReceiverTable when the list refreshes", () => {
  const table = (list: Receiver[]) => (
    <ReceiverTable receivers={list} freqKhz={10_000} current={null} sun={null} onChoose={() => {}} />
  );
  const names = () =>
    within(screen.getByRole("table"))
      .queryAllByRole("button", { name: /\.example:8073/ })
      .map((b) => b.querySelector(".receiver-name")!.textContent);
  // Alpha now has the best signal, Charlie fills up: a new list would reorder the rows.
  const refreshed = [
    rx("Alpha", { snr: 45 }),
    rx("Bravo", { snr: 40, users: 8 }),
    rx("Charlie", { snr: 30, users: 8 }),
    rx("Delta", { snr: 50, minKhz: 110_000, maxKhz: 142_000 }),
  ];

  // Value: protects=a background refresh never moves or removes rows under the reader's click; fails_when=the table renders each new list as it arrives; why_new=Claude adversarial (PR 1): a poll could reorder rows just before a click; seam=rerender with a new list; no_claim=react-query's structural sharing of unchanged lists
  it("keeps the rows as shown and offers the new list", () => {
    const view = render(table(receivers));
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
    view.rerender(table(refreshed));
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(screen.getByRole("status", { name: "" }).textContent).toMatch(/List updated/);
    fireEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(screen.queryByRole("button", { name: "Show it" })).toBeNull();
  });

  // Value: protects=keyboard users keep their place after taking the new list (the button goes away); fails_when=focus is left on the removed button, falling back to the page; why_new=a11y review (PR 2a); seam=none; no_claim=screen reader announcement wording
  it("moves focus to the table after showing the new list", async () => {
    const view = render(table(receivers));
    view.rerender(table(refreshed));
    const show = screen.getByRole("button", { name: "Show it" });
    show.focus();
    fireEvent.click(show);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("table", { name: "Public receivers" })));
  });

  // Value: protects=recovering from an over-filtered table shows the newest list; fails_when=Clear filters resets the filters but keeps the old list; why_new=coverage audit (PR 2a); seam=none; no_claim=none beyond protects
  it("takes the new list when filters are cleared", () => {
    const view = render(table(receivers));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "nothing like it" } });
    view.rerender(table(refreshed));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(names()).toEqual(["Delta", "Alpha", "Bravo", "Charlie"]);
  });

  // Value: protects=the listener's own sort or filter shows the newest list; fails_when=adopt() isn't called from the table's controls, so the table stays on an old list until the link is found; why_new=steady rows; seam=none; no_claim=none beyond protects
  it("takes the new list on the listener's next sort or filter", () => {
    const view = render(table(receivers));
    view.rerender(table(refreshed));
    fireEvent.click(screen.getByLabelText("Has a free slot"));
    expect(names()).toEqual(["Alpha"]);
  });

  // Value: protects=a column sort shows the newest list, not the frozen one; fails_when=sortBy stops calling adopt() (it doesn't go through edit()), so a header click re-sorts the old rows and the notice stays; why_new=ship coverage audit (PR 2a): only the checkbox path was tested; seam=rerender with a new list; no_claim=sort direction defaults (other tests)
  it("takes the new list on a column sort", () => {
    const view = render(table(receivers));
    view.rerender(table(refreshed));
    fireEvent.click(screen.getByRole("button", { name: "SNR" }));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(screen.queryByRole("button", { name: "Show it" })).toBeNull();
  });

  // Value: protects=Show all reveals the newest list like every other control that reshapes the rows; fails_when=Show all only sets showAll, extending the old list; why_new=PR 2a review: the one control without adopt(); seam=rerender with a new list; no_claim=none beyond protects
  it("takes the new list on Show all", () => {
    const many = Array.from({ length: 60 }, (_, i) => rx(`R${String(i).padStart(2, "0")}`));
    const view = render(table(many));
    view.rerender(table([...many, rx("Newcomer", { snr: 99 })]));
    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));
    expect(names()).toHaveLength(61);
    expect(names()[0]).toBe("Newcomer");
    expect(screen.queryByRole("button", { name: "Show it" })).toBeNull();
  });

  // Value: protects=keyboard focus stays in the list when the new list has no matching rows (no table to focus); fails_when=showUpdated drops the search fallback, so focus falls to the page body; why_new=ship coverage audit (PR 2a): only the table branch was tested; seam=none; no_claim=screen reader announcement wording
  it("moves focus to the search when the new list shows no rows", async () => {
    const view = render(table(receivers));
    view.rerender(table([rx("Delta", { minKhz: 110_000, maxKhz: 142_000 })]));
    const show = screen.getByRole("button", { name: "Show it" });
    show.focus();
    fireEvent.click(show);
    expect(screen.getByText("No receivers match.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search")));
  });
});
