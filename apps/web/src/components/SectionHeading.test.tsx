// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionHeading } from "./SectionHeading";

afterEach(cleanup);

describe("SectionHeading", () => {
  // Value: protects=without a fold the heading renders as the plain h2 it was, so sections used outside the page (and their tests) are unchanged; fails_when=a stray button appears or the id is lost; why_new=collapsible sections; seam=none; no_claim=none
  it("is a plain heading without a fold", () => {
    render(<SectionHeading id="h" bodyId="b">Saved frequencies</SectionHeading>);
    expect(screen.getByRole("heading", { level: 2, name: "Saved frequencies" }).id).toBe("h");
    expect(screen.queryByRole("button")).toBeNull();
  });

  // Value: protects=the folding heading stays an h2 (screen readers jump to it, share links scroll to it) holding a button that says expanded or not, names the body it controls, and toggles; while folded a muted summary follows, hidden from screen readers; fails_when=the heading role is lost, aria-expanded or aria-controls are wrong, the summary shows while open, or a click doesn't toggle; why_new=collapsible sections (owner: muted summary while folded); seam=onToggle; no_claim=visual look
  it("folds through a button inside the h2 and shows a summary only while folded", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SectionHeading id="h" bodyId="b" fold={{ folded: false, onToggle }} tail="12 saved">
        Saved frequencies
      </SectionHeading>,
    );
    const button = screen.getByRole("button", { name: "Saved frequencies" });
    expect(button.closest("h2")?.id).toBe("h");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("b");
    expect(screen.queryByText(/12 saved/)).toBeNull();
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <SectionHeading id="h" bodyId="b" fold={{ folded: true, onToggle }} tail="12 saved">
        Saved frequencies
      </SectionHeading>,
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const tail = screen.getByText(/12 saved/);
    expect(tail.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("Saved frequencies");
  });
});
