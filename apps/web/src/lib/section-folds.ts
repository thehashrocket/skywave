/**
 * Which of the main page's sections the listener has folded (collapsible
 * sections, owner 2026-11-25): Saved frequencies, Find a station, Signal
 * stations and Strong signals now. Every section starts open, a first visit
 * included; a fold is remembered in this browser. Absent or unreadable storage
 * means everything open.
 */

export const SECTION_IDS = ["presets", "station-search", "signal-stations", "signals"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const KEY = "skywave.folded";

const isSectionId = (v: unknown): v is SectionId => (SECTION_IDS as readonly unknown[]).includes(v);

/** The folded sections saved in this browser; empty when none or unreadable. */
export function loadFolded(): ReadonlySet<SectionId> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter(isSectionId) : []);
  } catch {
    return new Set();
  }
}

/** Saves the folded sections; none folded removes the key, so absent means all open. */
export function saveFolded(folded: ReadonlySet<SectionId>): void {
  try {
    if (folded.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(SECTION_IDS.filter((id) => folded.has(id))));
  } catch {
    /* storage full or blocked: the fold lasts this visit only */
  }
}

/** A section's fold, as the page hands it to the section: folded or not, and how to flip it. */
export type Fold = { folded: boolean; onToggle: () => void };
