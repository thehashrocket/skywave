// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTagManager,
  readConsent,
  resetAnalyticsConsentForTests,
  revokeTagManager,
  writeConsent,
} from "./analytics-consent";
import { commands, dataLayer, gtmScripts, resetGtmPage } from "@/test/gtm-page";

beforeEach(resetGtmPage);
afterEach(() => vi.restoreAllMocks());

describe("analytics consent", () => {
  // Value: protects=a visitor's Accept or Decline survives a reload, and a value the page didn't write counts as no answer; fails_when=the key or values change, or junk in storage is read as consent; why_new=GTM consent banner; seam=localStorage; no_claim=cross-tab sync
  it("keeps the answer across page loads and ignores values it didn't write", () => {
    expect(readConsent()).toBeNull();
    writeConsent("denied");
    resetAnalyticsConsentForTests();
    expect(readConsent()).toBe("denied");

    localStorage.setItem("skywave.analyticsConsent", "yes");
    resetAnalyticsConsentForTests();
    expect(readConsent()).toBeNull();
  });

  // Value: protects=with storage blocked an answer still holds for the page, so the banner doesn't come back or flip after a click; fails_when=writeConsent only writes storage; why_new=GTM consent banner; seam=Storage spies; no_claim=answers across page loads with storage blocked (there are none)
  it("holds the answer for the page when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    writeConsent("granted");
    expect(readConsent()).toBe("granted");
  });

  // Value: protects=Google's snippet runs as given (async gtm.js with the container ID, the gtm.js start event that fires page-view triggers, gtag 'js'), once per page, with ad storage defaulting to denied because the bar asks about analytics only; fails_when=the gtm.js event or consent default is dropped, ads are granted, the script URL changes, or a second Accept adds a second container; why_new=GTM consent banner, and its review; seam=document.head and dataLayer; no_claim=the script loading from Google or GTM honouring consent
  it("loads Google's Tag Manager snippet once, with ad storage denied", () => {
    loadTagManager("GTM-TEST123");
    loadTagManager("GTM-TEST123");
    const scripts = gtmScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-TEST123");
    expect(scripts[0]!.async).toBe(true);
    const layer = dataLayer();
    expect(layer).toHaveLength(3);
    expect(layer[0]).toEqual([
      "consent",
      "default",
      { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" },
    ]);
    expect((layer[1] as unknown[])[0]).toBe("js");
    expect(layer[2]).toMatchObject({ event: "gtm.js", "gtm.start": expect.any(Number) });
  });

  // Value: protects=withdrawing consent on a page where GTM runs denies all storage, switches off each GA property GTM loaded so no more hits go out, and deletes Google's analytics and ads cookies, without touching anything when GTM never loaded; fails_when=the consent update, ga-disable flag or cookie clearing is dropped, a Google cookie kind is missed, or revoke pushes to a dataLayer GTM never read; why_new=GTM consent banner, and its review; seam=dataLayer, window.google_tag_manager and document.cookie; no_claim=GA honouring ga-disable, cookies on a domain jsdom can't model, non-Google tags in the container
  it("turns off Google Analytics and deletes Google's cookies when consent is withdrawn", () => {
    revokeTagManager();
    expect(dataLayer()).toEqual([]);

    loadTagManager("GTM-TEST123");
    const w = window as unknown as Record<string, unknown>;
    w.google_tag_manager = { "GTM-TEST123": {}, "G-ABC123": {} };
    for (const c of ["_ga=1", "_ga_ABC=2", "_gid=3", "_gat_UA=4", "_gcl_au=5", "keep=1"])
      document.cookie = `${c}; path=/`;
    revokeTagManager();
    expect(commands("consent").at(-1)).toEqual([
      "consent",
      "update",
      { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" },
    ]);
    expect(w["ga-disable-G-ABC123"]).toBe(true);
    expect(w["ga-disable-GTM-TEST123"]).toBeUndefined();
    expect(document.cookie).toBe("keep=1");
    document.cookie = "keep=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  // Value: protects=declining then accepting again on the same page turns analytics (only) back on instead of leaving GTM off until the next load; fails_when=loadTagManager returns early without a grant after a revoke, the re-grant grants ad storage, ga-disable stays set, or a second container loads; why_new=review of the GTM consent banner; seam=dataLayer and window flags; no_claim=GTM honouring the update
  it("turns analytics back on when consent is given again on the same page", () => {
    loadTagManager("GTM-TEST123");
    loadTagManager("GTM-TEST123");
    expect(commands("consent")).toHaveLength(1);
    const w = window as unknown as Record<string, unknown>;
    w.google_tag_manager = { "G-ABC123": {} };
    revokeTagManager();
    loadTagManager("GTM-TEST123");
    expect(commands("consent").at(-1)).toEqual(["consent", "update", { analytics_storage: "granted" }]);
    expect(w["ga-disable-G-ABC123"]).toBe(false);
    expect(gtmScripts()).toHaveLength(1);
  });
});
