// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenerId, resetListenerIdForTests } from "./listener-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("listenerId", () => {
  beforeEach(() => {
    localStorage.clear();
    resetListenerIdForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("is a random UUID, kept across page loads", () => {
    const id = listenerId();
    expect(id).toMatch(UUID);
    resetListenerIdForTests();
    expect(listenerId()).toBe(id);
  });

  it("replaces a stored value it didn't write", () => {
    localStorage.setItem("skywave.listenerId", "jas@example.com");
    expect(listenerId()).toMatch(UUID);
  });

  // Value: protects=with storage blocked the id is still stable for the page, so the server's rate limits still count one listener; fails_when=a fresh id is made per report when storage throws (getItem or only setItem); why_new=reception reports; seam=Storage spies; no_claim=none beyond protects
  it.each(["getItem", "setItem"] as const)("stays the same for the page when %s throws", (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const id = listenerId();
    expect(id).toMatch(UUID);
    expect(listenerId()).toBe(id);
  });
});
