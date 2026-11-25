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

/** Each migration's SQL statements, comments dropped, by directory name. */
const statements = readdirSync(`${dir}migrations`, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({
    name: d.name,
    sql: readFileSync(`${dir}migrations/${d.name}/migration.sql`, "utf8")
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  }));

describe("prisma migrations", () => {
  // Value: protects=a CREATE INDEX CONCURRENTLY migration (#102's ReceptionReport txKind index) stays its file's only statement, so Prisma applies it outside a transaction and `prisma migrate deploy` (vercel-build) doesn't fail on Postgres's "cannot run inside a transaction block"; fails_when=another statement is added beside a CONCURRENTLY one and the deploy breaks; why_new=the rule lived only in the migration's comment; seam=reads the files, no database; no_claim=that Prisma's single-statement handling stays the same across Prisma versions
  it("keeps each CONCURRENTLY statement alone in its migration", () => {
    const concurrent = statements.filter((m) => m.sql.some((s) => /\bCONCURRENTLY\b/i.test(s)));
    expect(concurrent.length).toBeGreaterThan(0);
    for (const m of concurrent) expect(m.sql, m.name).toHaveLength(1);
  });


  // Value: protects=every model and field in schema.prisma is created by a committed migration, so `prisma migrate deploy` (vercel-build) gives production the tables the code queries; fails_when=the schema gains a model or column without a migration; why_new=ReceptionReport (#60) added the second model; seam=reads the files, no database; no_claim=types, defaults or indexes match, or migrations apply cleanly
  it.each(models().map((m) => [m.name, m.fields] as const))("creates %s and its columns", (name, fields) => {
    const table = new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`).exec(migrations)?.[1];
    expect(table, `no migration creates "${name}"`).toBeDefined();
    // A column comes from the CREATE TABLE or a later ALTER TABLE on that table, which
    // Prisma writes as one statement with an ADD COLUMN per column, comma-separated.
    const added = [...migrations.matchAll(new RegExp(`ALTER TABLE "${name}" ([^;]*);`, "g"))].flatMap(([, body]) =>
      [...body!.matchAll(/ADD COLUMN "(\w+)"/g)].map(([, f]) => `"${f}"`),
    );
    for (const f of fields)
      expect(`${table} ${added.join(" ")}`, `"${name}"."${f}" has no migration`).toContain(`"${f}"`);
  });
});
