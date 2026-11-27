import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedBroadcast } from "@/lib/eibi";
import type { SiteTable } from "@/lib/eibi-sites";
import type { IbpStatus } from "@/lib/ibp-status";
import { PRIYOM_ON_AIR_MS, type PriyomTx } from "@/lib/priyom-schedule";
import type { RbnDay } from "@/lib/rbn";
import type { Receiver } from "@/lib/kiwi-list";
import { PICK_CONTEXT_VERSION } from "@/lib/pick-context";
import { ASK_RULE_VERSION } from "@/lib/reception";
import { findStation, type SignalStation } from "@/lib/signal-stations";
import type { createContext } from "@/server/trpc";
import {
  candidateKeyOk,
  namesPriyomStation,
  sitesHeard,
  PICK_IN_SLOT_MS,
  RECEIVER_REPORTS_PER_HOUR,
  REPORTS_PER_HOUR,
  SAME_CHANNEL_MS,
  signalChecks,
  askedTogether,
  type GroupReportInput,
  type ReportInput,
} from "./reports";

// The real module opens a Prisma client at import; every test injects its own db.
vi.mock("@/server/db", () => ({ db: {} }));

// The server's cached schedule and receiver list, as stations.schedule and receivers.list serve them.
const cache = {
  broadcasts: [] as ListedBroadcast[],
  sites: new Map() as SiteTable,
  receivers: [] as Receiver[],
  listDown: false,
  beaconStatus: null as IbpStatus | null,
  rbn: null as RbnDay | null,
  priyom: null as PriyomTx[] | null,
};
vi.mock("./beacons", async (actual) => ({
  ...(await actual<typeof import("./beacons")>()),
  getBeaconStatus: vi.fn(async () => cache.beaconStatus),
  rbnDays: { get: vi.fn(async () => cache.rbn), peek: vi.fn(async () => cache.rbn) },
}));
vi.mock("./stations", async (actual) => ({
  ...(await actual<typeof import("./stations")>()),
  getSchedule: vi.fn(async () => ({
    season: "b26",
    bundled: false,
    broadcasts: cache.broadcasts,
    listed: cache.broadcasts,
  })),
  getSites: vi.fn(() => cache.sites),
}));
vi.mock("./signals", async (actual) => ({
  ...(await actual<typeof import("./signals")>()),
  getPriyomSchedule: vi.fn(async () => cache.priyom && { transmissions: cache.priyom, fetchedAt: 0 }),
}));
vi.mock("./receivers", async (actual) => ({
  ...(await actual<typeof import("./receivers")>()),
  getReceivers: vi.fn(async () => {
    if (cache.listDown) throw new Error("Receiver list request failed: HTTP 502");
    return { receivers: cache.receivers, fetchedAt: 0, stale: false };
  }),
}));

const { appRouter } = await import("@/server/root");
const { getSchedule, getSites } = await import("./stations");
const { getPriyomSchedule } = await import("./signals");
const { getReceivers } = await import("./receivers");

/** A broadcast between two UTC times ("HHMM"), daily. */
const on = (khz: number, station: string, from = "0000", to = "2400", site?: string): ListedBroadcast => {
  const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
  const b: ListedBroadcast = { khz, start: min(from), end: min(to), days: "", station, lang: "E", target: "NAm", country: "KOR" };
  if (site !== undefined) b.site = site;
  return b;
};
const rx = (host: string, port = 8073): Receiver => ({
  id: `${host}:${port}`,
  name: host,
  location: "",
  antenna: "",
  host,
  port,
  users: 0,
  usersMax: 8,
  snr: 20,
  minKhz: 0,
  maxKhz: 30_000,
});

// KBS all day on every frequency the limit tests use, and the receivers they report on.
const LIMIT_FREQS = [9_580, 9_590, 7_000, ...Array.from({ length: 40 }, (_, i) => 6_000 + i)];
beforeEach(() => {
  cache.broadcasts = LIMIT_FREQS.map((khz) => on(khz, "KBS World Radio")).sort((a, b) => a.khz - b.khz);
  cache.receivers = [rx("kiwi.example.org"), rx("kiwi.example.org", 8074), rx("other.example")];
  cache.listDown = false;
  cache.sites = new Map();
});

type Context = Awaited<ReturnType<typeof createContext>>;
type Row = {
  listenerId: string;
  receiverHost: string;
  receiverPort: number;
  freqKhz: number;
  txName?: string;
  askGroup?: string;
  createdAt: Date;
};
type Where = Record<string, unknown> & { createdAt: { gte: Date } };

/**
 * An in-memory ReceptionReport table that answers count() and groupBy() the
 * way Prisma would for these filters (equality, null for an empty column,
 * `{ in: [...] }`, `{ not: null }`).
 */
function setup() {
  const rows: Row[] = [];
  const matching = ({ createdAt, ...eq }: Where) =>
    rows.filter(
      (r) =>
        r.createdAt >= createdAt.gte &&
        Object.entries(eq).every(([k, v]) => {
          const got = r[k as keyof Row] ?? null;
          if (v !== null && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(got);
          if (v !== null && typeof v === "object" && "not" in v) return got !== v.not;
          return got === v;
        }),
    );
  const add = (data: Omit<Row, "createdAt">) => {
    const row = { ...data, createdAt: new Date() };
    rows.push(row);
    return { id: String(rows.length), ...row };
  };
  const receptionReport = {
    count: vi.fn(async ({ where }: { where: Where }) => matching(where).length),
    groupBy: vi.fn(async ({ by, where }: { by: ["askGroup"]; where: Where }) =>
      [...new Set(matching(where).map((r) => r[by[0]] ?? null))].map((askGroup) => ({ askGroup })),
    ),
    create: vi.fn(async ({ data }: { data: Omit<Row, "createdAt"> }) => add(data)),
    createMany: vi.fn(async ({ data }: { data: Omit<Row, "createdAt">[] }) => ({ count: data.map(add).length })),
  };
  const caller = appRouter.createCaller({ db: { receptionReport } } as unknown as Context);
  return { caller, receptionReport };
}

const LISTENER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const valid = {
  listenerId: LISTENER,
  receiverHost: "Kiwi.Example.org",
  receiverPort: 8073,
  freqKhz: 9_580,
  mode: "am" as const,
  txKind: "eibi" as const,
  txName: "KBS World Radio",
  txDetail: "E/NAm",
  outcome: "heard" as const,
};

describe("reports.submit", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 12) })); // pregate-literal: PICK_CONTEXT_VERSION=10 the month (November), not the version
  afterEach(() => vi.useRealTimers());

  // Value: protects=a report is stored as one receiver (lowercase host) with a blank comment as none, and nothing beyond the fields asked for plus the server's own transmitter lookup (#72: here EiBi gives no site); fails_when=the host isn't normalised, a blank comment is stored, or extra fields slip in; why_new=reception reports; seam=in-memory db; no_claim=Postgres behaviour
  it("stores a report, the host lowercased and a blank comment dropped", async () => {
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submit({ ...valid, comment: "   " })).resolves.toEqual({ accepted: true });
    expect(receptionReport.create).toHaveBeenCalledWith({
      data: {
        ...valid,
        receiverHost: "kiwi.example.org",
        comment: undefined,
        txSites: [{ key: null, country: "KOR", coords: [] }],
      },
    });
  });

  it.each([
    ["a listener id that isn't a UUID", { listenerId: "1.2.3.4" }],
    ["an unknown outcome", { outcome: "maybe" }],
    ["an unknown transmitter kind", { txKind: "ship" }],
    ["an unknown mode", { mode: "fm" }],
    ["a frequency above 32 MHz", { freqKhz: 40_000 }],
    ["a port out of range", { receiverPort: 70_000 }],
    ["a blank station", { txName: "  " }],
    ["a blank receiver", { receiverHost: " " }],
    ["a comment over 280 characters", { comment: "x".repeat(281) }],
  ])("rejects %s without touching the database", async (_, override) => {
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submit({ ...valid, ...override } as typeof valid)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(receptionReport.count).not.toHaveBeenCalled();
    expect(receptionReport.create).not.toHaveBeenCalled();
  });

  it("keeps a comment of exactly 280 characters", async () => {
    const { caller } = setup();
    await expect(caller.reports.submit({ ...valid, comment: "x".repeat(280) })).resolves.toEqual({ accepted: true });
  });

  // Value: protects=one listener can't answer about the same receiver and frequency twice in 30 minutes, while another frequency or receiver still counts, and the same one again after the window; fails_when=the per-channel limit is missing, too broad, or never expires; why_new=reception reports; seam=in-memory db + fake clock; no_claim=concurrent submits racing the count
  it("takes one report per listener, receiver and frequency in 30 minutes", async () => {
    const { caller, receptionReport } = setup();
    await caller.reports.submit(valid);
    // Any spelling of the same host is the same receiver.
    await expect(caller.reports.submit({ ...valid, receiverHost: "kiwi.example.org" })).resolves.toEqual({
      accepted: false,
    });
    await expect(caller.reports.submit({ ...valid, freqKhz: 9_590 })).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submit({ ...valid, receiverPort: 8074 })).resolves.toEqual({ accepted: true });
    expect(receptionReport.create).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(SAME_CHANNEL_MS + 1);
    await expect(caller.reports.submit(valid)).resolves.toEqual({ accepted: true });
  });

  // Value: protects=a listener is held to 10 reports in a rolling hour, quietly (accepted: false, not an error), others aren't affected, and the window rolls; fails_when=the hourly cap is off by one, global, throws, or never rolls; why_new=reception reports; seam=in-memory db + fake clock; no_claim=concurrent submits racing the count
  it("takes at most 10 reports per listener an hour, then quietly declines", async () => { // pregate-literal: PICK_CONTEXT_VERSION=10 the hourly report cap, not the version
    const { caller, receptionReport } = setup();
    for (let i = 0; i < REPORTS_PER_HOUR; i++) {
      await expect(caller.reports.submit({ ...valid, freqKhz: 6_000 + i })).resolves.toEqual({ accepted: true });
    }
    await expect(caller.reports.submit({ ...valid, freqKhz: 7_000 })).resolves.toEqual({ accepted: false });
    expect(receptionReport.create).toHaveBeenCalledTimes(REPORTS_PER_HOUR);
    // Someone else is unaffected.
    const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    await expect(caller.reports.submit({ ...valid, listenerId: other })).resolves.toEqual({ accepted: true });
    vi.advanceTimersByTime(60 * 60_000 + 1);
    await expect(caller.reports.submit({ ...valid, freqKhz: 7_000 })).resolves.toEqual({ accepted: true });
  });

  // Value: protects=a script minting a fresh listener id per report can add at most RECEIVER_REPORTS_PER_HOUR reports about one receiver an hour, other receivers unaffected, and the hour rolls; fails_when=the only limits are per listener id (which the client makes), or the receiver cap is global or never rolls; why_new=review: per-listener limits don't stop a scripted flood; seam=in-memory db + fake clock; no_claim=per-IP limits (Vercel firewall, not this code)
  it("caps reports about one receiver an hour, whatever listener ids they carry", async () => {
    const { caller, receptionReport } = setup();
    const fresh = () => crypto.randomUUID();
    for (let i = 0; i < RECEIVER_REPORTS_PER_HOUR; i++) {
      await caller.reports.submit({ ...valid, listenerId: fresh(), freqKhz: 6_000 + i });
    }
    expect(receptionReport.create).toHaveBeenCalledTimes(RECEIVER_REPORTS_PER_HOUR);
    await expect(caller.reports.submit({ ...valid, listenerId: fresh(), freqKhz: 7_000 })).resolves.toEqual({
      accepted: false,
    });
    await expect(
      caller.reports.submit({ ...valid, listenerId: fresh(), receiverHost: "other.example" }),
    ).resolves.toEqual({ accepted: true });
    vi.advanceTimersByTime(60 * 60_000 + 1);
    await expect(caller.reports.submit({ ...valid, listenerId: fresh(), freqKhz: 7_000 })).resolves.toEqual({
      accepted: true,
    });
  });
});

