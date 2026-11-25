// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAnalyticsConsentForTests } from "@/lib/analytics-consent";
import { commands, gtmScripts, resetGtmPage } from "@/test/gtm-page";
import { AnalyticsConsent } from "./AnalyticsConsent";
import { SiteFooter } from "./SiteFooter";

const banner = () => screen.queryByRole("region", { name: /Google Analytics/ });

beforeEach(() => {
  resetGtmPage();
  vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-TEST123");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("AnalyticsConsent", () => {
  // Value: protects=previews and local dev (no NEXT_PUBLIC_GTM_ID) show no banner, no footer link and load nothing; fails_when=the env check is dropped or the ID is hardcoded; why_new=GTM consent banner; seam=env stub; no_claim=Vercel's per-environment variables
  it("does nothing where no container ID is set", () => {
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "");
    render(
      <>
        <AnalyticsConsent />
        <SiteFooter />
      </>,
    );
    expect(banner()).toBeNull();
    expect(screen.queryByRole("button", { name: "Cookie settings" })).toBeNull();
    expect(gtmScripts()).toHaveLength(0);
  });

  // Value: protects=Tag Manager loads only after Accept, never just from showing the banner; fails_when=GTM loads on mount or on Decline; why_new=GTM consent banner; seam=document.head; no_claim=Google's script running
  it("asks first and loads Tag Manager only after Accept", () => {
    render(<AnalyticsConsent />);
    expect(banner()).not.toBeNull();
    expect(gtmScripts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(banner()).toBeNull();
    expect(gtmScripts()).toHaveLength(1);
  });

  // Value: protects=a Decline is remembered: no banner and nothing loaded on later visits; fails_when=Decline isn't stored or a stored denial still loads GTM; why_new=GTM consent banner; seam=localStorage; no_claim=none beyond protects
  it("remembers Decline and loads nothing on the next visit", () => {
    render(<AnalyticsConsent />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    cleanup();
    resetAnalyticsConsentForTests();
    render(<AnalyticsConsent />);
    expect(banner()).toBeNull();
    expect(gtmScripts()).toHaveLength(0);
  });

  // Value: protects=a returning visitor who accepted gets Tag Manager without being asked again; fails_when=a stored grant is ignored or re-asks; why_new=GTM consent banner; seam=localStorage; no_claim=none beyond protects
  it("loads straight away for a visitor who already accepted", () => {
    localStorage.setItem("skywave.analyticsConsent", "granted");
    render(<AnalyticsConsent />);
    expect(banner()).toBeNull();
    expect(gtmScripts()).toHaveLength(1);
  });

  // Value: protects=the footer's Cookie settings (in player mode too) reopens the banner, and Decline then withdraws consent in place with a GTM consent update; fails_when=the button or event wiring breaks, or withdrawal doesn't reach the dataLayer; why_new=GTM consent banner; seam=window event between footer and banner; no_claim=that no reload happens (jsdom can't observe one; the code has none)
  it("reopens from the footer and withdraws consent on Decline", () => {
    localStorage.setItem("skywave.analyticsConsent", "granted");
    render(
      <>
        <AnalyticsConsent />
        <SiteFooter onPlayer />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cookie settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(banner()).toBeNull();
    expect(localStorage.getItem("skywave.analyticsConsent")).toBe("denied");
    expect(commands("consent").at(-1)!.slice(0, 2)).toEqual(["consent", "update"]);
  });

  // Value: protects=a screen-reader user who opens Cookie settings lands on the bar (focus moves to it), while a first visit's bar still never takes focus; fails_when=focus stays on the footer button, or the first-visit bar starts grabbing focus; why_new=review of the GTM consent banner; seam=document.activeElement; no_claim=what a given screen reader announces
  it("moves focus to the bar only when Cookie settings opens it", () => {
    render(
      <>
        <AnalyticsConsent />
        <SiteFooter />
      </>,
    );
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Cookie settings" }));
    expect(document.activeElement).toBe(banner());
  });

  // Value: protects=an answer given in another tab applies here: Decline there stops GTM in this tab, Accept there loads it and closes this tab's bar; fails_when=the storage listener is dropped, checks the wrong key, or ignores one answer; why_new=review of the GTM consent banner; seam=a dispatched StorageEvent; no_claim=real cross-tab delivery by the browser
  it("follows an answer given in another tab", () => {
    render(<AnalyticsConsent />);
    expect(banner()).not.toBeNull();
    const fromOtherTab = (newValue: string) =>
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key: "skywave.analyticsConsent", newValue }));
      });
    fromOtherTab("granted");
    expect(banner()).toBeNull();
    expect(gtmScripts()).toHaveLength(1);
    fromOtherTab("denied");
    expect(commands("consent").at(-1)).toEqual([
      "consent",
      "update",
      { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" },
    ]);
  });
});
