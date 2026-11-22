// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = [{ id: "s1", name: "WWV", freqKhz: 10_000, mode: "am" }];
const mutate = vi.fn();

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    presets: {
      list: { queryOptions: () => ({}), queryKey: () => ["presets"] },
      create: { mutationOptions: () => ({ kind: "create" }) },
      delete: { mutationOptions: () => ({ kind: "delete" }) },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: shared, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (o: { kind: string }) => ({
    mutate: (...a: unknown[]) => mutate(o.kind, ...a),
    isPending: false,
    isError: false,
  }),
}));

const { Presets } = await import("./Presets");

beforeEach(() => {
  localStorage.clear();
  mutate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Presets", () => {
  // Value: protects=on a public site saving stays in this browser and the shared list can't be deleted from; fails_when=a public visitor's save or delete reaches the shared database; why_new=going public; seam=react-query mocked; no_claim=the server's own refusal (presets router test)
  it("saves to this browser and keeps shared picks read-only on a public site", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_PUBLIC", "1");
    render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: "Delete WWV" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Radio Australia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Yours" }).textContent).toContain("Radio Australia");
    expect(JSON.parse(localStorage.getItem("skywave.presets")!)[0]).toMatchObject({
      name: "Radio Australia",
      freqKhz: 9580,
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Radio Australia" }));
    expect(localStorage.getItem("skywave.presets")).toBe("[]");
  });

  // Value: protects=the saved frequency being listened to (same frequency and mode) is current for screen readers too, not only in lamp colour; fails_when=aria-current is missing, or set when only the frequency matches; why_new=station search design review (owner: build now); seam=react-query mocked; no_claim=styling
  it("marks the tuned preset for screen readers", () => {
    const { rerender } = render(<Presets freqKhz={10_000} mode="am" onSelect={() => {}} />);
    const wwv = () => screen.getByRole("button", { name: /^10,000/ });
    expect(wwv().getAttribute("aria-current")).toBe("true");
    rerender(<Presets freqKhz={10_000} mode="usb" onSelect={() => {}} />);
    expect(wwv().getAttribute("aria-current")).toBeNull();
  });

  // Value: protects=on a private site saving and deleting go to the shared list through the server; fails_when=a save or delete stays local, or deletes another preset; why_new=presets before going public (card added during station search review); seam=react-query mocked; no_claim=the server's own handling (presets router test)
  it("saves to and deletes from the shared list on a private site", () => {
    render(<Presets freqKhz={9580} mode="am" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete WWV" }));
    expect(mutate).toHaveBeenCalledWith("delete", { id: "s1" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Radio Australia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      "create",
      { name: "Radio Australia", freqKhz: 9580, mode: "am" },
      expect.anything(),
    );
  });
});
