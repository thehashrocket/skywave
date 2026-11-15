import { afterEach, describe, expect, it, vi } from "vitest";

// SERVICE_URL is read once at module load, so each case imports a fresh copy.
async function messageFor(url: string | undefined) {
  vi.resetModules();
  if (url === undefined) vi.stubEnv("NEXT_PUBLIC_RADIO_WS_URL", undefined as unknown as string);
  else vi.stubEnv("NEXT_PUBLIC_RADIO_WS_URL", url);
  const { unreachableMessage } = await import("./use-radio");
  return unreachableMessage();
}

describe("unreachableMessage", () => {
  afterEach(() => vi.unstubAllEnvs());

  // Value: protects=listeners on the live site get advice they can act on (a VPN or blocker filtering the radio host) instead of a developer command; fails_when=production shows "pnpm dev:radio" or doesn't name the blocked host; why_new=NordVPN Threat Protection blocked radio.jasonshultz.com on an iPhone and the page said to run pnpm; seam=env stub + fresh import; no_claim=which filters block what
  it("names the blocked host and the likely blocker in production", async () => {
    const msg = await messageFor("wss://radio.example.com/ws");
    expect(msg).toMatch(/VPN, ad blocker or firewall/);
    expect(msg).toContain("radio.example.com");
    expect(msg).not.toMatch(/pnpm/);
  });

  // Value: protects=a developer without the service running still gets told how to start it; fails_when=the local check misses localhost or the default URL; why_new=production wording split from dev; seam=env stub; no_claim=none
  it.each([undefined, "ws://localhost:8765/ws", "ws://127.0.0.1:8765/ws", "ws://[::1]:8765/ws"])(
    "keeps the developer hint for a local service (%s)",
    async (url) => {
      expect(await messageFor(url)).toMatch(/pnpm dev:radio/);
    },
  );
});
