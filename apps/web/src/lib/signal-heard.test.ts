import { describe, expect, it } from "vitest";
import {
  HEARD_SHOWN_MS,
  lastHeard,
  NOT_HEARD_OVER_OTHER,
  sharedChannels,
  stationActivity,
  type AnswerTally,
  type HeardSums,
} from "./signal-heard";
import { findStation, SIGNAL_STATIONS } from "./signal-stations";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const MIN = 60_000;
/** Sums as the database returns them; each list empty unless given. */
const sums = (s: Partial<HeardSums>): HeardSums => ({ latest: [], shared: [], counts: [], ...s });

describe("sharedChannels", () => {
  // Value: protects=the channels whose answers count for several stations are exactly WWV and WWVH's four shared ones (owner's option 1 on #102), so WWV's 20 MHz and every other station stay their own; fails_when=a catalog change makes another frequency shared silently, or WWV/WWVH lose one; why_new=#102 shared-channel sums; seam=signal-stations catalog; no_claim=none
  it("lists WWV and WWVH's shared frequencies only", () => {
    expect(sharedChannels().map((c) => [c.khz, c.stations.map((s) => s.slug)])).toEqual([
      [10_000, ["wwv", "wwvh"]],
      [5_000, ["wwv", "wwvh"]],
      [15_000, ["wwv", "wwvh"]],
      [2_500, ["wwv", "wwvh"]],
    ]);
  });
});

