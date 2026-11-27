import { describe, expect, it } from "vitest";
import snapshot from "../server/eibi-snapshot.json";
import {
  forPage,
  listedOn,
  parseEibi,
  rankBroadcasts,
  scheduledBetween,
  scheduledOn,
  shortLabel,
  stationLine,
  type Broadcast,
} from "./eibi";
import { dayNightRows, onAirSchedule, stationNamed, type OnAirRow, type PriyomCopy } from "./on-air";
import { priyomSpan, type PriyomTx } from "./priyom-schedule";
import { findBroadcasts } from "./station-search";
import { SIGNAL_STATIONS } from "./signal-stations";

/** The bundled season (b26), as the page gets it. */
const EIBI: Broadcast[] = parseEibi(snapshot.csv, snapshot.season).map(forPage);
const at = (iso: string) => Date.parse(iso);

// 2026-11-26 is a Thursday, the day the issue's table compares.
const THU = "2026-11-26";
const tx = (station: string, iso: string, khz: number, extra: Partial<PriyomTx> = {}): PriyomTx => ({
  station,
  startMs: at(iso),
  khz,
  mode: "usb",
  summary: `${station} ${khz}kHz USB`,
  ...extra,
});
/** A healthy copy fetched early on the Thursday: it covers the whole day. */
const copy = (transmissions: PriyomTx[]): PriyomCopy => ({ transmissions, fetchedAt: at(`${THU}T00:30:00Z`) });
// From the issue's table: Priyom has E11 at 13:00 on 4909 only, and at 07:45 on 23031.
const PRIYOM = copy([tx("E11", `${THU}T13:00:00Z`, 4909), tx("E11", `${THU}T07:45:00Z`, 23031)]);

const names = (rows: readonly Broadcast[]) => rows.map((b) => b.station);
const on = (rows: readonly OnAirRow[], khz: number, iso: string) => listedOn(rows, khz, at(iso));

