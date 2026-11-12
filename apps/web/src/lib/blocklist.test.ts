import { describe, expect, it } from "vitest";
import { isBlocked, parseBlocked } from "@/lib/blocklist";

describe("blocklist", () => {
  const list = parseBlocked(" Kiwi.Example. , other.example:8074, [2001:db8::1]:8073, 2001:db8::2, bad:0 ,");

  it("parses hosts, ports and IPv6, skipping bad entries", () => {
    expect(list).toEqual([
      { host: "kiwi.example", port: null },
      { host: "other.example", port: 8074 },
      { host: "2001:db8::1", port: 8073 },
      { host: "2001:db8::2", port: null },
    ]);
  });

  it("matches a bare host on any port and a host:port on that port only", () => {
    expect(isBlocked(list, "KIWI.example", 8073)).toBe(true);
    expect(isBlocked(list, "other.example", 8074)).toBe(true);
    expect(isBlocked(list, "other.example", 8073)).toBe(false);
    expect(isBlocked(list, "2001:db8::2", 80)).toBe(true);
    expect(isBlocked(parseBlocked(undefined), "kiwi.example", 8073)).toBe(false);
  });
});