describe("reports.submit checks what it's told", () => {
  // Noon UTC.
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 12) })); // pregate-literal: PICK_CONTEXT_VERSION=10 the month (November), not the version
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const declined = async (input: ReportInput) => {
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submit(input)).resolves.toEqual({ accepted: false });
    expect(receptionReport.create).not.toHaveBeenCalled();
  };
  const accepted = async (input: ReportInput) => {
    const { caller } = setup();
    await expect(caller.reports.submit(input)).resolves.toEqual({ accepted: true });
  };

  // Value: protects=a report names a station the server's own schedule has on that frequency, not whatever a client sends; fails_when=txName isn't checked, or is checked against any frequency; why_new=PR #63 review: the server trusted client-sent transmitter details; seam=getSchedule mocked; no_claim=EiBi's accuracy
  it("declines a station the schedule doesn't have on that frequency", async () => {
    await declined({ ...valid, txName: "Radio Nowhere" });
    cache.broadcasts = [on(9_580, "KBS World Radio"), on(11_700, "Radio A")];
    await declined({ ...valid, txName: "Radio A" });
  });

  // Value: protects=an answer given a few minutes after the listing ended still counts (the prompt comes after 60 s and may wait), but not past the 5-minute grace, judged to the minute; fails_when=only the current minute is checked (dropping late honest answers) or the grace is open-ended; why_new=PR #63 review; seam=getSchedule mocked + fake clock; no_claim=the client's own timeout
  it("accepts a listing that ended within the last 5 minutes, not one before that", async () => {
    // On air 11:00 until 11:56 (its last minute 11:55): five minutes before noon.
    cache.broadcasts = [on(9_580, "Just ended", "1100", "1156")];
    await accepted({ ...valid, txName: "Just ended" });
    // Its last minute 11:54: six minutes ago.
    cache.broadcasts = [on(9_580, "Long gone", "1100", "1155")];
    await declined({ ...valid, txName: "Long gone" });
  });

  it("accepts two or three stations asked about together only if each is scheduled", async () => {
    cache.broadcasts = [on(11_700, "Radio A"), on(11_700, "Radio B")];
    await accepted({ ...valid, freqKhz: 11_700, txName: "Radio A / Radio B" });
    await declined({ ...valid, freqKhz: 11_700, txName: "Radio A / Radio Nowhere" });
  });

  // Value: protects=a report is about a receiver on the public list the page is served (opted-out owners left out), checked from the cached list; fails_when=any host:port is taken, a blocked receiver's reports are kept, or a list outage lets unchecked reports in; why_new=PR #63 review: the server trusted client-sent receiver details; seam=getReceivers mocked; no_claim=the mirror's contents
  it("declines a receiver that isn't on the served list, or when there's no list", async () => {
    await declined({ ...valid, receiverHost: "made-up.example" });
    await declined({ ...valid, receiverPort: 9999 });
    vi.stubEnv("BLOCKED_RECEIVERS", "kiwi.example.org:8073");
    await declined(valid);
    vi.unstubAllEnvs();
    cache.listDown = true;
    await declined(valid);
  });

  describe("a beacon report", () => {
    const NOON = Date.UTC(2026, 10, 18, 12); // pregate-literal: PICK_CONTEXT_VERSION=10 the month (November), not the version
    // 11:57:00 opened the last cycle: 4U1UN on 14.100 until 11:57:10, then VE8AT.
    const SLOT = NOON - 180_000;
    const beacon = {
      ...valid,
      freqKhz: 14_100,
      mode: "cw" as const,
      txKind: "beacon" as const,
      txName: "4U1UN",
      txDetail: "14100",
      slotStartMs: SLOT,
    };
    beforeEach(() => {
      cache.broadcasts = [];
      cache.beaconStatus = null;
      cache.rbn = null;
    });

    // Value: protects=each beacon report stores RBN's spot count for that beacon and the day it counts, from what the server has saved, read without downloading (peek, never get); nothing without a saved day; fails_when=the count isn't stored, is another beacon's, has no day, or submitting starts RBN's 6 MB download; why_new=issue #69 v2 (owner: store the day's RBN count on each beacon report); seam=rbnDays mocked, in-memory db; no_claim=RBN's accuracy
    it.each([
      [{ rbnSpots: 0, rbnDay: "2026-11-17" }, { day: "2026-11-17", total: 20_000, beacons: [{ call: "4U1UN", spots: 0 }, { call: "VE8AT", spots: 9 }] }],
      [{ rbnSpots: 4534, rbnDay: "2026-11-17" }, { day: "2026-11-17", total: 20_000, beacons: [{ call: "4U1UN", spots: 4534 }] }],
      [{ rbnSpots: undefined, rbnDay: undefined }, null],
    ])("stores RBN's count for the beacon (%o)", async (stored, day) => {
      cache.rbn = day as RbnDay | null;
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit(beacon)).resolves.toEqual({ accepted: true });
      const { data } = receptionReport.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect({ rbnSpots: data.rbnSpots, rbnDay: data.rbnDay }).toEqual(stored);
      const { rbnDays } = await import("./beacons");
      expect(rbnDays.get).not.toHaveBeenCalled();
    });

    // Value: protects=each beacon report stores NCDXF's official status for that beacon from the server's own cached copy ("OFF" or "OK"), and nothing when the server has no copy yet; fails_when=the status isn't stored, is taken for the wrong beacon, or a missing copy is stored as "OK"; why_new=issue #69 v1 (store each beacon report's official status); seam=getBeaconStatus mocked, in-memory db; no_claim=that NCDXF's list is current
    it.each([
      ["OFF", { stampedAt: null, beacons: [{ call: "4U1UN", off: true, note: null }, { call: "VE8AT", off: false, note: null }] }],
      ["OK", { stampedAt: null, beacons: [{ call: "4U1UN", off: false, note: null }, { call: "VE8AT", off: true, note: null }] }],
      [undefined, null],
    ])("stores the beacon's official status (%s)", async (stored, status) => {
      cache.beaconStatus = status as IbpStatus | null;
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit(beacon)).resolves.toEqual({ accepted: true });
      const { data } = receptionReport.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data.beaconStatus).toBe(stored);
    });

    // Value: protects=the EiBi question markers are never stored on a beacon answer, even when a page sends them; fails_when=a beacon row gets askRule/askRegion and #61 counts it among station questions; why_new=#115 review D1; seam=in-memory db; no_claim=none
    it("stores no question rule or region for a beacon", async () => {
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit({ ...beacon, askRule: 1, askRegion: "na" })).resolves.toEqual({ accepted: true });
      const { data } = receptionReport.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty("askRule");
      expect(data).not.toHaveProperty("askRegion");
    });

    // Value: protects=a beacon report is kept when the schedule had that beacon on that band in the slot it names, judged by the server's clock (not EiBi), and the slot is stored with it; fails_when=the slot isn't checked or stored, or beacon reports go through the EiBi check; why_new=tightened beacon check (owner: the 5-minute window passed any beacon); seam=getSchedule mocked empty, in-memory db; no_claim=that the listener heard it
    it("accepts the right beacon in the right slot, and stores the slot", async () => {
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit(beacon)).resolves.toEqual({ accepted: true });
      expect(receptionReport.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ txKind: "beacon", txName: "4U1UN", slotStartMs: BigInt(SLOT) }),
      });
    });

    // Value: protects=a real beacon on a real beacon frequency is declined when the named slot belonged to another beacon; fails_when=the check only asks whether the beacon was on the band at some point (any beacon passes a 5-minute window); why_new=tightened beacon check; seam=none; no_claim=none
    it("declines the right beacon in the wrong slot", async () => {
      await declined({ ...beacon, slotStartMs: SLOT + 10_000 });
      // Nor on another band in its own slot, nor a made-up callsign, nor off a beacon frequency.
      await declined({ ...beacon, freqKhz: 18_110 });
      await declined({ ...beacon, txName: "N0CALL" });
      await declined({ ...beacon, freqKhz: 14_000 });
    });

    // Value: protects=a slot must start on the 10 s grid; fails_when=an off-grid time is floored into a slot and accepted; why_new=tightened beacon check; seam=none; no_claim=none
    it("declines a slot that isn't on a ten-second boundary", async () => {
      await declined({ ...beacon, slotStartMs: SLOT + 1 });
      await declined({ ...beacon, slotStartMs: SLOT + 5_000 });
    });

    // Value: protects=only a slot in the last 5 minutes counts (exactly 5 minutes still does), and none from the future beyond a few seconds of clock difference; fails_when=the window is open-ended or off by its edge, or future slots pass; why_new=tightened beacon check; seam=fake clock at noon; no_claim=none
    it("declines a slot older than 5 minutes, or from the future", async () => {
      // 4U1UN had 14.100 at 11:54:00 too, a cycle earlier.
      await declined({ ...beacon, slotStartMs: SLOT - 180_000 });
      // 11:55:00, exactly 5 minutes ago, was JA2IGY's slot on 14.100.
      await accepted({ ...beacon, txName: "JA2IGY", slotStartMs: NOON - 5 * 60_000 });
      // 4U1UN on 14.100 at noon itself (now) is fine; the next cycle isn't.
      await accepted({ ...beacon, slotStartMs: NOON });
      await declined({ ...beacon, slotStartMs: NOON + 180_000 });
    });

    // Value: protects=on one receiver and band each beacon is its own channel for the 30-minute limit (4U1UN then YV5B both kept), the same beacon twice isn't (until 30 minutes pass); EiBi's per-frequency limit is the earlier test; fails_when=beacon answers about different callsigns are dropped as one channel, or the same one is kept twice; why_new=owner: beacon answers dropped after thanks; seam=in-memory db + fake clock; no_claim=the page's own matching rule (hook tests)
    it("limits beacon reports per callsign on one receiver and band", async () => {
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit(beacon)).resolves.toEqual({ accepted: true });
      // YV5B had 14.100 at 11:59:50.
      const yv5b = { ...beacon, txName: "YV5B", slotStartMs: NOON - 10_000 };
      await expect(caller.reports.submit(yv5b)).resolves.toEqual({ accepted: true });
      await expect(caller.reports.submit(beacon)).resolves.toEqual({ accepted: false });
      expect(receptionReport.create).toHaveBeenCalledTimes(2);
      // 30 minutes on, 4U1UN again (its 12:27:00 turn on 14.100) is a new report.
      vi.advanceTimersByTime(SAME_CHANNEL_MS + 1);
      const later = { ...beacon, slotStartMs: NOON + 27 * 60_000 };
      await expect(caller.reports.submit(later)).resolves.toEqual({ accepted: true });
    });

    // Value: protects=a beacon report without a slot is declined, and an EiBi report neither needs nor stores one; fails_when=the slot is optional for beacons, or EiBi rows get a slot; why_new=tightened beacon check (column is beacons only); seam=in-memory db; no_claim=none
    it("needs a slot for a beacon, and keeps none for an EiBi listing", async () => {
      await declined({ ...beacon, slotStartMs: undefined });
      await declined({ ...valid, freqKhz: 14_100, txName: "4U1UN" });
      cache.broadcasts = [on(9_580, "KBS World Radio")];
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit({ ...valid, slotStartMs: SLOT })).resolves.toEqual({ accepted: true });
      expect(receptionReport.create.mock.calls[0]![0].data).not.toHaveProperty("slotStartMs");
    });
  });

  // Value: protects=the checks read the server's cached schedule and list, one call each, never a fetch of their own; fails_when=submit builds its own source or fetches EiBi/the mirror per request; why_new=PR #63 review (no fetch per request); seam=sources mocked, fetch stubbed; no_claim=the sources' own caching (stations/receivers tests)
  it("uses the cached schedule and list without fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(getSchedule).mockClear();
    vi.mocked(getReceivers).mockClear();
    await accepted(valid);
    expect(getSchedule).toHaveBeenCalledTimes(1);
    expect(getReceivers).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Value: protects=a station answer stores the question's rule and region as sent, a malformed one is dropped (logged) while the answer is kept, a region never stands without a rule, and an answer from an older page stores neither; fails_when=a bad marker rejects the answer, a forged value is stored, or old pages get a default rule; why_new=#115 review D1/D2 (askRule, askRegion); seam=in-memory db; no_claim=Postgres column types (prisma-migrations.test checks the columns exist)
  it.each<[string, Record<string, unknown>, Record<string, unknown>, boolean]>([
    ["rule and region", { askRule: ASK_RULE_VERSION, askRegion: "na" }, { askRule: ASK_RULE_VERSION, askRegion: "na" }, false],
    ["a rule with no region", { askRule: 1 }, { askRule: 1, askRegion: undefined }, false], // pregate-literal: ASK_RULE_VERSION=1 answers from pages before #148 still carry rule 1 and stay valid
    ["an older page", {}, { askRule: undefined, askRegion: undefined }, false],
    ["rule 0", { askRule: 0, askRegion: "na" }, { askRule: undefined, askRegion: undefined }, true],
    ["a rule past the current one", { askRule: ASK_RULE_VERSION + 1 }, { askRule: undefined }, true], // pregate-literal: ASK_RULE_VERSION=1 the "+ 1" is an offset past the current rule, not the old value
    ["a fractional rule", { askRule: 1.5 }, { askRule: undefined }, true],
    ["an unknown region", { askRule: ASK_RULE_VERSION, askRegion: "xx" }, { askRule: ASK_RULE_VERSION, askRegion: undefined }, true],
    ["a region that isn't text", { askRule: ASK_RULE_VERSION, askRegion: 7 }, { askRule: ASK_RULE_VERSION, askRegion: undefined }, true],
    // superjson can deliver a BigInt; logging it must not fail the report.
    ["a BigInt rule", { askRule: BigInt(1) }, { askRule: undefined }, true],
  ])("stores the question's rule and region: %s", async (_, sent, stored, warned) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submit({ ...valid, ...sent } as ReportInput)).resolves.toEqual({ accepted: true });
    const { data } = receptionReport.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect({ askRule: data.askRule, askRegion: data.askRegion }).toMatchObject(stored);
    for (const [k, v] of Object.entries(stored)) if (v === undefined) expect(data).not.toHaveProperty(k);
    expect(warn.mock.calls.some(([m]) => String(m).startsWith("reports.submit: dropped malformed ask"))).toBe(warned);
    warn.mockRestore();
  });
});

