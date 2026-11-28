import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Repo-relative, so the pre-gate links this test to the stylesheet.
const REPO = new URL("../../../../", import.meta.url);
const css = readFileSync(new URL("apps/web/src/app/globals.css", REPO), "utf8");
const sources = [
  new URL("./page.tsx", import.meta.url),
  new URL("./owners/page.tsx", import.meta.url),
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

/** The body of the `@media <query>` block (to its closing brace at the start of a line), comments stripped. */
function mediaBlock(query: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`@media ${esc}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(text);
  if (!m) throw new Error(`no @media ${query} block`);
  return m[1]!;
}

/** Whether any rule in `text` lists `selector` in its selector list and declares `declaration`. */
function declares(text: string, selector: string, declaration: RegExp): boolean {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, selectors, body]) => selectors!.split(",").some((s) => s.trim() === selector) && declaration.test(body!),
  );
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

  // Value: protects=brass outline buttons (Pick best, Stop, Save) keep their text at WCAG AA (4.5:1) on both the page and a raised panel; fails_when=an outline button's color goes back to --brass, or --enamel-raised or the brass token is retuned below 4.5:1; why_new=design critique 2026-11-27 measured --brass on --enamel-raised at 4.3:1; seam=the filled Listen button uses --ink on --brass and is not covered here; no_claim=reads token values and rules, not rendered pixels or hover states
  it("keeps outline-button text at WCAG AA contrast on the page and on panels", () => {
    for (const selector of [".pick-best", ".power-on", ".presets-save button"]) {
      const color = /(?:^|[\s;])color:\s*var\((--[\w-]+)\)/.exec(ruleBody(selector))?.[1];
      expect(color, `${selector} color`).toBeDefined();
      for (const bg of ["--enamel", "--enamel-raised"]) {
        expect(contrast(token(color!), token(bg)), `${selector} ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The bar bites: plain --brass, the buttons' border, is under AA on a raised panel.
    expect(contrast(token("--brass"), token("--enamel-raised"))).toBeLessThan(4.5);
  });

  // Value: protects=text fields, selects and idle mode segments have a boundary of at least 3:1 (WCAG 1.4.11) against the page, a raised panel and their own deep fill; fails_when=those rules go back to --rule, or --rule-strong drops under 3:1 on any of the three enamel tones; why_new=design critique 2026-11-27 measured --rule at 1.38:1 to 2.10:1; seam=--rule itself stays for dividers and the map and is not asserted here; no_claim=does not cover focus rings, which are --lamp and already pass
  it("gives fields, selects and idle mode segments a 3:1 boundary", () => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const controls = [".field input", ".field select", ".select-button", ".presets-save input", ".mode span", ".span-step", ".tuning-bar-mode"];
    for (const selector of controls) {
      expect(declares(text, selector, /border:\s*1px solid var\(--rule-strong\)\s*;/), `${selector} border`).toBe(true);
    }
    for (const bg of ["--enamel", "--enamel-raised", "--enamel-deep"]) {
      expect(contrast(token("--rule-strong"), token(bg)), `--rule-strong on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  // Value: protects=the gutter is as tall as the glass and its row labels sit on their band rows, for the full dial and the compact one; fails_when=a Dial.tsx layout's H or band rows change, or .dial-glass min-width stops reading --glass-min, and the gutter's --dial-aspect or label positions are not updated; why_new=nothing tied the CSS to Dial.tsx geometry (the compact layout added a second one); seam=none; no_claim=real layout (jsdom has no container queries; source text only)
  it("sizes the dial gutter and places its labels from Dial.tsx's geometry", () => {
    const dial = readFileSync(new URL("../components/Dial.tsx", import.meta.url), "utf8").replace(/\s+/g, "");
    const W = Number(/constW=(\d+);/.exec(dial)?.[1]);
    expect(W).toBeGreaterThan(0);
    const layout = (name: string) => {
      const m = new RegExp(
        `const${name}:Layout=\\{H:(\\d+),broadcast:\\{y:(\\d+),labelY:\\[(\\d+),(\\d+)\\]\\},.*?ham:\\{y:(\\d+),labelY:\\[(\\d+),(\\d+)\\]\\}`,
      ).exec(dial);
      expect(m, `${name} layout`).not.toBeNull();
      const [H, by, b0, b1, hy, h0, h1] = m!.slice(1).map(Number) as [number, ...number[]];
      return { H, broadcast: [by!, b0!, b1!], ham: [hy!, h0!, h1!] };
    };
    // Both band rows draw from the active layout.
    expect(dial).toContain("<BandRowbands={BROADCAST_BANDS}{...layout.broadcast}");
    expect(dial).toContain("<BandRowbands={HAM_BANDS}{...layout.ham}");

    // Height = glass width × --dial-aspect, with the glass never narrower than its min-width.
    expect(ruleBody(".dial-gutter")).toMatch(
      /height:\s*calc\(max\(var\(--glass-min\),.*\)\s*\*\s*var\(--dial-aspect\)\)\s*;/,
    );
    expect(ruleBody(".dial-glass")).toMatch(/min-width:\s*var\(--glass-min\)\s*;/);

    const cases = [
      { name: "FULL", frame: ".dial-frame", label: (row: string) => `.dial-row-label-${row}` },
      {
        name: "COMPACT",
        frame: ".dial[data-compact] .dial-frame",
        label: (row: string) => `.dial[data-compact] .dial-row-label-${row}`,
      },
    ];
    for (const c of cases) {
      const g = layout(c.name);
      const aspect = Number(/--dial-aspect:\s*([\d.]+)\s*;/.exec(ruleBody(c.frame))?.[1]);
      expect(aspect, `${c.name} --dial-aspect`).toBeCloseTo(g.H / W, 3);
      // Each label's center falls inside its band row: from the higher of bar top and first label, to the second label.
      for (const row of ["broadcast", "ham"] as const) {
        const [y, l0, l1] = g[row];
        let body: string;
        try {
          body = ruleBody(c.label(row));
        } catch {
          body = ruleBody(`.dial-row-label-${row}`); // the compact dial keeps the full one's position
        }
        const top = Number(/top:\s*([\d.]+)%/.exec(body)?.[1]);
        const center = (top / 100) * g.H;
        expect(center, `${c.name} ${row} label center`).toBeGreaterThanOrEqual(Math.min(y!, l0!));
        expect(center, `${c.name} ${row} label center`).toBeLessThanOrEqual(l1!);
      }
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

  // Value: protects=#102 owner decision D5: every live signal row's "heard" line holds one line's height from the first render (1.5em kept before 1lh for browsers without the lh unit) and never wraps, and on phones the cell may shrink so the line ends in an ellipsis instead of widening the row; fails_when=a duplicate-property cleanup drops the 1.5em fallback or puts it after 1lh, nowrap/ellipsis go, or the phone min-width:0 leaves the media block, so a badge arriving moves another station's Listen under a press; why_new=SignalStations.test checks the empty span exists but jsdom has no layout and nothing read these rules; seam=none; no_claim=how any browser renders it (source text only)
  it("reserves one unwrapped line for a signal row's heard badge", () => {
    const heard = ruleBody(".signals-heard");
    const fallback = heard.search(/min-height:\s*1\.5em\s*;/);
    const lh = heard.search(/min-height:\s*1lh\s*;/);
    expect(fallback, "min-height: 1.5em").toBeGreaterThan(-1);
    expect(lh, "min-height: 1lh after the 1.5em fallback").toBeGreaterThan(fallback);
    expect(heard).toMatch(/display:\s*block\s*;/);
    expect(heard).toMatch(/white-space:\s*nowrap\s*;/);
    expect(heard).toMatch(/overflow:\s*hidden\s*;/);
    expect(heard).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(ruleBody(".signals .sched-strip tr > td")).toMatch(/min-width:\s*0\s*;/);
    // That shrink rule is the phone grid's: inside the max-width media block.
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const at = text.search(/(^|[}\s])\.signals \.sched-strip tr > td\s*\{/);
    const open = text.lastIndexOf("@media (max-width:", at);
    expect(open).toBeGreaterThan(-1);
    const between = text.slice(open, at);
    expect(between.split("{").length - between.split("}").length).toBeGreaterThan(0);
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

  // Value: protects=Listen/Stop holds its place in the header's first row whatever the strip says, so the button just pressed doesn't move while a receiver connects; fails_when=.console-header goes back to a wrapping flex row or the strip's column loses minmax(0, 1fr); why_new=design critique 2026-11-27 saw Stop wrap under the wordmark on a long "Listening via" line; seam=the strip's text is page.tsx's, tested there; no_claim=jsdom has no layout, so this reads the CSS and does not prove the rendered position
  it("keeps Listen/Stop in its own header column beside a strip that can shrink", () => {
    const header = ruleBody(".console-header");
    expect(header).toMatch(/display:\s*grid\s*;/);
    expect(header).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/);
    // A strip that wraps its links to a second line grows the row; the button holds the top.
    expect(header).toMatch(/align-items:\s*start\s*;/);
  });

  // Value: protects=on a small tablet or narrow window the strip gets a row of its own instead of a ~100px column four lines deep, while Listen/Stop keeps the first row's right end; fails_when=the mid-width media block stops giving the button its own auto column or stops putting the strip on a full-width second row, or its breakpoint goes back to px so large text squeezes the strip's links under the button, or the ≤520px block stops returning .console-header to the wrapping flex row so phones get the grid instead of #106's stacked header; why_new=headless measure at 521px showed the three-column strip squeezed to ~100px, and nothing else asserts the phone override the owner chose; seam=none; no_claim=jsdom has no layout, so this reads the CSS and does not prove the rendered position or the 720px width is the best cut
  it("gives the header strip its own row between phone and desktop widths", () => {
    // In em, so with a larger default font the switch moves out with the wordmark and button.
    const block = /@media \(max-width: 45em\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(block, "the 45em (720px at 16px) media block").toBeDefined();
    expect(block).toMatch(/\.console-header\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s*;/);
    // The strip is placed on row 2, not given a two-row template, so a header without one gets no empty row.
    expect(block).not.toMatch(/grid-template-(areas|rows)/);
    const strip = /\.tuned-to\s*\{([^}]*)\}/.exec(block!)?.[1];
    expect(strip).toMatch(/grid-column:\s*1\s*\/\s*-1\s*;/);
    expect(strip).toMatch(/grid-row:\s*2\s*;/);
    // A phone keeps #106's stacked header: the 520px block puts the wrapping flex row back.
    const phone = /@media \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]?.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(phone, "the 520px media block").toBeDefined();
    const phoneHeader = /(?:^|\s)\.console-header\s*\{([^}]*)\}/.exec(phone!)?.[1];
    expect(phoneHeader, "the phone .console-header rule").toBeDefined();
    expect(phoneHeader).toMatch(/display:\s*flex\s*;/);
    expect(phoneHeader).toMatch(/flex-wrap:\s*wrap\s*;/);
  });

  // Value: protects=on /owners and /signals the header's lone "skywave" link keeps its text width in the grid, so blank header space doesn't link home; fails_when=.owners-wordmark loses justify-self: start and the link stretches across the ≤720px grid's wide column; why_new=the Step 9 review found the stretch at 521-720px, which no test covered; seam=none; no_claim=jsdom has no layout, so this reads the CSS and does not prove the rendered click area
  it("keeps the secondary pages' wordmark link to its text width in the header grid", () => {
    expect(ruleBody(".owners-wordmark")).toMatch(/justify-self:\s*start\s*;/);
  });

  // Value: protects=between phone and desktop widths the readout's column (readout plus Copy link, #179) spans both control columns, and on phones drops back to the single column; fails_when=the 860px span-2 list or the 520px reset names the inner .readout form (as before #179) or drops .readout-col, so the readout and its station line squeeze into half the panel; why_new=#179 moved the grid item from .readout to .readout-col and no test read either media list; seam=none; no_claim=jsdom has no layout, so this reads the CSS and does not prove the rendered widths
  it("lets the readout's column span the controls' two columns at tablet width, one on phones", () => {
    const tablet = mediaBlock("(max-width: 860px)");
    expect(declares(tablet, ".controls", /grid-template-columns:\s*1fr 1fr\s*;/)).toBe(true);
    expect(declares(tablet, ".readout-col", /grid-column:\s*span 2\s*;/), ".readout-col spans both").toBe(true);
    expect(declares(mediaBlock("(max-width: 520px)"), ".readout-col", /grid-column:\s*auto\s*;/), "reset on phones").toBe(true);
  });

  // Value: protects=the Decode RTTY line keeps its height while the switch is hidden (AM, CW, #179), on touch too, so changing mode doesn't move the S-meter row and everything under it; fails_when=.decode-slot loses its one-line min-height, or leaves the coarse-pointer 44px list while .letter-keys (the switch inside it) stays, so the panel jumps ~20px on a tablet when USB is picked, or Copy link (.readout-copy) leaves that list and is a ~20px tap target on a touch tablet; why_new=#179 added the held slot and nothing read its rules; seam=none; no_claim=jsdom has no layout, so this reads the CSS and does not measure the panel
  it("holds the Decode RTTY line's height while the switch is hidden, at touch size too", () => {
    expect(ruleBody(".decode-slot")).toMatch(/min-height:\s*1lh\s*;/);
    const touch = mediaBlock("(max-width: 520px), (pointer: coarse)");
    // Copy link (#179, owner D3) is small text on its own line; on touch it gets the same 44px.
    for (const selector of [".letter-keys", ".decode-slot", ".readout-copy"]) {
      expect(declares(touch, selector, /min-height:\s*44px\s*;/), `${selector} at 44px on touch`).toBe(true);
    }
  });

  // Value: protects=the intro line (#177) keeps its taller version's height and shows one version, so the dial doesn't move 24px on a phone when the sentence switches (tuning off 10,000 kHz, saved tuning loading); fails_when=.console-intro stops being a grid, its spans leave the shared cell, or the aria-hidden version stops being hidden; why_new=the fix added the held height and nothing read its rules; seam=none; no_claim=jsdom has no layout, so this reads the CSS and does not measure the line
  it("holds the intro line at its taller version's height, showing one version", () => {
    expect(ruleBody(".console-intro")).toMatch(/display:\s*grid\s*;/);
    expect(ruleBody(".console-intro > span")).toMatch(/grid-area:\s*1\s*\/\s*1\s*;/);
    expect(ruleBody(".console-intro > span[aria-hidden]")).toMatch(/visibility:\s*hidden\s*;/);
  });

  // Value: protects=the open audio waterfall's "Nothing is playing" / "Tuning in…" line (#178) sits on the same dark chip as the wide view's notes, over the picture left after Stop; fails_when=the data-open selector leaves the chip rule, or the chip loses its --enamel-deep ground; why_new=Waterfall.test checks the span exists but jsdom applies no CSS and nothing read this rule; seam=none; no_claim=jsdom has no layout, so this reads the CSS and does not prove the chip's contrast over every picture
  it("puts the open waterfall's empty line on the wide view's chip", () => {
    for (const selector of [".waterfall[data-wide] .waterfall-empty > span", ".waterfall[data-open] .waterfall-empty > span"]) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(declares(text, selector, /background:\s*var\(--enamel-deep\)\s*;/), `${selector} on the chip`).toBe(true);
    }
  });

  // Value: protects=the Decode RTTY title and decoded text stay >= 4.5:1 on the page's --enamel ground (#178); fails_when=.decode-title or .decode-text goes back to --ink (dark ink meant for the dial glass, ~1.1:1 here) or a token is retuned below AA; why_new=no test read the decode panel's colours; seam=none; no_claim=computed from :root hex values on the body's --enamel only; source text, not rendering
  it("keeps the decode panel's title and text at WCAG AA contrast on the page", () => {
    for (const selector of [".decode-title", ".decode-text"]) {
      const color = /(?:^|[\s;])color:\s*var\((--[\w-]+)\)/.exec(ruleBody(selector))?.[1];
      expect(color, `${selector} color`).toBeDefined();
      expect(contrast(token(color!), token("--enamel")), `${selector} ${color} on --enamel`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
