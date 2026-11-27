import { describe, expect, it } from "vitest";
import { parseShareLink } from "./share-link";
import { channelText, listenHref, pageDescription, scheduleLines, stationHref } from "./signal-page";
import { findStation, SIGNAL_STATIONS } from "./signal-stations";

const station = (slug: string) => findStation(slug)!;

describe("signal page text", () => {
  // Value: protects=#103 every station page's schedule reads right for its kind: around the clock, day/night channels (switching at EiBi's listed times, the sun only without them, #168), Priyom's pattern note, or off the air since its year-month; fails_when=a kind falls through to empty text or the wrong channel names, or the page still says the sun decides; why_new=#103 pages, reworded for #168 (owner, /document-release); seam=signal-stations catalog; no_claim=catalog facts
  it("describes each kind of schedule", () => {
    expect(scheduleLines(station("uvb-76"))).toEqual(["On the air around the clock."]);
    expect(scheduleLines(station("the-pip"))).toEqual([
      "On the air around the clock: 5.448 USB by day and 3.756 USB by night, switching at the times EiBi's schedule lists (by the sun at the transmitter when it lists none).",
    ]);
    expect(scheduleLines(station("e11"))[0]).toMatch(/twice a week/i);
    expect(scheduleLines(station("lincolnshire-poacher"))).toEqual(["Off the air since 2008-07."]);
    for (const s of SIGNAL_STATIONS) expect(scheduleLines(s).join("").length).toBeGreaterThan(0);
  });

  // Value: protects=#103 a station on set hours reads as days and UTC times with its channel ("Daily" when no days), a defunct station with no known end says only "Off the air.", and a fractional frequency keeps its fourth digit (3.3635, not 3.364); fails_when=windowText drops the days or channel, hhmm mis-pads, a missing `ended` prints "undefined", or channelText rounds 3363.5 kHz to the wrong channel; why_new=no catalog station uses windows or lacks `ended` yet, and no test checked a fractional channel's text since channelText moved out of the panel; seam=none (synthetic station objects); no_claim=catalog facts
  it("describes set-hours windows, an unknown end, and a fractional channel", () => {
    const base = station("uvb-76");
    const windowed = {
      ...base,
      channels: [{ khz: 4_625, mode: "usb" as const }],
      schedule: {
        kind: "windows" as const,
        windows: [
          { days: "Mo-Fr", startUtc: 14 * 60, endUtc: 15 * 60 + 30, khz: 4_625 },
          { startUtc: 5, endUtc: 65, khz: 9_999 },
        ],
      },
    };
    expect(scheduleLines(windowed)).toEqual(["Mo-Fr 14:00–15:30 UTC on 4.625 USB", "Daily 00:05–01:05 UTC"]);
    expect(scheduleLines({ ...base, schedule: { kind: "defunct" } })).toEqual(["Off the air."]);
    expect(scheduleLines(station("squeaky-wheel"))[0]).toContain("3.3635 USB by night");
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

  // Value: protects=a Priyom RTTY slot reads with Priyom's listed frequency first, the number logs and Priyom's pages use, then the exact dial Listen tunes ("17532 kHz RTTY · dial 17529.875 USB", owner #148), never a rounded "17.5299"; other channels keep their MHz form with every kHz decimal (The Squeaky Wheel's 3363.5 as 3.3635, WWV-style whole kHz unchanged); fails_when=the listed frequency is dropped, the dial is rounded, or ordinary channels change; why_new=review note on the F06 page, owner chose this format; seam=none; no_claim=mark-vs-centre on the air
  it("shows an RTTY slot by Priyom's frequency then its dial, and other channels as before", () => {
    expect(channelText({ khz: 17_529.875, mode: "usb", listedKhz: 17_532 })).toBe("17532 kHz RTTY · dial 17529.875 USB");
    expect(channelText({ khz: 3_363.5, mode: "usb" })).toBe("3.3635 USB");
    expect(channelText({ khz: 4_625, mode: "usb" })).toBe("4.625 USB");
    expect(channelText({ khz: 17_529.875, mode: "usb" })).toBe("17.529875 USB");
  });
});
