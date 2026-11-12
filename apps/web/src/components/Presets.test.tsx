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
