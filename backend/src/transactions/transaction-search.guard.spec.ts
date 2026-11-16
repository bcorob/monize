import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/**
 * INV-SEARCH-001: every surface that takes a transaction search string reads
 * it through one parser and one clause builder, and escapes it exactly once.
 *
 * Before the search syntax (docs/specs/advanced-search.md) five call
 * sites each escaped the string, wrapped it in `%...%` and bound three
 * parameters by hand, and the LLM totals path escaped it a second time, so a
 * search holding `%` gave the assistant totals that disagreed with its own
 * rows. The door is `applyTransactionSearch` (or its two halves,
 * `resolveTransactionSearch` and `applyParsedSearch`); the parser and the
 * builder are imported only by the door and by their own files.
 */

/** Files that may import the parser or the builder. */
const DOOR = new Set([
  "transactions/apply-transaction-search.ts",
  "transactions/transaction-search.util.ts",
  "transactions/transaction-search-query.util.ts",
]);

const BUILDER_IMPORT =
  /\b(?:parseTransactionSearch|buildTransactionSearchWhere)\b/;

/** A hand-built LIKE pattern around a search-like value. */
const HAND_PATTERN = /`%\$\{[^}]*search[^}]*\}%?`/i;

/**
 * Blanks line and block comments, keeping line count and length, so prose
 * that names a banned pattern cannot fail the scan and an offender's line
 * number stays right. Strings are kept: the banned shapes live in them.
 */
export function blankComments(source: string): string {
  let out = "";
  let inLine = false;
  let inBlock = false;
  let inString: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "\n") {
      inLine = false;
      out += c;
      continue;
    }
    if (inLine || inBlock) {
      if (inBlock && c === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i++;
        continue;
      }
      out += " ";
      continue;
    }
    if (inString) {
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i++;
        continue;
      }
      if (c === inString) inString = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("transaction search has one door (INV-SEARCH-001)", () => {
  const files = sourceFiles(SRC_ROOT).map((file) => ({
    rel: relative(SRC_ROOT, file).split("\\").join("/"),
    lines: blankComments(readFileSync(file, "utf8")).split("\n"),
  }));

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => DOOR.has(file.rel))).toBe(true);
  });

  it("imports the parser and the builder only through the door", () => {
    const offenders = files
      .filter((file) => !DOOR.has(file.rel))
      .flatMap((file) =>
        file.lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => BUILDER_IMPORT.test(line))
          .map(({ index }) => `${file.rel}:${index + 1}`),
      );
    if (offenders.length > 0) {
      throw new Error(
        `Apply a search string through applyTransactionSearch (or ` +
          `resolveTransactionSearch + applyParsedSearch) in ` +
          `transactions/apply-transaction-search.ts, never the parser or ` +
          `the clause builder directly:\n  ${offenders.join("\n  ")}`,
      );
    }
  });

  it("never hand-builds a LIKE pattern around a search string", () => {
    // The transactions module, where the search string lives, and the custom
    // report engine, whose text filters go through the door too (audit A26-L12).
    const offenders = files
      .filter(
        (file) =>
          file.rel.startsWith("transactions/") ||
          file.rel.startsWith("reports/"),
      )
      .filter((file) => !DOOR.has(file.rel))
      .flatMap((file) =>
        file.lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => HAND_PATTERN.test(line))
          .map(({ index }) => `${file.rel}:${index + 1}`),
      );
    if (offenders.length > 0) {
      throw new Error(
        `A search string is escaped once, inside the clause builder; pass ` +
          `the raw string to applyTransactionSearch instead of wrapping it ` +
          `in %...% here:\n  ${offenders.join("\n  ")}`,
      );
    }
  });

  describe("the scan itself", () => {
    it("catches the shapes it bans", () => {
      expect(
        BUILDER_IMPORT.test('import { parseTransactionSearch } from "./x";'),
      ).toBe(true);
      expect(HAND_PATTERN.test("const p = `%${filters.search.trim()}%`;")).toBe(
        true,
      );
      expect(HAND_PATTERN.test("search: `%${safeSearchText}%`,")).toBe(true);
    });

    it("leaves unrelated LIKE patterns alone", () => {
      expect(HAND_PATTERN.test("`%${escapeLikePattern(domain)}`")).toBe(false);
      expect(HAND_PATTERN.test("`%${escapeLikePattern(filter.value)}%`")).toBe(
        false,
      );
    });

    it("ignores prose but keeps code, line for line", () => {
      const prose =
        "// never write `%${search}%` by hand\n/* parseTransactionSearch */";
      const code = "const p = `%${search}%`;";
      expect(HAND_PATTERN.test(blankComments(prose))).toBe(false);
      expect(BUILDER_IMPORT.test(blankComments(prose))).toBe(false);
      expect(HAND_PATTERN.test(blankComments(code))).toBe(true);
      expect(blankComments(prose).split("\n")).toHaveLength(
        prose.split("\n").length,
      );
    });
  });
});
