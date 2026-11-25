// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { IDENT_KEY, IDENT_MAX, identProblem, identShown, loadIdent, saveIdent } from "./listener-ident";

beforeEach(() => localStorage.clear());

describe("listener ident", () => {
  // Value: protects=the field accepts what the radio service accepts (letters, digits, spaces, / - _, at most IDENT_MAX once trimmed) and explains the rest; fails_when=the web and service rules drift, so the field promises a name the service then swaps for Skywave's; why_new=issue #108; seam=none; no_claim=the service's own check (radio test_ident.py)
  it("accepts what the service accepts", () => {
    expect(identProblem("")).toBeNull();
    expect(identProblem("  N0CALL  ")).toBeNull();
    expect(identProblem("VE3/N0CALL-1 Jo_S")).toBeNull();
    expect(identProblem("x".repeat(IDENT_MAX))).toBeNull();
    expect(identProblem("x".repeat(IDENT_MAX + 1))).toMatch(/At most 24/);
    expect(identProblem("N0CALL;")).toMatch(/Letters, digits/);
    expect(identProblem("Zoë")).toMatch(/Letters, digits/);
  });

  // Value: protects=a usable name is kept normalized across visits, blank forgets it, and a refused one forgets the old name instead of keeping it, so what goes out always matches what the field shows; fails_when=saving skips normalizing, a stale name survives a refused edit, or a tampered stored value is used; why_new=issue #108; seam=jsdom localStorage; no_claim=storage that throws
  it("saves, forgets and loads the name", () => {
    expect(saveIdent("  Jo   Smith ")).toBe(true);
    expect(localStorage.getItem(IDENT_KEY)).toBe("Jo Smith");
    expect(loadIdent()).toBe("Jo Smith");
    expect(saveIdent("Jo;")).toBe(false);
    expect(loadIdent()).toBeUndefined();
    saveIdent("N0CALL");
    saveIdent("   ");
    expect(localStorage.getItem(IDENT_KEY)).toBeNull();
    localStorage.setItem(IDENT_KEY, "bad=value");
    expect(loadIdent()).toBeUndefined();
  });

  // Value: protects=the preview is what a receiver with the usual 16-character ident_len shows: "skywave " first, then the name, cut at its end (owner decision); fails_when=the prefix moves, the cut length changes, or the cut lands anywhere but the name's end; why_new=owner chose the marker first for #108; seam=none; no_claim=receivers whose owner set another ident_len
  it.each([
    ["Jason Shultz", "skywave Jason Sh"],
    ["N0CALL", "skywave N0CALL"],
    ["N0CALL/P", "skywave N0CALL/P"],
    ["VE3/N0CALL/P", "skywave VE3/N0CA"],
    ["  Jo   Smith ", "skywave Jo Smith"],
  ])("previews %j as %j", (name, shown) => {
    expect(identShown(name)).toBe(shown);
  });
});
