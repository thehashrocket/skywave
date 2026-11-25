// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENT_KEY } from "@/lib/listener-ident";
import { IdentField } from "./IdentField";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("IdentField", () => {
  // Value: protects=the field shows the saved name, saves edits as typed, previews exactly what a receiver with the usual 16-character ident_len shows ("skywave " first, the name cut after it) with the privacy note, and flags a refused name; fails_when=it doesn't persist, previews another format or cut, loses the privacy note, or hides why a name won't be used; why_new=issue #108, owner chose the marker first; seam=jsdom localStorage; no_claim=layout (CSS)
  it("saves the name and says who can see it", () => {
    localStorage.setItem(IDENT_KEY, "N0CALL");
    render(<IdentField />);
    const input = screen.getByLabelText("Your call sign or name") as HTMLInputElement;
    expect(input.value).toBe("N0CALL");
    expect(
      screen.getByText(
        "From your next Listen, receivers show you as “skywave N0CALL” (some allow more or fewer characters). Their owners and other listeners there can see it.",
      ),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "Jason Shultz" } });
    expect(localStorage.getItem(IDENT_KEY)).toBe("Jason Shultz");
    expect(screen.getByText(/show you as “skywave Jason Sh” \(some allow more or fewer characters\)/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Jo;" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Letters, digits, spaces and / - _ only.")).toBeTruthy();
    expect(localStorage.getItem(IDENT_KEY)).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    expect(
      screen.getByText(
        /Optional\. Shown on the receiver's user list, where its owner and other listeners can see it\./,
      ),
    ).toBeTruthy();
  });

  // Value: protects=when the browser won't store site data, the field says the name won't reach receivers instead of previewing it; fails_when=a failed save still shows "shows you as …" while every tune goes out with Skywave's name; why_new=review of PR 121; seam=localStorage.setItem stubbed to throw; no_claim=which browsers block storage
  it("says so when the name can't be saved", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      render(<IdentField />);
      fireEvent.change(screen.getByLabelText("Your call sign or name"), { target: { value: "N0CALL" } });
      expect(screen.getByText(/isn't saving site data, so receivers will show Skywave's own name/)).toBeTruthy();
      expect(screen.queryByText(/show you as/)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});
