// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_LABEL, ReceiverChip } from "./ReceiverChip";

afterEach(cleanup);

describe("ReceiverChip", () => {
  // Value: protects=Auto is a plain label (nothing to press), while a pinned receiver shows its name with a ✕ named for what it does; fails_when=Auto grows a button or the ✕ loses its accessible name; why_new=receiver chip; seam=none; no_claim=the chip's look (CSS)
  it("shows Auto as text, and a pin with a named ✕ that unpins", () => {
    const onUnpin = vi.fn();
    const view = render(<ReceiverChip id="c" pinned={null} onUnpin={onUnpin} />);
    expect(document.getElementById("c")!.textContent).toBe(AUTO_LABEL);
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(<ReceiverChip id="c" pinned="Tremolat, FR" onUnpin={onUnpin} />);
    expect(document.getElementById("c")!.textContent).toBe("Tremolat, FR");
    fireEvent.click(screen.getByRole("button", { name: "Unpin Tremolat, FR and use Auto" }));
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });
});
