// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROADCAST_BANDS } from "@/lib/radio-types";
import { SpanPicker } from "./SpanPicker";

afterEach(cleanup);

const band31 = BROADCAST_BANDS.find((b) => b.name === "31m")!;

describe("SpanPicker", () => {
  // Value: protects=the widths read in order as one labelled group with the chosen one pressed, the band named when the dial is in one, and a click reports its width; fails_when=the group loses its name, aria-pressed is wrong, or the band label is generic in band; why_new=wideband waterfall; seam=none; no_claim=how the row looks (CSS)
  it("offers the widths as one group, naming the band", () => {
    const onChange = vi.fn();
    render(<SpanPicker step="60" band={band31} canView onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Waterfall width" });
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Audio", "15 kHz", "60 kHz", "230 kHz", "31m band"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true", "false", "false"]);
    fireEvent.click(screen.getByRole("button", { name: "31m band" }));
    expect(onChange).toHaveBeenCalledWith("band");
  });

  // Value: protects=without the service's stream only Audio can be chosen, and Band needs a band; fails_when=a width that can't be shown stays clickable; why_new=wideband waterfall; seam=none; no_claim=none
  it("disables what can't be shown", () => {
    render(<SpanPicker step="audio" band={undefined} canView={false} onChange={() => {}} />);
    const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
    expect(disabled("Audio")).toBe(false);
    expect(["15 kHz", "60 kHz", "230 kHz", "Band"].map(disabled)).toEqual([true, true, true, true]);
    expect(screen.getByRole("button", { name: "60 kHz" }).title).toMatch(/can't show the receiver's own waterfall/);
    cleanup();
    render(<SpanPicker step="60" band={undefined} canView onChange={() => {}} />);
    expect(disabled("60 kHz")).toBe(false);
    expect(disabled("Band")).toBe(true);
    expect(screen.getByRole("button", { name: "Band" }).title).toBe("Tune into a band to see all of it");
    expect(screen.getByRole("button", { name: "60 kHz" }).title).toBe("");
  });
});
