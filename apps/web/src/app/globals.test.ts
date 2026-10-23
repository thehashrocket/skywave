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

describe("globals.css", () => {
  // Value: protects=a renamed or deleted selector can't silently unstyle a component; fails_when=a component uses a class globals.css never defines; why_new=pre-gate had no lane for globals.css; seam=source text; no_claim=how anything looks
  it("defines every class the page and its components use", () => {
    const used = sources.flatMap((url) => classesIn(readFileSync(url, "utf8")));
    // The scan really reads the components, including the ternary form.
    expect(used).toEqual(expect.arrayContaining(["col-night", "status-back", "power-on", "dial-num-major"]));
    const missing = used.filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
    expect(missing).toEqual([]);
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