describe("onAirSchedule", () => {
  // Value: protects=a station outside the catalog reaches every surface exactly as EiBi lists it (every unmapped row kept unchanged, and a broadcaster's frequency reads the same as raw EiBi), and the merged list stays sorted by frequency for eibi.ts's binary search; fails_when=the merge drops, rewrites or reorders unmapped rows; why_new=new merge (#148); seam=none; no_claim=next season's file
  it("keeps every unmapped EiBi row as it is, sorted by frequency", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    const unmapped = EIBI.filter((b) => !stationNamed(b.station));
    const kept = new Set(merged.filter((r) => r.source === "eibi" && !r.slug).map(({ source: _s, ...b }) => JSON.stringify(b)));
    expect(unmapped.filter((b) => !kept.has(JSON.stringify(b))).map((b) => `${b.khz} ${b.station}`)).toEqual([]);
    for (let i = 1; i < merged.length; i++) expect(merged[i]!.khz).toBeGreaterThanOrEqual(merged[i - 1]!.khz);
    expect(names(on(merged, 9_410, `${THU}T13:05:00Z`))).toEqual(names(listedOn(EIBI, 9_410, at(`${THU}T13:05:00Z`))));
  });

  // Value: protects=with Priyom's copy healthy, E11 is named only where Priyom has it (4909 at 13:05 once, as Priyom's), never on EiBi's season frequencies (5371); fails_when=EiBi's grid leaks back for a Priyom station, or E11 is listed twice; why_new=the bug #148 exists for; seam=none; no_claim=Priyom's live data (fixture slots from the issue's table)
  it("names E11 only where Priyom has it", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    const e11 = on(merged, 4909, `${THU}T13:05:00Z`).filter((r) => r.slug === "e11");
    expect(e11).toHaveLength(1);
    expect(e11[0]).toMatchObject({ source: "priyom", station: "E11", mode: "usb", lang: "E" });
    expect(on(merged, 5371, `${THU}T13:05:00Z`).filter((r) => r.slug === "e11")).toEqual([]);
  });

  // Value: protects=the same precedence on a slot EiBi's winter rows really list (07:45 Thu on 13908), so the test doesn't lean on #149's date bug: raw EiBi names E11 there, the merge names it only on Priyom's 23031; fails_when=precedence fails and only the date windows hid 5371; why_new=Codex C2 positive control; seam=none; no_claim=none beyond protects
  it("moves E11 from EiBi's 13908 to Priyom's 23031 at 07:45 (positive control)", () => {
    expect(names(listedOn(EIBI, 13_908, at(`${THU}T07:47:00Z`)))).toContain("E11 Polish Spy Numbers");
    const merged = onAirSchedule(EIBI, PRIYOM);
    expect(on(merged, 13_908, `${THU}T07:47:00Z`)).toEqual([]);
    expect(names(on(merged, 23_031, `${THU}T07:47:00Z`))).toEqual(["E11"]);
  });

  // Value: protects=a Priyom station Priyom has nothing for, with its copy healthy, is off the air: E06 on 16163 at 03:05 Thu (EiBi's November row, active before and after #149) names nothing and no unconfirmed row stands in; fails_when=a healthy copy's gaps fall back to EiBi; why_new=owner addition before build; seam=none; no_claim=Priyom's real E06 coverage
  it("drops E06 when a healthy Priyom copy has no E06 slot", () => {
    expect(names(listedOn(EIBI, 16_163, at(`${THU}T03:05:00Z`)))).toContain("E06 Russian Spy Numbers");
    const merged = onAirSchedule(EIBI, PRIYOM);
    expect(on(merged, 16_163, `${THU}T03:05:00Z`)).toEqual([]);
  });

  // Value: protects=the second half of the owner's two-part rule (D7): a catalog station without a Priyom designator keeps its EiBi rows off its catalog channels (WWV on 25 MHz, as EiBi's) and takes the catalog's on them (WWV on 10 MHz once, by the catalog's name, beside BPM); the first half (E11's rows all go) is the 5371 test above; fails_when=WWV 25 MHz drops, or WWV shows twice or under EiBi's name; why_new=R5; seam=none; no_claim=none beyond protects
  it("keeps WWV on 25 MHz as EiBi's and on 10 MHz as the catalog's", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    expect(on(merged, 25_000, `${THU}T13:05:00Z`).filter((r) => r.station.startsWith("WWV"))).toMatchObject([
      { station: "WWV Colorado (m.ann.)", source: "eibi" },
    ]);
    const ten = on(merged, 10_000, `${THU}T13:05:00Z`);
    expect(ten.filter((r) => r.slug === "wwv")).toMatchObject([{ station: "WWV", source: "catalog", mode: "am", lang: "-TS" }]);
    expect(names(ten)).not.toContain("WWV Colorado (m.ann.)");
    expect(names(ten)).toContain("BPM Xian");
  });

  // Value: protects=#152: on a shared frequency a catalog station leads the readout and the waterfall label when no region decides (WWV, not PPE, on 10 MHz), while a region still puts the stations aimed there first; fails_when=the merged sort loses its catalog-first tiebreak, puts it ahead of the region rank, or the catalog order flips WWV and WWVH; why_new=no test ordered catalog against EiBi rows on one frequency; seam=none; no_claim=the page passing the right region (page.test)
  it.each([
    [undefined, "WWV"],
    ["na", "WWV"],
    ["la", "PPE Observatorio Nac."],
    ["eu", "ItalCable"],
  ] as const)("on 10 MHz with region %s, %s leads", (region, leader) => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    const t = at(`${THU}T08:49:00Z`);
    const ranked = scheduledOn(merged, 10_000, t, region);
    expect(ranked[0]!.station).toBe(leader);
    expect(stationLine(ranked)!.all).toContain("PPE Observatorio Nac.");
    const [channel] = scheduledBetween(merged, 10_000, 10_000, t, region);
    expect(shortLabel(rankBroadcasts(channel!.broadcasts, region))).toBe(`${leader} +${ranked.length - 1}`);
  });

  // Value: protects=#152 D3: a Priyom-confirmed slot leads a frequency it shares with EiBi broadcasters (E11 over the all-day jammer on 11,100), and a season row standing in for Priyom's keeps trailing; fails_when=the tiebreak keys on catalog only (E11 trails) or on slug (the unconfirmed row leads); why_new=D3's rule is new; seam=none; no_claim=Priyom's live feed (fixture copy)
  it("puts a confirmed Priyom slot first on a shared frequency, not a season row", () => {
    const confirmed = onAirSchedule(EIBI, copy([tx("E11", `${THU}T10:45:00Z`, 11_100)]));
    const live = scheduledOn(confirmed, 11_100, at(`${THU}T10:47:00Z`));
    expect(live[0]).toMatchObject({ station: "E11", source: "priyom" });
    expect(names(live)).toContain("CNR1 Jammer/Firedrake");
    // Wednesday: EiBi's E11 row on 11,100 (Mo,We 10:45-10:55) stands in, marked.
    const season = scheduledOn(onAirSchedule(EIBI, null), 11_100, at("2026-11-25T10:47:00Z"));
    expect(season[0]!.station).toBe("CNR1 Jammer/Firedrake");
    expect(season.at(-1)).toMatchObject({ station: "E11", unconfirmed: true });
  });

  // Value: protects=day/night stations keep EiBi's hours under the catalog identity (D8): The Pip on 3756 at 20:00, not at 12:00; The Squeaky Wheel's 3364 row moves to the catalog's 3363.5 and is still found from 3364; fails_when=0000-2400 rows or the sun guess replace EiBi's hours, or 3364 loses the name; why_new=R6; seam=none; no_claim=#149's both-windows flaw
  it("names the day/night stations on EiBi's hours as the catalog's", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    expect(on(merged, 3_756, "2026-11-25T20:00:00Z")).toMatchObject([{ station: "The Pip", slug: "the-pip", source: "catalog" }]);
    expect(on(merged, 3_756, "2026-11-25T12:00:00Z")).toEqual([]);
    expect(on(merged, 3_364, "2026-11-25T20:00:00Z")).toMatchObject([{ station: "The Squeaky Wheel", khz: 3_363.5, mode: "usb" }]);
  });

  // Value: protects=D4: while Priyom's schedule loads nothing is named for its stations, and with none to be had their EiBi rows come back marked unconfirmed (still as the catalog station); fails_when=loading flashes EiBi's grid, or a failure blanks the stations or loses the mark; why_new=R2; seam=none; no_claim=the hook's network states (use-priyom-schedule tests)
  it("shows nothing while loading and marked EiBi rows when Priyom is unavailable", () => {
    const loading = onAirSchedule(EIBI, undefined);
    expect(loading.filter((r) => r.slug === "e11")).toEqual([]);
    const none = onAirSchedule(EIBI, null);
    expect(on(none, 13_908, `${THU}T07:47:00Z`)).toMatchObject([{ station: "E11", slug: "e11", unconfirmed: true }]);
    expect(none.filter((r) => r.slug === "e11" && !r.unconfirmed)).toEqual([]);
  });

  // Value: protects=D13 with the owner's boundary test: a copy is used up to the last moment of its span and EiBi's marked rows stand in from the first moment outside it, at both ends; fails_when=an off-by-one at the span's edges blanks or doubles a moment, or a stale copy reads as "nothing scheduled"; why_new=R11; seam=none; no_claim=none beyond protects
  it("falls back exactly outside the copy's span", () => {
    const daily: Broadcast = { khz: 7_000, start: 0, end: 1440, days: "", station: "E11 Polish Spy Numbers", lang: "E", target: "" };
    const fetchedAt = at(`${THU}T00:30:00Z`);
    const { fromMs, toMs } = priyomSpan(fetchedAt);
    const merged = onAirSchedule([daily], { transmissions: [], fetchedAt });
    const named = (ms: number) => listedOn(merged, 7_000, ms).map((r) => r.unconfirmed ?? false);
    expect(named(toMs - 1)).toEqual([]);
    expect(named(toMs)).toEqual([true]);
    expect(named(fromMs)).toEqual([]);
    expect(named(fromMs - 1)).toEqual([true]);
    expect(named(at("2026-12-20T10:00:00Z"))).toEqual([true]); // a copy weeks old
  });

  // Value: protects=a Priyom RTTY slot (F06, filed under F06 from F06a) is a row with a USB dial, read as "Digital data", on the air for its ten minutes only; fails_when=data rows lose their mode or label, or linger past the slot; why_new=R15 and the F06a decision; seam=none; no_claim=mark-vs-centre on the air
  it("lists an F06 RTTY slot on its USB dial as digital data", () => {
    const merged = onAirSchedule(EIBI, copy([tx("F06", `${THU}T01:00:00Z`, 17_529.875, { data: true, designator: "F06a", listedKhz: 17_532 })]));
    expect(on(merged, 17_529.875, `${THU}T01:05:00Z`)).toMatchObject([
      { station: "F06", slug: "f06", lang: "-TY", mode: "usb", source: "priyom", listedKhz: 17_532 },
    ]);
    expect(on(merged, 17_529.875, `${THU}T01:10:00Z`)).toEqual([]);
    // Search keeps Priyom's listed frequency for the row's display (owner, #148).
    expect(findBroadcasts(merged, "F06", at(`${THU}T01:05:00Z`), snapshot.season).found).toMatchObject([{ khz: 17_529.875, listedKhz: 17_532 }]);
  });

  // Value: protects=a Priyom slot that starts before midnight UTC stays named after it for the rest of its ten minutes (E11 at 23:55 Wed is on at 00:02 Thu, off at 00:05); fails_when=priyomRow's end stops wrapping past 1440, so the after-midnight half of a slot drops from the readout, the prompt and search; why_new=/ship coverage audit of #148: every Priyom fixture starts mid-day; seam=none; no_claim=Priyom's real slot lengths
  it("keeps a slot that crosses midnight on after it", () => {
    const merged = onAirSchedule(EIBI, copy([tx("E11", "2026-11-25T23:55:00Z", 4_909)]));
    expect(on(merged, 4_909, "2026-11-25T23:58:00Z")).toMatchObject([{ station: "E11", source: "priyom" }]);
    expect(on(merged, 4_909, `${THU}T00:02:00Z`)).toMatchObject([{ station: "E11", source: "priyom" }]);
    expect(on(merged, 4_909, `${THU}T00:05:00Z`)).toEqual([]);
  });

  // Value: protects=a slot Priyom lists without a frequency yet ("M12 Search", which the server passes through for catalog stations) makes no row at all, so nothing is named on a null frequency and Find a station never offers an untunable result; fails_when=priyomRow's khz/mode null guard goes, putting a khz-null row into the sorted schedule and search; why_new=/ship coverage audit of #148: no on-air fixture had a Search slot; seam=none; no_claim=when Priyom fills in the frequency
  it("makes no row for a slot without a frequency", () => {
    const search = tx("M12", `${THU}T13:00:00Z`, 0, { khz: null, mode: null, summary: "M12 Search" });
    const merged = onAirSchedule(EIBI, copy([search, tx("M12", `${THU}T13:00:00Z`, 6_200)]));
    expect(merged.filter((r) => r.slug === "m12").map((r) => r.khz)).toEqual([6_200]);
    expect(findBroadcasts(merged, "M12", at(`${THU}T13:05:00Z`), snapshot.season).found.map((f) => f.khz)).toEqual([6_200]);
  });

  // Value: protects=Find a station's filters keep working on rows built for catalog stations: E11's Priyom rows keep EiBi's language (English), WWV's catalog rows EiBi's non-voice "-TS", and every built row carries the station's other names; fails_when=built rows get a blank language (E11 vanishes under English, WWV survives "hide non-voice") or lose the aliases search needs; why_new=Q2/C9 preservation; seam=none; no_claim=search matching itself (station-search tests)
  it("gives built rows the station's EiBi language and other names", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    expect(merged.find((r) => r.slug === "e11" && r.source === "priyom")).toMatchObject({ lang: "E" });
    expect(merged.find((r) => r.slug === "wwv" && r.source === "catalog")).toMatchObject({ lang: "-TS" });
    expect(merged.find((r) => r.slug === "uvb-76")?.aka).toContain("The Buzzer");
  });
});

