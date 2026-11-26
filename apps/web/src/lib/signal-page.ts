/**
 * What the signal station pages (#103) say about a station: its schedule in
 * words, the category heading, and the links that open the main page tuned to
 * it. Pure, so the pages render statically and tests need no clock.
 */

import { MODE_LABELS } from "./radio-types";
import { mhz } from "./ghostnet";
import { buildShareLink } from "./share-link";
import type { SignalCategory, SignalChannel, SignalStation, SignalWindow } from "./signal-stations";

/** Category names as page headings, in the order the index lists them. */
export const CATEGORY_HEADINGS: readonly (readonly [SignalCategory, string])[] = [
  ["time", "Time signals"],
  ["marker", "Markers"],
  ["military", "Military"],
  ["numbers", "Numbers stations"],
  ["other", "Other"],
];

/**
 * "4.625 USB" for a channel, with as many more digits as the kHz has decimals (up
 * to three), so 3363.5 kHz reads 3.3635. A Priyom RTTY slot leads with the
 * frequency Priyom and every log list it, then the dial (owner, #148):
 * "17532 kHz RTTY · dial 17529.875 USB".
 */
export function channelText(ch: SignalChannel): string {
  return channelParts(ch).join(" ");
}

/**
 * channelText in its pieces: one for an ordinary channel; for a Priyom RTTY slot
 * the listed frequency and "· dial ...", which a narrow cell may put on two lines.
 */
export function channelParts(ch: SignalChannel): [string] | [string, string] {
  if (ch.listedKhz !== undefined) return [`${ch.listedKhz} kHz RTTY`, `· dial ${ch.khz} ${MODE_LABELS[ch.mode]}`];
  const decimals = Number.isInteger(ch.khz) ? 0 : Math.min(3, (String(ch.khz).split(".")[1] ?? "").length);
  return [`${mhz(ch.khz, 3 + decimals)} ${MODE_LABELS[ch.mode]}`];
}

/**
 * The main page opened tuned to `ch` with the station named (`?f=&m=&sig=`),
 * so its Listen picks a receiver by the station's path. Relative: it works on
 * any host. A link never starts audio by itself.
 */
export function listenHref(station: SignalStation, ch: SignalChannel): string {
  return buildShareLink("/", { freqKhz: ch.khz, mode: ch.mode, signal: station.slug });
}

/** The main page with the station named and nothing tuned (`?sig=`), for a station with no fixed frequency. */
export function stationHref(station: SignalStation): string {
  return `/?sig=${encodeURIComponent(station.slug)}`;
}

/** "HH:MM" in UTC from minutes since midnight. */
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** One window as words: "Mo-Fr 14:00–15:00 UTC on 4.625 USB". */
function windowText(station: SignalStation, w: SignalWindow): string {
  const ch = station.channels.find((c) => c.khz === w.khz);
  const days = w.days ? `${w.days} ` : "Daily ";
  return `${days}${hhmm(w.startUtc)}–${hhmm(w.endUtc)} UTC${ch ? ` on ${channelText(ch)}` : ""}`;
}

/**
 * The station's schedule as lines of plain text. A numbers station's times
 * come from Priyom and change, so its lines describe the pattern; the page
 * shows the live times beside them.
 */
export function scheduleLines(station: SignalStation): string[] {
  const { schedule } = station;
  const ch = (khz: number) => station.channels.find((c) => c.khz === khz);
  switch (schedule.kind) {
    case "always":
      return ["On the air around the clock."];
    case "dayNight": {
      const day = ch(schedule.dayKhz);
      const night = ch(schedule.nightKhz);
      return [
        `On the air around the clock: ${day ? channelText(day) : `${schedule.dayKhz} kHz`} by day and ${
          night ? channelText(night) : `${schedule.nightKhz} kHz`
        } by night at the transmitter.`,
      ];
    }
    case "windows":
      return schedule.windows.map((w) => windowText(station, w));
    case "irregular":
      return [schedule.note];
    case "defunct":
      return [schedule.ended ? `Off the air since ${schedule.ended}.` : "Off the air."];
  }
}

/** A page description for search results and link previews. */
export function pageDescription(station: SignalStation): string {
  if (station.schedule.kind === "defunct") return `${station.blurb} Off the air now; its history on skywave.`;
  return `${station.blurb} Listen live through public receivers on skywave.`;
}
