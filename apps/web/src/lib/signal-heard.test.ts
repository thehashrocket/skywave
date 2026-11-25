import { describe, expect, it } from "vitest";
import { confirmedFirst, COUNT_MS, HEARD_SHOWN_MS, lastHeard, type SignalAnswer } from "./signal-heard";
import { panelGroups } from "./signal-panel";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const MIN = 60_000;
const answer = (txName: string, khz: number, outcome: string, agoMs: number): SignalAnswer => ({
  txName,
  txDetail: String(khz),
  outcome,
  createdAtMs: NOW - agoMs,
});

describe("lastHeard", () => {
  // Value: protects=with no answers, or only "not heard" ones, no station gets a heard time (the badge stays hidden), while not-heard answers are still counted; fails_when=a not-heard answer shows as heard, or a station with no reports gets a badge; why_new=#102 acceptance fixtures; seam=none (pure); no_claim=the database query
  it("gives no heard time with no answers or only not-heard ones", () => {
    expect(lastHeard([], NOW)).toEqual({});
    const out = lastHeard([answer("uvb-76", 4_625, "not_heard", 10 * MIN), answer("uvb-76", 4_625, "no_open", MIN)], NOW);
    expect(out).toEqual({ "uvb-76": { heardMs: null, either: null, heard24h: 0, notHeard24h: 1 } });
  });

  // Value: protects=mixed answers: the latest "heard" wins, counts cover only the last 24 h, and a heard older than 7 days shows no badge; fails_when=an older heard hides a newer one, last week's answers inflate today's counts, or a stale heard keeps a badge; why_new=#102 acceptance fixtures; seam=none (pure); no_claim=none
  it("keeps the latest heard and counts the last day", () => {
    const out = lastHeard(
      [
        answer("uvb-76", 4_625, "heard", 90 * MIN),
        answer("uvb-76", 4_625, "heard", 40 * MIN),
        answer("uvb-76", 4_625, "not_heard", 20 * MIN),
        answer("uvb-76", 4_625, "heard", COUNT_MS + MIN),
        answer("the-pip", 5_448, "heard", HEARD_SHOWN_MS + MIN),
      ],
      NOW,
    );
    expect(out["uvb-76"]).toEqual({ heardMs: NOW - 40 * MIN, either: null, heard24h: 2, notHeard24h: 1 });
    expect(out["the-pip"]).toBeUndefined();
  });

  // Value: protects=owner's option 1 on #102: a heard about WWV or WWVH on a shared frequency (2.5/5/10/15 MHz) shows on both rows as "WWV or WWVH", counts stay with the station named, and WWV on 20 MHz (its alone) is WWV's only; fails_when=a WWVH heard marks only WWVH (or WWV as plainly heard), counts merge, or 20 MHz credits WWVH; why_new=#102 WWV/WWVH decision; seam=signal-stations catalog; no_claim=which station the listener really heard
  it("credits WWV and WWVH together on the frequencies they share", () => {
    const shared = lastHeard([answer("wwvh", 10_000, "heard", 10 * MIN)], NOW);
    expect(shared["wwv"]).toEqual({ heardMs: NOW - 10 * MIN, either: ["WWV", "WWVH"], heard24h: 0, notHeard24h: 0 });
    expect(shared["wwvh"]).toEqual({ heardMs: NOW - 10 * MIN, either: ["WWV", "WWVH"], heard24h: 1, notHeard24h: 0 });
    const own = lastHeard([answer("wwv", 20_000, "heard", 5 * MIN), answer("wwvh", 10_000, "heard", 10 * MIN)], NOW);
    expect(own["wwv"]).toMatchObject({ heardMs: NOW - 5 * MIN, either: null, heard24h: 1 });
    expect(own["wwvh"]).toMatchObject({ heardMs: NOW - 10 * MIN, either: ["WWV", "WWVH"] });
  });

  // Value: protects=rows the catalog doesn't know (a renamed slug) or a defunct station are ignored rather than crashing or badging history; fails_when=an old slug throws or a defunct station looks alive; why_new=#102; seam=signal-stations catalog; no_claim=none
  it("ignores unknown and defunct stations", () => {
    expect(lastHeard([answer("gone", 1_000, "heard", MIN), answer("lincolnshire-poacher", 1_000, "heard", MIN)], NOW)).toEqual({});
  });
});

describe("confirmedFirst", () => {
  // Value: protects=Always on puts stations heard in the last day first, most recent first, and keeps the catalog order for the rest (a week-old heard doesn't reorder); fails_when=unconfirmed stations jump ahead or the order shuffles with no reports; why_new=#102 sort; seam=signal-panel groups; no_claim=none
  it("sorts stations heard today first, the rest in order", () => {
    const always = panelGroups(NOW, null).always;
    const heard = lastHeard(
      [answer("rwm", 9_996, "heard", 30 * MIN), answer("the-pip", 5_448, "heard", 5 * MIN), answer("uvb-76", 4_625, "heard", 2 * COUNT_MS)],
      NOW,
    );
    const slugs = confirmedFirst(always, heard, NOW).map((r) => r.station.slug);
    expect(slugs).toEqual(["the-pip", "rwm", "wwv", "wwvh", "uvb-76", "squeaky-wheel"]);
    expect(confirmedFirst(always, null, NOW)).toEqual(always);
  });
});
