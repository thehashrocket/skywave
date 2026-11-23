import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The repository root: VERSION and CHANGELOG.md live there, two levels above apps/web.
const root = fileURLToPath(new URL("../../", import.meta.url));
const version = readFileSync(join(root, "VERSION"), "utf8").trim();
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})/gm)].map(([, v, date]) => ({
  v: v!,
  date: date!,
}));

const parts = (v: string) => v.split(".").map(Number);
/** Negative when a is the older version. */
const compare = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

describe("release files", () => {
  // Value: protects=VERSION is the four-part number /ship bumps, and the newest CHANGELOG entry is that release, so a bump never ships without its entry or the reverse; fails_when=VERSION is hand-edited to another format, or bumped without moving the CHANGELOG heading; why_new=VERSION and CHANGELOG.md are new (0.44.0.0); seam=reads the files; no_claim=the entry's wording describes the release
  it("heads the CHANGELOG with the VERSION release", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(headings[0]?.v).toBe(version);
  });

  // Value: protects=CHANGELOG releases are newest first with versions that only go up and dates that never go back, as one per merged PR; fails_when=an entry is inserted out of order, a version repeats, or a date runs backwards; why_new=the history was rebuilt by hand from 79 PRs; seam=reads the file; no_claim=each version's bump level matches its PR
  it("lists releases newest first, each version above the one before", () => {
    expect(headings.length).toBeGreaterThan(1);
    for (let i = 1; i < headings.length; i++) {
      const [newer, older] = [headings[i - 1]!, headings[i]!];
      expect(compare(newer.v, older.v), `${newer.v} above ${older.v}`).toBeGreaterThan(0);
      expect(newer.date >= older.date, `${newer.v} dated ${newer.date}, ${older.v} ${older.date}`).toBe(true);
    }
  });
});