describe("reports.submit with Pick best's context (#61)", () => {
  const NOON = Date.UTC(2026, 10, 18, 12); // pregate-literal: PICK_CONTEXT_VERSION=10 the month (November), not the version
  beforeEach(() => vi.useFakeTimers({ now: NOON }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Picked a minute ago from a list where the answered receiver came first.
  const pick = {
    version: PICK_CONTEXT_VERSION,
    pickedAtMs: NOON - 60_000,
    pickSource: "listen" as const,
    rankPos: 0,
    candidates: ["kiwi.example.org:8073", "other.example:8073"],
    freqKhz: 9_580,
    lat: 44.5,
    lon: -72.6,
    snr: 20,
    users: 1,
  };
  const stored = {
    pickedAtMs: BigInt(NOON - 60_000),
    pickSource: "listen",
    rankPos: 0,
    candidates: ["kiwi.example.org:8073", "other.example:8073"],
    candidatesListed: 2,
    pickLat: 44.5,
    pickLon: -72.6,
    pickSnr: 20,
    pickUsers: 1,
    pickVersion: PICK_CONTEXT_VERSION,
  };
  const pickColumns = Object.keys(stored);
  const submit = async (input: ReportInput) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submit(input)).resolves.toEqual({ accepted: true });
    const data = receptionReport.create.mock.lastCall![0].data as Record<string, unknown>;
    return { data, warn };
  };

  // Value: protects=a report with context fitting it stores every pick column; fails_when=a column is dropped, renamed or mis-converted (pickedAtMs as BigInt); why_new=new columns (D5); seam=in-memory db; no_claim=Postgres JSONB behaviour
  it("stores context that fits the report", async () => {
    const { data, warn } = await submit({ ...valid, pick });
    expect(data).toMatchObject(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=a pick started from station search's Pick best button, a GhostNet row's Listen, a row of the on-now list (browse), or a signal station's Listen is stored with its own source, so #61 can tell those runs apart; fails_when="search", "ghostnet", "browse" or "signal" is missing from the sources the server takes (the answer loses its context) or is stored as another source; why_new=station search design 6bA, GhostNet owner D3/D11, then #109/#110 eng D9, then #99/#100; seam=in-memory db; no_claim=Postgres
  it.each(["search", "ghostnet", "browse", "signal"] as const)("stores context from a %s pick", async (pickSource) => {
    const { data, warn } = await submit({ ...valid, pick: { ...pick, pickSource } });
    expect(data).toMatchObject({ ...stored, pickSource });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=context naming candidates the public list doesn't have (a forged key like localhost:22, or a real receiver that left the list since the pick) is kept, with the count of listed candidates stored so the replay can tell; fails_when=the count isn't stored, counts every candidate, or unlisted candidates drop real context; why_new=P4 TODO (owner: store a listed count); seam=getReceivers mocked, in-memory db; no_claim=the mirror's contents
  it("stores how many candidates are on the list, keeping context with unlisted ones", async () => {
    const candidates = ["kiwi.example.org:8073", "localhost:22", "gone.example:8073"];
    const { data, warn } = await submit({ ...valid, pick: { ...pick, candidates } });
    expect(data).toMatchObject({ ...stored, candidates, candidatesListed: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=an answer from a page without context (a tab open before the deploy, a hand pick) saves exactly as before with no pick columns; fails_when=context becomes required or empty columns are written; why_new=deploy-order safety (D6); seam=in-memory db; no_claim=none beyond protects
  it("stores a report without context as before", async () => {
    const { data } = await submit(valid);
    for (const k of pickColumns) expect(data).not.toHaveProperty(k);
  });

  // Value: protects=context the server can't vouch for is dropped and logged but the answer is kept, for each bound D6 lists; fails_when=a bound is missing, inverted, or rejects the whole report; why_new=D6 contract; seam=console.warn spied, fake clock; no_claim=that the page sends true values
  it.each([
    ["malformed: too many candidates", { candidates: Array.from({ length: 11 }, (_, i) => `r${i}.example:8073`) }],
    ["malformed: an unknown source", { pickSource: "map" }],
    ["malformed: a latitude past the pole", { lat: 91 }],
    ["malformed: a longitude past the antimeridian", { lon: 181 }],
    ["malformed: more users than any receiver has", { users: 1_001 }],
    ["malformed: a negative rank", { rankPos: -1 }],
    ["malformed: a rank no list can reach", { rankPos: 3_000 }],
    ["malformed: a candidate that isn't host:port", { candidates: ["kiwi.example.org:8073", "<b>not a key</b>"] }],
    ["malformed: a candidate listed twice", { candidates: ["kiwi.example.org:8073", "kiwi.example.org:8073"] }],
    ["malformed: a candidate on port 0", { candidates: ["kiwi.example.org:8073", "other.example:0"] }],
    ["malformed: a candidate past the last port", { candidates: ["kiwi.example.org:8073", "other.example:99999"] }],
    ["malformed: a version this server doesn't know", { version: PICK_CONTEXT_VERSION + 1 }],
    ["malformed: a version before the first numbered rules", { version: 1 }],
    ["malformed: version 0", { version: 0 }],
    ["malformed: a candidate with a padded port", { candidates: ["kiwi.example.org:8073", "other.example:08073"] }],
    ["malformed: a candidate with a trailing dot", { candidates: ["kiwi.example.org:8073", "other.example.:8073"] }],
    ["malformed: a candidate in capitals", { candidates: ["kiwi.example.org:8073", "Other.Example:8073"] }],
    ["malformed: an IPv6 candidate written out in full", { candidates: ["kiwi.example.org:8073", "2001:0db8::1:8073"] }],
    ["malformed: a candidate that only looks like IPv6", { candidates: ["kiwi.example.org:8073", "::::::8073"] }],
    ["malformed: a candidate with no port", { candidates: ["kiwi.example.org:8073", "other.example"] }],
    // Value: protects=an IPv4 candidate a URL rewrites (leading zero, read as octal) isn't canonical and drops the context; fails_when=candidateKeyOk skips the URL round trip for non-IPv6 hosts; why_new=the other rows reject non-IPv6 keys by regex alone; seam=none; no_claim=none beyond protects
    ["malformed: an IPv4 candidate with a leading zero", { candidates: ["kiwi.example.org:8073", "010.0.0.1:8073"] }],
    ["malformed: a latitude without a longitude", { lon: undefined }],
    [
      "a rank past the head for a receiver the head names",
      {
        rankPos: 12,
        candidates: ["kiwi.example.org:8073", ...Array.from({ length: 9 }, (_, i) => `r${i}.example:8073`)],
      },
    ],
    ["malformed: an implausible SNR", { snr: 99 }],
    ["ranked for another frequency", { freqKhz: 9_590 }],
    ["picked in the future", { pickedAtMs: NOON + 10_000 }],
    ["picked over three hours ago", { pickedAtMs: NOON - 3 * 3_600_000 - 1 }],
    ["naming another receiver at its rank", { rankPos: 1 }],
    ["a rank past a short list", { rankPos: 5 }],
    ["from beacon Listen, about a broadcast", { pickSource: "beacon" }],
  ])("drops context %s, keeps the answer, and logs it", async (_, override) => {
    const { data, warn } = await submit({ ...valid, pick: { ...pick, ...override } } as ReportInput);
    for (const k of pickColumns) expect(data).not.toHaveProperty(k);
    expect(data).toMatchObject({ outcome: "heard", txName: "KBS World Radio" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Value: protects=a receiver Pick best reached past the stored top 10 keeps its rank (owner answer: store rank, top 10 anyway); fails_when=such context is dropped or rankPos is capped; why_new=rank past 10 rule; seam=none; no_claim=none beyond protects
  it("keeps a rank past the stored top 10 when the list was that long", async () => { // pregate-literal: PICK_CONTEXT_VERSION=10 the stored top ten, not the version
    const candidates = Array.from({ length: 10 }, (_, i) => `r${i}.example:8073`); // pregate-literal: PICK_CONTEXT_VERSION=10 ten candidates, not the version
    const { data, warn } = await submit({ ...valid, pick: { ...pick, rankPos: 12, candidates } });
    expect(data).toMatchObject({ rankPos: 12, candidates });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=context from a receiver with no SNR on the list is kept, its SNR stored as null; fails_when=the schema stops accepting null snr, or null is dropped/coerced on write; why_new=nullable snr was untested; seam=in-memory db; no_claim=Postgres NULL handling
  it("keeps context whose receiver had no SNR, storing it as null", async () => {
    const { data, warn } = await submit({ ...valid, pick: { ...pick, snr: null } });
    expect(data).toMatchObject({ ...stored, pickSnr: null });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=context from a tab loaded before versions existed (PR #73's rules) is still stored but with no pickVersion, so the replay can tell it from fixed context; fails_when=version becomes required (old tabs lose context) or a default version is written; why_new=pickVersion (owner: version on each answer); seam=in-memory db; no_claim=Postgres NULL handling
  it("keeps context from a page before versions, with no version", async () => {
    const { version: _, ...old } = pick;
    const { data, warn } = await submit({ ...valid, pick: old });
    const { pickVersion: __, ...rest } = stored;
    expect(data).toMatchObject(rest);
    expect(data.pickVersion).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=a tab opened before the round 2, clock, round 3, scheduled clock, station search, GhostNet, on-now browse, signal stations or held-last deploy still sends version 2 to 10; its context is kept and stored as sent, so the replay can tell it from version 11; fails_when=the server accepts only the current version (old tabs lose context) or rewrites the version it stores; why_new=round 2 raised PICK_CONTEXT_VERSION to 3, the monotonic clock to 4, round 3 to 5, the scheduled clock to 6, station search's "search" source to 7, GhostNet's "ghostnet" source to 8, on-now browse's "browse" source to 9, signal stations' "signal" source to 10, held-last ordering (#155) to 11; seam=in-memory db; no_claim=Postgres
  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10])("keeps context from a tab on earlier version %i, storing that version", async (version) => { // pregate-literal: PICK_CONTEXT_VERSION=10 an earlier version on purpose
    expect(PICK_CONTEXT_VERSION).toBe(11);
    const { data, warn } = await submit({ ...valid, pick: { ...pick, version } });
    expect(data).toMatchObject({ ...stored, pickVersion: version });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=the longest key the page can write (a 253-character hostname and port 65535) still passes the length check that runs before any parsing, and a far longer forged key doesn't; fails_when=MAX_CANDIDATE_KEY is set too low and drops real long-hostname receivers; why_new=round 2 review (length cap); seam=none; no_claim=the CPU saved on forged keys
  it("takes candidate keys up to the longest a receiver can have", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(host).toHaveLength(253);
    expect(candidateKeyOk(`${host}:65535`)).toBe(true);
    expect(candidateKeyOk(`${"1:".repeat(5_000)}:8073`)).toBe(false);
  });

  // Value: protects=candidate ports at both ends of the range are real receiver ports and keep the context; fails_when=the port check is off by one at 1 or 65535; why_new=round-2 edge cases (canonical keys); seam=none; no_claim=none beyond protects
  it("keeps context whose candidates use ports 1 and 65535", async () => {
    const candidates = ["kiwi.example.org:8073", "low.example:1", "high.example:65535"];
    const { data, warn } = await submit({ ...valid, pick: { ...pick, candidates } });
    expect(data).toMatchObject({ candidates });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=a ranked list holding an IPv6 receiver (keyed bare, as parseReceiver gives it) keeps its context; fails_when=the candidate check refuses colons in the host again; why_new=edge-case fixes (IPv6 keys); seam=none; no_claim=that IPv6 receivers appear on the list
  it("keeps context whose list holds an IPv6 receiver", async () => {
    const candidates = ["kiwi.example.org:8073", "2001:db8::1:8073"];
    const { data, warn } = await submit({ ...valid, pick: { ...pick, candidates } });
    expect(data).toMatchObject({ candidates });
    expect(warn).not.toHaveBeenCalled();
  });

  // Value: protects=the beacon slot bound applies only to beacon answers: a broadcast answer that also carries a slot keeps context picked long after it; fails_when=pickChecks reads slotStartMs for non-beacon reports; why_new=#73 proposed test 5; seam=fake clock; no_claim=none beyond protects
  it("doesn't hold a broadcast answer's context to a slot it carries", async () => {
    const { data, warn } = await submit({ ...valid, slotStartMs: NOON - 180_000, pick });
    expect(data).toMatchObject(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  describe("about a beacon", () => {
    const SLOT = NOON - 180_000;
    const beacon = {
      ...valid,
      freqKhz: 14_100,
      mode: "cw" as const,
      txKind: "beacon" as const,
      txName: "4U1UN",
      txDetail: "14100",
      slotStartMs: SLOT,
    };
    beforeEach(() => {
      cache.broadcasts = [];
    });

    // Value: protects=a beacon's context counts only if beacon Listen chose before the slot asked about could still be heard (slot + 1.5 s: 7 s heard after audio + 1.5 s latency), including a Listen early in the beacon's own turn, so the replay keeps those picks and never credits a later one; fails_when=the bound is the slot start (drops early-turn picks), ignores the stream latency, or is off by one; why_new=final-round review, tightened in the edge-case fixes; seam=fake clock; no_claim=the page's own clock offset
    it("keeps context picked before the asked slot could be heard, drops it from slot + 1.5 s", async () => {
      const at = (pickedAtMs: number) => ({ ...pick, pickSource: "beacon" as const, freqKhz: 14_100, pickedAtMs });
      expect(PICK_IN_SLOT_MS).toBe(1_500);
      const before = await submit({ ...beacon, pick: at(SLOT - 8_500) });
      expect(before.data).toMatchObject({ pickedAtMs: BigInt(SLOT - 8_500), slotStartMs: BigInt(SLOT) });
      // Listen pressed 1 s into the beacon's turn, and that turn is the one asked about.
      const early = await submit({ ...beacon, pick: at(SLOT + 1_000) });
      expect(early.data).toMatchObject({ pickedAtMs: BigInt(SLOT + 1_000) });
      const last = await submit({ ...beacon, pick: at(SLOT + PICK_IN_SLOT_MS - 1) });
      expect(last.data).toMatchObject({ pickedAtMs: BigInt(SLOT + PICK_IN_SLOT_MS - 1) });
      const late = await submit({ ...beacon, pick: at(SLOT + PICK_IN_SLOT_MS) });
      expect(late.data).not.toHaveProperty("pickedAtMs");
      expect(late.data).toMatchObject({ slotStartMs: BigInt(SLOT) });
    });

    // Value: protects=a beacon answer keeps only beacon Listen's context, since only beacon Listen leads to a beacon question; fails_when=pickChecks stops comparing the source with the report kind; why_new=edge-case fixes (source vs kind); seam=console.warn spied; no_claim=none beyond protects
    it("drops a beacon answer's context from any other button, keeping the answer", async () => {
      const { data, warn } = await submit({ ...beacon, pick: { ...pick, pickSource: "drawer", freqKhz: 14_100, pickedAtMs: SLOT - 8_500 } });
      expect(data).not.toHaveProperty("pickedAtMs");
      expect(data).toMatchObject({ txKind: "beacon", slotStartMs: BigInt(SLOT) });
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("transmitter sites on an EiBi answer (#72)", () => {
  const NOW = Date.UTC(2026, 10, 18, 12); // pregate-literal: PICK_CONTEXT_VERSION=10 the month (November), not the version
  const sites: SiteTable = new Map([
    ["KOR-k", { country: "KOR", coords: [[37.5, 127]] }],
    ["KOR-h", { country: "KOR", coords: [[35.1, 129]] }],
    ["USA-uc", { country: "USA", coords: [[38.3, -123.1], [37.8, -122.5]] }],
    ["KOR-xx", { country: "KOR", coords: [] }],
  ]);
  const usa = (b: ListedBroadcast): ListedBroadcast => ({ ...b, country: "USA" });

  // Value: protects=an answer keeps every site its station was listed on at the latest on-air minute, each with every coordinate EiBi gives (a group stays a group), sorted by key; fails_when=sites are deduped to one, coordinates averaged, or only the first listing is read; why_new=#72 D8 (txSites keeps all candidates); seam=none; no_claim=which site the listener heard
  it("keeps every site and every coordinate", () => {
    const schedule = [
      on(9_580, "KBS World Radio", "0000", "2400", "KOR-k"),
      on(9_580, "KBS World Radio", "0000", "2400", "KOR-h"),
      usa(on(9_580, "Radio Group", "0000", "2400", "USA-uc")),
    ];
    expect(sitesHeard(schedule, sites, "KBS World Radio", 9_580, NOW)).toEqual([
      { key: "KOR-h", coords: [[35.1, 129]] },
      { key: "KOR-k", coords: [[37.5, 127]] },
    ]);
    expect(sitesHeard(schedule, sites, "Radio Group", 9_580, NOW)).toEqual([
      { key: "USA-uc", coords: [[38.3, -123.1], [37.8, -122.5]] },
    ]);
  });

  // Value: protects=sites come from the latest minute each station was on the air, so an answer just after a :00/:30 changeover doesn't carry the outgoing slot's site; fails_when=sites are collected over the whole grace window; why_new=#72 D10; seam=none; no_claim=a prompt left open across a site change
  it("takes the latest on-air minute, not the whole grace window", () => {
    const schedule = [
      on(9_580, "KBS World Radio", "1100", "1158", "KOR-k"),
      on(9_580, "KBS World Radio", "1158", "1300", "KOR-h"),
    ];
    expect(sitesHeard(schedule, sites, "KBS World Radio", 9_580, NOW).map((c) => c.key)).toEqual(["KOR-h"]);
    // Gone off the air 3 minutes ago: its last minute still counts.
    const ended = [on(9_580, "KBS World Radio", "1100", "1157", "KOR-k")];
    expect(sitesHeard(ended, sites, "KBS World Radio", 9_580, NOW).map((c) => c.key)).toEqual(["KOR-k"]);
  });

  // Value: protects=an answer about two stations pools both stations' sites, listings within MATCH_KHZ count, and other stations on the channel don't; fails_when=only the first station is read, the half-kHz window is dropped, or a co-channel station's site is added; why_new=#72 review N3; seam=none; no_claim=none beyond protects
  it("pools the stations asked about, within half a kHz", () => {
    const schedule = [
      on(9_580, "KBS World Radio", "0000", "2400", "KOR-k"),
      on(9_580.4, "Other", "0000", "2400", "KOR-h"),
      usa(on(9_580, "Not asked", "0000", "2400", "USA-uc")),
    ];
    expect(sitesHeard(schedule, sites, "KBS World Radio / Other", 9_580, NOW).map((c) => c.key)).toEqual([
      "KOR-h",
      "KOR-k",
    ]);
  });

  // Value: protects=EiBi not saying which site (blank Remarks, no default) is an explicit entry with the country, a code the table lacks or gives no coordinates for keeps its key with none, so null txSites only ever means our lookup failed; fails_when=unknown sites save nothing or null; why_new=#72 D12; seam=none; no_claim=none beyond protects
  it("records sites EiBi doesn't place", () => {
    const schedule = [
      on(9_580, "Sound of Hope", "0000", "2400", "KOR"),
      on(9_580, "Sound of Hope", "0000", "2400", "KOR-zz"),
      on(9_580, "Sound of Hope", "0000", "2400", "KOR-xx"),
      on(9_580, "Sound of Hope"),
    ];
    expect(sitesHeard(schedule, sites, "Sound of Hope", 9_580, NOW)).toEqual([
      { key: null, country: "KOR", coords: [] },
      { key: "KOR-xx", coords: [] },
      { key: "KOR-zz", coords: [] },
    ]);
  });

  describe("on submit", () => {
    beforeEach(() => vi.useFakeTimers({ now: NOW }));
    afterEach(() => vi.useRealTimers());

    // Value: protects=reports.submit saves the server's own site lookup with an EiBi answer, and none with a beacon; fails_when=txSites isn't stored, comes from the page, or lands on beacon rows; why_new=#72 D1; seam=getSchedule/getSites mocked, in-memory db; no_claim=Postgres JSON round trip
    it("saves the sites with the answer", async () => {
      cache.broadcasts = [on(9_580, "KBS World Radio", "0000", "2400", "KOR-k")];
      cache.sites = sites;
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit(valid)).resolves.toEqual({ accepted: true });
      expect((receptionReport.create.mock.calls[0]![0].data as Record<string, unknown>).txSites).toEqual([{ key: "KOR-k", coords: [[37.5, 127]] }]);
      // A beacon answer (4U1UN's 14.100 slot that opened at 11:57) carries no txSites, not even an empty list.
      const beacon = setup();
      await expect(
        beacon.caller.reports.submit({
          ...valid,
          freqKhz: 14_100,
          mode: "cw",
          txKind: "beacon",
          txName: "4U1UN",
          txDetail: "14100",
          slotStartMs: NOW - 180_000,
        }),
      ).resolves.toEqual({ accepted: true });
      expect(beacon.receptionReport.create.mock.calls[0]![0].data).not.toHaveProperty("txSites");
    });

    // Value: protects=a site lookup that throws costs only the sites: the answer is saved without txSites and the failure is logged; fails_when=the error rejects the answer or is swallowed silently; why_new=#72 D1/D12; seam=getSites mocked to throw; no_claim=none beyond protects
    it("keeps the answer when the lookup fails", async () => {
      cache.broadcasts = [on(9_580, "KBS World Radio", "0000", "2400", "KOR-k")];
      vi.mocked(getSites).mockImplementationOnce(() => {
        throw new Error("broken table");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { caller, receptionReport } = setup();
      await expect(caller.reports.submit(valid)).resolves.toEqual({ accepted: true });
      expect(receptionReport.create.mock.calls[0]![0].data).not.toHaveProperty("txSites");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("transmitter sites"), expect.any(Error));
    });
  });
});

describe("a signal-station report (#101)", () => {
  const NOON = Date.UTC(2026, 10, 18, 12); // pregate-literal: PICK_CONTEXT_VERSION=10 the month (November), not the version
  beforeEach(() => {
    vi.useFakeTimers({ now: NOON });
    cache.broadcasts = [];
    cache.priyom = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const wwv = {
    ...valid,
    freqKhz: 10_000,
    txKind: "signal" as const,
    txName: "wwv",
    txDetail: "10000",
  };
  // E11 on Priyom's schedule: a transmission that started 3 minutes ago on 20,167 kHz.
  const SLOT = NOON - 3 * 60_000;
  const e11Tx: PriyomTx = { station: "E11", startMs: SLOT, khz: 20_167, mode: "usb", summary: "E11 20167kHz USB" };
  const e11 = { ...valid, freqKhz: 20_167, mode: "usb" as const, txKind: "signal" as const, txName: "e11", txDetail: "20167", slotStartMs: SLOT };

  const submit = async (input: ReportInput) => {
    const { caller, receptionReport } = setup();
    const result = await caller.reports.submit(input);
    return { result, data: receptionReport.create.mock.lastCall?.[0].data as Record<string, unknown> | undefined };
  };

  // Value: protects=a report about a station that's always on, on one of its catalog channels, is kept with its kind, slug and channel, and no slot (only Priyom's stations have one); fails_when=signal reports go through the EiBi check (and are all declined), or a stray slot is stored; why_new=issue #101; seam=in-memory db; no_claim=that the listener heard it
  it("keeps a report about an always-on station on its channel, with no slot", async () => {
    const { result, data } = await submit({ ...wwv, slotStartMs: NOON });
    expect(result).toEqual({ accepted: true });
    expect(data).toMatchObject({ txKind: "signal", txName: "wwv", txDetail: "10000", freqKhz: 10_000 });
    expect(data).not.toHaveProperty("slotStartMs");
  });

  // Value: protects=the server vouches for the station itself: an unknown slug, a frequency that isn't the station's, and a defunct station are all refused; fails_when=any client-sent slug or frequency is stored, or CHU (off the air since 2023) can be reported heard; why_new=issue #101 acceptance (wrong frequency, unknown slug, defunct: refused); seam=catalog as shipped; no_claim=the catalog's accuracy
  it.each([
    ["an unknown slug", { ...wwv, txName: "uvb-77" }],
    ["a frequency that isn't the station's", { ...wwv, freqKhz: 9_580 }],
    ["a defunct station on its old channel", { ...wwv, txName: "chu", freqKhz: 7_850, mode: "usb" as const }],
  ])("declines %s", async (_, input) => {
    const { result, data } = await submit(input);
    expect(result).toEqual({ accepted: false });
    expect(data).toBeUndefined();
  });

  // Value: protects=a numbers station is checked against the exact Priyom transmission named (station, start and frequency) and stored with that slot; fails_when=any time or frequency passes, or the slot isn't kept for the replay; why_new=issue #101 under the beacon rule's exact-slot server check (owner 2026-11-25); seam=getPriyomSchedule mocked; no_claim=Priyom's accuracy
  it("keeps a numbers-station report naming Priyom's transmission, and stores the slot", async () => {
    cache.priyom = [e11Tx];
    const { result, data } = await submit(e11);
    expect(result).toEqual({ accepted: true });
    expect(data).toMatchObject({ txName: "e11", slotStartMs: BigInt(SLOT) });
  });

  // Value: protects=a numbers-station report is refused off its schedule: no slot, a slot Priyom doesn't list, another frequency, another station's transmission, one long over, one not started, or no schedule on the server; fails_when=the server takes a numbers-station answer it can't place in a real transmission; why_new=issue #101 acceptance (off-schedule time refused); seam=getPriyomSchedule mocked; no_claim=none
  it("declines a numbers-station report off Priyom's schedule", async () => {
    const no = async (input: ReportInput) => expect((await submit(input)).result).toEqual({ accepted: false });
    await no(e11);
    cache.priyom = [e11Tx];
    await no({ ...e11, slotStartMs: undefined });
    await no({ ...e11, slotStartMs: SLOT + 60_000 });
    await no({ ...e11, freqKhz: 20_168 });
    cache.priyom = [{ ...e11Tx, station: "S11a" }];
    await no(e11);
    // Off the air (PRIYOM_ON_AIR_MS after its start) more than 5 minutes ago; and starting in a minute.
    const long = NOON - PRIYOM_ON_AIR_MS - 5 * 60_000 - 1;
    cache.priyom = [{ ...e11Tx, startMs: long }];
    await no({ ...e11, slotStartMs: long });
    cache.priyom = [{ ...e11Tx, startMs: NOON + 60_000 }];
    await no({ ...e11, slotStartMs: NOON + 60_000 });
  });

  // Value: protects=the same-channel limit counts each signal station on a frequency as its own (WWV and WWVH share 10 MHz), while a second answer about one station there within 30 minutes is declined; fails_when=a WWVH answer is refused after a WWV one, or WWV is taken twice; why_new=issue #101; seam=in-memory db; no_claim=none
  it("counts WWV and WWVH on one frequency as two channels", async () => {
    const { caller } = setup();
    await expect(caller.reports.submit(wwv)).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submit({ ...wwv, txName: "wwvh" })).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submit(wwv)).resolves.toEqual({ accepted: false });
  });

  // Value: protects=a signal answer and an EiBi answer on the same receiver and frequency don't block each other (the page asks the EiBi question there once the pick ends), while a second EiBi answer within 30 minutes still is declined; fails_when=the EiBi count includes signal rows, so the listener is thanked for an answer the server drops; why_new=#101 review (important); seam=in-memory db, getSchedule mocked; no_claim=none
  it("keeps a signal answer from blocking an EiBi answer on that frequency, and back", async () => {
    cache.broadcasts = [{ khz: 10_000, start: 0, end: 1440, days: "", station: "WWV", lang: "E", target: "NAm", country: "USA" }];
    const eibi = { ...valid, freqKhz: 10_000, txName: "WWV" };
    const { caller } = setup();
    await expect(caller.reports.submit(wwv)).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submit(eibi)).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submit(eibi)).resolves.toEqual({ accepted: false });
    await expect(caller.reports.submit({ ...wwv, txName: "wwvh" })).resolves.toEqual({ accepted: true });
  });

  // Value: protects=a tab from before #148 asking EiBi's question about E11 (alone or sharing a frequency) has its answer refused even though EiBi lists E11 there, while a broadcaster's on the same frequency still lands (D9); fails_when=the refusal isn't wired into submit, so old tabs keep filing season-grid answers; why_new=D9; seam=in-memory db, getSchedule mocked; no_claim=the analysis CTE
  it("refuses an EiBi answer naming a Priyom station", async () => {
    cache.broadcasts = [
      { khz: 11_100, start: 0, end: 1440, days: "", station: "E11 Polish Spy Numbers", lang: "E", target: "", country: "POL" },
      { khz: 11_100, start: 0, end: 1440, days: "", station: "Sound of Hope", lang: "M", target: "CHN", country: "TWN" },
    ];
    const { caller } = setup();
    const at = { ...valid, freqKhz: 11_100 };
    await expect(caller.reports.submit({ ...at, txName: "E11 Polish Spy Numbers" })).resolves.toEqual({ accepted: false });
    await expect(caller.reports.submit({ ...at, txName: "Sound of Hope / E11 Polish Spy Numbers" })).resolves.toEqual({ accepted: false });
    await expect(caller.reports.submit({ ...at, txName: "Sound of Hope" })).resolves.toEqual({ accepted: true });
  });

  // Value: protects=a signal row's txDetail is the channel the server checked, whatever text the page sends; fails_when=a script stores any text there, contradicting the schema's "channel in kHz"; why_new=#101 review (nit); seam=in-memory db; no_claim=none
  it("stores the checked channel as the detail, not the page's text", async () => {
    const { data } = await submit({ ...wwv, txDetail: "anything" });
    expect(data).toMatchObject({ txDetail: "10000" });
  });

  // Value: protects=a signal answer keeps Pick best's context from any run except a beacon's (#148 D15: since D3 a search, link or Listen run can lead to a signal question too), and a beacon pick is still dropped from it; fails_when=search/browse picks on signal stations vanish from #61, or a beacon pick is stored on a signal row; why_new=D15 replaced #101's signal-only rule; seam=in-memory db; no_claim=none
  it("keeps pick context from any non-beacon run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pick = {
      version: PICK_CONTEXT_VERSION,
      pickedAtMs: NOON - 90_000,
      rankPos: 0,
      candidates: ["kiwi.example.org:8073"],
      freqKhz: 10_000,
      snr: 20,
      users: 1,
    };
    const signal = await submit({ ...wwv, pick: { ...pick, pickSource: "signal" } });
    expect(signal.data).toMatchObject({ pickSource: "signal" });
    const search = await submit({ ...wwv, pick: { ...pick, pickSource: "search" } });
    expect(search.data).toMatchObject({ pickSource: "search" });
    const beacon = await submit({ ...wwv, pick: { ...pick, pickSource: "beacon" } });
    expect(beacon.result).toEqual({ accepted: true });
    expect(beacon.data).not.toHaveProperty("pickSource");
  });

  // Value: protects=a day/night station is taken on either of its channels (its switch times are only the sun's guess), and an always-on one on any of its catalog channels; fails_when=a correct report is refused around dawn or dusk; why_new=issue #101; seam=catalog as shipped; no_claim=when The Pip really switches
  it("takes a day/night station on either channel", () => {
    expect(signalChecks("the-pip", 5_448, undefined, null, NOON)).toBe(true);
    expect(signalChecks("the-pip", 3_756, undefined, null, NOON)).toBe(true);
    expect(signalChecks("the-pip", 4_625, undefined, null, NOON)).toBe(false);
    expect(signalChecks("wwv", 20_000, undefined, null, NOON)).toBe(true);
  });

  // Value: protects=the server takes a catalog station's answer within MATCH_KHZ of its frequency, as the page asks it (#148 D10 for every catalog station): The Squeaky Wheel at 3364, UVB-76 at 4625.3, E11 0.4 kHz off its Priyom slot; nothing past 0.5; fails_when=the server refuses answers the page asks for, or takes ones further off; why_new=D10; seam=catalog as shipped; no_claim=audio heard
  it("takes a catalog station within half a kHz", () => {
    expect(signalChecks("squeaky-wheel", 3_364, undefined, null, NOON)).toBe(true);
    expect(signalChecks("squeaky-wheel", 3_364.6, undefined, null, NOON)).toBe(false);
    expect(signalChecks("uvb-76", 4_625.3, undefined, null, NOON)).toBe(true);
    expect(signalChecks("wwv", 10_000.6, undefined, null, NOON)).toBe(false);
    expect(signalChecks("e11", 20_167.4, SLOT, [e11Tx], NOON)).toBe(true);
    expect(signalChecks("e11", 20_167.6, SLOT, [e11Tx], NOON)).toBe(false);
  });

  // Value: protects=an EiBi answer naming a station Priyom drives is refused (#148 D9), matched on each whole " / " part (a Priyom station as the second part of a joint name too), while broadcasters and catalog time stations' EiBi names still pass; fails_when=old tabs' season-grid answers land, or a substring match catches an unrelated name; why_new=D9; seam=catalog as shipped; no_claim=the analysis CTE (61-exclude-priyom-eibi.sql)
  it("knows which EiBi names are Priyom stations", () => {
    expect(namesPriyomStation("E11 Polish Spy Numbers")).toBe(true);
    expect(namesPriyomStation("Sound of Hope / E11 Polish Spy Numbers")).toBe(true);
    expect(namesPriyomStation("E11 Polish Spy Numbers Relay")).toBe(false);
    expect(namesPriyomStation("WWV Colorado (m.ann.) / WWVH Hawaii (f.ann.)")).toBe(false);
    expect(namesPriyomStation("BBC")).toBe(false);
  });

  // Value: protects=an answer about a numbers-station transmission that ended within the last LISTING_GRACE_MS is kept (the prompt may sit up to 4 minutes after asking); fails_when=the grace is dropped from the on-air bound, so the listener is thanked and the answer silently refused; why_new=only the refusal just past the grace was tested; seam=getPriyomSchedule mocked; no_claim=none
  it("keeps a numbers-station answer given within the grace after the transmission ended", async () => {
    const ended = NOON - PRIYOM_ON_AIR_MS - 4 * 60_000;
    cache.priyom = [{ ...e11Tx, startMs: ended }];
    const { result, data } = await submit({ ...e11, slotStartMs: ended });
    expect(result).toEqual({ accepted: true });
    expect(data).toMatchObject({ slotStartMs: BigInt(ended) });
  });

  // Value: protects=a signal answer's txDetail is the channel the server matched, not the dial the listener sat on (owner, #148 review): WWV answered on 10000.4 stores "10000", E11 answered 0.3 kHz off its Priyom slot stores the slot's 20167, while freqKhz keeps each dial; fails_when=txDetail stores the dial again, so #61 grouping by channel splits one channel into many; why_new=D10 widened the match to half a kHz; seam=getPriyomSchedule mocked, in-memory db; no_claim=which signal the listener heard
  it("stores the matched channel as txDetail and the dial as freqKhz", async () => {
    const off = await submit({ ...wwv, freqKhz: 10_000.4, txDetail: "10000.4" });
    expect(off.data).toMatchObject({ freqKhz: 10_000.4, txDetail: "10000" });
    cache.priyom = [e11Tx];
    const e11Off = await submit({ ...e11, freqKhz: 20_167.3, txDetail: "20167.3" });
    expect(e11Off.data).toMatchObject({ freqKhz: 20_167.3, txDetail: "20167", slotStartMs: BigInt(SLOT) });
  });

  // Value: protects=an answer about an F06 slot Priyom listed as F06a keeps that designator beside the checked channel in txDetail (owner, #148), and one listed under the station's own designator keeps the channel alone; fails_when=the designator is lost (a later F06/F06a split becomes guesswork) or leaks onto own-designator slots; why_new=F06a decision; seam=getPriyomSchedule mocked, in-memory db; no_claim=Priyom's meaning of F06a
  it("records the designator Priyom used when it isn't the station's own", async () => {
    const f06Tx: PriyomTx = { station: "F06", designator: "F06a", startMs: SLOT, khz: 17_529.875, mode: "usb", data: true, listedKhz: 17_532, summary: "F06a 17532kHz RTTY" };
    cache.priyom = [f06Tx];
    const f06 = { ...e11, freqKhz: 17_529.875, txName: "f06", txDetail: "17529.875" };
    expect((await submit(f06)).data).toMatchObject({ txDetail: "17529.875 F06a", slotStartMs: BigInt(SLOT) });
    cache.priyom = [e11Tx];
    expect((await submit(e11)).data).toMatchObject({ txDetail: "20167" });
  });

  // Value: protects=a signal Listen's pick made after the Priyom transmission began keeps its context, since only a beacon's slot bounds when the pick was made; fails_when=the Priyom slot is passed to pickChecks, PICK_IN_SLOT_MS drops every real numbers-station pick and #61 loses its signal rows; why_new=the other pick test uses WWV, which has no slot; seam=getPriyomSchedule mocked, in-memory db; no_claim=none
  it("keeps a signal pick made after the Priyom transmission began", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cache.priyom = [e11Tx];
    const pick = {
      version: PICK_CONTEXT_VERSION,
      pickedAtMs: SLOT + 60_000,
      pickSource: "signal" as const,
      rankPos: 0,
      candidates: ["kiwi.example.org:8073"],
      freqKhz: 20_167,
      snr: 20,
      users: 1,
    };
    const { result, data } = await submit({ ...e11, pick });
    expect(result).toEqual({ accepted: true });
    expect(data).toMatchObject({ pickSource: "signal", pickedAtMs: BigInt(SLOT + 60_000), slotStartMs: BigInt(SLOT) });
  });
});

describe("a shared-frequency report (#150)", () => {
  const NOON = Date.UTC(2026, 10, 18, 12);
  beforeEach(() => {
    vi.useFakeTimers({ now: NOON });
    cache.priyom = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const group: GroupReportInput = {
    listenerId: LISTENER,
    receiverHost: "Kiwi.Example.org",
    receiverPort: 8073,
    freqKhz: 10_000,
    mode: "am",
    stations: [{ slug: "wwv" }, { slug: "wwvh" }],
    answer: { heard: "wwv" },
  };
  const rowsOf = (createMany: ReturnType<typeof setup>["receptionReport"]["createMany"]) =>
    (createMany.mock.lastCall?.[0].data ?? []) as unknown as Record<string, unknown>[];

  // Value: protects=each choice files the rows #150 lists (heard one: that one heard and the other not_heard; both; nothing; didn't open), one signal row per station with its checked channel, the comment and the lowercased host, all sharing one askGroup that differs between answers; fails_when=the outcomes are swapped, a station is left out, rows don't share a group id, or two answers share one; why_new=#150 acceptance (mapping); seam=in-memory db; no_claim=Postgres behaviour
  it.each<[string, GroupReportInput["answer"], Record<string, string>]>([
    ["heard WWV", { heard: "wwv" }, { wwv: "heard", wwvh: "not_heard" }],
    ["heard WWVH", { heard: "wwvh" }, { wwv: "not_heard", wwvh: "heard" }],
    ["heard both", "all", { wwv: "heard", wwvh: "heard" }],
    ["heard nothing", "none", { wwv: "not_heard", wwvh: "not_heard" }],
    ["didn't open", "no_open", { wwv: "no_open", wwvh: "no_open" }],
  ])("files %s as one row per station sharing a group", async (_, answer, outcomes) => {
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submitGroup({ ...group, answer, comment: " S5 " })).resolves.toEqual({ accepted: true });
    const rows = rowsOf(receptionReport.createMany);
    expect(Object.fromEntries(rows.map((r) => [r.txName, r.outcome]))).toEqual(outcomes);
    expect(rows[0]!.askGroup).toEqual(expect.any(String));
    for (const r of rows)
      expect(r).toMatchObject({
        txKind: "signal",
        txDetail: "10000",
        receiverHost: "kiwi.example.org",
        comment: "S5",
        askGroup: rows[0]!.askGroup,
      });
    await caller.reports.submitGroup({ ...group, receiverPort: 8074 });
    expect(rowsOf(receptionReport.createMany)[0]!.askGroup).not.toBe(rows[0]!.askGroup);
  });

  // Value: protects=the server quietly refuses (accepted: false, not an error) a group it can't vouch for: an unknown slug, a duplicate slug, a single station, a station not on that frequency (WWVH isn't on 20 MHz), a heard answer naming a station not asked about, "can't tell" (nothing to file), and an unlisted receiver; nothing is stored; fails_when=any client-sent group is filed unchecked, one bad station still files the rest, or a shape no question makes throws instead of the quiet refusal every other path gives; why_new=#150 acceptance (server refusals), #150 review (quiet refusal); seam=catalog as shipped, in-memory db; no_claim=none
  it.each<[string, Partial<GroupReportInput>]>([
    ["an unknown slug", { stations: [{ slug: "wwv" }, { slug: "wwvx" }] }],
    ["a duplicate slug", { stations: [{ slug: "wwv" }, { slug: "wwv" }] }],
    ["a single station", { stations: [{ slug: "wwv" }] }],
    ["a station not on that frequency", { freqKhz: 20_000 }],
    ["a heard station not asked about", { answer: { heard: "chu" } }],
    ["can't tell", { answer: "unsure" }],
    ["an unlisted receiver", { receiverHost: "nowhere.example" }],
  ])("declines %s", async (_, change) => {
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submitGroup({ ...group, ...change })).resolves.toEqual({ accepted: false });
    expect(receptionReport.createMany).not.toHaveBeenCalled();
  });

  // Value: protects=a group counts as one answer against REPORTS_PER_HOUR (nine single answers and a group fill the hour; ten groups do too, not five), so the shared-frequency question doesn't cost two of a listener's ten; fails_when=the limits count rows, so a group costs two answers, or groups aren't counted at all; why_new=#150 acceptance (rate limit counts a group once); seam=in-memory db + fake clock; no_claim=concurrent submits racing the count
  it("counts a group as one answer against the hourly limit", async () => {
    const singles = setup();
    for (let i = 0; i < REPORTS_PER_HOUR - 1; i++)
      await expect(singles.caller.reports.submit({ ...valid, freqKhz: 6_000 + i })).resolves.toEqual({ accepted: true });
    await expect(singles.caller.reports.submitGroup(group)).resolves.toEqual({ accepted: true });
    await expect(singles.caller.reports.submit({ ...valid, freqKhz: 7_000 })).resolves.toEqual({ accepted: false });

    const groups = setup();
    const places = [2_500, 5_000, 10_000, 15_000].flatMap((freqKhz) => [8073, 8074].map((receiverPort) => ({ freqKhz, receiverPort })));
    for (const [i, place] of places.entries())
      await expect(groups.caller.reports.submitGroup({ ...group, ...place, answer: i % 2 ? "all" : "none" })).resolves.toEqual({ accepted: true });
    for (const freqKhz of [2_500, 5_000])
      await expect(groups.caller.reports.submitGroup({ ...group, receiverHost: "other.example", freqKhz })).resolves.toEqual({ accepted: true });
    // Ten groups, twenty rows: the hour is full.
    await expect(groups.caller.reports.submit(valid)).resolves.toEqual({ accepted: false });
  });

  // Value: protects=a group is taken only when it names exactly the stations the question names on that frequency, in any order, at some minute of the last 5 (a question asked before one went off still counts); a subset of three stations sharing a channel, or the full set once one has been off for over 5 minutes, is refused; fails_when=a page can choose which stations an answer files, so a heard-one answer drops a station the listener was asked about; why_new=#150 review; seam=made-up stations sharing a channel, catalog for WWV/WWVH; no_claim=none
  it("takes only the stations the question names there", () => {
    const wwv = findStation("wwv")!;
    expect(askedTogether(["wwvh", "wwv"], 10_000, null, NOON)).toBe(true);
    expect(askedTogether(["wwv", "wwvh"], 20_000, null, NOON)).toBe(false);
    const at = (slug: string, schedule: SignalStation["schedule"] = { kind: "always" }): SignalStation => ({
      ...wwv,
      slug,
      name: slug.toUpperCase(),
      channels: [{ khz: 7_000, mode: "am" }],
      schedule,
    });
    const three = [at("a"), at("b"), at("c")];
    expect(askedTogether(["a", "b", "c"], 7_000, null, NOON, three)).toBe(true);
    expect(askedTogether(["a", "b"], 7_000, null, NOON, three)).toBe(false);
    // C on the air until 4 minutes ago: the three-station question was still asked within the grace.
    // NOON is 12:00 UTC: minute 720 of the day.
    const until = (agoMin: number) => at("c", { kind: "windows", windows: [{ startUtc: 6 * 60, endUtc: 720 - agoMin, khz: 7_000 }] });
    expect(askedTogether(["a", "b", "c"], 7_000, null, NOON, [at("a"), at("b"), until(4)])).toBe(true);
    expect(askedTogether(["a", "b", "c"], 7_000, null, NOON, [at("a"), at("b"), until(10)])).toBe(false);
  });

  // Value: protects=the per-receiver cap counts rows, so a flood of group answers from fresh listener ids adds at most RECEIVER_REPORTS_PER_HOUR rows to one receiver an hour (15 WWV/WWVH groups fill it, and a group needing two rows is refused at 29), while another receiver is unaffected; fails_when=the receiver cap counts a group once, so a flood doubles what lands against one receiver; why_new=#150 review (the cap's bound); seam=in-memory db + fake clock; no_claim=per-IP limits (Vercel firewall)
  it("caps one receiver's rows an hour, a group costing one per station", async () => {
    const { caller, receptionReport } = setup();
    const fresh = () => crypto.randomUUID();
    const freqs = [2_500, 5_000, 10_000, 15_000];
    for (let i = 0; i < RECEIVER_REPORTS_PER_HOUR / 2; i++)
      await expect(caller.reports.submitGroup({ ...group, listenerId: fresh(), freqKhz: freqs[i % 4]! })).resolves.toEqual({ accepted: true });
    expect(receptionReport.createMany).toHaveBeenCalledTimes(RECEIVER_REPORTS_PER_HOUR / 2);
    await expect(caller.reports.submitGroup({ ...group, listenerId: fresh() })).resolves.toEqual({ accepted: false });
    await expect(caller.reports.submit({ ...valid, listenerId: fresh() })).resolves.toEqual({ accepted: false });
    await expect(caller.reports.submitGroup({ ...group, listenerId: fresh(), receiverHost: "other.example" })).resolves.toEqual({ accepted: true });

    // At 29 rows a single answer still fits; a group of two doesn't.
    const near = setup();
    for (let i = 0; i < RECEIVER_REPORTS_PER_HOUR - 1; i++)
      await near.caller.reports.submit({ ...valid, listenerId: fresh(), freqKhz: 6_000 + i });
    await expect(near.caller.reports.submitGroup({ ...group, listenerId: fresh() })).resolves.toEqual({ accepted: false });
    await expect(near.caller.reports.submit({ ...valid, listenerId: fresh(), freqKhz: 7_000 })).resolves.toEqual({ accepted: true });
  });

  // Value: protects=the same-channel limit holds across single and grouped answers per station: a group naming WWV is refused within 30 minutes of a single WWV answer there, and a single WWVH answer after a group naming it, while another frequency is free, and the group is taken once the window passes; fails_when=the group's same-channel check skips its stations, so one listener files WWV twice in 30 minutes; why_new=#150 (limits); seam=in-memory db + fake clock; no_claim=none
  it("holds the same-channel limit across single and grouped answers", async () => {
    const { caller } = setup();
    const wwv = { ...valid, freqKhz: 10_000, txKind: "signal" as const, txName: "wwv" };
    await expect(caller.reports.submit(wwv)).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submitGroup(group)).resolves.toEqual({ accepted: false });
    await expect(caller.reports.submitGroup({ ...group, freqKhz: 5_000 })).resolves.toEqual({ accepted: true });
    await expect(caller.reports.submit({ ...wwv, freqKhz: 5_000, txName: "wwvh" })).resolves.toEqual({ accepted: false });
    vi.advanceTimersByTime(SAME_CHANNEL_MS + 1);
    await expect(caller.reports.submitGroup(group)).resolves.toEqual({ accepted: true });
  });

  // Value: protects=a group's rows keep Pick best's context from a non-beacon run, as a single signal answer does, and drop a beacon pick or malformed context while keeping the answer, each logged as reports.submitGroup; fails_when=grouped answers lose #61's pick context, store a beacon pick, or log either drop under reports.submit; why_new=#150 (shared pick handling), #150 review (log name); seam=in-memory db, console.warn spied; no_claim=none
  it("keeps pick context on every row of a group", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pick = { version: 10, pickedAtMs: NOON - 90_000, rankPos: 0, candidates: ["kiwi.example.org:8073"], freqKhz: 10_000, snr: 20, users: 1 };
    const { caller, receptionReport } = setup();
    await caller.reports.submitGroup({ ...group, pick: { ...pick, pickSource: "search" } });
    const rows = rowsOf(receptionReport.createMany);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ pickSource: "search", candidatesListed: 1 });
    await expect(
      caller.reports.submitGroup({ ...group, freqKhz: 5_000, pick: { ...pick, freqKhz: 5_000, pickSource: "beacon" } }),
    ).resolves.toEqual({ accepted: true });
    for (const r of rowsOf(receptionReport.createMany)) expect(r).not.toHaveProperty("pickSource");
    // Logged under the procedure that dropped it.
    expect(warn).toHaveBeenLastCalledWith("reports.submitGroup: dropped pick context that doesn't fit the report");
    // Malformed context too: the answer is kept, the warning names submitGroup.
    await expect(
      caller.reports.submitGroup({ ...group, freqKhz: 15_000, pick: { ...pick, freqKhz: 15_000, rankPos: 1.5, pickSource: "search" } }),
    ).resolves.toEqual({ accepted: true });
    expect(warn).toHaveBeenCalledWith("reports.submitGroup: dropped malformed pick context:", "rankPos");
  });

  // Value: protects=a WWV/WWVH answer never waits on Priyom's schedule (a fresh server's first fetch can take 10 s), as a single WWV answer doesn't; fails_when=submitGroup fetches Priyom for every group, so a slow or unreachable Priyom delays or times out answers that don't depend on it; why_new=#150 review; seam=getPriyomSchedule mocked; no_claim=Priyom's latency
  it("doesn't fetch Priyom's schedule for stations that don't use it", async () => {
    vi.mocked(getPriyomSchedule).mockClear();
    const { caller } = setup();
    await expect(caller.reports.submitGroup(group)).resolves.toEqual({ accepted: true });
    expect(getPriyomSchedule).not.toHaveBeenCalled();
  });
});
