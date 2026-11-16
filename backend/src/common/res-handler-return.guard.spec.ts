import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

import { escapeRegExp } from "./escape-regexp.util";

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
 * Blank comments while keeping line numbers, so an offender report still points
 * at the right line and prose may name the banned shape.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The identifiers a file binds to the raw Express response with `@Res()`.
 *
 * Derived per file rather than assumed to be `res`, because the ban has to
 * follow the parameter's real name and must not catch an unrelated `response`
 * (a `fetch` result, a provider reply) in a file that never touches `@Res()`.
 * Comments are stripped first: prose explaining this rule says "a @Res()
 * handler", and reading that as a declaration would ban `return handler` in
 * every file that documents the rule.
 */
function resParameterNames(source: string): string[] {
  const code = stripComments(source);
  const decl = /@Res\(\s*\)\s*([A-Za-z_$][\w$]*)/g;
  return [...new Set([...code.matchAll(decl)].map((m) => m[1]))];
}

/**
 * `return <resName>`, terminated so an identifier that merely starts with the
 * same letters (`resolveFxRate`) cannot match. The whole file is scanned at
 * once rather than line by line: prettier wraps a long chain onto the next
 * line (`return res` / `  .status(400)` / `  .json(body)`), and a per-line
 * scan sees `return res` with nothing after it and passes the offender.
 *
 * The names come out of the source, so they go through `escapeRegExp` before
 * they are interpolated -- escaping the one metacharacter an identifier can
 * contain is the incomplete form that helper exists to prevent.
 */
function bannedReturn(names: string[]): RegExp {
  const alternatives = names.map(escapeRegExp);
  return new RegExp(
    `\\breturn\\s+(?:${alternatives.join("|")})\\b\\s*(?:[.;)}]|$)`,
    "g",
  );
}

/** 1-based line of a character offset. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function offendingLines(source: string, names: string[]): number[] {
  const stripped = stripComments(source);
  return [...stripped.matchAll(bannedReturn(names))].map((m) =>
    lineOf(stripped, m.index ?? 0),
  );
}

/**
 * A `@Res()` handler sends the response and returns nothing.
 *
 * `return res.json(...)` reads as a tidy early exit, and the reply it sends is
 * correct -- but the value a handler returns still travels through the global
 * interceptor chain, and `ClassSerializerInterceptor` is registered app-wide
 * (`app.module.ts`). Handed an Express `Response`, `instanceToPlain` walks the
 * live object graph (`res` -> `socket` -> `_events`) and *calls* the Node HTTP
 * internals it finds on the way with a plain object as the receiver. Node's
 * socket bookkeeping is cleared by that walk, so when the already-sent response
 * finishes, `ServerResponse.detachSocket` fails its own assertion and the
 * process dies with an uncatchable `ERR_INTERNAL_ASSERTION`.
 *
 * That is not a theory about a Node bug: the reply is on the wire before the
 * crash, which is why it read as "the backend restarts right after the 2FA
 * challenge" and locked every 2FA account out of the product. Three of the five
 * sites that had this shape were on the unauthenticated auth surface.
 *
 * `Promise<void>` on a handler is the stronger form of the same rule and is
 * preferred where a handler is being touched; this scan is what covers the
 * `@Res()` handlers that carry no explicit return type.
 */
describe("a @Res() handler returns nothing", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds the @Res() handlers it is meant to scan", () => {
    const withRes = files.filter(
      (file) => resParameterNames(readFileSync(file, "utf8")).length > 0,
    );
    // A regression in `resParameterNames` would empty the scan and read green.
    expect(withRes.length).toBeGreaterThan(5);
  });

  it("no handler returns the raw Express response", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const names = resParameterNames(source);
      if (names.length === 0) continue;
      for (const line of offendingLines(source, names)) {
        offenders.push(`${relative(SRC_ROOT, file)}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the scan recognises the shape it was written for", () => {
    const scan = (code: string) => offendingLines(code, ["res"]);

    expect(scan("    return res.json({ requires2FA: true });")).toEqual([1]);
    expect(scan("    return res.status(405).end();")).toEqual([1]);
    expect(scan("    return res;")).toEqual([1]);
    // The wrap prettier produces for a long chain: the offender is on the line
    // carrying `return`, and a per-line scan would miss it entirely.
    expect(
      scan("    return res\n      .status(400)\n      .json(body);"),
    ).toEqual([1]);
    // The fixed shape, and a return of something whose name merely starts the
    // same way, are both fine.
    expect(scan("    res.json({ requires2FA: true });")).toEqual([]);
    expect(scan("    return;")).toEqual([]);
    expect(scan("    return resolveFxRate(date);")).toEqual([]);
    expect(scan("    return response.ok;")).toEqual([]);
  });

  it("escapes the one metacharacter an identifier can carry", () => {
    // `$` is legal in an identifier and means end-of-input in a pattern, so an
    // unescaped name would match nothing. `escapeRegExp` neutralises it.
    expect(offendingLines("    return $res.json(body);", ["$res"])).toEqual([
      1,
    ]);
    expect(offendingLines("    return other.json(body);", ["$res"])).toEqual(
      [],
    );
  });

  it("the scan reads code, not prose", () => {
    const prose = "/**\n * Never `return res.json(...)` from a handler.\n */\n";
    const code = "\n\n    return res.json({ ok: true });\n";

    expect(offendingLines(prose, ["res"])).toEqual([]);
    // Blanking keeps the line count, so the reported line stays true.
    expect(offendingLines(code, ["res"])).toEqual([3]);
  });

  it("the parameter scan follows the declared name and ignores prose", () => {
    expect(resParameterNames("async get(@Res() res: Response) {}")).toEqual([
      "res",
    ]);
    expect(resParameterNames("async get(@Res() reply: Response) {}")).toEqual([
      "reply",
    ]);
    expect(resParameterNames("const r = await fetch(u); return r.ok;")).toEqual(
      [],
    );
    // The comment this rule is documented with, which reads as a declaration
    // of a parameter named `handler` until comments are stripped. The real
    // declaration follows it, so a scan that strips only for the first match
    // still reports `handler` here.
    expect(
      resParameterNames(
        "// the value a @Res() handler returns\nasync get(@Res() res: Response) {}",
      ),
    ).toEqual(["res"]);
    // Prose after the declaration is the same mistake in the other order.
    expect(
      resParameterNames(
        "async get(@Res() res: Response) {}\n// a @Res() handler returns nothing",
      ),
    ).toEqual(["res"]);
  });
});