describe("lastHeard", () => {
  // Value: protects=with no answers, or only "not heard" ones, no station gets a heard time (the badge stays hidden), while not-heard answers are still counted and "didn't open" isn't; fails_when=a not-heard answer shows as heard, or a station with no reports gets a badge; why_new=#102 acceptance fixtures; seam=none (pure); no_claim=the database query
  it("gives no heard time with no answers or only not-heard ones", () => {
    expect(lastHeard(sums({}), NOW)).toEqual({});
    const out = lastHeard(
      sums({ counts: [{ txName: "uvb-76", outcome: "not_heard", n: 1 }, { txName: "uvb-76", outcome: "no_open", n: 3 }] }),
      NOW,
    );
    expect(out).toEqual({ "uvb-76": { heardMs: null, either: null, heard24h: 0, notHeard24h: 1 } });
  });

  // Value: protects=a station's newest heard and its day counts come through, and a heard older than 7 days or dated after now shows no badge; fails_when=a stale or future heard keeps a badge, or counts go to the wrong outcome; why_new=#102 acceptance fixtures; seam=none (pure); no_claim=none
  it("keeps the newest heard in the week and the day's counts", () => {
    const out = lastHeard(
      sums({
        latest: [
          { txName: "uvb-76", ms: NOW - 40 * MIN },
          { txName: "the-pip", ms: NOW - HEARD_SHOWN_MS - MIN },
          { txName: "rwm", ms: NOW + 5 * MIN },
        ],
        counts: [
          { txName: "uvb-76", outcome: "heard", n: 2 },
          { txName: "uvb-76", outcome: "not_heard", n: 1 },
        ],
      }),
      NOW,
    );
    expect(out["uvb-76"]).toEqual({ heardMs: NOW - 40 * MIN, either: null, heard24h: 2, notHeard24h: 1 });
    expect(out["the-pip"]).toBeUndefined();
    expect(out["rwm"]).toBeUndefined();
  });

  // Value: protects=owner's option 1 on #102: a heard about WWV or WWVH on a shared frequency shows on both rows as "WWV or WWVH" (a tie with a station's own newest reads shared, since that answer was on the shared channel), counts stay with the station named, and WWV's own newer 20 MHz heard is WWV's alone; fails_when=a WWVH heard marks only WWVH, counts merge, or 20 MHz credits WWVH; why_new=#102 WWV/WWVH decision; seam=signal-stations catalog; no_claim=which station the listener really heard
  it("credits WWV and WWVH together on the frequencies they share", () => {
    const t = NOW - 10 * MIN;
    const shared = lastHeard(
      sums({
        latest: [{ txName: "wwvh", ms: t }],
        shared: [{ khz: 10_000, txName: "wwvh", ms: t }],
        counts: [{ txName: "wwvh", outcome: "heard", n: 1 }],
      }),
      NOW,
    );
    expect(shared["wwv"]).toEqual({ heardMs: t, either: ["WWV", "WWVH"], heard24h: 0, notHeard24h: 0 });
    expect(shared["wwvh"]).toEqual({ heardMs: t, either: ["WWV", "WWVH"], heard24h: 1, notHeard24h: 0 });
    const own = lastHeard(
      sums({
        latest: [
          { txName: "wwv", ms: NOW - 5 * MIN },
          { txName: "wwvh", ms: t },
        ],
        shared: [{ khz: 10_000, txName: "wwvh", ms: t }],
      }),
      NOW,
    );
    expect(own["wwv"]).toMatchObject({ heardMs: NOW - 5 * MIN, either: null });
    expect(own["wwvh"]).toMatchObject({ heardMs: t, either: ["WWV", "WWVH"] });
  });

  // Value: protects=with several "heard" answers on WWV and WWVH's shared channels, both rows show the newest of them (across stations and across channels), not the first one read; fails_when=the shared-channel pick keeps the first or oldest row, so a WWV/WWVH badge reads hours staler than the latest answer; why_new=existing fixtures give each channel one shared row, so a first-row pick passes them; seam=none (pure); no_claim=the database's per-channel sums
  it("shows the newest of several shared-channel answers on both rows", () => {
    const older = NOW - 90 * MIN;
    const newer = NOW - 15 * MIN;
    const out = lastHeard(
      sums({
        latest: [
          { txName: "wwv", ms: older },
          { txName: "wwvh", ms: newer },
        ],
        shared: [
          { khz: 15_000, txName: "wwv", ms: older },
          { khz: 15_000, txName: "wwvh", ms: newer },
          { khz: 10_000, txName: "wwv", ms: older - MIN },
        ],
      }),
      NOW,
    );
    expect(out["wwv"]).toMatchObject({ heardMs: newer, either: ["WWV", "WWVH"] });
    expect(out["wwvh"]).toMatchObject({ heardMs: newer, either: ["WWV", "WWVH"] });
  });

  // Value: protects=names the catalog doesn't know (a renamed slug) or has as defunct are ignored rather than crashing or badging history; fails_when=an old slug throws or a defunct station looks alive; why_new=#102; seam=signal-stations catalog; no_claim=none
  it("ignores unknown and defunct stations", () => {
    const out = lastHeard(
      sums({
        latest: [
          { txName: "gone", ms: NOW - MIN },
          { txName: "lincolnshire-poacher", ms: NOW - MIN },
        ],
        counts: [{ txName: "gone", outcome: "heard", n: 1 }],
      }),
      NOW,
    );
    expect(out).toEqual({});
  });
});

