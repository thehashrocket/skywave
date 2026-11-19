import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "@/lib/eibi";
import type { IbpStatus } from "@/lib/ibp-status";
import type { RbnDay } from "@/lib/rbn";
import type { Receiver } from "@/lib/kiwi-list";
import { PICK_CONTEXT_VERSION } from "@/lib/pick-context";
import type { createContext } from "@/server/trpc";
import {
  candidateKeyOk,
  PICK_IN_SLOT_MS,
  RECEIVER_REPORTS_PER_HOUR,
  REPORTS_PER_HOUR,
  SAME_CHANNEL_MS,
  type ReportInput,
} from "./reports";

// The real module opens a Prisma client at import; every test injects its own db.
vi.mock("@/server/db", () => ({ db: {} }));

// The server's cached schedule and receiver list, as stations.schedule and receivers.list serve them.
const cache = {
  broadcasts: [] as Broadcast[],
  receivers: [] as Receiver[],
  listDown: false,
  beaconStatus: null as IbpStatus | null,
  rbn: null as RbnDay | null,
};
vi.mock("./beacons", async (actual) => ({
  ...(await actual<typeof import("./beacons")>()),
  getBeaconStatus: vi.fn(async () => cache.beaconStatus),
  rbnDays: { get: vi.fn(async () => cache.rbn), peek: vi.fn(async () => cache.rbn) },
}));
vi.mock("./stations", async (actual) => ({
  ...(await actual<typeof import("./stations")>()),
  getSchedule: vi.fn(async () => ({ season: "b26", bundled: false, broadcasts: cache.broadcasts })),
}));
vi.mock("./receivers", async (actual) => ({
  ...(await actual<typeof import("./receivers")>()),
  getReceivers: vi.fn(async () => {
    if (cache.listDown) throw new Error("Receiver list request failed: HTTP 502");
    return { receivers: cache.receivers, fetchedAt: 0, stale: false };
  }),
}));

const { appRouter } = await import("@/server/root");
const { getSchedule } = await import("./stations");
const { getReceivers } = await import("./receivers");

/** A broadcast between two UTC times ("HHMM"), daily. */
const on = (khz: number, station: string, from = "0000", to = "2400"): Broadcast => {
  const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
  return { khz, start: min(from), end: min(to), days: "", station, lang: "E", target: "NAm" };
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
});

type Context = Awaited<ReturnType<typeof createContext>>;
type Row = { listenerId: string; receiverHost: string; receiverPort: number; freqKhz: number; createdAt: Date };
type Where = Partial<Omit<Row, "createdAt">> & { createdAt: { gte: Date } };

/** An in-memory ReceptionReport table that answers count() the way Prisma would for these filters. */
function setup() {
  const rows: Row[] = [];
  const receptionReport = {
    count: vi.fn(async ({ where }: { where: Where }) => {
      const { createdAt, ...eq } = where;
      return rows.filter(
        (r) => r.createdAt >= createdAt.gte && Object.entries(eq).every(([k, v]) => r[k as keyof typeof eq] === v),
      ).length;
    }),
    create: vi.fn(async ({ data }: { data: Omit<Row, "createdAt"> }) => {
      const row = { ...data, createdAt: new Date() };
      rows.push(row);
      return { id: String(rows.length), ...row };
    }),
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
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 12) }));
  afterEach(() => vi.useRealTimers());

  // Value: protects=a report is stored as one receiver (lowercase host) with a blank comment as none, and nothing beyond the fields asked for; fails_when=the host isn't normalised, a blank comment is stored, or extra fields slip in; why_new=reception reports; seam=in-memory db; no_claim=Postgres behaviour
  it("stores a report, the host lowercased and a blank comment dropped", async () => {
    const { caller, receptionReport } = setup();
    await expect(caller.reports.submit({ ...valid, comment: "   " })).resolves.toEqual({ accepted: true });
    expect(receptionReport.create).toHaveBeenCalledWith({
      data: { ...valid, receiverHost: "kiwi.example.org", comment: undefined },
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
  it("takes at most 10 reports per listener an hour, then quietly declines", async () => {
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
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 12) }));
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
    const NOON = Date.UTC(2026, 10, 18, 12);
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
    it("declines a slot that isn't on a 10-second boundary", async () => {
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
});

describe("reports.submit with Pick best's context (#61)", () => {
  const NOON = Date.UTC(2026, 10, 18, 12);
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
  it("keeps a rank past the stored top 10 when the list was that long", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => `r${i}.example:8073`);
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

  // Value: protects=a tab opened before the round 2, clock or round 3 deploy still sends version 2, 3, 4 or 5; its context is kept and stored as sent, so the replay can tell it from version 6; fails_when=the server accepts only the current version (old tabs lose context) or rewrites the version it stores; why_new=round 2 raised PICK_CONTEXT_VERSION to 3, the monotonic clock to 4, round 3 to 5, the scheduled clock to 6; seam=in-memory db; no_claim=Postgres
  it.each([2, 3, 4, 5])("keeps context from a tab on earlier version %i, storing that version", async (version) => {
    expect(PICK_CONTEXT_VERSION).toBe(6);
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
