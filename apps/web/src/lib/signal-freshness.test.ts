import { describe, expect, it } from "vitest";
import type { PriyomTx } from "./priyom-schedule";
import { freshnessIssueBody, freshnessReport, type FreshnessInput } from "./signal-freshness";
import { findStation, SIGNAL_STATIONS, type SignalStation } from "./signal-stations";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-12-07T15:00:00Z");
const tx = (station: string): PriyomTx => ({ station, startMs: NOW + DAY, khz: 10_000, mode: "usb", summary: `${station} 10000kHz USB` });
/** Every catalog designator transmitting this week. */
const allPriyom = SIGNAL_STATIONS.flatMap((s) => (s.priyom ? [tx(s.priyom)] : []));
/** Answers that keep every always-on station "ok". */
const heardAll = SIGNAL_STATIONS.map((s) => ({ txName: s.slug, outcome: "heard", listenerId: "x", n: 1 }));

const input = (over: Partial<FreshnessInput> = {}): FreshnessInput => ({
  now: NOW,
  tallies: heardAll,
  schedule: { transmissions: allPriyom },
  fetch: { fetchedAt: NOW - 3_600_000, error: null },
  feed: { trackedSince: NOW - 10 * DAY, changedAt: NOW - 2 * DAY },
  ...over,
});

