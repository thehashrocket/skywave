export const CONSENT_STORAGE_KEY = "skywave.analyticsConsent";

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
    return parseConsent(localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null; /* storage unavailable: ask again */
  }
}

/** A stored value as an answer (remembered for the page), or null if it isn't one. */
export function parseConsent(stored: string | null): ConsentChoice | null {
  return stored === "granted" || stored === "denied" ? (current = stored) : null;
}

export function writeConsent(value: ConsentChoice): void {
  current = value;
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    /* kept in memory only */
  }
}

/** The globals Google's scripts read and write: dataLayer, google_tag_manager, ga-disable-G-…. */
type GtmWindow = {
  dataLayer?: unknown[];
  google_tag_manager?: Record<string, unknown>;
  [gaDisable: `ga-disable-${string}`]: boolean;
};

const gtmWindow = () => window as unknown as GtmWindow;

/**
 * Pushes to the dataLayer the way Google's gtag() does. Tag Manager reads
 * command pushes only as an Arguments object, not an array, so this pushes
 * `arguments` and leaves the rest parameter unused.
 */
function gtag(..._args: unknown[]): void {
  const w = gtmWindow();
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push(arguments);
}

/**
 * Google's Tag Manager snippet, run once per page and only after consent. The
 * visitor agreed to analytics only, so ad storage defaults to denied. The
 * `gtm.js` event is what fires the container's page-view triggers. On a page
 * where consent was withdrawn and then given again, turns analytics back on
 * instead of loading a second container.
 */
export function loadTagManager(id: string): void {
  if (loaded) {
    if (revoked) setAnalytics(true);
    return;
  }
  loaded = true;
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "granted",
  });
  gtag("js", new Date());
  gtmWindow().dataLayer!.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);
}

/**
 * Withdrawn consent on a page where Tag Manager already runs: deny storage,
 * switch off each Google Analytics property it loaded, and delete Google's
 * cookies. The page isn't reloaded, which would cut the audio; Tag Manager
 * itself stays until the page closes, and the next visit loads nothing.
 */
export function revokeTagManager(): void {
  if (!loaded) return;
  setAnalytics(false);
  clearGoogleCookies();
}

const ALL_DENIED = {
  ad_storage: "denied",
  analytics_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

function setAnalytics(on: boolean): void {
  revoked = !on;
  const w = gtmWindow();
  // Tag Manager lists each Google tag it loaded (G-…) as a key, and GA checks
  // window['ga-disable-G-…'] before it sends anything.
  for (const key of Object.keys(w.google_tag_manager ?? {})) if (key.startsWith("G-")) w[`ga-disable-${key}`] = !on;
  gtag("consent", "update", on ? { analytics_storage: "granted" } : ALL_DENIED);
}

/** Google's analytics and ads cookies: _ga, _ga_*, _gid, _gat*, _gcl_*. */
const GOOGLE_COOKIE = /^(_ga|_ga_.+|_gid|_gat.*|_gcl_.+)$/;

/** Expires Google's cookies on this host and each parent domain they may use. */
function clearGoogleCookies(): void {
  const names = document.cookie
    .split(";")
    .map((c) => c.split("=")[0]!.trim())
    .filter((n) => GOOGLE_COOKIE.test(n));
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
