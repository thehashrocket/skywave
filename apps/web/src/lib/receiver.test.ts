import { describe, expect, it } from "vitest";
import { parseReceiver } from "./receiver";

describe("parseReceiver", () => {
  it.each([
    ["f4kiy.ddns.net", { host: "f4kiy.ddns.net" }],
    ["  f4kiy.ddns.net  ", { host: "f4kiy.ddns.net" }],
    ["http://f4kiy.ddns.net", { host: "f4kiy.ddns.net" }],
    ["http://sa4bna.hopto.org/", { host: "sa4bna.hopto.org" }],
    ["http://f4kiy.ddns.net:8074/", { host: "f4kiy.ddns.net", port: "8074" }],
    ["https://kiwi.example.org:8073/?f=10000am", { host: "kiwi.example.org", port: "8073" }],
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
