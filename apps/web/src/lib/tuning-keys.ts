import { clampKhz, type Mode } from "./radio-types";

/**
 * Keyboard tuning (#89), shared by the dial and the page so they step alike:
 * the dial takes every key below while it has focus; the page takes only ← and →
 * from anywhere else, leaving ↑ ↓ PgUp PgDn to scroll the page (eng review D2).
 */
type KeyLike = { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

/** kHz one press moves the dial, or undefined for a key the dial doesn't take. */
export function dialStepKhz(key: string, shift: boolean): number | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return shift ? 10 : 1;
    case "ArrowLeft":
    case "ArrowDown":
      return shift ? -10 : -1;
    case "PageUp":
      return 100;
    case "PageDown":
      return -100;
  }
  return undefined;
}

/** A frequency moved by `step` kHz: to the nearest 10 Hz, inside the tunable range. */
export function steppedKhz(freqKhz: number, step: number): number {
  return clampKhz(Math.round((freqKhz + step) * 100) / 100);
}

/** kHz the page tunes for ← or → (Shift for 10) pressed outside the dial; undefined for anything else. */
export function pageStepKhz(e: KeyLike): number | undefined {
  if (e.ctrlKey || e.altKey || e.metaKey) return undefined;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return undefined;
  return dialStepKhz(e.key, e.shiftKey);
}

const LETTER_MODES: Record<string, Mode> = { a: "am", u: "usb", l: "lsb", c: "cw" };

/** The mode a letter key picks (A, U, L, C; Caps Lock counts, Shift and other modifiers don't), or undefined. */
export function modeForKey(e: KeyLike): Mode | undefined {
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return undefined;
  return LETTER_MODES[e.key.toLowerCase()];
}

// What the listener types into (letters and arrows are theirs), and the receiver map (it pans).
const TYPING =
  'input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], ' +
  'input[type="number"], input[type="tel"], input[type="password"], ' +
  'textarea, select, [contenteditable]:not([contenteditable="false"]), [data-map-region]';
// Plus controls whose arrow keys are their own: the dial, the volume (a range), the mode radios.
const OWN_ARROWS = `${TYPING}, input[type="range"], input[type="radio"], [role="slider"]`;

const within = (target: EventTarget | null, selector: string) =>
  target instanceof Element && target.closest(selector) !== null;

/** Whether ← → pressed with `target` focused belong to that control, not to page-wide tuning. */
export function keepsArrowKeys(target: EventTarget | null): boolean {
  return within(target, OWN_ARROWS);
}

/** Whether a letter typed with `target` focused belongs to that control, not to the mode keys. */
export function keepsLetterKeys(target: EventTarget | null): boolean {
  return within(target, TYPING);
}
