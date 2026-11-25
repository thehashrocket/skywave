/**
 * The listener's own call sign or name, shown in a receiver's user list in
 * place of Skywave's (issue #108). The radio service checks it again
 * (session.py, listener_ident) and falls back to its own name for anything
 * this would refuse; checking here too lets the field say why first.
 */
export const IDENT_KEY = "skywave.ident";
/** Keep in step with IDENT_MAX in apps/radio/skywave_radio/session.py. */
export const IDENT_MAX = 24;
const IDENT_CHARS = /^[A-Za-z0-9/_\- ]+$/;
/**
 * Keep in step with IDENT_PREFIX in session.py: first, so a receiver's cut takes the name's end.
 * Fixed, not the service's KIWI_IDENT, which names only connections without a listener's name.
 */
export const IDENT_PREFIX = "skywave ";
/** Where most receivers cut an ident (the KiwiSDR's usual ident_len); owners can set more or fewer. */
export const IDENT_SHOWN = 16;

/** What a receiver with the usual ident_len shows for a usable `name`. */
export function identShown(name: string): string {
  return (IDENT_PREFIX + normalizeIdent(name)).slice(0, IDENT_SHOWN);
}

/** Trimmed, with each run of spaces as one: what the service would use. */
export function normalizeIdent(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Why `raw` can't be used, or null when it can (blank is fine: it means Skywave's own name). */
export function identProblem(raw: string): string | null {
  const name = normalizeIdent(raw);
  if (name === "") return null;
  if (name.length > IDENT_MAX) return `At most ${IDENT_MAX} characters.`;
  if (!IDENT_CHARS.test(name)) return "Letters, digits, spaces and / - _ only.";
  return null;
}

/** The saved name, if there is a usable one. */
export function loadIdent(): string | undefined {
  try {
    const stored = localStorage.getItem(IDENT_KEY);
    if (stored === null) return undefined;
    const name = normalizeIdent(stored);
    return name && identProblem(name) === null ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save a usable name, or forget it when blank. One that can't be used is
 * forgotten too, returning false, so what the field shows as refused never
 * goes out under an older name: the receiver gets Skywave's own.
 */
export function saveIdent(raw: string): boolean {
  const usable = identProblem(raw) === null;
  const name = usable ? normalizeIdent(raw) : "";
  try {
    if (name) localStorage.setItem(IDENT_KEY, name);
    else localStorage.removeItem(IDENT_KEY);
  } catch {
    /* storage unavailable: the name isn't kept */
  }
  return usable;
}
