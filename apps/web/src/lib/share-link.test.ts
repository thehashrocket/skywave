import { describe, expect, it } from "vitest";
import { buildShareLink, parseShareLink } from "@/lib/share-link";

describe("parseShareLink", () => {
  it("reads frequency, mode and receiver", () => {
    expect(parseShareLink("?f=9580&m=AM&rx=kiwi.example:8074")).toEqual({
      freqKhz: 9580,
      mode: "am",
      receiver: { host: "kiwi.example", port: 8074, secure: false },
    });
  });

  it("defaults the port and reads tls", () => {
    expect(parseShareLink("?rx=Kiwi.Example&tls=1")?.receiver).toEqual({
      host: "kiwi.example",
      port: 8073,
      secure: true,
    });
  });

  it("reads a bracketed IPv6 receiver", () => {
    expect(parseShareLink("?rx=%5B2001%3Adb8%3A%3A1%5D%3A8073")?.receiver).toEqual({
      host: "2001:db8::1",
      port: 8073,
      secure: false,
    });
  });

  it("drops what it can't use", () => {
    expect(parseShareLink("?f=99999&m=fm&rx=bad%20host")).toBeNull();
    expect(parseShareLink("?f=abc")).toBeNull();
    expect(parseShareLink("?rx=kiwi.example:70000")).toBeNull();
    expect(parseShareLink("")).toBeNull();
  });

  it("rounds to the dial's steps", () => {
    expect(parseShareLink("?f=7200.123")?.freqKhz).toBe(7200.12);
  });
});

describe("buildShareLink", () => {
  it("round-trips through parseShareLink", () => {
    const t = { freqKhz: 7200.5, mode: "lsb" as const, receiver: { host: "2001:db8::1", port: 8073, secure: true } };
    const url = buildShareLink("https://skywave.example/", t);
    expect(parseShareLink(new URL(url).search)).toEqual(t);
  });

  it("leaves the receiver out for Auto", () => {
    expect(buildShareLink("https://skywave.example/", { freqKhz: 9580, mode: "am", receiver: null })).toBe(
      "https://skywave.example/?f=9580&m=am",
    );
  });
});