describe("Find a station over the merged schedule", () => {
  // Value: protects=searching "E11" lists Priyom's slots (on now, or starting later with their time and USB mode), never EiBi's season grid; fails_when=StationSearch keeps the raw schedule or the merge leaks EiBi rows; why_new=issue acceptance; seam=none; no_claim=StationSearch's rendering
  it("finds E11 at Priyom's times, not EiBi's", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    const { found } = findBroadcasts(merged, "E11", at(`${THU}T07:00:00Z`), snapshot.season);
    expect(found.map((f) => [f.khz, f.startsAt === undefined ? "now" : new Date(f.startsAt).toISOString().slice(11, 16), f.mode])).toEqual([
      [23_031, "07:45", "usb"],
      [4_909, "13:00", "usb"],
    ]);
  });

  // Value: protects=search still finds a station by EiBi's name and the catalog's aliases ("The Buzzer" finds UVB-76), language filters keep finding numbers stations (English finds E11), and a fallback row is marked; fails_when=built rows lose aliases or language, or the mark doesn't reach the result; why_new=C8/C9 preservation; seam=none; no_claim=StationSearch's rendering
  it("finds stations by their other names, keeps the filters, and marks fallback rows", () => {
    const merged = onAirSchedule(EIBI, PRIYOM);
    const now = at(`${THU}T13:05:00Z`);
    expect(findBroadcasts(merged, "The Buzzer", now, snapshot.season).found.map((f) => f.station)).toEqual(["UVB-76"]);
    const english = { area: null, language: { codes: ["E"], nonVoice: true } };
    expect(findBroadcasts(merged, "E11", now, snapshot.season, english).found.map((f) => f.khz)).toContain(4_909);
    const fallback = findBroadcasts(onAirSchedule(EIBI, null), "E11", at(`${THU}T07:47:00Z`), snapshot.season).found;
    expect(fallback.find((f) => f.khz === 13_908)).toMatchObject({ onNow: true, unconfirmed: true });
  });

  // Value: protects=a Priyom slot tomorrow still shows on the last day of an EiBi season, since the season cut applies to EiBi's rows only; fails_when=nextStart's season cut hides confirmed Priyom slots past the switch; why_new=Codex C10; seam=none; no_claim=none beyond protects
  it("keeps tomorrow's Priyom slot across an EiBi season change", () => {
    // b26 ends at 00:00 on the last Sunday of March 2027 (28 Mar); a slot that morning, searched the evening before.
    const merged = onAirSchedule(EIBI, { transmissions: [tx("E11", "2027-03-28T07:45:00Z", 23_031)], fetchedAt: at("2027-03-27T10:00:00Z") });
    const { found } = findBroadcasts(merged, "E11", at("2027-03-27T20:00:00Z"), "b26");
    expect(found.map((f) => f.khz)).toEqual([23_031]);
  });
});

