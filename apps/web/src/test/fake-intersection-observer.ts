import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Stands in for IntersectionObserver (jsdom has none) and returns a function
 * that reports whether the last observer's target is in view, as scrolling
 * would. Undo with vi.unstubAllGlobals().
 */
export function fakeIntersectionObserver(): (intersecting: boolean) => void {
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
  return (intersecting) => {
    if (!callback) throw new Error("no IntersectionObserver was made");
    act(() => callback!([{ isIntersecting: intersecting }]));
  };
}
