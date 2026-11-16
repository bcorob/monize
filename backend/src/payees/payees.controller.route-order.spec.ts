import { readFileSync } from "fs";
import { join } from "path";

/**
 * Nest matches routes in declaration order, so a literal segment declared
 * after a parameter route with the same shape is unreachable: a
 * `@Post("lookup-contact")` below `@Post(":id")` would be read as a payee id
 * and 400 on the UUID pipe. `PayeesController` therefore declares every
 * literal-segment route before its first `:id` route, and this scan holds
 * it there. Comments are blanked (line count preserved) so a decorator
 * quoted in prose cannot trip the scan, and so the offender's line is real.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("PayeesController route order", () => {
  const source = stripComments(
    readFileSync(join(__dirname, "payees.controller.ts"), "utf8"),
  );
  const routes = [
    ...source.matchAll(/@(Get|Post|Patch|Delete)\("([^"]*)"\)/g),
  ].map((m) => ({ verb: m[1], path: m[2], line: lineOf(source, m.index!) }));

  it("finds the routes it means to check", () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.some((r) => r.path === "lookup-contact")).toBe(true);
  });

  it("declares every literal route before a parameter route that would shadow it", () => {
    const offenders: string[] = [];
    for (const route of routes) {
      const segments = route.path.split("/");
      if (segments.some((seg) => seg.startsWith(":"))) continue;
      const shadowedBy = routes.find(
        (earlier) =>
          earlier.verb === route.verb &&
          earlier.line < route.line &&
          shadows(earlier.path.split("/"), segments),
      );
      if (shadowedBy) {
        offenders.push(
          `${route.verb} "${route.path}" (line ${route.line}) is unreachable behind ${route.verb} "${shadowedBy.path}" (line ${shadowedBy.line})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would catch the mistake it exists for", () => {
    expect(shadows([":id"], ["lookup-contact"])).toBe(true);
    expect(shadows([":id", "lookup-contact"], ["x", "lookup-contact"])).toBe(
      true,
    );
    expect(shadows([":id", "aliases"], ["inactive", "match"])).toBe(false);
    expect(shadows([":id"], ["a", "b"])).toBe(false);
  });
});

/**
 * A parameter route shadows a literal one when they have the same number of
 * segments and every segment of the parameter route is either a parameter
 * or equal to the literal's.
 */
function shadows(param: string[], literal: string[]): boolean {
  return (
    param.length === literal.length &&
    param.some((seg) => seg.startsWith(":")) &&
    param.every((seg, i) => seg.startsWith(":") || seg === literal[i])
  );
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}
