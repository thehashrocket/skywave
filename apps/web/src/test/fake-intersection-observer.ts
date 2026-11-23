import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Stands in for IntersectionObserver (jsdom has none) and returns a function
 * that reports whether the last observer's target is in view, as scrolling
 * would. Undo with vi.unstubAllGlobals().
 */
export function fakeIntersectionObserver(): (intersecting: boolean | boolean[]) => void {
  let callback: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  // An array is several entries in one callback, oldest first, as a fast scroll can deliver them.
  return (intersecting) => {
    if (!callback) throw new Error("no IntersectionObserver was made");
    const entries = (Array.isArray(intersecting) ? intersecting : [intersecting]).map((i) => ({ isIntersecting: i }));
    act(() => callback!(entries));
  };
}
