import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Repo-relative, so the pre-gate links this test to the stylesheet.
const REPO = new URL("../../../../", import.meta.url);
const css = readFileSync(new URL("apps/web/src/app/globals.css", REPO), "utf8");
const sources = [
  new URL("./page.tsx", import.meta.url),
  ...readdirSync(new URL("../components/", import.meta.url))
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => new URL(`../components/${f}`, import.meta.url)),
];

/** Every class name written as a string literal in className=… or className={c ? "a" : "b"}. */
function classesIn(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/className=(?:"([^"]+)"|\{([^}]*)\})/g)) {
    const text = m[1] ?? [...m[2]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]).join(" ");
    for (const name of text.split(/\s+/)) if (/^[a-z][\w-]*$/.test(name)) names.add(name);
  }
  return [...names];
}

/** The declarations of the first rule whose selector list is exactly `selector`, comments stripped. */
function ruleBody(selector: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(text);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

/** A :root color token's hex value. */
function token(name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(ruleBody(":root"));
  if (!m) throw new Error(`no hex token ${name}`);
  return m[1]!;
}

/** WCAG 2.x contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("globals.css", () => {
  // Value: protects=band labels on the dial glass (12px text) stay >= 4.5:1 against both ends of the glass gradient; fails_when=.dial-band-ham text goes back to --ham (3.65:1) or an ink token or the glass is retuned below AA; why_new=no test read token values; seam=none; no_claim=the gold radial overlay or real rendering (computed from :root hex values; source text only)
  it("keeps the dial's band label text at WCAG AA contrast on the glass", () => {
    const glass = [token("--glass"), token("--glass-shade")];
    for (const row of ["broadcast", "ham"]) {
      const fill = /fill:\s*var\((--[\w-]+)\)/.exec(ruleBody(`.dial-band-${row} text`))?.[1];
      expect(fill, `.dial-band-${row} text fill`).toBeDefined();
      for (const bg of glass) expect(contrast(token(fill!), bg), `${fill} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // The bar bites: --ham, the bar color, is too light for text on the glass's darker foot.
    expect(contrast(token("--ham"), token("--glass-shade"))).toBeLessThan(4.5);
  });

  // Value: protects=the gutter is as tall as the glass and its row labels sit on their band rows; fails_when=Dial.tsx's viewBox or a BandRow y changes, or .dial-glass min-width stops reading --glass-min, and the gutter is not updated; why_new=nothing tied the CSS to Dial.tsx geometry; seam=none; no_claim=real layout (jsdom has no container queries; source text only)
  it("sizes the dial gutter and places its labels from Dial.tsx's geometry", () => {
    const dial = readFileSync(new URL("../components/Dial.tsx", import.meta.url), "utf8");
    const num = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(dial)?.[1]);
    const [W, H] = [num("W"), num("H")];
    expect(W).toBeGreaterThan(0);
    expect(H).toBeGreaterThan(0);

    // Height = glass width × H/W, with the glass never narrower than its min-width.
    const height = /height:\s*calc\(max\(var\(--glass-min\),.*\)\s*\*\s*([\d.]+)\)\s*;/.exec(ruleBody(".dial-gutter"));
    expect(height, ".dial-gutter height formula").not.toBeNull();
    expect(Number(height![1])).toBeCloseTo(H / W, 4);
    expect(ruleBody(".dial-glass")).toMatch(/min-width:\s*var\(--glass-min\)\s*;/);

    // Each label's center falls inside its band row: from the higher of bar top and first label, to the second label.
    const rows = [...dial.matchAll(/<BandRow[^>]*\by=\{(\d+)\}\s*labelY=\{\[(\d+),\s*(\d+)\]\}[^>]*dial-band-(\w+)"/g)];
    expect(rows.map((r) => r[4])).toEqual(["broadcast", "ham"]);
    for (const [, y, l0, l1, row] of rows) {
      const top = Number(/top:\s*([\d.]+)%/.exec(ruleBody(`.dial-row-label-${row}`))?.[1]);
      const center = (top / 100) * H;
      expect(center, `${row} label center`).toBeGreaterThanOrEqual(Math.min(Number(y), Number(l0)));
      expect(center, `${row} label center`).toBeLessThanOrEqual(Number(l1));
    }
  });

  // Value: protects=the signal list fills strongest-first in CSS columns, not across like the presets grid it shares a class with; fails_when=.signals-list loses display:block or moves above .presets-list, so grid wins and columns are ignored; why_new=no test read list layout; seam=none; no_claim=how a browser flows the columns (source text only)
  it("lets .signals-list override the .presets-list grid it shares an element with", () => {
    const signalList = readFileSync(new URL("../components/SignalList.tsx", import.meta.url), "utf8");
    expect(signalList).toMatch(/"presets-list signals-list/);
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // Equal specificity, so the later rule wins: .signals-list must follow .presets-list.
    expect(text.search(/(^|\})\s*\.signals-list\s*\{/)).toBeGreaterThan(text.search(/(^|\})\s*\.presets-list\s*\{/));
    expect(ruleBody(".presets-list")).toMatch(/display:\s*grid/);
    expect(ruleBody(".signals-list")).toMatch(/display:\s*block/);
    expect(ruleBody(".signals-list")).toMatch(/columns:\s*\d+px/);
    expect(ruleBody(".signals-list li")).toMatch(/break-inside:\s*avoid/);
  });

  // Value: protects=on phones a browser without field-sizing keeps the readout's 9.4ch box instead of the input's default width (wider than the screen); fails_when=width:auto on .readout-input moves outside @supports (field-sizing: content); why_new=review found this exact bug; seam=none; no_claim=how any browser renders it (source text only)
  it("only lets the readout shrink to its digits where field-sizing is supported", () => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const shrinks = [...text.matchAll(/\.readout-input\s*\{[^}]*width:\s*auto/g)].map((m) => m.index!);
    // The scan really finds the phone rule.
    expect(shrinks.length).toBeGreaterThan(0);
    for (const at of shrinks) {
      const open = text.lastIndexOf("@supports (field-sizing: content)", at);
      expect(open, "width:auto outside @supports (field-sizing: content)").toBeGreaterThan(-1);
      // Still inside that block: more braces opened than closed between it and the rule.
      const between = text.slice(open, at);
      expect(between.split("{").length - between.split("}").length).toBeGreaterThan(0);
    }
  });

  // Value: protects=a renamed or deleted selector can't silently unstyle a component; fails_when=a component uses a class globals.css never defines; why_new=pre-gate had no lane for globals.css; seam=source text; no_claim=how anything looks
  it("defines every class the page and its components use", () => {
    const used = sources.flatMap((url) => classesIn(readFileSync(url, "utf8")));
    // The scan really reads the components, including the ternary form.
    expect(used).toEqual(expect.arrayContaining(["col-night", "status-back", "power-on", "dial-num-major"]));
    const missing = used.filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
    expect(missing).toEqual([]);
  });

  // Value: protects=every custom property read without a fallback (e.g. --glass-min, --ham-ink, --gutter) is declared, so no rule silently drops; fails_when=a token is renamed or removed on one side only; why_new=only class names were checked; seam=none; no_claim=that the declaration reaches the element through the cascade (source text only)
  it("declares every custom property it reads without a fallback", () => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const read = new Set([...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]!));
    // The scan really finds the dial's tokens.
    expect([...read]).toEqual(expect.arrayContaining(["--glass-min", "--ham-ink", "--gutter"]));
    expect([...read].filter((name) => !declared.has(name))).toEqual([]);
  });

  // Value: protects=phone-width rules that hide the host or clamp the name touch only table rows, not the map card that shares those classes; fails_when=a media rule names .receiver-host or .receiver-name without .receivers-table; why_new=no test read the media blocks; review found the map card losing its host; seam=none; no_claim=how a phone renders it (jsdom applies no media queries; source text only)
  it("scopes media rules for receiver names and hosts to the table", () => {
    const selectors: string[] = [];
    for (const m of css.matchAll(/@media[^{]*\{/g)) {
      // The block runs to its matching brace.
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      for (; depth > 0; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
      const block = css.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of block.matchAll(/([^{}]+)\{/g)) selectors.push(...rule[1]!.split(",").map((s) => s.trim()));
    }
    const named = selectors.filter((s) => /\.receiver-(name|host)(?![\w-])/.test(s));
    // The scan really finds the phone rules.
    expect(named).toEqual(expect.arrayContaining([".receivers-table .receiver-host"]));
    expect(named.filter((s) => !s.includes(".receivers-table"))).toEqual([]);
  });
});
