// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "@/lib/eibi";
import { SHOWN, StationSearch } from "./StationSearch";

afterEach(cleanup);

const NOW = Date.parse("2026-11-18T14:00:00Z");
const b = (over: Partial<Broadcast>): Broadcast => ({
  khz: 9_580,
  start: 0,
  end: 1440,
  days: "",
  station: "Radio X",
  lang: "E",
  target: "Eu",
  ...over,
});

function show(schedule: Broadcast[] | undefined, clock: number | null = NOW) {
  const onTune = vi.fn();
  render(<StationSearch schedule={schedule} clock={clock} freqKhz={9_410} onTune={onTune} />);
  const type = (q: string) =>
    fireEvent.change(screen.getByRole("searchbox", { name: "Station name" }), { target: { value: q } });
  return { onTune, type };
}

describe("StationSearch", () => {
  // Value: protects=the section waits for the schedule and the page's clock; fails_when=it renders a search that can't answer; why_new=new component; seam=none; no_claim=none beyond protects
  it("stays hidden until the schedule and clock are in", () => {
    show(undefined);
    show([b({})], null);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  // Value: protects=a station on now gets a button per frequency that tunes there, and the count says how many are on; fails_when=a frequency button is missing or tunes elsewhere; why_new=station search; seam=onTune; no_claim=reception
  it("tunes to a frequency a station is on now", () => {
    const { onTune, type } = show([b({ station: "BBC", khz: 9_410 }), b({ station: "BBC", khz: 15_400 })]);
    type("bbc");
    expect(screen.getByRole("status").textContent).toBe("1 station, 1 on the air now.");
    fireEvent.click(screen.getByRole("button", { name: /15,400/ }));
    expect(onTune).toHaveBeenCalledWith(15_400);
  });

  // Value: protects=a station off now says when and where it's next on, in UTC, and that frequency tunes too; fails_when=an off station shows nothing or a dead frequency; why_new=station search; seam=none; no_claim=local time
  it("says when a station is next on", () => {
    const { onTune, type } = show([b({ station: "Radio Soon", khz: 7_100, start: 15 * 60, end: 16 * 60 })]);
    type("soon");
    expect(screen.getByText(/Off now\. Next on/).textContent).toBe(
      "Off now. Next on 7,100 kHz at 1500 UTC in English.",
    );
    fireEvent.click(screen.getByRole("button", { name: "7,100 kHz" }));
    expect(onTune).toHaveBeenCalledWith(7_100);
  });

  // Value: protects=a name not in the schedule says so; fails_when=no match leaves the area blank; why_new=station search; seam=none; no_claim=none beyond protects
  it("says when nothing matches", () => {
    const { type } = show([b({})]);
    type("zzzz");
    expect(screen.getByRole("status").textContent).toBe("No station by that name in this season's schedule.");
  });

  // Value: protects=a broad query shows the first rows and a Show all that reveals the rest; fails_when=a hundred rows render at once or Show all does nothing; why_new=station search; seam=none; no_claim=none beyond protects
  it("shortens a long list until asked", () => {
    const many = Array.from({ length: SHOWN + 3 }, (_, i) => b({ station: `Radio ${i}`, khz: 5_000 + i }));
    const { type } = show(many);
    type("radio");
    expect(screen.getAllByRole("listitem")).toHaveLength(SHOWN);
    fireEvent.click(screen.getByRole("button", { name: `Show all ${SHOWN + 3}` }));
    expect(screen.getAllByRole("listitem")).toHaveLength(SHOWN + 3);
  });
});
