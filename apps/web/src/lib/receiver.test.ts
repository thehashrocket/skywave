import { describe, expect, it } from "vitest";
import { formatHostPort, parseReceiver } from "./receiver";

describe("parseReceiver", () => {
  it.each([
    ["f4kiy.ddns.net", { host: "f4kiy.ddns.net" }],
    ["  f4kiy.ddns.net  ", { host: "f4kiy.ddns.net" }],
    ["http://f4kiy.ddns.net", { host: "f4kiy.ddns.net", port: "80", secure: false }],
    ["http://sa4bna.hopto.org/", { host: "sa4bna.hopto.org", port: "80", secure: false }],
    ["http://x.proxy.kiwisdr.com/", { host: "x.proxy.kiwisdr.com", port: "8073", secure: false }],
    ["http://f4kiy.ddns.net:8074/", { host: "f4kiy.ddns.net", port: "8074", secure: false }],
    ["https://kiwi.example.org:8073/?f=10000am", { host: "kiwi.example.org", port: "8073", secure: true }],
    // URL drops a scheme's default port, even typed out; https means 443.
    ["https://kwsdr.db0nas.de:443/", { host: "kwsdr.db0nas.de", port: "443", secure: true }],
    ["https://kwsdr.db0nas.de", { host: "kwsdr.db0nas.de", port: "443", secure: true }],
    ["wss://kiwi.example.org:8073", { host: "kiwi.example.org", port: "8073", secure: true }],
    ["f4kiy.ddns.net:8075", { host: "f4kiy.ddns.net", port: "8075" }],
    ["F4KIY.ddns.net", { host: "f4kiy.ddns.net" }],
    ["[2001:db8::1]:8073", { host: "2001:db8::1", port: "8073" }],
    ["", { host: "" }],
  ])("%j", (input, expected) => {
    expect(parseReceiver(input)).toEqual(expected);
  });

  it("passes through text it can't parse so the service can explain what's wrong", () => {
    expect(parseReceiver("not a host!")).toEqual({ host: "not a host!" });
  });
});

describe("formatHostPort", () => {
  // Value: protects=an IPv6 receiver shown in the table pastes back as a working address; fails_when=brackets are dropped; why_new=TODOS parser hardening; seam=none; no_claim=none beyond protects
  it.each([
    ["kiwi.example", 8073, "kiwi.example:8073"],
    ["2001:db8::1", 8073, "[2001:db8::1]:8073"],
  ])("%s %i", (host, port, shown) => {
    expect(formatHostPort(host, port)).toBe(shown);
    expect(parseReceiver(shown)).toEqual({ host, port: String(port) });
  });
});
