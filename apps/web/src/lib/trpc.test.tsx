// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Providers, useTRPC } from "./trpc";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function BothQueries() {
  const trpc = useTRPC();
  useQuery(trpc.receivers.list.queryOptions());
  useQuery(trpc.presets.list.queryOptions());
  return null;
}

// Value: protects=the slow mirror call never holds up the fast database queries in one batched request; fails_when=Providers' splitLink stops matching receivers.list (or the link is swapped for a plain batch link); why_new=the existing test only checked the path names a procedure; seam=none; no_claim=server-side handling of either request
it("sends receivers.list on its own request, outside the batch", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("[]", { status: 500 });
    }),
  );
  render(
    <Providers>
      <BothQueries />
    </Providers>,
  );
  await waitFor(() => expect(urls).toHaveLength(2));
  const receivers = urls.find((u) => u.includes("receivers.list"))!;
  expect(receivers).not.toMatch(/batch=1/);
  expect(receivers).not.toContain("presets.list");
  expect(urls.find((u) => u.includes("presets.list"))).toMatch(/batch=1/);
});
