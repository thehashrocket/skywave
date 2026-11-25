"use client";

import { useEffect, useRef, useState } from "react";
import {
  CONSENT_STORAGE_KEY,
  type ConsentChoice,
  OPEN_CONSENT_EVENT,
  gtmId,
  loadTagManager,
  parseConsent,
  readConsent,
  revokeTagManager,
  writeConsent,
} from "@/lib/analytics-consent";

/** Loads or withdraws Tag Manager for an answer. */
function apply(id: string, value: ConsentChoice): void {
  if (value === "granted") loadTagManager(id);
  else revokeTagManager();
}

/**
 * Asks before loading Google Tag Manager, and loads it only after Accept.
 * Renders nothing where NEXT_PUBLIC_GTM_ID is unset. On a first visit the bar
 * sits along the bottom edge without taking focus, so the page stays usable;
 * opened from the footer's Cookie settings, it takes focus so screen readers
 * land on it. An answer given in another tab applies here too.
 */
export function AnalyticsConsent() {
  const id = gtmId();
  const [asking, setAsking] = useState(false);
  const focusOnShow = useRef(false);
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!id) return;
    const consent = readConsent();
    if (consent === "granted") loadTagManager(id);
    else if (consent === null) setAsking(true);
    const open = () => {
      focusOnShow.current = true;
      setAsking(true);
      bar.current?.focus(); // already showing: no re-render, so focus here
    };
    const otherTab = (e: StorageEvent) => {
      if (e.key !== CONSENT_STORAGE_KEY) return;
      const value = parseConsent(e.newValue);
      if (!value) return;
      apply(id, value);
      setAsking(false);
    };
    window.addEventListener(OPEN_CONSENT_EVENT, open);
    window.addEventListener("storage", otherTab);
    return () => {
      window.removeEventListener(OPEN_CONSENT_EVENT, open);
      window.removeEventListener("storage", otherTab);
    };
  }, [id]);

  useEffect(() => {
    if (asking && focusOnShow.current) bar.current?.focus();
    focusOnShow.current = false;
  }, [asking]);

  if (!id || !asking) return null;

  const answer = (value: ConsentChoice) => {
    writeConsent(value);
    apply(id, value);
    setAsking(false);
  };

  return (
    <section ref={bar} tabIndex={-1} className="analytics-consent" aria-labelledby="analytics-consent-text">
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