describe("Find a station's season cut on day/night rows", () => {
  // Value: protects=The Pip's rows, EiBi's hours under the catalog's name (D8), still stop at the EiBi season's end in search, so a start past the switch from this season's file isn't offered; fails_when=retagged rows skip the cut like Priyom's do; why_new=bug review of #148 (C10 applies to EiBi-derived rows); seam=none; no_claim=next season's hours
  it("doesn't list The Pip past the season switch", () => {
    const pip: Broadcast = { khz: 5_448, start: 180, end: 1050, days: "", station: "The Pip (Kaplya) Rostov", lang: "-TS", target: "RUS" };
    const merged = onAirSchedule([pip], null);
    // b26 ends at 00:00 on 28 Mar 2027; searched the evening before, 03:00 next morning is a27.
    expect(findBroadcasts(merged, "Pip", at("2027-03-27T20:00:00Z"), "b26").found).toEqual([]);
    expect(findBroadcasts(merged, "Pip", at("2027-03-26T20:00:00Z"), "b26").found.map((f) => f.station)).toEqual(["The Pip"]);
  });
});

describe("the catalog's EiBi names", () => {
  // Value: protects=every EiBi row named "... Numbers" in the bundled season belongs to a catalog station, so a new designator can't slip onto the dial with its season grid; every catalog EiBi name is one EiBi really uses; "WWVB Colorado" is not WWV (whole names only); fails_when=EiBi renames a station, a station is added to EiBi but not the catalog, or prefix matching creeps in; why_new=issue acceptance; seam=none; no_claim=the next season's file
  it("cover every numbers station in the snapshot, exactly", () => {
    expect(EIBI.filter((b) => /Numbers/.test(b.station) && !stationNamed(b.station)).map((b) => b.station)).toEqual([]);
    const used = new Set(EIBI.map((b) => b.station));
    for (const s of SIGNAL_STATIONS) for (const n of s.eibi ?? []) expect(used, `${s.slug}: ${n}`).toContain(n);
    expect(stationNamed("WWVB Colorado")).toBeUndefined();
  });
});

describe("dayNightRows", () => {
  // Value: protects=#168 the station page's slice of the schedule is exactly the merged schedule's rows for The Pip and The Squeaky Wheel (EiBi's four month windows on each of their two channels, on the catalog's frequencies, 3363.5 for EiBi's 3364), so the page and the dial read the same hours; fails_when=other stations' rows leak in (a bigger payload, wrong names), a channel's rows go missing, or the Squeaky Wheel's 3364 rows keep EiBi's frequency; why_new=#168 signals.dayNight; seam=the bundled B26 snapshot; no_claim=that the server serves the current season
  it("keeps only the day/night stations' rows, on the catalog's channels", () => {
    const rows = dayNightRows(EIBI);
    const merged = onAirSchedule(EIBI, undefined).filter((r) => r.slug === "the-pip" || r.slug === "squeaky-wheel");
    expect(rows).toEqual(merged);
    const count = (slug: string, khz: number) => rows.filter((r) => r.slug === slug && r.khz === khz).length;
    expect([count("the-pip", 3_756), count("the-pip", 5_448), count("squeaky-wheel", 3_363.5), count("squeaky-wheel", 5_367)]).toEqual([4, 4, 4, 4]);
    expect(rows.length).toBe(16);
  });
});
