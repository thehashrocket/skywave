// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PowerButton } from "./PowerButton";

afterEach(cleanup);

describe("PowerButton", () => {
  // Value: protects=a double-click's second press never submits (so it can't stop what the first started) and onPress runs only for a press that submits; fails_when=the detail>1 guard is removed or inverted, or onPress fires on the guarded press; why_new=the guard had no direct test before it was shared by header and bar (#90); seam=none; no_claim=browser click.detail quirks (synthetic events)
  it("submits the receiver form on a single press, not on a double-click's second", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    const onPress = vi.fn();
    render(
      <>
        <form id="receiver-form" onSubmit={(e) => onSubmit(e.nativeEvent)} />
        <PowerButton busy={false} onPress={onPress} />
      </>,
    );
    const button = screen.getByRole("button", { name: "Listen" });

    fireEvent.click(button, { detail: 1 });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.click(button, { detail: 2 });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // Value: protects=the label says what a press will do (Stop while busy); fails_when=label ignores busy; why_new=label moved out of page.tsx; seam=none; no_claim=styling of power-on (CSS)
  it("reads Stop while busy", () => {
    render(<PowerButton busy />);
    expect(screen.getByRole("button", { name: "Stop" }).className).toBe("power power-on");
  });
});
