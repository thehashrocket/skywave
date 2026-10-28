import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const { attachDatabasePool } = vi.hoisted(() => ({ attachDatabasePool: vi.fn() }));
vi.mock("@vercel/functions", () => ({ attachDatabasePool }));

// The real adapter, wrapped so the test can see what it was given.
const { PrismaPg } = vi.hoisted(() => ({ PrismaPg: vi.fn() }));
vi.mock("@prisma/adapter-pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prisma/adapter-pg")>();
  PrismaPg.mockImplementation(function (...args: ConstructorParameters<typeof actual.PrismaPg>) {
    return new actual.PrismaPg(...args);
  });
  return { PrismaPg };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as { prisma?: unknown }).prisma;
});

describe("db", () => {
  // Value: protects=idle database connections are released before Vercel suspends an instance; fails_when=attachDatabasePool is dropped or given a pool Prisma doesn't use; why_new=db.ts had no test; seam=none; no_claim=real suspend behavior (mocked @vercel/functions; no database)
  it("hands the pool Prisma uses to attachDatabasePool", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://skywave:skywave@localhost:5432/skywave");
    await import("./db");

    expect(attachDatabasePool).toHaveBeenCalledTimes(1);
    const pool = attachDatabasePool.mock.calls[0]![0];
    expect(pool).toBeInstanceOf(Pool);
    expect(PrismaPg).toHaveBeenCalledWith(pool);
    await (pool as Pool).end();
  });

  // Value: protects=a missing DATABASE_URL fails loudly instead of building a pool for localhost; fails_when=the guard is removed while reworking the pool; why_new=db.ts had no test; seam=none; no_claim=none beyond protects
  it("refuses to start without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(import("./db")).rejects.toThrow("DATABASE_URL is not set");
  });
});
