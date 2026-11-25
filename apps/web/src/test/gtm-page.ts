import { resetAnalyticsConsentForTests } from "@/lib/analytics-consent";

export type GtmWindow = Window & { dataLayer?: IArguments[] };

/** The Tag Manager scripts on the page. */
export const gtmScripts = () =>
  document.head.querySelectorAll<HTMLScriptElement>('script[src^="https://www.googletagmanager.com/gtm.js"]');

/** The dataLayer's pushes as plain arrays. */
export const dataLayer = () => ((window as GtmWindow).dataLayer ?? []).map((a) => [...a]);

/** A fresh first visit: no stored answer, no Tag Manager script, no dataLayer. */
export function resetGtmPage(): void {
  localStorage.clear();
  resetAnalyticsConsentForTests();
  delete (window as GtmWindow).dataLayer;
  for (const s of gtmScripts()) s.remove();
}
