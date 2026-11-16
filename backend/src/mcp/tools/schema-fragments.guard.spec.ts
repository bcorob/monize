import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "../../common/repo-tree.util";

/**
 * The shared input-schema fragments are only worth having if nothing declares a
 * second copy. A tool that spells `z.string().uuid()` inline ships a
 * 166-character pattern the fragment exists to avoid, and a tool that spells its
 * own approval enum can drift from the wording every other write tool uses.
 *
 * A scan, not a paragraph: this is exactly the mechanical mistake a source scan
 * catches and a convention does not.
 */

const TOOLS_DIR = join(__dirname);
const FRAGMENTS_FILE = "schema-fragments.ts";

function toolSources(): Array<{ file: string; source: string }> {
  return gitListFiles(TOOLS_DIR)
    .filter((f) => f.endsWith(".tool.ts"))
    .map((file) => ({
      file,
      source: readFileSync(join(TOOLS_DIR, file), "utf8"),
    }));
}

/** Blank comments so prose naming a banned pattern cannot trip the scan. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

describe("shared MCP input-schema fragments", () => {
  const sources = toolSources();

  it("finds the tool sources it claims to scan", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
  });

  it("declares no UUID validator outside the fragments file", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      stripComments(source)
        .split("\n")
        .forEach((line, index) => {
          if (line.includes(".uuid()")) {
            offenders.push(`${file}:${index + 1}`);
          }
        });
    }
    // `uuidString()` from schema-fragments.ts, which ships a 75-character
    // pattern instead of a format plus a 166-character one.
    expect(offenders).toEqual([]);
  });

  it("declares no second copy of the operation or approval enum", () => {
    const banned = [
      `z.enum(["create", "update", "delete"])`,
      `z.enum(["bulk", "individual"])`,
    ];
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      const stripped = stripComments(source).replace(/\s+/g, " ");
      for (const pattern of banned) {
        if (stripped.includes(pattern)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("takes every number and boolean through the coercing helpers", () => {
    // A model writes `limit: "10"` often enough that a bare z.number() is a
    // defect, not strictness: the SDK answered -32602 "expected number,
    // received string" for a request that was perfectly clear. numberArg and
    // booleanArg accept the string form, still refuse junk, and serialize to
    // the same JSON Schema, so the tolerance is free.
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      // `numberArg(z.number()...)` is the correct form -- the bounds belong to
      // the number and the wrapper is what accepts the string form -- and the
      // formatter often splits that call across two lines. So blank the pair
      // across the whole source before scanning, keeping newlines so the
      // offender report still points at the right line.
      const scanned = stripComments(source).replace(
        /numberArg\(\s*z\.number\(\)/g,
        (match) => match.replace(/[^\n]/g, " "),
      );
      scanned.split("\n").forEach((line, index) => {
        if (/\bz\.(number|boolean)\(\)/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the UUID pattern free of regex flags", () => {
    // Zod serializes `regex.source`, which never carries flags: a flagged
    // pattern would validate one way on the server and another on the client.
    const fragments = readFileSync(join(TOOLS_DIR, FRAGMENTS_FILE), "utf8");
    const patterns = fragments.match(/\/\^[^\n]*\/[a-z]*;/g) ?? [];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern).toMatch(/\/;$/);
    }
  });
});
