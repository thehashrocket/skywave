import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createContext } from "@/server/trpc";
import { RECEIVER_REPORTS_PER_HOUR, REPORTS_PER_HOUR, SAME_CHANNEL_MS } from "./reports";

// The real module opens a Prisma client at import; every test injects its own db.
vi.mock("@/server/db", () => ({ db: {} }));

const { appRouter } = await import("@/server/root");

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
    ["a beacon, before beacon mode", { txKind: "beacon" }],
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
