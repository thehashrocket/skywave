import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("./prisma/", import.meta.url));
const schema = readFileSync(`${dir}schema.prisma`, "utf8");
const migrations = readdirSync(`${dir}migrations`, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => readFileSync(`${dir}migrations/${d.name}/migration.sql`, "utf8"))
  .join("\n");

/** Each model and its scalar fields, from the schema text. */
function models(): { name: string; fields: string[] }[] {
  return [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
    name: name!,
    fields: body!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\w/.test(l))
      .map((l) => l.split(/\s+/)[0]!),
  }));
}

describe("prisma migrations", () => {
  // Value: protects=every model and field in schema.prisma is created by a committed migration, so `prisma migrate deploy` (vercel-build) gives production the tables the code queries; fails_when=the schema gains a model or column without a migration; why_new=ReceptionReport (#60) added the second model; seam=reads the files, no database; no_claim=types, defaults or indexes match, or migrations apply cleanly
  it.each(models().map((m) => [m.name, m.fields] as const))("creates %s and its columns", (name, fields) => {
    const table = new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`).exec(migrations)?.[1];
    expect(table, `no migration creates "${name}"`).toBeDefined();
    for (const f of fields) expect(table, `"${name}"."${f}" has no migration`).toContain(`"${f}"`);
  });
});
