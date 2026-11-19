import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unzipFile } from "./unzip";

const deflated = readFileSync(new URL("../lib/fixtures/rbn-20261118-sample.zip", import.meta.url));
const stored = readFileSync(new URL("../lib/fixtures/rbn-20261118-stored.zip", import.meta.url));

describe("unzipFile", () => {
  // Value: protects=RBN's zip opens with Node's own zlib, deflated or stored, to the same CSV; fails_when=either method misreads, or the entry is found by the wrong name; why_new=issue #69 v2 (no zip dependency); seam=zips made by Info-ZIP from RBN's real file; no_claim=ZIP64 archives
  it("reads a deflated or stored entry", () => {
    const a = unzipFile(deflated, ".csv", 1_000_000).toString("utf8");
    const b = unzipFile(stored, ".csv", 1_000_000).toString("utf8");
    expect(a).toBe(b);
    expect(a.startsWith("callsign,de_pfx,de_cont,freq,band,dx,")).toBe(true);
  });

  // Value: protects=anything but the expected zip is refused with an error (the caller keeps what it has): an error body, a truncated download, no matching entry, a file bigger than allowed once decompressed; fails_when=a bad download decodes to garbage or exhausts memory; why_new=issue #69 v2 (RBN answered 502 bodies in testing); seam=none; no_claim=none beyond protects
  it("refuses what isn't a whole zip with the file", () => {
    expect(() => unzipFile(Buffer.from("error code: 502"), ".csv", 1_000_000)).toThrow(/Not a zip/);
    expect(() => unzipFile(deflated.subarray(0, 4_000), ".csv", 1_000_000)).toThrow();
    expect(() => unzipFile(deflated, ".txt", 1_000_000)).toThrow(/No .txt file/);
    expect(() => unzipFile(deflated, ".csv", 1_000)).toThrow(/larger than expected/);
  });
});
