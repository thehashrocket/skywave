// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createdAt as superjson delivers it: a Date. Shared rows never show it (eng D2, D5).
const shared = [{ id: "s1", name: "WWV", freqKhz: 10_000, mode: "am", createdAt: new Date("2026-11-22T10:00:00Z") }];
const mutate = vi.fn();
// The server's time, a Monday; the device clock is left alone so a save that used it would show.
const NOW = Date.parse("2026-11-23T22:14:00Z");
let serverMs = NOW;
// onServerOffset for useServerTick, which gives the stamps their "now".
vi.mock("@/lib/server-clock", () => ({ serverNow: () => serverMs, onServerOffset: () => () => {} }));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    presets: {
      list: { queryOptions: () => ({}), queryKey: () => ["presets"] },
      create: { mutationOptions: () => ({ kind: "create" }) },
      delete: { mutationOptions: () => ({ kind: "delete" }) },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: shared, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (o: { kind: string }) => ({
    mutate: (...a: unknown[]) => mutate(o.kind, ...a),
    isPending: false,
    isError: false,
  }),
}));

const { Presets } = await import("./Presets");

beforeEach(() => {
  localStorage.clear();
  mutate.mockClear();
  serverMs = NOW;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Presets", () => {
  // Value: protects=on a public site saving stays in this browser and the shared list can't be deleted from; fails_when=a public visitor's save or delete reaches the shared database; why_new=going public; seam=react-query mocked; no_claim=the server's own refusal (presets router test)
  it("saves to this browser and keeps shared picks read-only on a public site", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_PUBLIC", "1");
    render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: "Delete WWV" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Radio Australia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Yours" }).textContent).toContain("Radio Australia");
    expect(JSON.parse(localStorage.getItem("skywave.presets")!)[0]).toMatchObject({
      name: "Radio Australia",
      freqKhz: 9580,
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Radio Australia" }));
    expect(localStorage.getItem("skywave.presets")).toBe("[]");
  });

  // Value: protects=a new save records the server's time and shows it as the button's description, not its name, with full date and local time on hover (#107, design DD5, DD13, DD14); fails_when=savedAt is missing or from the device clock, the stamp joins the name, or describedby/title is lost; why_new=#107; seam=server-clock and react-query mocked; no_claim=a real screen reader's output
  it("stamps a new save with the server's time, read as a description", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_PUBLIC", "1");
    render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Radio Australia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(JSON.parse(localStorage.getItem("skywave.presets")!)[0].savedAt).toBe(NOW);
    const row = screen.getByRole("button", {
      // jsdom joins the row's spans without spaces; the name must not carry the stamp.
      name: (n) => n.startsWith("9,580") && !n.includes("saved"),
      description: "saved Mon 2214 UTC",
    });
    expect(row.querySelector(".preset-saved")!.getAttribute("title")).toMatch(/^Saved Mon 23 Nov 2026, 2214 UTC · /);
  });

  // Value: protects=entries saved before #107 still load and show with no stamp, and a corrupt savedAt drops only the stamp and is not written back (#107, eng O-C1, O-N8); fails_when=loadLocal rejects old entries, keeps a bad savedAt, or formatting 1e20 throws; why_new=#107 old-entry compatibility; seam=react-query mocked; no_claim=export/import (#97)
  it("loads old and corrupt saves without stamps and drops the bad field", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_PUBLIC", "1");
    localStorage.setItem(
      "skywave.presets",
      JSON.stringify([
        { id: "a", name: "Old save", freqKhz: 6070, mode: "am" },
        { id: "b", name: "Bad stamp", freqKhz: 7490, mode: "am", savedAt: 1e20 },
        { id: "c", name: "Text stamp", freqKhz: 9700, mode: "am", savedAt: "yesterday" },
        { id: "d", name: "Week old", freqKhz: 11_780, mode: "am", savedAt: Date.parse("2026-11-08T22:14:00Z") },
      ]),
    );
    render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    const yours = screen.getByRole("list", { name: "Yours" });
    expect(yours.querySelectorAll("li")).toHaveLength(4);
    expect(yours.querySelectorAll(".preset-saved")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^6,070/ }).hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByRole("button", { name: /^11,780/, description: "saved 8 Nov 2214 UTC" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const stored = JSON.parse(localStorage.getItem("skywave.presets")!) as { id: string; savedAt?: unknown }[];
    expect(stored.find((p) => p.id === "b")).not.toHaveProperty("savedAt");
    expect(stored.find((p) => p.id === "c")).not.toHaveProperty("savedAt");
  });

  // Value: protects=an open page's stamp moves from weekday to date by itself once the save is 7 UTC days old (#107), and render never reads the server clock; fails_when=now is read once per render, so the old weekday stays until something else re-renders; why_new=code review; seam=server-clock mocked, fake timers; no_claim=the real clock's corrections
  it("updates a stamp's form as days pass, without a re-render", () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("NEXT_PUBLIC_SITE_PUBLIC", "1");
      const saved = Date.parse("2026-11-17T23:00:00Z"); // 6 UTC days before NOW
      localStorage.setItem(
        "skywave.presets",
        JSON.stringify([{ id: "a", name: "Kept", freqKhz: 6070, mode: "am", savedAt: saved }]),
      );
      const { container } = render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
      const stamp = () => container.querySelector(".preset-saved")!.textContent;
      expect(stamp()).toBe("saved Tue 2300 UTC");
      serverMs = Date.parse("2026-11-24T00:00:30Z"); // past UTC midnight: 7 days now
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(stamp()).toBe("saved 17 Nov 2300 UTC");
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=shared presets show no saved time in either mode, so an owner's add time or a seed time never reads as when someone heard it (eng D2, D5); fails_when=createdAt is rendered as a stamp; why_new=#107 scope; seam=react-query mocked; no_claim=server presets router
  it.each([
    ["public", "1"],
    ["private", ""],
  ])("shows no stamp on the shared list (%s site)", (_mode, flag) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_PUBLIC", flag);
    const { container } = render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    expect(container.querySelector(".preset-saved")).toBeNull();
    expect(screen.getByRole("button", { name: /^10,000/ }).hasAttribute("aria-describedby")).toBe(false);
  });

  // Value: protects=the saved frequency being listened to (same frequency and mode) is current for screen readers too, not only in lamp colour; fails_when=aria-current is missing, or set when only the frequency matches; why_new=station search design review (owner: build now); seam=react-query mocked; no_claim=styling
  it("marks the tuned preset for screen readers", () => {
    const { rerender } = render(<Presets freqKhz={10_000} mode="am" onSelect={() => {}} />);
    const wwv = () => screen.getByRole("button", { name: /^10,000/ });
    expect(wwv().getAttribute("aria-current")).toBe("true");
    rerender(<Presets freqKhz={10_000} mode="usb" onSelect={() => {}} />);
    expect(wwv().getAttribute("aria-current")).toBeNull();
  });

  // Value: protects=on a private site saving and deleting go to the shared list through the server; fails_when=a save or delete stays local, or deletes another preset; why_new=presets before going public (card added during station search review); seam=react-query mocked; no_claim=the server's own handling (presets router test)
  it("saves to and deletes from the shared list on a private site", () => {
    render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete WWV" }));
    expect(mutate).toHaveBeenCalledWith("delete", { id: "s1" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Radio Australia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      "create",
      { name: "Radio Australia", freqKhz: 9580, mode: "am" },
      expect.anything(),
    );
  });
});
