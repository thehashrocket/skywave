const STORAGE_KEY = "skywave.listenerId";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let current: string | null = null;

/**
 * A random id for this browser, kept in localStorage, sent with reception
 * reports. Not auth and not a person: it only lets the server's rate limits
 * count one listener's reports. Where storage throws (private windows,
 * blocked site data, a full quota), a new one is made and kept for this
 * page's life, so the limits still hold within it.
 */
export function listenerId(): string {
  if (current) return current;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && UUID.test(stored)) return (current = stored);
  } catch {
    /* storage unavailable; make one below */
  }
  current = crypto.randomUUID();
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* kept in memory only */
  }
  return current;
}

/** Tests only: forget the in-memory id. */
export function resetListenerIdForTests(): void {
  current = null;
}
