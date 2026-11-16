import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "../common/repo-tree.util";

/**
 * A phone number is written to the database in one form, through one door.
 *
 * `payees.phone` used to be stored exactly as typed, and three surfaces write
 * one -- the payee form through `PayeesService`, the AI Assistant and MCP
 * `manage_payees` tools through the same service, and the AI contact lookup,
 * whose background enrichment `UPDATE` writes a model's answer into the column
 * with no DTO anywhere in its path. Each stored a different shape of the same
 * number, so nothing could compare two of them and a `tel:` link dialled
 * whatever the last writer happened to save.
 *
 * The rule is not that every file calls the normalizer: it is that a file
 * writing this column is one of the doors that does. A fourth writer added
 * later -- an importer, a merge, a bulk edit -- fails here rather than shipping
 * a second format nobody notices until two screens disagree.
 */
const srcRoot = join(__dirname, "..");

/**
 * Comments blanked, newlines preserved so a reported line number still points
 * at the offending line. The prose in this repository has to be able to NAME
 * the pattern being banned without tripping the scan that bans it -- the
 * alternative is weakening the explanation, which is the opposite of the point.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, lead: string) => lead + " ".repeat(match.length - lead.length),
    );
}

/**
 * A phone value being put somewhere, in each dialect this codebase uses: an
 * object literal, an assignment, and raw SQL -- both the `UPDATE` that names
 * the column and the `INSERT` that names it in a column list. Deliberately by
 * shape rather than by file, because the point is to catch the writer nobody
 * has thought of yet.
 */
const PHONE_WRITES: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "an entity or update field", pattern: /\bphone:\s*(?!undefined\b)/ },
  { what: "an assignment to a phone field", pattern: /\.phone\s*=\s*[^=]/ },
  {
    what: "raw SQL setting phone",
    pattern: /\bSET\b[\s\S]{0,200}?\bphone\s*=/i,
  },
  {
    // `[^)]` keeps the match inside the column list: an INSERT that does not
    // name the column, followed anywhere later in the file by the word, is not
    // a write. A row of placeholders says nothing about which column each one
    // fills, so the column list is the only place an INSERT declares itself.
    what: "raw SQL inserting a phone column",
    pattern: /\bINSERT\s+INTO\s+\w+\s*\([^)]{0,400}\bphone\b/i,
  },
];

/**
 * Reaching the database at all. Paired with the patterns above, this is what
 * separates a file that STORES a phone from the many that merely declare one:
 * an entity's `@Column`, a Zod tool schema, a prompt, a type, and the support
 * backup's redaction map all name the field and none of them can write it.
 *
 * Asking two questions rather than widening the first one keeps the rule
 * honest: an exclusion list of files that "only declare" would have to grow
 * every time somebody names the field, and a file quietly gaining a write
 * would keep its exemption.
 */
const PERSISTS =
  /\.(?:save|insert|upsert|update|createQueryBuilder|query)\s*\(|\brepo(?:sitory)?\.create\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i;

/**
 * The doors, and why each is one.
 *
 * `payees.service.ts` normalizes every create, update and preview through
 * `previewContactFields`. `payee-contact-lookup.service.ts` normalizes every
 * suggestion before any caller sees it, which is what makes the enrichment
 * `UPDATE` safe -- it writes only values that came through that door.
 */
const NORMALIZING_DOORS: Record<string, string> = {
  "payees/payees.service.ts":
    "normalizes every create, update and preview through previewContactFields",
  "payees/lookup/payee-contact-lookup.service.ts":
    "normalizes every suggestion before a caller can write it",
  "payees/lookup/payee-contact-enrichment.service.ts":
    "writes only values the lookup service already normalized",
};

/**
 * Files that carry a phone value past a database call without deciding its
 * format -- a read model, an adapter over a service that normalizes, or a
 * writer of a fixed constant whose format another spec pins. Each is listed
 * with the reason, because ending up here should be a decision, and the reason
 * has to name what decides the format instead of this file.
 */
const PASSES_THROUGH: Record<string, string> = {
  "ai/actions/ai-actions.service.ts":
    "builds a CreatePayeeDto/UpdatePayeeDto and calls PayeesService, which normalizes; it holds no Payee repository",
  "mcp/tools/payees.tool.ts":
    "builds tool rows and calls PayeesService, which normalizes; it holds no Payee repository",
  "database/demo-seed.service.ts":
    "writes the fixed demo payee numbers from demo-seed-data/payees.ts, whose spec asserts each one already equals its own normalized stored form",
};

function sourceFiles(): string[] {
  return gitListFiles(srcRoot)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".spec.ts"))
    .filter((file) => !file.endsWith("common/phone-number.util.ts"));
}

/** Every source file that puts a phone value somewhere AND reaches the database. */
function phoneWriters(): { file: string; what: string; source: string }[] {
  const found: { file: string; what: string; source: string }[] = [];
  for (const file of sourceFiles()) {
    const source = withoutComments(readFileSync(join(srcRoot, file), "utf8"));
    if (!PERSISTS.test(source)) continue;
    for (const { what, pattern } of PHONE_WRITES) {
      if (pattern.test(source)) {
        found.push({ file, what, source });
        break;
      }
    }
  }
  return found;
}