describe("freshnessReport", () => {
  // Value: protects=#147 a freshly checked catalog with heard stations and a working, changing Priyom feed gives an empty report (the workflow closes the issue); fails_when=something is flagged with nothing wrong, so the issue never closes; why_new=#147 weekly report; seam=signal-stations catalog; no_claim=the route's database read
  it("is empty when nothing needs a look", () => {
    const r = freshnessReport(input());
    expect(r).toMatchObject({ stale: [], suspect: [], quiet: [], empty: true });
    expect(r.priyom).toMatchObject({ error: null, unchanged: false, missing: [] });
    expect(freshnessIssueBody(r)).toContain("Nothing needs a look this week.");
  });

  // Value: protects=#147 an entry checked over 180 days ago is listed with its age and sources, and one at 180 isn't; fails_when=old entries go unlisted, or the threshold drifts; why_new=#147 acceptance; seam=none; no_claim=none
  it("lists entries not checked in over 180 days", () => {
    const stations: SignalStation[] = [
      { ...findStation("rwm")!, checked: "2026-06-09" },
      { ...findStation("wwv")!, checked: "2026-06-10" },
    ];
    const r = freshnessReport(input({ stations, now: Date.parse("2026-12-07T12:00:00Z") }));
    expect(r.stale).toEqual([
      { slug: "rwm", name: "RWM", checked: "2026-06-09", days: 181, sources: ["https://en.wikipedia.org/wiki/RWM"] },
    ]);
    expect(r.empty).toBe(false);
    expect(freshnessIssueBody(r)).toContain("- [ ] **RWM** (`rwm`): last checked 2026-06-09, 181 days ago. Sources: <https://en.wikipedia.org/wiki/RWM>");
  });

  // Value: protects=#147 suspect stations make the report non-empty with their counts, while quiet ones are listed for information only and don't keep the issue open; fails_when=a station nobody listens to keeps the issue open forever, or a suspect one is left out; why_new=#147; seam=signal-heard stationActivity; no_claim=none
  it("lists suspect stations as to-dos and quiet ones for information", () => {
    const notHeard = ["a", "b", "c"].map((w) => ({ txName: "uvb-76", outcome: "not_heard", listenerId: w, n: 2 }));
    const r = freshnessReport(input({ tallies: [...heardAll.filter((t) => t.txName !== "uvb-76" && t.txName !== "rwm"), ...notHeard] }));
    expect(r.suspect).toEqual([{ slug: "uvb-76", name: "UVB-76", notHeard: 6, listeners: 3, sources: findStation("uvb-76")!.sources }]);
    expect(r.quiet.map((s) => s.slug)).toEqual(["rwm"]);
    expect(r.empty).toBe(false);
    const body = freshnessIssueBody(r);
    expect(body).toContain('**UVB-76** (`uvb-76`): 6 "not heard" from 3 listeners');
    expect(body).toContain("there's no evidence either way: RWM.");
    expect(freshnessReport(input({ tallies: heardAll.filter((t) => t.txName !== "rwm") })).empty).toBe(true);
  });

  // Value: protects=#147 the Priyom section flags a failing fetch with its reason, a feed with no change in over 45 days, and catalog designators with no transmissions this week (not defunct ones); fails_when=a broken or abandoned feed goes unreported, or a missing designator is hidden; why_new=#147 acceptance; seam=none; no_claim=what Priyom actually did
  it("flags a failing, unchanged or incomplete Priyom feed", () => {
    const failing = freshnessReport(input({ schedule: null, fetch: { fetchedAt: null, error: "HTTP 503" } }));
    expect(failing.priyom).toMatchObject({ error: "HTTP 503", missing: null });
    expect(failing.empty).toBe(false);
    expect(freshnessIssueBody(failing)).toContain("Priyom's schedule isn't loading: HTTP 503.");

    const old = freshnessReport(input({ feed: { trackedSince: NOW - 90 * DAY, changedAt: NOW - 46 * DAY } }));
    expect([old.priyom.unchanged, old.empty]).toEqual([true, false]);
    expect(freshnessIssueBody(old)).toContain("no change to the catalog stations' slots since 2026-10-22");
    expect(freshnessReport(input({ feed: { trackedSince: NOW - 90 * DAY, changedAt: NOW - 44 * DAY } })).priyom.unchanged).toBe(false);

    const noM12 = freshnessReport(input({ schedule: { transmissions: allPriyom.filter((t) => t.station !== "M12") } }));
    expect(noM12.priyom.missing?.map((s) => s.designator)).toEqual(["M12"]);
    expect(freshnessIssueBody(noM12)).toContain("**M12** (`m12`): no M12 transmissions in Priyom's schedule this week");
  });

  // Value: protects=#147 a server with no Priyom copy and no fetch error yet (nothing tried, or a cold instance) and no shared record still reports Priyom as not loading, so the report isn't empty and the workflow doesn't close the issue; fails_when=the "no copy yet" fallback is dropped, so a feed that never loaded reads as "nothing needs a look"; why_new=the fallback branch had no test; seam=none (pure); no_claim=why the copy is missing
  it("isn't empty with no Priyom copy, even without an error", () => {
    const r = freshnessReport(input({ schedule: null, fetch: { fetchedAt: null, error: null }, feed: null }));
    expect(r.priyom).toEqual({ fetchedAt: null, error: "no copy of Priyom's schedule yet", changedAt: null, trackedSince: null, unchanged: false, missing: null });
    expect(r.empty).toBe(false);
    expect(freshnessIssueBody(r)).toContain("Priyom's schedule isn't loading: no copy of Priyom's schedule yet. Last good copy on this server: none.");
  });

  // Value: protects=#147 a feed with no change seen since tracking began over 45 days ago is flagged, and the issue line names when tracking began (there's no change date to give); fails_when=the line prints "since null" / crashes on a null changedAt, or a never-changing feed isn't flagged; why_new=the trackedSince branch of the Priyom line had no test; seam=none; no_claim=none
  it("names when tracking began when no change was ever seen", () => {
    const r = freshnessReport(input({ feed: { trackedSince: NOW - 46 * DAY, changedAt: null } }));
    expect([r.priyom.unchanged, r.empty]).toEqual([true, false]);
    expect(freshnessIssueBody(r)).toContain("no change to the catalog stations' slots since tracking began 2026-10-22 (over 45 days)");
  });

  // Value: protects=#147 a Priyom-listed station marked defunct isn't reported missing from Priyom's schedule (it's known to be off), while a live one is; fails_when=the defunct filter is dropped, so retiring a numbers station keeps the issue open every week; why_new=no catalog station is both Priyom-listed and defunct today, so existing tests pass without the filter; seam=stations input; no_claim=none
  it("doesn't list a defunct station as missing from Priyom", () => {
    const e07 = findStation("e07")!;
    const retired: SignalStation = { ...e07, schedule: { kind: "defunct", ended: "2026-11" } };
    const r = freshnessReport(input({ stations: [retired, findStation("e11")!], schedule: { transmissions: [tx("E11")] } }));
    expect([r.priyom.missing, r.empty]).toEqual([[], true]);
    expect(freshnessReport(input({ stations: [e07], schedule: { transmissions: [] } })).priyom.missing?.map((m) => m.designator)).toEqual(["E07"]);
  });
});
