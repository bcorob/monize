import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

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

/**
 * Blank comments while keeping line numbers, so an offender report still
 * points at the right line and prose may name the banned shape.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * A numeric environment variable is coerced, never merely type-asserted.
 *
 * `ConfigService.get<number>("X")` reads `process.env` and hands the value
 * back untouched: the type parameter is an assertion, not a conversion, so the
 * value is the *string* `"465"` in every deployment and a number only where a
 * test mocks the reader. That gap is invisible in review and invisible in a
 * unit suite whose mock returns numbers, and it costs real behaviour --
 * `SMTP_PORT=465` compared with `=== 465` decided against implicit TLS, the
 * transport greeted Gmail's TLS-only port in cleartext, and the relay hung up
 * (`Error: Unexpected socket close`).
 *
 * The rule is already written down -- `backend/CLAUDE.md` and
 * `docs/backend/modules-and-runtime.md` -- so this is the version the machine
 * checks. `resolvePositiveInt` (`src/common/env-number.util.ts`) coerces and
 * separates *absent* from *invalid*; a boolean environment variable is
 * compared as the string it is.
 */
describe("numeric environment variables are coerced, not type-asserted", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never reads a config value through get<number> or get<boolean>", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (/\.get\s*<\s*(number|boolean)\s*>\s*\(/.test(line)) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("still sees the banned shape when it is real code, not prose", () => {
    const prose = '/**\n * configService.get<number>("SMTP_PORT")\n */\n';
    const code = 'const p = this.configService.get<number>("SMTP_PORT");\n';
    const banned = /\.get\s*<\s*(number|boolean)\s*>\s*\(/;

    expect(banned.test(stripComments(prose))).toBe(false);
    expect(banned.test(stripComments(code))).toBe(true);
    // Blanking keeps the line count, so reported line numbers stay true.
    expect(stripComments(prose).split("\n")).toHaveLength(
      prose.split("\n").length,
    );
  });
});
