import { describe, expect, it } from "vitest";
import { parseShareLink } from "./share-link";
import { listenHref, pageDescription, scheduleLines, stationHref } from "./signal-page";
import { findStation, SIGNAL_STATIONS } from "./signal-stations";

const station = (slug: string) => findStation(slug)!;

describe("signal page text", () => {
  // Value: protects=#103 every station page's schedule reads right for its kind: around the clock, day/night channels, Priyom's pattern note, or off the air since its year-month; fails_when=a kind falls through to empty text or the wrong channel names; why_new=#103 pages; seam=signal-stations catalog; no_claim=catalog facts
  it("describes each kind of schedule", () => {
    expect(scheduleLines(station("uvb-76"))).toEqual(["On the air around the clock."]);
    expect(scheduleLines(station("the-pip"))).toEqual([
      "On the air around the clock: 5.448 USB by day and 3.756 USB by night at the transmitter.",
    ]);
    expect(scheduleLines(station("e11"))[0]).toMatch(/twice a week/i);
    expect(scheduleLines(station("lincolnshire-poacher"))).toEqual(["Off the air since 2008-07."]);
    for (const s of SIGNAL_STATIONS) expect(scheduleLines(s).join("").length).toBeGreaterThan(0);
  });

  // Value: protects=a station page's Tune link opens the main page tuned to that channel with the station named, exactly as the main page parses links (?f=&m=&sig=), so its Listen ranks by the station's path; fails_when=the link format drifts from parseShareLink (wrong param, a dropped sig) and the page opens untuned or unnamed; why_new=#103 Listen links; seam=share-link parser; no_claim=the main page's Listen behaviour
  it("links to the main page tuned to the station, as the page reads links", () => {
    for (const s of SIGNAL_STATIONS)
      for (const ch of s.channels) {
        const href = listenHref(s, ch);
        expect(href.startsWith("/?")).toBe(true);
        expect(parseShareLink(href.slice(1))).toEqual({ freqKhz: ch.khz, mode: ch.mode, signal: s.slug });
      }
    expect(parseShareLink(stationHref(station("e07")).slice(1))).toEqual({ signal: "e07" });
  });

  // Value: protects=search and link-preview text says a live station can be heard live and a defunct one is history; fails_when=a defunct station is advertised as "listen live"; why_new=#103 metadata; seam=none; no_claim=search engine behaviour
  it("describes live and defunct stations differently", () => {
    expect(pageDescription(station("uvb-76"))).toMatch(/Listen live/);
    expect(pageDescription(station("cherry-ripe"))).toMatch(/Off the air now/);
    expect(pageDescription(station("cherry-ripe"))).not.toMatch(/Listen live/);
  });
});