describe("stationActivity", () => {
  const wwv = findStation("wwv")!;
  /** `n` answers of `outcome` about `txName` from listener `who`. */
  const t = (who: string, outcome: string, n = 1, txName = "wwv"): AnswerTally => ({ txName, outcome, listenerId: who, n });
  const notHeardFrom = (...who: string[]) => who.map((w) => t(w, "not_heard", 2));

  // Value: protects=#147 a station on the air all the time is "suspect" only with 5+ "not heard" answers from 3+ different listeners and no "heard", with the counts right; fails_when=the thresholds drift, or another station's answers or "no_open" count toward it; why_new=#147 possibly-off-the-air signal; seam=none (pure); no_claim=the 60-day database read (the route's)
  it("calls a station suspect with enough not-heard answers from enough listeners", () => {
    const tallies = [...notHeardFrom("a", "b", "c"), t("d", "no_open", 9), t("a", "heard", 4, "wwvh")];
    expect(stationActivity(wwv, tallies)).toEqual({ status: "suspect", heard: 0, notHeard: 6, notHeardListeners: 3 });
    // 4 not-heard from 3 listeners: not enough answers.
    expect(stationActivity(wwv, [t("a", "not_heard", 2), t("b", "not_heard"), t("c", "not_heard")])?.status).toBe("ok");
  });

  // Value: protects=#147 one "heard" in the window clears a station however many say they didn't (bad propagation for some isn't death); fails_when=heard answers are ignored or outvoted; why_new=#147 acceptance; seam=none; no_claim=none
  it("isn't suspect when anyone heard it", () => {
    expect(stationActivity(wwv, [...notHeardFrom("a", "b", "c", "d"), t("e", "heard")])).toMatchObject({ status: "ok", heard: 1 });
  });

  // Value: protects=#147 one or two listeners' repeated "not heard" (a bad receiver, an unlucky evening) can't make a station suspect, however many answers; fails_when=listeners aren't counted, so one person flags a station; why_new=#147 acceptance; seam=none; no_claim=a listener clearing their id to look like many (listenerId is the browser's)
  it("isn't suspect when the not-heards come from one or two listeners", () => {
    expect(stationActivity(wwv, [t("a", "not_heard", 20)])).toMatchObject({ status: "ok", notHeard: 20, notHeardListeners: 1 });
    expect(stationActivity(wwv, [t("a", "not_heard", 10), t("b", "not_heard", 10)])?.status).toBe("ok");
  });

  // Value: protects=#147 no answers at all reads "quiet" (no evidence), never "suspect" or "ok", and "didn't open" answers aren't answers; fails_when=silence is taken as off the air; why_new=#147 acceptance; seam=none; no_claim=none
  it("is quiet with no answers", () => {
    expect(stationActivity(wwv, [])).toEqual({ status: "quiet", heard: 0, notHeard: 0, notHeardListeners: 0 });
    expect(stationActivity(findStation("the-pip")!, [t("a", "no_open", 3, "the-pip")])?.status).toBe("quiet");
  });

  // Value: protects=#147 only always-on and day/night stations are judged: irregular, Priyom-scheduled and defunct ones get null whatever the answers, since silence between transmissions proves nothing; fails_when=a numbers station is flagged suspect for being quiet between transmissions; why_new=#147 acceptance; seam=signal-stations catalog; no_claim=none
  it("never judges irregular, Priyom or defunct stations", () => {
    for (const s of SIGNAL_STATIONS.filter((s) => !["always", "dayNight"].includes(s.schedule.kind))) {
      const tallies = ["a", "b", "c", "d"].map((w) => t(w, "not_heard", 3, s.slug));
      expect(stationActivity(s, tallies), s.slug).toBeNull();
    }
    expect(stationActivity({ ...wwv, priyom: "X01" }, notHeardFrom("a", "b", "c"))).toBeNull();
  });
});

describe("stationActivity with shared-frequency answers (#150)", () => {
  const t = (outcome: string, listenerId: string, n = 2): AnswerTally => ({ txName: "wwvh", outcome, listenerId, n });

  // Value: protects=the owner's #150 rule: "not heard over the other" tallies, however many and from however many listeners, never make a station suspect, but keep it out of "quiet" (someone answered), while plain not-heards beside them still count; fails_when=WWVH drowned out by WWV is flagged as possibly off the air, or reads as unanswered in the weekly report; why_new=#150 review; seam=none; no_claim=the database's tallies (grouped-tallies.test)
  it("never calls a station suspect on not heard over the other, nor quiet", () => {
    const wwvh = findStation("wwvh")!;
    const over = ["a", "b", "c", "d"].map((l) => t(NOT_HEARD_OVER_OTHER, l));
    expect(stationActivity(wwvh, over)).toEqual({ status: "ok", heard: 0, notHeard: 0, notHeardListeners: 0 });
    const plain = ["a", "b", "c"].map((l) => t("not_heard", l));
    expect(stationActivity(wwvh, [...over, ...plain])!.status).toBe("suspect");
  });
});
