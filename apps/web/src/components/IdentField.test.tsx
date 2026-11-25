// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        "Receivers you connect to next show you as “skywave N0CALL” (some allow more or fewer characters). Their owner and other listeners there can see it.",
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
});
