const STORAGE_KEY = "skywave.analyticsConsent";

/** Sent by the footer's "Cookie settings" to ask the banner to show again. */
export const OPEN_CONSENT_EVENT = "skywave:open-analytics-consent";

export type ConsentChoice = "granted" | "denied";

let current: ConsentChoice | null = null;
let loaded = false;
let revoked = false;

/**
 * The Google Tag Manager container ID, or null where analytics are off. Set
 * NEXT_PUBLIC_GTM_ID for Production only in Vercel, so previews and local dev
 * never ask or load anything.
 */
export function gtmId(): string | null {
  return process.env.NEXT_PUBLIC_GTM_ID || null;
}

/**
 * What this browser said about analytics cookies, or null if it hasn't said.
 * Kept in localStorage; where storage throws, the answer lasts for this page.
 */
export function readConsent(): ConsentChoice | null {
  if (current) return current;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "granted" || stored === "denied") return (current = stored);
  } catch {
    /* storage unavailable: ask again */
  }
  return null;
}

export function writeConsent(value: ConsentChoice): void {
  current = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* kept in memory only */
  }
}

type GtmWindow = Window & { dataLayer?: unknown[] };

/**
 * Pushes to the dataLayer the way Google's gtag() does. Tag Manager reads
 * command pushes only as an Arguments object, not an array, so this pushes
 * `arguments` and leaves the rest parameter unused.
 */
function gtag(..._args: unknown[]): void {
  const w = window as GtmWindow;
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push(arguments);
}

/**
 * Google's Tag Manager snippet, run once per page and only after consent. On
 * a page where consent was withdrawn and then given again, grants storage
 * back instead of loading a second container.
 */
export function loadTagManager(id: string): void {
  if (loaded) {
    if (revoked) setStorage("granted");
    return;
  }
  loaded = true;
  gtag("js", new Date());
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);
}

/**
 * Withdrawn consent on a page where Tag Manager already runs: tell its tags to
 * stop using cookies and delete Google Analytics' own. The page isn't
 * reloaded, which would cut the audio; the next visit loads nothing.
 */
export function revokeTagManager(): void {
  if (!loaded) return;
  setStorage("denied");
  clearGoogleAnalyticsCookies();
}

function setStorage(value: ConsentChoice): void {
  revoked = value === "denied";
  gtag("consent", "update", {
    ad_storage: value,
    analytics_storage: value,
    ad_user_data: value,
    ad_personalization: value,
  });
}

/** Expires _ga and _ga_* on this host and each parent domain GA may have used. */
function clearGoogleAnalyticsCookies(): void {
  const names = document.cookie
    .split(";")
    .map((c) => c.split("=")[0]!.trim())
    .filter((n) => n === "_ga" || n.startsWith("_ga_"));
  const parts = location.hostname.split(".");
  const domains = [""];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join(".")}`);
  for (const name of names)
    for (const domain of domains) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
}

/** Tests only: forget the in-memory answer and Tag Manager's state, as a reload would. */
export function resetAnalyticsConsentForTests(): void {
  current = null;
  loaded = false;
  revoked = false;
}
