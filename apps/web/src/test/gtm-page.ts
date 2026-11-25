import { resetAnalyticsConsentForTests } from "@/lib/analytics-consent";

export type GtmWindow = Window & { dataLayer?: (IArguments | object)[] } & Record<string, unknown>;

/** The Tag Manager scripts on the page. */
export const gtmScripts = () =>
  document.head.querySelectorAll<HTMLScriptElement>('script[src^="https://www.googletagmanager.com/gtm.js"]');

/** The dataLayer's pushes: gtag() commands as plain arrays, event objects as they are. */
export const dataLayer = (): unknown[] =>
  ((window as unknown as GtmWindow).dataLayer ?? []).map((a) =>
    Object.prototype.toString.call(a) === "[object Arguments]" ? [...(a as IArguments)] : a,
  );

/** The dataLayer's gtag() commands of one kind, e.g. "consent". */
export const commands = (name: string): unknown[][] =>
  dataLayer().filter((p): p is unknown[] => Array.isArray(p) && p[0] === name);

/** A fresh first visit: no stored answer, no Tag Manager script, no dataLayer. */
export function resetGtmPage(): void {
  localStorage.clear();
  resetAnalyticsConsentForTests();
  const w = window as unknown as GtmWindow;
  delete w.dataLayer;
  delete w.google_tag_manager;
  for (const key of Object.keys(w)) if (key.startsWith("ga-disable-")) delete w[key];
  for (const s of gtmScripts()) s.remove();
}
