"use client";

import { useEffect, useState } from "react";
import {
  type ConsentChoice,
  OPEN_CONSENT_EVENT,
  gtmId,
  loadTagManager,
  readConsent,
  revokeTagManager,
  writeConsent,
} from "@/lib/analytics-consent";

/**
 * Asks before loading Google Tag Manager, and loads it only after Accept.
 * Renders nothing where NEXT_PUBLIC_GTM_ID is unset. The bar sits along the
 * bottom edge and never takes focus, so the page stays usable while it's up.
 */
export function AnalyticsConsent() {
  const id = gtmId();
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!id) return;
    const consent = readConsent();
    if (consent === "granted") loadTagManager(id);
    else if (consent === null) setAsking(true);
    const open = () => setAsking(true);
    window.addEventListener(OPEN_CONSENT_EVENT, open);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, open);
  }, [id]);

  if (!id || !asking) return null;

  const answer = (value: ConsentChoice) => {
    writeConsent(value);
    if (value === "granted") loadTagManager(id);
    else revokeTagManager();
    setAsking(false);
  };

  return (
    <section className="analytics-consent" aria-labelledby="analytics-consent-text">
      <p id="analytics-consent-text">
        May skywave use Google Analytics cookies to count visits? Nothing loads unless you accept.
      </p>
      <span className="analytics-consent-answers">
        <button type="button" className="link-button inline" onClick={() => answer("granted")}>
          Accept
        </button>
        <button type="button" className="link-button inline" onClick={() => answer("denied")}>
          Decline
        </button>
      </span>
    </section>
  );
}

/** The footer's way back to the banner, to change or withdraw an answer. */
export function CookieSettingsButton() {
  if (!gtmId()) return null;
  return (
    <>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        className="link-button inline"
        onClick={() => window.dispatchEvent(new Event(OPEN_CONSENT_EVENT))}
      >
        Cookie settings
      </button>
    </>
  );
}
