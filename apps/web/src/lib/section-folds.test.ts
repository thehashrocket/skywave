// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadFolded, saveFolded } from "./section-folds";

afterEach(() => localStorage.clear());

describe("section folds", () => {
  // Value: protects=folded sections survive a reload in this browser, and folding none removes the key so absent means everything open; fails_when=folds aren't saved, come back wrong, or an empty list lingers; why_new=collapsible sections (owner 2026-11-25: open by default, remember folds); seam=localStorage; no_claim=storage in private browsing
  it("saves and loads the folded sections, and clears the key when none are folded", () => {
    expect(loadFolded()).toEqual(new Set());
    saveFolded(new Set(["signal-stations", "presets"]));
    expect(loadFolded()).toEqual(new Set(["presets", "signal-stations"]));
    saveFolded(new Set());
    expect(localStorage.getItem("skywave.folded")).toBeNull();
  });

  // Value: protects=a damaged or older saved value folds nothing it doesn't know, and never throws, so the page still loads fully open; fails_when=bad JSON or an unknown id crashes the mount effect or folds an arbitrary section; why_new=collapsible sections; seam=localStorage; no_claim=none
  it("ignores unreadable values and unknown ids", () => {
    localStorage.setItem("skywave.folded", "{not json");
    expect(loadFolded()).toEqual(new Set());
    localStorage.setItem("skywave.folded", JSON.stringify(["presets", "map", 7]));
    expect(loadFolded()).toEqual(new Set(["presets"]));
    localStorage.setItem("skywave.folded", JSON.stringify({ presets: true }));
    expect(loadFolded()).toEqual(new Set());
  });
});
