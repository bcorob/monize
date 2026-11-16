import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const NET_WORTH_ROOT = __dirname;

/**
 * Blank out line and block comments, preserving line count and line length, so
 * an offender's report still points at the right line.
 *
 * A guard that bans a pattern has to be explained by prose that names the
 * pattern, and `series-dates.util.ts` does exactly that in its doc comment. A
 * scan of raw text would fail on the explanation, and the cheap way out --
 * weakening the comment -- is the opposite of the point.
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
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * A calendar date is iterated as `YYYY-MM-DD`, never through a local `Date`.
 *
 * `new Date(ymd + "T00:00:00")` is LOCAL midnight and `toISOString()` reads UTC
 * components, so the pair names every day one day early in any process east of
 * Greenwich; `setDate` stepping carries the same instant across a DST boundary.
 * The series that ran on that pair reported the first day of every range with
 * no cash at all and never emitted the last (#1389). The rule is mechanical, so
 * it gets a scan: `enumerateDaysYMD` (`series-dates.util.ts`) and `addDaysYMD`
 * (`common/date-utils.ts`) are the two shapes a date walk may take here.
 */
describe("the net-worth series iterates calendar dates as strings", () => {
  const files = sourceFiles(NET_WORTH_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it("builds no zone-less local-midnight Date from a YYYY-MM-DD value", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(NET_WORTH_ROOT, file).split("\\").join("/");
      const lines = blankComments(readFileSync(file, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        // A `T00:00:00` that does not end in `Z` or an offset is local midnight.
        if (/T00:00:00(?![.\d]*(?:Z|[+-]\d))/.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    // Jest prints the offending lines; the repair is `enumerateDaysYMD`.
    expect(offenders).toEqual([]);
  });

  it("steps a date with addDaysYMD, not with Date.setDate", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(NET_WORTH_ROOT, file).split("\\").join("/");
      const lines = blankComments(readFileSync(file, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (/\.setDate\s*\(/.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("blankComments", () => {
  it("hides the banned shape when it is being explained", () => {
    const prose =
      '// new Date(start + "T00:00:00") is local midnight\nconst a = 1;\n';
    expect(/T00:00:00/.test(blankComments(prose))).toBe(false);
    expect(blankComments(prose).split("\n")[1]).toBe("const a = 1;");
  });

  it("still sees the banned shape in code", () => {
    const code = 'const d = new Date(start + "T00:00:00");\n';
    expect(/T00:00:00/.test(blankComments(code))).toBe(true);
  });

  it("preserves line numbers across a block comment", () => {
    const src = "/* one\n   two */\nconst c = 3;\n";
    expect(blankComments(src).split("\n")).toHaveLength(4);
    expect(blankComments(src).split("\n")[2]).toBe("const c = 3;");
  });
});
