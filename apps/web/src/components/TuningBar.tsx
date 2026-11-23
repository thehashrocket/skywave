"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { PowerButton } from "@/components/PowerButton";
import { formatKhz, MODE_LABELS, MODES, type Mode } from "@/lib/radio-types";

/**
 * The bar pinned to the top of the window once the frequency and modes have
 * scrolled up out of view (#90): the frequency, the modes, the receiver and
 * Listen/Stop, so a listener down in the presets or the station lists doesn't
 * scroll back up for them.
 *
 *   sentinel: page top ─► bottom of `watch` (the mode group), less the bar's height
 *   sentinel in view       ─► hidden (the main controls show; never both)
 *   sentinel scrolled past ─► shown
 *   keyboard focus inside the bar ─► stays shown until focus leaves it
 *
 * The sentinel starts at the page top, so it is either in view or scrolled
 * past: a jump straight down the page still crosses its edge, which a watch on
 * the controls themselves could miss. Hidden is the `hidden` attribute, so the
 * bar is out of the tab order and the accessibility tree, not just out of
 * sight. Without IntersectionObserver the bar never shows.
 */
export function TuningBar({
  watch,
  freqKhz,
  mode,
  onMode,
  busy,
  onPower,
  receiverText,
  onChangeReceiver,
}: {
  /** The element whose bottom edge, once under the bar, shows the bar. */
  watch: RefObject<HTMLElement | null>;
  freqKhz: number;
  mode: Mode;
  onMode: (m: Mode) => void;
  busy: boolean;
  /** Runs on a Listen/Stop press in the bar, before the receiver form submits. */
  onPower?: () => void;
  /** What the header strip says: the place playing, or the receiver choice. */
  receiverText: string;
  onChangeReceiver: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [past, setPast] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  // Between a pointer press and its release: focus that arrives then came from the pointer. Most
  // browsers focus a clicked button, and that focus mustn't keep the bar up after a scroll back.
  const pressing = useRef(false);

  // The watched element as of the last render, so the observers start once it exists and move with it.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (watch.current !== target) setTarget(watch.current);
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !target || typeof IntersectionObserver === "undefined") return;
    const parent = sentinel.offsetParent ?? document.documentElement;

    // The sentinel runs from the top of its positioned parent (the page's <main>) to where
    // the watched element's bottom meets the bar's bottom edge.
    const measure = () => {
      const top = parent.getBoundingClientRect().top;
      const bottom = target.getBoundingClientRect().bottom - top;
      sentinel.style.height = `${Math.max(1, bottom - barHeightPx())}px`;
    };
    measure();
    // A fast scroll can cross the sentinel twice before a callback: the newest entry is where it is now.
    const io = new IntersectionObserver((entries) => setPast(!entries[entries.length - 1]!.isIntersecting));
    io.observe(sentinel);
    // Whatever moves the watched element (the drawer, the dial going compact, a resize) resizes the page.
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    ro?.observe(parent);
    ro?.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      io.disconnect();
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [target]);

  // Cleared on any release, anywhere: a press that ends off the bar, or focuses nothing (Safari's
  // buttons, the bar's padding, a touch that scrolls), mustn't make the next Tab look like a pointer's.
  useEffect(() => {
    const release = () => {
      pressing.current = false;
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, []);

  const shown = past || keyboardFocus;

  return (
    <>
      <div ref={sentinelRef} className="tuning-bar-sentinel" aria-hidden="true" />
      <section
        className="tuning-bar"
        aria-label="Tuning bar"
        hidden={!shown}
        onPointerDown={() => {
          pressing.current = true;
        }}
        // Keyboard focus turns the hold on; only focus leaving the bar turns it off. A click while
        // held keeps it, so the bar doesn't vanish from under the pointer before the click lands.
        onFocus={() => {
          if (!pressing.current) setKeyboardFocus(true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboardFocus(false);
        }}
      >
        <span className="tuning-bar-freq">
          {formatKhz(freqKhz)} <span className="tuning-bar-unit">kHz</span>
        </span>
        <div className="tuning-bar-modes" role="group" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="tuning-bar-mode"
              aria-pressed={mode === m}
              // The mode already on changes nothing, so it isn't a listener action (#89 D4).
              onClick={() => {
                if (m !== mode) onMode(m);
              }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {/* Named from what it shows, so a voice command saying what's on screen reaches it (WCAG 2.5.3). */}
        <button
          type="button"
          className="tuning-bar-receiver"
          aria-label={`${receiverText}, change receiver`}
          title={receiverText}
          onClick={onChangeReceiver}
        >
          {receiverText}
        </button>
        <PowerButton busy={busy} onPress={onPower} />
      </section>
    </>
  );
}

/** The bar's height in px, from the `--tuning-bar-h` it's sized by (rem, so it follows text zoom). */
function barHeightPx(): number {
  const root = getComputedStyle(document.documentElement);
  const rem = parseFloat(root.fontSize) || 16;
  return (parseFloat(root.getPropertyValue("--tuning-bar-h")) || 0) * rem;
}
