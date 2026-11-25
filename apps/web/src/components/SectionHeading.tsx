import type { ReactNode } from "react";
import type { Fold, SectionId } from "@/lib/section-folds";

type HeadingProps = {
  /** Which section: its h2 is `${section}-heading` (aria-labelledby, share links), its body `${section}-body`. */
  section: SectionId;
  children: ReactNode;
  /** The section's fold; without it the heading is a plain h2, as before. */
  fold?: Fold;
  /** A one-line summary shown after the heading while folded ("12 saved"); muted. */
  tail?: string | null;
};

/**
 * A main-page section's heading, foldable (collapsible sections): the h2 stays
 * a heading, so screen readers still jump to it and links still scroll to it,
 * and a button inside it shows or hides the section's body (the disclosure
 * pattern). While folded, a muted line after it says what's inside.
 */
export function SectionHeading({ section, children, fold, tail }: HeadingProps) {
  const id = `${section}-heading`;
  if (!fold) return <h2 id={id}>{children}</h2>;
  return (
    <h2 id={id}>
      <button
        type="button"
        className="section-toggle"
        aria-expanded={!fold.folded}
        aria-controls={`${section}-body`}
        onClick={fold.onToggle}
      >
        <span className="section-chevron" aria-hidden="true" />
        {children}
      </button>
      {fold.folded && tail && (
        <span className="section-tail" aria-hidden="true">
          {" "}
          · {tail}
        </span>
      )}
    </h2>
  );
}

/**
 * The part of a section its heading folds: hidden (out of the tab order and the
 * accessibility tree) while folded, but still mounted, so its state keeps running.
 */
export function SectionBody({ section, fold, children }: { section: SectionId; fold?: Fold; children: ReactNode }) {
  return (
    <div id={`${section}-body`} hidden={fold?.folded}>
      {children}
    </div>
  );
}