describe("a payee phone is stored in one form", () => {
  it("finds the writers, so the sweep below is not vacuous", () => {
    // Were the scan to break, the rule would pass over an empty list and this
    // guard would silently stop guarding.
    const files = phoneWriters().map((entry) => entry.file);
    expect(files.length).toBeGreaterThan(2);
    expect(files).toContain("payees/payees.service.ts");
  });

  it("is written only through a normalizing door", () => {
    const offenders = phoneWriters()
      .filter(({ file }) => !(file in NORMALIZING_DOORS))
      .filter(({ file }) => !(file in PASSES_THROUGH))
      .filter(({ source }) => !source.includes("normalizePhone"))
      .map(({ file, what }) => `${file}: ${what}`);
    // Either normalize through `normalizePhoneOrThrow` /
    // `normalizePhoneNumber`, or list the file above with the reason it stores
    // no format decision of its own.
    expect(offenders).toEqual([]);
  });

  it("keeps the pass-through list free of entries that no longer apply", () => {
    // The teeth: the list may only shrink. An entry stops applying when the
    // file stops writing a phone, starts normalizing one, or goes away -- and
    // an exemption that outlives its reason is how a second format door hides.
    const writers = new Set(phoneWriters().map((entry) => entry.file));
    const stale = Object.keys(PASSES_THROUGH).filter(
      (file) => !writers.has(file),
    );
    expect(stale).toEqual([]);
  });

  it("names doors that really are doors", () => {
    for (const file of Object.keys(NORMALIZING_DOORS)) {
      const source = readFileSync(join(srcRoot, file), "utf8");
      // The enrichment service is a door because its input is normalized, not
      // because it normalizes; it is checked by its own spec instead.
      if (file.endsWith("payee-contact-enrichment.service.ts")) {
        expect(source).toContain("phone");
        continue;
      }
      expect(withoutComments(source)).toContain("normalizePhone");
    }
  });

  it("catches a writer that stores a raw value", () => {
    // The counter-test: the rule must not be able to pass by matching nothing.
    const offending = `const row = { phone: dto.phone }; await repo.save(row);`;
    expect(PHONE_WRITES.some(({ pattern }) => pattern.test(offending))).toBe(
      true,
    );
    expect(PERSISTS.test(offending)).toBe(true);

    const sql = `await m.query("UPDATE payees SET phone = $1 WHERE id = $2");`;
    expect(PHONE_WRITES.some(({ pattern }) => pattern.test(sql))).toBe(true);
    expect(PERSISTS.test(sql)).toBe(true);

    // An INSERT names the column in its list rather than beside its value, so
    // the UPDATE pattern above reads straight past it -- which is how a seeder
    // came to write this column without going through a door.
    const insert = `await m.query(\`INSERT INTO payees (
        user_id, name, website, address, phone
      ) VALUES ($1, $2, $3, $4, $5)\`);`;
    expect(PHONE_WRITES.some(({ pattern }) => pattern.test(insert))).toBe(true);
    expect(PERSISTS.test(insert)).toBe(true);
  });

  it("does not read an INSERT that leaves the column alone as a write", () => {
    // The word appearing later in the file -- another statement, a variable, a
    // returned column -- is not this INSERT naming the column.
    const insert = `await m.query(\`INSERT INTO payees (user_id, name) VALUES ($1, $2)\`);
      const phone = row.phone;`;
    const inserts = PHONE_WRITES.find(({ what }) =>
      what.includes("inserting"),
    ) as { pattern: RegExp };
    expect(inserts.pattern.test(insert)).toBe(false);
  });

  it("does not read a declaration as a write", () => {
    // A type, a Zod schema and an entity column all NAME the field; none can
    // store one, and treating them as writers is what makes a guard so noisy
    // it gets exempted into uselessness.
    for (const declaration of [
      `export interface Payee { phone: string | null }`,
      `phone: z.string().max(50).optional(),`,
      `@Column({ name: "phone" }) phone: string | null;`,
      `const REDACTION = { phone: "drop" };`,
    ]) {
      expect(PERSISTS.test(declaration)).toBe(false);
    }
  });

  it("blanks comments without moving the lines after them", () => {
    // A scan that reads prose would fail the paragraph explaining it, and the
    // cheap way out is a weaker explanation.
    const source = ["/* phone: raw */", "const a = 1;", "// .phone = raw"].join(
      "\n",
    );
    const blanked = withoutComments(source);
    expect(blanked).not.toMatch(/phone:\s*raw/);
    expect(blanked).not.toMatch(/\.phone\s*=\s*raw/);
    expect(blanked.split("\n")).toHaveLength(3);
    expect(blanked.split("\n")[1]).toBe("const a = 1;");
    // ...and it still finds a real write on the line after a comment.
    expect(withoutComments("// note\nconst r = { phone: x };")).toContain(
      "phone: x",
    );
  });
});
