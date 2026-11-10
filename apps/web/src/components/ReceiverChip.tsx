"use client";

export const AUTO_LABEL = "Auto (best for this frequency)";

/**
 * Which receiver Listen uses: Auto, or the one the listener pinned, with a ✕
 * that goes back to Auto. Unpinning changes only the next choice; whatever is
 * playing keeps playing.
 *
 * `id` names the text, so a field can point aria-describedby at it.
 */
export function ReceiverChip({
  id,
  pinned,
  onUnpin,
}: {
  id: string;
  /** The pinned receiver's name, or null for Auto. */
  pinned: string | null;
  onUnpin: () => void;
}) {
  const auto = pinned === null;
  return (
    <span className={auto ? "chip chip-auto" : "chip"}>
      <span id={id} className={auto ? undefined : "chip-label"} title={pinned ?? undefined}>
        {pinned ?? AUTO_LABEL}
      </span>
      {!auto && (
        <button type="button" className="chip-unpin" aria-label={`Unpin ${pinned} and use Auto`} onClick={onUnpin}>
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </span>
  );
}
