import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_FIELD, MAX_ROWS, parseGps, parseKiwiList, placeName, rankReceivers, type Receiver } from "./kiwi-list";

// Seven real entries from the mirror, kept in its exact format (comments,
// `var` wrapper, trailing comma).
const FIXTURE = readFileSync(new URL("./fixtures/kiwisdr_com.txt", import.meta.url), "utf8");

describe("parseKiwiList", () => {
  const list = parseKiwiList(FIXTURE);
  const byHost = (host: string) => list.find((r) => r.host === host);

  it("reads the mirror's format, dropping receivers we can't dial", () => {
    expect(list.map((r) => r.host)).toEqual([
      "f4kiy.ddns.net",
      "irelandnorthwest3.proxy.kiwisdr.com",
      "kiwi.770net.de",
      "hasenberg04.proxy.kiwisdr.com",
      "pb8w.proxy.kiwisdr.com",
      "sdr.k1vl.com",
      "swl-lippi-2.stbach.de",
    ]);
  });

  // Value: protects=https-only list receivers are offered and dialed over wss://; fails_when=toReceiver drops https URLs or loses the flag; why_new=https entries were dropped until the service spoke wss; seam=none; no_claim=the 443 port rule (PR4)
  it("keeps https receivers and marks them secure", () => {
    expect(byHost("kiwi.770net.de")).toMatchObject({ port: 8073, secure: true });
    expect(byHost("f4kiy.ddns.net")).not.toHaveProperty("secure");
  });

  it("normalizes one entry", () => {
    expect(byHost("f4kiy.ddns.net")).toEqual({
      id: "3ce4b0f8f760",
      name: "0-30 MHz SDR | Brettnach F57320",
      location: "Brettnach F57320",
      antenna: "vertical",
      host: "f4kiy.ddns.net",
      port: 8073,
      users: 8,
      usersMax: 8,
      snr: 42,
      minKhz: 0,
      maxKhz: 30_000,
    });
  });

  it("defaults the port to 8073 on kiwisdr.com's proxy and 80 elsewhere", () => {
    expect(byHost("irelandnorthwest3.proxy.kiwisdr.com")?.port).toBe(8073);
    expect(byHost("swl-lippi-2.stbach.de")?.port).toBe(80);
    expect(byHost("sdr.k1vl.com")?.port).toBe(8076);
  });

  it("turns HTML in names and antennas into plain text", () => {
    const pb8w = byHost("pb8w.proxy.kiwisdr.com")!;
    expect(pb8w.antenna).toBe("Active Loop antenna PAHGOR (serial nr: 001) built by ► PA0EBC ◀ 👍");
    expect(pb8w.antenna).not.toMatch(/[<>]|&#/);
  });

  it("drops a tag the mirror cut off before its closing bracket", () => {
    const [r] = parseKiwiList(
      'var kiwisdr_com = [{"status":"active","offline":"no","url":"http://a.example:8073","bands":"0-30000000","antenna":"Wellgood Loop V4.1 <a href"}];',
    );
    expect(r!.antenna).toBe("Wellgood Loop V4.1");
  });

  it("keeps a bare '<' that doesn't start a tag", () => {
    const [r] = parseKiwiList(
      'var kiwisdr_com = [{"status":"active","offline":"no","url":"http://a.example:8073","bands":"0-30000000","antenna":"Loop <30 MHz rooftop"}];',
    );
    expect(r!.antenna).toBe("Loop <30 MHz rooftop");
  });

  // Value: protects=one operator's malformed entity can't fail the whole list; fails_when=the code-point range guard is removed (fromCodePoint throws); why_new=fixture only has valid entities; seam=none; no_claim=none beyond protects
  it("keeps out-of-range or unknown entities as text instead of failing the list", () => {
    const [r] = parseKiwiList(
      'var kiwisdr_com = [{"status":"active","offline":"no","url":"http://a.example:8073","bands":"0-30000000","name":"A &#x110000; &#0; &#99999999999; &bogus; &amp; B"}];',
    );
    expect(r!.name).toBe("A &#x110000; &#0; &#99999999999; &bogus; & B");
  });

  const entry = (fields: Record<string, unknown>) =>
    JSON.stringify({ status: "active", offline: "no", url: "http://a.example:8073", bands: "0-30000000", ...fields });
  const one = (fields: Record<string, unknown>) => parseKiwiList(`var kiwisdr_com = [${entry(fields)},];`);

  // Value: protects=a listed receiver can't win every Pick best by claiming an absurd SNR; fails_when=the plausibility cap is removed; why_new=SNR was trusted as-is; seam=none; no_claim=honest-but-wrong SNR values
  it("treats an implausible SNR as unmeasured", () => {
    expect(one({ snr: "1e308,999" })[0]!.snr).toBeNull();
    expect(one({ snr: "50,47" })[0]!.snr).toBe(47);
  });

  // Value: protects=a list entry can only aim the radio service at a Kiwi port, not at web or admin ports on public hosts; fails_when=the allowlist widens back to "80 or >=1024"; why_new=D2.2/D2.5 (Codex High); seam=none; no_claim=which ports real Kiwis move to later
  it.each([
    ["http://a.example", 80],
    ["http://a.example:80", 80],
    ["http://a.example:8070", 8070],
    ["http://a.example:8073", 8073],
    ["http://a.example:8079", 8079],
    ["https://a.example", 443],
    ["https://a.example:443", 443],
    ["https://a.example:8073", 8073],
  ])("keeps %s on port %i", (url, port) => {
    expect(one({ url })[0]!.port).toBe(port);
  });

  it.each([
    "http://a.example:22",
    "http://a.example:443", // 443 only for an https entry
    "http://a.example:5000",
    "http://a.example:5432",
    "http://a.example:8069",
    "http://a.example:8080",
    "http://a.example:8443",
    "http://a.example:18073",
    "https://a.example:8443",
  ])("drops %s, which isn't on a Kiwi port", (url) => {
    expect(() => one({ url })).toThrow(/no usable receivers/);
  });

  // Value: protects=a reverse-proxied receiver isn't offered, since the service would dial host:port and miss the path; fails_when=URLs with a path are accepted; why_new=TODOS parser hardening (0 of 873 today); seam=none; no_claim=future path-based Kiwis working
  it("drops a receiver whose URL has a path, but not a trailing slash or query", () => {
    expect(() => one({ url: "http://a.example:8073/kiwi/" })).toThrow(/no usable receivers/);
    expect(one({ url: "http://a.example:8073/" })).toHaveLength(1);
    expect(one({ url: "http://a.example:8073/?f=10000" })).toHaveLength(1);
  });

  // Value: protects=a name written with its root dot still works, since the service refuses the dot; fails_when=toReceiver keeps the dot; why_new=TODOS small edges; seam=none; no_claim=none beyond protects
  it("drops a trailing dot from a hostname, keeping the proxy port rule", () => {
    expect(one({ url: "http://kiwi.example.:8073" })[0]!.host).toBe("kiwi.example");
    expect(one({ url: "http://x.proxy.kiwisdr.com." })[0]).toMatchObject({ host: "x.proxy.kiwisdr.com", port: 8073 });
  });

  // Value: protects=a giant or hostile list can't freeze the picker; fails_when=the row or field caps are removed; why_new=TODOS parser hardening (D6); seam=none; no_claim=render speed itself
  it(`keeps at most ${MAX_ROWS} receivers, in list order, and cuts long text`, () => {
    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => entry({ url: `http://r${i}.example:8073` }));
    const parsed = parseKiwiList(`var kiwisdr_com = [${many.join(",")}];`);
    expect(parsed).toHaveLength(MAX_ROWS);
    expect(parsed.at(-1)!.host).toBe(`r${MAX_ROWS - 1}.example`);

    const [r] = one({ name: "n".repeat(10_000), loc: "l".repeat(10_000), antenna: "<b>a</b>".repeat(5_000) });
    expect(r!.name).toHaveLength(MAX_FIELD);
    expect(r!.location).toHaveLength(MAX_FIELD);
    expect(r!.antenna.length).toBeLessThanOrEqual(MAX_FIELD);
  });

  // Value: protects=the parser reads the list itself, not the first bracket in whatever wraps it; fails_when=extraction starts at the first "[" again; why_new=TODOS parser hardening; seam=none; no_claim=a renamed variable (that throws, by design)
  it("reads the kiwisdr_com array even when a bracket comes before it", () => {
    const text = `// generated [${"2026-10-20"}]\nvar other = [1, 2];\nvar kiwisdr_com = [${entry({})},];`;
    expect(parseKiwiList(text).map((r) => r.host)).toEqual(["a.example"]);
  });

  it("drops a band range wider than a Kiwi can tune", () => {
    expect(() => one({ bands: "0-1000000000" })).toThrow(/no usable receivers/);
    expect(one({ bands: "110000000-142000000" })[0]!.minKhz).toBe(110_000);
  });

  it("accepts numeric fields in case the mirror stops quoting them", () => {
    expect(one({ users: 3, users_max: 8, snr: 30 })[0]).toMatchObject({ users: 3, usersMax: 8, snr: 30 });
  });

  // Value: protects=operator text and file shape changes can't corrupt or break the parse; fails_when=parsing goes back to regex/lastIndexOf; why_new=trailing-comma regex rewrote string contents; seam=none; no_claim=non-JSON entries
  it("parses string-safely: brackets and trailing commas inside text are left alone", () => {
    const text = `var kiwisdr_com = [${entry({ name: "Odd, ] name, }" })},]; var other = [1];`;
    expect(parseKiwiList(text)[0]!.name).toBe("Odd, ] name, }");
  });

  // Value: protects=a quote or backslash in operator text can't end a string early and break the list; fails_when=the escape branch in extractEntries is removed; why_new=no input had escapes; seam=none; no_claim=non-JSON escapes
  it("handles escaped quotes and backslashes inside operator text", () => {
    const [r] = one({ name: 'He said "hi ]", ok', antenna: "C:\\" });
    expect(r!.name).toBe('He said "hi ]", ok');
    expect(r!.antenna).toBe("C:\\");
  });

  // Value: protects=parsing stays linear on a large untrusted body; fails_when=the parser rescans its output per bracket (it took minutes on crafted input); why_new=no size test existed; seam=none; no_claim=absolute speed on slow hosts
  it("parses a megabyte of entries quickly", () => {
    const text = `var kiwisdr_com = [${"{},".repeat(330_000)}${entry({})},];`;
    const t0 = performance.now();
    expect(parseKiwiList(text)).toHaveLength(1);
    // gstack-timing-ok: guards against quadratic blow-up (seconds+), not micro speed
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  // Value: protects=one operator's JS-only text can't blank the whole list; fails_when=the list goes back to a single JSON.parse; why_new=adversarial review: one bad escape failed every refresh; seam=none; no_claim=every JS syntax
  it("drops only the entry it can't read", () => {
    const bad = `{"status":"active","offline":"no","url":"http://b.example:8073","bands":"0-30000000","name":"\\x41"}`;
    const text = `var kiwisdr_com = [${entry({})},${bad},${entry({ url: "http://c.example:8073" })},];`;
    expect(parseKiwiList(text).map((r) => r.host)).toEqual(["a.example", "c.example"]);
  });

  // Value: protects=unparseable mirror URLs don't become rows that can only fail; fails_when=toReceiver trusts parseReceiver's pass-through; why_new=Codex: "http://bad host" was listed; seam=none; no_claim=URLs the browser and Python parse differently
  it.each(["http://bad host:8073", "http://2001:db8::1:8073"])("drops the unparseable URL %s", (url) => {
    expect(() => one({ url })).toThrow(/no usable receivers/);
  });

  it("skips receivers that aren't active", () => {
    expect(() => one({ status: "inactive" })).toThrow(/no usable receivers/);
  });

  it("treats a receiver with no listed capacity as full, so it ranks last", () => {
    const [r] = one({ users: "0" });
    expect(r).toMatchObject({ users: 0, usersMax: 0 });
    expect(rankReceivers([r!, rx("open", { snr: 1 })], 10_000).map((x) => x.host)).toEqual(["open", "a.example"]);
  });

  // Value: protects=Pick best never auto-dials a LAN address from the list, even where private hosts are allowed; fails_when=isPrivateHost is removed or misses a range; why_new=relied on ALLOW_PRIVATE_HOSTS being off; seam=none; no_claim=DNS names that resolve privately (hostguard's job)
  it.each([
    "http://192.168.1.1:8073",
    "http://10.0.0.5:8073",
    "http://172.20.0.1:8073",
    "http://127.0.0.1:8765",
    "http://100.100.1.1:8073",
    "http://[::1]:8073",
    "http://[fd00::1]:8073",
    "http://localhost:8073",
    "http://kiwi.local:8073",
    "http://kiwi.lan:8073",
    "http://nas.lan.:8073",
    "http://169.254.169.254:8073",
    "http://0.0.0.0:8073",
    "http://[fe80::1]:8073",
    "http://[::ffff:192.168.1.1]:8073",
    "http://[::ffff:127.0.0.1]:8073",
    // Ranges the radio service also refuses: 6to4, NAT64, IPv4-compatible,
    // multicast, reserved, documentation and benchmarking nets.
    "http://[2002:c0a8:101::1]:8073",
    "http://[64:ff9b::a00:1]:8073",
    "http://[::10.0.0.1]:8073",
    "http://[ff02::1]:8073",
    "http://[2001:db8::1]:8073",
    "http://224.0.0.1:8073",
    "http://239.255.255.250:8073",
    "http://240.0.0.1:8073",
    "http://255.255.255.255:8073",
    "http://198.18.0.1:8073",
    "http://192.0.2.1:8073",
    "http://203.0.113.9:8073",
  ])("drops list entries on private address %s", (url) => {
    expect(() => one({ url })).toThrow(/no usable receivers/);
  });

  it("keeps public addresses that look a bit like private ones", () => {
    expect(one({ url: "http://172.32.0.1:8073" })[0]!.host).toBe("172.32.0.1");
    expect(one({ url: "http://locality.example.net:8073" })[0]!.host).toBe("locality.example.net");
    expect(one({ url: "http://[::ffff:8.8.8.8]:8073" })[0]!.port).toBe(8073);
    expect(one({ url: "http://198.20.0.1:8073" })[0]!.host).toBe("198.20.0.1");
    expect(one({ url: "http://223.255.255.1:8073" })[0]!.host).toBe("223.255.255.1");
    expect(one({ url: "http://[2001:4860::8888]:8073" })[0]!.host).toBe("2001:4860::8888");
  });

  it("lists a receiver that appears twice only once", () => {
    const text = `var kiwisdr_com = [${entry({ id: "x" })},${entry({ id: "y" })}];`;
    expect(parseKiwiList(text)).toHaveLength(1);
  });

  it("treats an SNR of 0 as unmeasured", () => {
    expect(byHost("hasenberg04.proxy.kiwisdr.com")?.snr).toBeNull();
  });

  it("uses the band range as the tunable range, offset already applied", () => {
    expect(byHost("hasenberg04.proxy.kiwisdr.com")).toMatchObject({ minKhz: 110_000, maxKhz: 142_000 });
    expect(byHost("sdr.k1vl.com")).toMatchObject({ minKhz: 10, maxKhz: 30_000 });
  });

  it.each([
    ["a page with no array", "<html>Service unavailable</html>", /no array/],
    ["an object with no array", 'var kiwisdr_com = {"a": 1};', /no array/],
    ["a file cut off mid-list", 'var kiwisdr_com = [{"a": 1},', /never closes/],
    ["an array with no usable receivers", "var kiwisdr_com = [1, null, {}];", /no usable receivers/],
  ])("throws on %s", (_, text, message) => {
    expect(() => parseKiwiList(text)).toThrow(message);
  });

  it("skips entries that are offline or malformed", () => {
    const text = `var kiwisdr_com = [
      {"status":"active","offline":"yes","url":"http://a.example:8073","bands":"0-30000000"},
      {"status":"active","offline":"no","url":"http://b.example:8073","bands":"junk"},
      {"status":"active","offline":"no","url":"http://c.example:8073","bands":"0-30000000"},
      null,
    ];`;
    expect(parseKiwiList(text).map((r) => r.host)).toEqual(["c.example"]);
  });

  // Value: protects=only real positions place a receiver on the map; fails_when=the gps parser accepts junk, swaps lat/lon or keeps (0, 0); why_new=gps was ignored before the receiver map; seam=none; no_claim=a Kiwi's position being accurate
  it.each([
    ["(59.546000, 12.526000)", { lat: 59.546, lon: 12.526 }],
    ["(-33.86,151.21)", { lat: -33.86, lon: 151.21 }],
    [" ( 0, 12.5 ) ", { lat: 0, lon: 12.5 }],
    ["(0.000000, 0.000000)", {}],
    ["(91, 10)", {}],
    ["(10, -181)", {}],
    ["", {}],
    ["59.5, 12.5", {}],
    ["(abc, 1)", {}],
  ])("reads gps %j", (raw, position) => {
    expect(parseGps(raw)).toEqual(position);
  });

  it("puts a receiver's position on it only when the list has one", () => {
    expect(one({ gps: "(59.546000, 12.526000)" })[0]).toMatchObject({ lat: 59.546, lon: 12.526 });
    expect(one({ gps: "(0.000000, 0.000000)" })[0]).not.toHaveProperty("lat");
    expect(one({})[0]).not.toHaveProperty("lon");
  });

  // Value: protects=receivers that refuse apps (ext_api=0) are never offered or picked; fails_when=the ext_api check is removed or matches the missing field; why_new=Pick best handed listeners a receiver that hangs up after 10 s; seam=none; no_claim=owners changing the setting between list refreshes
  it("skips receivers that allow no app connections", () => {
    const text = `var kiwisdr_com = [${[
      entry({ url: "http://a.example:8073", ext_api: "0" }),
      entry({ url: "http://b.example:8073", ext_api: 0 }),
      entry({ url: "http://c.example:8073", ext_api: "1" }),
      entry({ url: "http://d.example:8073" }),
    ].join(",")}];`;
    expect(parseKiwiList(text).map((r) => r.host)).toEqual(["c.example", "d.example"]);
  });
});

function rx(host: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: host,
    name: host,
    location: "",
    antenna: "",
    host,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    ...over,
  };
}

// Value: protects=volunteers' pipe-separated locations read as place names in the status line and phone rows; fails_when=separators, spacing or empty parts leak through; why_new=placeName is new (design D9, eng R10); seam=none; no_claim=how every volunteer writes a location
describe("placeName", () => {
  it.each([
    ["Assen | Netherlands", "Assen, Netherlands"],
    ["Milford, PA", "Milford, PA"],
    ["  | Twente |  | NL ", "Twente, NL"],
    ["", ""],
    [" | ", ""],
  ])("%j reads %j", (location, place) => {
    expect(placeName(location)).toBe(place);
  });
});

describe("rankReceivers", () => {
  const hosts = (list: Receiver[]) => list.map((r) => r.host);

  it("puts the highest HF SNR first", () => {
    expect(
      hosts(rankReceivers([rx("low", { snr: 10 }), rx("high", { snr: 40 }), rx("mid", { snr: 25 })], 10_000)),
    ).toEqual(["high", "mid", "low"]);
  });

  it("ranks receivers listed as full last instead of dropping them", () => {
    const ranked = rankReceivers([rx("full", { snr: 50, users: 8 }), rx("open", { snr: 10 })], 10_000);
    expect(hosts(ranked)).toEqual(["open", "full"]);
  });

  it("drops receivers that can't tune the frequency", () => {
    const ranked = rankReceivers([rx("airband", { minKhz: 110_000, maxKhz: 142_000 }), rx("hf")], 10_000);
    expect(hosts(ranked)).toEqual(["hf"]);
  });

  it("breaks SNR ties by free slots, and puts unmeasured SNR after measured", () => {
    const ranked = rankReceivers(
      [rx("unmeasured", { snr: null }), rx("busy", { users: 6 }), rx("quiet", { users: 1 })],
      10_000,
    );
    expect(hosts(ranked)).toEqual(["quiet", "busy", "unmeasured"]);
  });

  // Value: protects=listeners don't all converge on the first of several equally good receivers, while one page's order stays put; fails_when=ties fall back to mirror order or reshuffle per call; why_new=TODOS parser hardening; seam=none; no_claim=how evenly real listeners spread
  it("breaks full ties in an order that isn't the mirror's but holds for this page", () => {
    const tied = Array.from({ length: 20 }, (_, i) => rx(`t${i}`));
    const first = hosts(rankReceivers(tied, 10_000));
    expect(first).not.toEqual(hosts(tied));
    expect(hosts(rankReceivers([...tied].reverse(), 10_000))).toEqual(first);
  });
});
