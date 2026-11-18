import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "@/lib/eibi";
import type { Receiver } from "@/lib/kiwi-list";
import type { createContext } from "@/server/trpc";
import {
  beaconRecently,
  RECEIVER_REPORTS_PER_HOUR,
  REPORTS_PER_HOUR,
  SAME_CHANNEL_MS,
  type ReportInput,
} from "./reports";

// The real module opens a Prisma client at import; every test injects its own db.
vi.mock("@/server/db", () => ({ db: {} }));

// The server's cached schedule and receiver list, as stations.schedule and receivers.list serve them.
const cache = { broadcasts: [] as Broadcast[], receivers: [] as Receiver[], listDown: false };
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

  // Value: protects=a beacon report names one of the 18 IBP beacons on a beacon frequency, judged by the server's own clock, not the EiBi schedule; fails_when=any callsign or frequency is taken, or beacon reports are checked against EiBi (and declined); why_new=beacon prompt (#59); seam=getSchedule mocked empty; no_claim=which slot the listener heard (a 5-minute window spans every beacon on every band)
  it("accepts a beacon report only for an IBP beacon on a beacon frequency", async () => {
    cache.broadcasts = [];
    const beacon = { ...valid, freqKhz: 14_100, mode: "cw" as const, txKind: "beacon" as const, txDetail: "14100" };
    // Noon UTC opens a cycle: 4U1UN on 14.100.
    await accepted({ ...beacon, txName: "4U1UN" });
    await declined({ ...beacon, freqKhz: 14_000, txName: "4U1UN" });
    await declined({ ...beacon, txName: "N0CALL" });
    // An EiBi report still needs the schedule.
    await declined({ ...valid, freqKhz: 14_100, txName: "4U1UN" });
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

describe("beaconRecently", () => {
  const noon = Date.UTC(2026, 10, 18, 12);

  // Value: protects=the window reaches back LISTING_GRACE_MS by slots on the band the frequency names, so a slot asked about just before the prompt closed still counts; fails_when=the window is shorter than the prompt's life, or the band is read from the wrong frequency; why_new=beacon prompt (#59); seam=none; no_claim=none
  it("finds the beacon in any slot of the last 5 minutes on that band", () => {
    expect(beaconRecently("4U1UN", 14_100, noon)).toBe(true);
    // 4U1UN had 28.200 (band 4) at 11:57:40; 4X6TU had 14.100 at 11:59:00.
    expect(beaconRecently("4U1UN", 28_200, noon)).toBe(true);
    expect(beaconRecently("4X6TU", 14_100, noon)).toBe(true);
    expect(beaconRecently("4U1UN", 14_200, noon)).toBe(false);
  });
});
