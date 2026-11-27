import { describe, expect, it } from "vitest";
import snapshot from "../server/eibi-snapshot.json";
import { forPage, parseEibi } from "./eibi";
import { onAirSchedule } from "./on-air";
import type { PriyomTx } from "./priyom-schedule";
import { panelGroups, UP_NEXT_MS, type PanelGroups } from "./signal-panel";
import type { SignalStation } from "./signal-stations";

const at = (iso: string) => Date.parse(iso);
const NOW = "2026-11-25T07:00:00Z";
const tx = (station: string, iso: string, khz: number | null = 20_167): PriyomTx => ({
  station,
  startMs: at(iso),
  khz,
  mode: khz === null ? null : "usb",
  summary: `${station} ${khz ?? "Search"}`,
});
const findRow = (g: PanelGroups, slug: string) =>
  Object.values(g)
    .flat()
    .find((r) => r.station.slug === slug);
const slugs = (rows: { station: SignalStation }[]) => rows.map((r) => r.station.slug);

describe("panelGroups", () => {
  // Value: protects=with no Priyom schedule (server has none), always-on stations fill "Always on" with a channel to tune, defunct ones sit in history with no Listen, and the numbers stations are still listed (later, no time, no Listen); fails_when=the panel looks empty, a defunct station gets a channel, or numbers stations vanish without the feed; why_new=#100 panel groups; seam=signal-stations catalog; no_claim=catalog facts
  it("groups the catalog with no Priyom schedule", () => {
    const g = panelGroups(at(NOW), null);
    expect(slugs(g.always)).toEqual(["wwv", "wwvh", "rwm", "uvb-76", "the-pip", "squeaky-wheel"]);
    expect(g.always.every((r) => r.listen !== null)).toBe(true);
    expect(slugs(g.history)).toEqual(["chu", "lincolnshire-poacher", "cherry-ripe"]);
    expect(g.history.every((r) => r.listen === null && r.shown === null)).toBe(true);
    expect(slugs(g.later).sort()).toEqual(["e06", "e07", "e11", "f06", "m12", "s06", "s11a", "v07"]);
    expect(g.later.every((r) => r.listen === null && r.atMs === null)).toBe(true);
    expect(g.onNow).toEqual([]);
    expect(g.upNext).toEqual([]);
  });

  // Value: protects=#168 the panel passes the merged schedule to the day/night rows, so at 05:00 UTC on 2026-11-25 The Pip's Always on row tunes EiBi's 3756 (as the dial names it), not the sun's 5448; fails_when=the rows stop reaching activeChannelAt and the panel and dial disagree around a switch; why_new=#168; seam=the bundled B26 snapshot through on-air.ts; no_claim=the switch rule itself (signal-stations.test)
  it("tunes a day/night station by the merged schedule when it has one", () => {
    const rows = onAirSchedule(parseEibi(snapshot.csv, snapshot.season).map(forPage), null);
    const ms = at("2026-11-25T05:00:00Z");
    expect(findRow(panelGroups(ms, null, rows), "the-pip")?.listen?.khz).toBe(3_756);
    expect(findRow(panelGroups(ms, null), "the-pip")?.listen?.khz).toBe(5_448);
  });

  // Value: protects=while the merged schedule loads (null) a day/night station's row shows no frequency and no Listen, so a listener arriving from its page's Listen on 3756 at 05:00 isn't offered the sun's 5448, which is off the air; WWV's always-on row keeps its Listen; fails_when=loading falls back to the sun's channel (review of #168) or every always-on row loses its Listen; why_new=/ship review of #168; seam=signal-stations catalog; no_claim=how long the schedule takes to load
  it("holds a day/night station's Listen while the schedule loads", () => {
    const g = panelGroups(at("2026-11-25T05:00:00Z"), null, null);
    for (const slug of ["the-pip", "squeaky-wheel"]) expect(findRow(g, slug), slug).toMatchObject({ group: "always", listen: null, shown: null });
    expect(findRow(g, "wwv")?.listen?.khz).toBe(10_000);
  });

  // Value: protects=the panel's Listen on an F06 RTTY slot tunes the dial parsePriyomEvents gives it (USB, 2.125 kHz below the listed 17532), so the panel, the dial and search agree (owner: apply it to the panel too); fails_when=data slots lose their Listen or the panel tunes the listed frequency; why_new=R15 panel scope; seam=none; no_claim=mark-vs-centre on the air
  it("offers Listen on an F06 data slot at its USB dial (#148 R15)", () => {
    const f06: PriyomTx = { station: "F06", designator: "F06a", startMs: at(NOW) - 60_000, khz: 17_529.875, mode: "usb", data: true, listedKhz: 17_532, summary: "F06a 17532kHz RTTY" };
    const row = panelGroups(at(NOW), [f06]).onNow.find((r) => r.station.slug === "f06");
    expect(row?.listen).toEqual({ khz: 17_529.875, mode: "usb", listedKhz: 17_532 });
  });

  // Value: protects=a Priyom slot is "on now" with its frequency as Listen for PRIYOM_ON_AIR_MS from its start (ending soonest first), a slot within 6 hours is "up next" with its frequency shown but no Listen, and one further off is "later" with its time; fails_when=Listen is offered before a transmission starts (dead air), the 6-hour boundary is off, or the groups sort wrong; why_new=#100 panel groups; seam=priyom-schedule; no_claim=how long a transmission really lasts
  it("places numbers stations by their Priyom slots", () => {
    const priyom = [
      tx("E11", "2026-11-25T06:55:00Z", 20_167),
      tx("S11a", "2026-11-25T06:58:00Z", 19_515),
      tx("E07", "2026-11-25T07:30:00Z", 17_428),
      tx("M12", "2026-11-25T13:00:00Z", 12_135),
      tx("S06", "2026-11-25T13:00:01Z", 11_616),
    ];
    const g = panelGroups(at(NOW), priyom);
    expect(slugs(g.onNow)).toEqual(["e11", "s11a"]);
    expect(g.onNow[0]!.listen).toEqual({ khz: 20_167, mode: "usb" });
    expect(g.onNow[0]!.atMs).toBe(at("2026-11-25T07:05:00Z"));
    expect(slugs(g.upNext)).toEqual(["e07", "m12"]); // M12 exactly 6 h out
    expect(at("2026-11-25T13:00:00Z") - at(NOW)).toBe(UP_NEXT_MS);
    expect(findRow(g, "e07")).toMatchObject({ listen: null, shown: { khz: 17_428, mode: "usb" } });
    expect(slugs(g.later).slice(0, 1)).toEqual(["s06"]);
    expect(findRow(g, "v07")).toMatchObject({ group: "later", atMs: null });
  });

  // Value: protects=an on-air Priyom slot with no frequency yet ("Search") is shown as on now without a Listen, so Listen never guesses a frequency; fails_when=a Search slot offers Listen or drops out of the panel; why_new=#100 panel groups; seam=priyom-schedule; no_claim=none
  it("offers no Listen for a Search slot", () => {
    const g = panelGroups(at(NOW), [tx("M12", "2026-11-25T06:59:00Z", null)]);
    expect(findRow(g, "m12")).toMatchObject({ group: "onNow", listen: null, shown: null });
  });
});
