// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTagManager,
  readConsent,
  resetAnalyticsConsentForTests,
  revokeTagManager,
  writeConsent,
} from "./analytics-consent";
import { dataLayer, gtmScripts, resetGtmPage } from "@/test/gtm-page";

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

  // Value: protects=Google's snippet runs as given (dataLayer 'js' push, async gtm.js with the container ID) and only once per page; fails_when=the script URL or ID changes, or a second Accept adds a second container; why_new=GTM consent banner; seam=document.head; no_claim=the script actually loading from Google
  it("loads Google's Tag Manager snippet once", () => {
    loadTagManager("GTM-T85M8RFM");
    loadTagManager("GTM-T85M8RFM");
    const scripts = gtmScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-T85M8RFM");
    expect(scripts[0]!.async).toBe(true);
    expect(dataLayer()).toHaveLength(1);
    expect(dataLayer()[0]![0]).toBe("js");
  });

  // Value: protects=withdrawing consent on a page where GTM runs denies its storage and deletes GA's cookies, without touching anything when GTM never loaded; fails_when=the consent update or cookie clearing is dropped, or revoke pushes to a dataLayer GTM never read; why_new=GTM consent banner; seam=dataLayer and document.cookie; no_claim=GTM honouring the update, cookies GA set on a domain jsdom can't model
  it("denies storage and deletes GA cookies when consent is withdrawn", () => {
    revokeTagManager();
    expect(dataLayer()).toEqual([]);

    loadTagManager("GTM-T85M8RFM");
    document.cookie = "_ga=GA1.1.123; path=/";
    document.cookie = "_ga_ABC=GS1.1.456; path=/";
    document.cookie = "keep=1; path=/";
    revokeTagManager();
    expect(dataLayer().at(-1)).toEqual([
      "consent",
      "update",
      { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" },
    ]);
    expect(document.cookie).toBe("keep=1");
    document.cookie = "keep=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  // Value: protects=declining then accepting again on the same page turns Google's storage back on instead of leaving GTM denied until the next load, and a first Accept sends no stray consent update; fails_when=loadTagManager returns early without a grant after a revoke, or loads a second container; why_new=review of the GTM consent banner; seam=dataLayer; no_claim=GTM honouring the update
  it("grants storage back when consent is given again on the same page", () => {
    loadTagManager("GTM-T85M8RFM");
    loadTagManager("GTM-T85M8RFM");
    expect(dataLayer().filter((push) => push[0] === "consent")).toEqual([]);
    revokeTagManager();
    loadTagManager("GTM-T85M8RFM");
    expect(dataLayer().at(-1)).toEqual([
      "consent",
      "update",
      { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
    ]);
    expect(gtmScripts()).toHaveLength(1);
  });
});
