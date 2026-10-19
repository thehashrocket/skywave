import { describe, expect, it, vi } from "vitest";
import type { createContext } from "@/server/trpc";

// The real module opens a Prisma client at import; every test injects its own db.
vi.mock("@/server/db", () => ({ db: {} }));

const { appRouter } = await import("@/server/root");

type Context = Awaited<ReturnType<typeof createContext>>;

function setup(ids: string[] = []) {
  const rows = new Set(ids);
  const preset = {
    deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({ count: rows.delete(where.id) ? 1 : 0 })),
    create: vi.fn(async ({ data }: { data: object }) => ({ id: "new", ...data })),
  };
  const caller = appRouter.createCaller({ db: { preset } } as unknown as Context);
  return { caller, preset };
}

describe("presets.delete", () => {
  it("deletes an existing preset", async () => {
    const { caller } = setup(["a"]);
    await expect(caller.presets.delete({ id: "a" })).resolves.toEqual({ count: 1 });
  });

  it("succeeds when the preset is already gone (double click, second tab)", async () => {
    const { caller } = setup(["a"]);
    await caller.presets.delete({ id: "a" });
    await expect(caller.presets.delete({ id: "a" })).resolves.toEqual({ count: 0 });
  });
});

describe("presets.create", () => {
  const valid = { name: "  Radio New Zealand  ", freqKhz: 9700, mode: "am" as const };

  it("saves a trimmed name", async () => {
    const { caller, preset } = setup();
    await caller.presets.create(valid);
    expect(preset.create).toHaveBeenCalledWith({ data: { ...valid, name: "Radio New Zealand" } });
  });

  it.each([
    ["an unknown mode", { mode: "fm" }],
    ["a frequency above 32 MHz", { freqKhz: 40_000 }],
    ["a zero frequency", { freqKhz: 0 }],
    ["a blank name", { name: "   " }],
    ["a name over 80 characters", { name: "x".repeat(81) }],
    ["a port out of range", { receiverPort: 70_000 }],
  ])("rejects %s without touching the database", async (_, override) => {
    const { caller, preset } = setup();
    await expect(caller.presets.create({ ...valid, ...override } as typeof valid)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(preset.create).not.toHaveBeenCalled();
  });
});
