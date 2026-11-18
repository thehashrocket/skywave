import { describe, expect, it } from "vitest";
import type { Receiver } from "./kiwi-list";
import { MAX_CANDIDATES, pickContext } from "./pick-context";

const rx = (host: string, extra: Partial<Receiver> = {}): Receiver => ({
  id: host,
  name: host,
  location: "",
  antenna: "",
  host,
  port: 8073,
  users: 2,
  usersMax: 8,
  snr: 18,
  minKhz: 0,
  maxKhz: 30_000,
  ...extra,
});

describe("pickContext", () => {
  // Value: protects=a pick time from a session whose clock offset ends in .5 still reaches the server, which takes whole ms only; fails_when=the time is passed through unrounded, so the server drops the context for about half of sessions; why_new=review finding (server-clock offset uses roundTrip / 2); seam=none; no_claim=the offset itself (server-clock tests)
  it("rounds a fractional pick time to whole milliseconds", () => {
    const ctx = pickContext([rx("a")], rx("a"), "listen", 9_580, 1_795_000_000_000.5);
    expect(Number.isInteger(ctx.pickedAtMs)).toBe(true);
    expect(ctx.pickedAtMs).toBe(1_795_000_000_001);
  });

  // Value: protects=the stored head is the first MAX_CANDIDATES of the list as given, keys lowercased like reports.submit's host, the rank counts in the whole list, and position is kept only when both coordinates are known; fails_when=the head isn't capped, hosts keep their case, or a half position is stored; why_new=pick context (D5); seam=none; no_claim=none beyond protects
  it("keeps the list's head, the chosen receiver's rank and its listed details", () => {
    const ranked = Array.from({ length: 12 }, (_, i) => rx(`Kiwi${i}.Example`, i === 11 ? { lat: 51.5, lon: -0.1 } : {}));
    const ctx = pickContext(ranked, ranked[11]!, "beacon", 14_100, 1_000);
    expect(ctx.candidates).toHaveLength(MAX_CANDIDATES);
    expect(ctx.candidates[0]).toBe("kiwi0.example:8073");
    expect(ctx).toMatchObject({ rankPos: 11, lat: 51.5, lon: -0.1, snr: 18, users: 2, pickSource: "beacon" });
    expect(pickContext(ranked, rx("Kiwi0.Example", { lat: 10 }), "listen", 14_100, 1_000)).not.toHaveProperty("lat");
  });
});
