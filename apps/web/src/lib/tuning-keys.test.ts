// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { DIAL_MAX_KHZ, TUNE_MIN_KHZ } from "./radio-types";
import { dialStepKhz, keepsArrowKeys, keepsLetterKeys, modeForKey, pageStepKhz, steppedKhz } from "./tuning-keys";

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("dialStepKhz", () => {
  // Value: protects=the dial's steps after the table moved out of Dial.tsx (1 kHz, Shift 10, PgUp/PgDn 100); fails_when=a row is dropped or a sign flips; why_new=table is new in lib; seam=none; no_claim=none beyond protects
  it.each([
    ["ArrowRight", false, 1],
    ["ArrowLeft", true, -10],
    ["ArrowUp", false, 1],
    ["ArrowDown", true, -10],
    ["PageUp", false, 100],
    ["PageDown", true, -100],
    ["Home", false, undefined],
  ])("%s (shift %s) steps %s kHz", (k, shift, step) => {
    expect(dialStepKhz(k, shift)).toBe(step);
  });
});

describe("steppedKhz", () => {
  // Value: protects=a step keeps 10 Hz precision and stays in the tunable range; fails_when=rounding or clampKhz is dropped; why_new=helper is new; seam=none; no_claim=none beyond protects
  it("rounds to 10 Hz and clamps to the tunable range", () => {
    expect(steppedKhz(7_203.37, 1)).toBe(7_204.37);
    expect(steppedKhz(14_000.1, 0.2)).toBe(14_000.3); // no float drift
    expect(steppedKhz(DIAL_MAX_KHZ - 3, 10)).toBe(DIAL_MAX_KHZ);
    expect(steppedKhz(TUNE_MIN_KHZ + 1, -10)).toBe(TUNE_MIN_KHZ);
  });
});

describe("pageStepKhz", () => {
  // Value: protects=page-wide keys are ← and → only (↑ ↓ PgUp PgDn keep scrolling, D2), and Ctrl/Alt/Meta combinations stay the browser's; fails_when=the page takes a scroll key or a modified arrow; why_new=page-wide tuning is new (#89); seam=none; no_claim=real scrolling (jsdom)
  it.each([
    [key("ArrowRight"), 1],
    [key("ArrowLeft", { shiftKey: true }), -10],
    [key("ArrowUp"), undefined],
    [key("PageDown"), undefined],
    [key("ArrowRight", { metaKey: true }), undefined],
    [key("ArrowLeft", { altKey: true }), undefined],
  ])("%o steps %s", (e, step) => {
    expect(pageStepKhz(e)).toBe(step);
  });
});

describe("modeForKey", () => {
  // Value: protects=A/U/L/C pick AM/USB/LSB/CW, Caps Lock still works, and Shift or Cmd/Ctrl/Alt letters (Cmd+C, Ctrl+L) never switch mode, and a keydown with no key (Chrome autofill) is ignored, not thrown on; fails_when=case, the modifier check or the key-type check changes; why_new=mode hotkeys are new (#89, N4); seam=none; no_claim=non-Latin layouts (a known gap)
  it.each([
    [key("a"), "am"],
    [key("u"), "usb"],
    [key("l"), "lsb"],
    [key("c"), "cw"],
    [key("C"), "cw"], // Caps Lock
    [key("C", { shiftKey: true }), undefined],
    [key("c", { metaKey: true }), undefined],
    [key("l", { ctrlKey: true }), undefined],
    [key("a", { altKey: true }), undefined],
    [key("x"), undefined],
    [{ ...key("a"), key: undefined as unknown as string }, undefined], // Chrome autofill
  ])("%o picks %s", (e, mode) => {
    expect(modeForKey(e)).toBe(mode);
  });
});

describe("keepsArrowKeys / keepsLetterKeys", () => {
  beforeAll(() => {
    document.body.innerHTML = `
      <input id="plain"><input id="search" type="search"><input id="num" type="number">
      <input id="date" type="date"><input id="color" type="color">
      <input id="range" type="range"><input id="radio" type="radio"><input id="check" type="checkbox">
      <textarea id="ta"></textarea><select id="sel"></select><div id="ce" contenteditable="true"></div>
      <div id="ceoff" contenteditable="false"></div>
      <svg role="slider" id="dial"></svg>
      <div data-map-region><button id="inmap">pin</button></div>
      <button id="btn">preset</button>`;
  });

  // Value: protects=typing fields keep letters and arrows; the volume, the mode radios, the dial and the map keep only their arrows, so A/U/L/C still work there (review item 4); buttons and checkboxes leave both to the page (N2: the letter-keys checkbox mustn't deaden arrows); fails_when=a control is added to or dropped from the wrong list; why_new=guard is new (#89); seam=none; no_claim=focus rules of real browsers
  it.each([
    ["plain", true, true],
    ["search", true, true],
    ["num", true, true],
    ["date", true, true],
    ["color", true, true],
    ["ta", true, true],
    ["sel", true, true],
    ["ce", true, true],
    ["inmap", true, false],
    ["range", true, false],
    ["radio", true, false],
    ["dial", true, false],
    ["check", false, false],
    ["ceoff", false, false],
    ["btn", false, false],
  ])("#%s keeps arrows %s, letters %s", (id, arrows, letters) => {
    const el = document.getElementById(id);
    expect(keepsArrowKeys(el)).toBe(arrows);
    expect(keepsLetterKeys(el)).toBe(letters);
  });

  // Value: protects=nothing focused (the page body) or no target leaves keys to the page; fails_when=the guard treats body or null as a control; why_new=guard is new; seam=none; no_claim=none beyond protects
  it("leaves keys to the page when nothing is focused", () => {
    expect(keepsArrowKeys(document.body)).toBe(false);
    expect(keepsLetterKeys(null)).toBe(false);
  });
});
