import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BEACONS } from "./ibp";
import { csvFields, offBeacons, parseFootnotes, parseIbpStatus } from "./ibp-status";

// NCDXF's files as served on 2026-11-19 (the status file stamped 2026-11-05).
const STATUS = readFileSync(new URL("./fixtures/IBPStatus.csv", import.meta.url), "utf8");
const FOOTNOTES = readFileSync(new URL("./fixtures/IBPStatusFootnotes.csv", import.meta.url), "utf8");

describe("parseIbpStatus", () => {
  // Value: protects=today's official files read as NCDXF means them: all 18 beacons in transmission order, VR2B and YV5B off with their footnotes' text (one holding commas inside quotes), the rest on the air, and the file's own stamp; fails_when=the timestamp line is read as a beacon, quoted commas split a note, a footnote number maps to the wrong text, or order follows the file instead of the schedule; why_new=issue #69 v1; seam=fixtures saved from ncdxf.org; no_claim=what NCDXF will publish next
  it("reads today's file", () => {
    const status = parseIbpStatus(STATUS, parseFootnotes(FOOTNOTES));
    expect(status.stampedAt).toBe("2026-11-05T21:03:21.000Z");
    expect(status.beacons.map((b) => b.call)).toEqual(BEACONS.map((b) => b.call));
    expect(status.beacons.filter((b) => b.off)).toEqual([
      {
        call: "VR2B",
        off: true,
        note: "The beacon hasn't been heard for a while. We are contacting the operator. If you hear the beacon back on, please report it to us.",
      },
      { call: "YV5B", off: true, note: "The beacon is off the air temporarily. We expect it will be back soon." },
    ]);
    expect(status.beacons.find((b) => b.call === "4U1UN")).toEqual({ call: "4U1UN", off: false, note: null });
    expect(parseFootnotes(FOOTNOTES).get("2")).toBe(
      "VE8AT has been moved to Inuvik, NT, 1,845 km from the previous location at Eureka.",
    );
  });

  // Value: protects=a damaged or changed file degrades safely: an unknown status counts as on the air, a missing or unknown footnote gives no text, unknown callsigns, short and junk lines are skipped, case, spaces, CRLF and a byte-order mark don't matter, a missing timestamp gives null, and a callsign listed twice takes its last line; fails_when=any of those throws, marks a beacon off, or attaches a wrong note; why_new=issue #69 v1 (defensive parsing); seam=none; no_claim=none beyond protects
  it("parses malformed lines defensively", () => {
    const text = [
      "﻿not a date",
      "4u1un , off , 1 ",
      "VE8AT,MAYBE,1",
      "W6WX,OFF,",
      "KH6RS,OFF,99",
      "ZL6B,OFF",
      "NOPE1,OFF,1",
      "garbage",
      ",,,",
      "JA2IGY,OFF,1",
      "JA2IGY,OK,",
    ].join("\r\n");
    const status = parseIbpStatus(text, new Map([["1", "Temporarily off."]]));
    expect(status.stampedAt).toBeNull();
    expect(status.beacons).toEqual([
      { call: "4U1UN", off: true, note: "Temporarily off." },
      { call: "VE8AT", off: false, note: "Temporarily off." },
      { call: "W6WX", off: true, note: null },
      { call: "KH6RS", off: true, note: null },
      { call: "ZL6B", off: true, note: null },
      { call: "JA2IGY", off: false, note: null },
    ]);
  });

  // Value: protects=a file that isn't the status file (an error page, an empty body, a moved URL's HTML) is refused rather than read as "no beacon is off", so the server keeps its last good copy; fails_when=an unreadable file parses to an empty, all-clear status; why_new=issue #69 v1 (keep the last good copy); seam=none; no_claim=none beyond protects
  it.each([
    ["an empty file", ""],
    ["an HTML page", "<!doctype html><html><body>Moved</body></html>"],
    ["only a timestamp", "2026-11-05T21:03:21+00:00\n"],
  ])("refuses %s", (_, text) => {
    expect(() => parseIbpStatus(text)).toThrow(/Not the IBP status file/);
  });
});

describe("parseFootnotes", () => {
  // Value: protects=footnotes read defensively: quoted text with commas and doubled quotes, unquoted text, an unclosed quote, empty notes and junk lines left out, numbers with leading zeros; fails_when=a note is cut at a comma, keeps its quotes, or an empty note shows as blank text; why_new=issue #69 v1; seam=none; no_claim=none beyond protects
  it("reads quoted, unquoted and broken lines", () => {
    const notes = parseFootnotes(
      [
        "2022-11-30T14:12:47+00:00",
        '1,"Off, for now; the ""main"" rig failed."',
        "2,Plain text",
        '3,"Unclosed, quote',
        '7,""',
        "8,",
        "x,Not a number",
        "04,Leading zero",
      ].join("\n"),
    );
    expect([...notes]).toEqual([
      ["1", 'Off, for now; the "main" rig failed.'],
      ["2", "Plain text"],
      ["3", "Unclosed, quote"],
      ["4", "Leading zero"],
    ]);
  });
});

describe("csvFields", () => {
  // Value: protects=the CSV splitter keeps empty trailing fields and quoted commas; fails_when=a trailing comma drops the empty footnote field or a quoted comma splits; why_new=issue #69 v1; seam=none; no_claim=none beyond protects
  it("splits fields", () => {
    expect(csvFields("4U1UN,OK,")).toEqual(["4U1UN", "OK", ""]);
    expect(csvFields('1,"a, b",c')).toEqual(["1", "a, b", "c"]);
  });
});

describe("offBeacons", () => {
  // Value: protects=the page's lookup holds only the beacons off the air, with their notes, and is empty without a status; fails_when=an on-air beacon is listed as off, or an unknown status (null) marks anything off; why_new=issue #69 v1; seam=none; no_claim=none beyond protects
  it("lists the beacons off the air", () => {
    const status = parseIbpStatus(STATUS, parseFootnotes(FOOTNOTES));
    expect([...offBeacons(status).keys()]).toEqual(["VR2B", "YV5B"]);
    expect(offBeacons(null).size).toBe(0);
  });
});
