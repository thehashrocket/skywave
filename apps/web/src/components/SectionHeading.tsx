import type { ReactNode } from "react";
import type { Fold } from "@/lib/section-folds";

type Props = {
  /** The h2's id, which the section's aria-labelledby names (and share links scroll to). */
  id: string;
  /** The id of the section body this heading folds; given to aria-controls. */
  bodyId: string;
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
export function SectionHeading({ id, bodyId, children, fold, tail }: Props) {
  if (!fold) return <h2 id={id}>{children}</h2>;
  return (
    <h2 id={id}>
      <button
        type="button"
        className="section-toggle"
        aria-expanded={!fold.folded}
        aria-controls={bodyId}
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
