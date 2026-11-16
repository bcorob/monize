import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Guards against running queries concurrently on one transaction.
 *
 * A `withScopedDb` transaction is one pooled connection, and a nested
 * `withScopedDb` joins it. A `Promise.all` over that connection's queries buys
 * no parallelism -- the server runs one statement per session at a time -- it
 * only hands `pg` a statement while the client is still busy with another.
 * `pg` queues it client-side, and that queue is deprecated: from the third
 * statement in flight every process logged "Calling client.query() when the
 * client is already executing a query is deprecated and will be removed in
 * pg@9.0" (issue #1587). Inside a transaction, each query is awaited in turn.
 *
 * Method: parse every non-spec source file and report a fan-out
 * (`Promise.all`, `Promise.allSettled`, `Promise.any`, `Promise.race`,
 * `mapWithConcurrency`) lexically inside a function that holds a transaction:
 * the callback handed to `withScopedDb`; a callback handed to a local wrapper
 * of it (a function in the same file that passes one of its own parameters
 * into a `withScopedDb` call, such as the `scoped(entity, fn)` helpers); or any
 * function taking an `EntityManager` or a `Repository<...>` parameter (a
 * repository is always obtained from a transaction's manager here). A
 * `runOutsideActiveScopedManager(...)` call leaves the transaction, so its
 * argument is not scanned.
 *
 * The scan does not follow calls. A fan-out whose branches each call
 * `withScopedDb` is not flagged, and gets a pooled connection per branch only
 * while no transaction is open: called from inside one, every branch joins it
 * and they share its connection again. So a method that fans out over its own
 * `withScopedDb` calls must not be reachable from inside a transaction, and
 * that half of the rule is the reviewer's to check.
 */

const FAN_OUT_CALLS = new Set([
  "Promise.all",
  "Promise.allSettled",
  "Promise.any",
  "Promise.race",
  "mapWithConcurrency",
]);

const TRANSACTION_PARAMETER_TYPE = /\bEntityManager\b|\bRepository</;

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionName(fn: ts.FunctionLikeDeclaration): string | null {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (
    parent &&
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return null;
}

/**
 * Names of the functions in this file that run a callback parameter inside a
 * `withScopedDb` transaction: the parameter is handed to `withScopedDb` as its
 * callback, or called from within that callback.
 */
function findScopedWrappers(sourceFile: ts.SourceFile): Set<string> {
  const wrappers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const name = functionName(node);
      const params = new Set(
        node.parameters
          .map((p) => (ts.isIdentifier(p.name) ? p.name.text : null))
          .filter((p): p is string => p !== null),
      );
      if (name && params.size > 0 && node.body) {
        const runsParameter = (callback: ts.Node): boolean => {
          if (ts.isIdentifier(callback) && params.has(callback.text)) {
            return true;
          }
          let called = false;
          const find = (n: ts.Node): void => {
            if (
              ts.isCallExpression(n) &&
              ts.isIdentifier(n.expression) &&
              params.has(n.expression.text)
            ) {
              called = true;
            }
            if (!called) ts.forEachChild(n, find);
          };
          find(callback);
          return called;
        };
        const scan = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            n.expression.getText() === "withScopedDb" &&
            n.arguments[1] &&
            runsParameter(n.arguments[1])
          ) {
            wrappers.add(name);
          }
          ts.forEachChild(n, scan);
        };
        scan(node.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return wrappers;
}

function holdsTransaction(
  fn: ts.FunctionLikeDeclaration,
  wrappers: ReadonlySet<string>,
): boolean {
  const parent = fn.parent;
  if (parent && ts.isCallExpression(parent)) {
    const callee = parent.expression.getText().replace(/^this\./, "");
    if (callee === "withScopedDb" && parent.arguments[1] === fn) {
      return true;
    }
    if (
      wrappers.has(callee) &&
      parent.arguments.some((argument) => argument === fn)
    ) {
      return true;
    }
  }
  return fn.parameters.some(
    (parameter) =>
      !!parameter.type &&
      TRANSACTION_PARAMETER_TYPE.test(parameter.type.getText()),
  );
}

export function findTransactionFanOuts(
  fileName: string,
  source: string,
): Array<{ line: number; call: string }> {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const wrappers = findScopedWrappers(sourceFile);
  const found: Array<{ line: number; call: string }> = [];
  const visit = (node: ts.Node, inTransaction: boolean): void => {
    let inside = inTransaction;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (callee === "runOutsideActiveScopedManager") {
        inside = false;
      } else if (inside && FAN_OUT_CALLS.has(callee)) {
        found.push({
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          call: callee,
        });
      }
    }
    if (isFunctionLike(node) && holdsTransaction(node, wrappers)) {
      inside = true;
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(sourceFile, false);
  return found;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("no concurrent queries on one transaction", () => {
  const SRC_DIR = path.resolve(__dirname, "../..");

  it("awaits each query in turn inside a transaction", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      if (!/Promise\.(all|allSettled|any|race)|mapWithConcurrency/.test(source))
        continue;
      for (const { line, call } of findTransactionFanOuts(file, source)) {
        offenders.push(`${path.relative(SRC_DIR, file)}:${line} ${call}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "Queries run concurrently on one transaction's connection. A " +
          "withScopedDb transaction (and every nested withScopedDb that joins " +
          "it) is a single pg client: await each query in turn instead of " +
          "fanning out, which is what the server does with them anyway.\n  " +
          offenders.join("\n  "),
      );
    }
  });

  describe("the scanner", () => {
    const scan = (source: string) =>
      findTransactionFanOuts("fixture.ts", source).map((f) => f.call);

    it("flags a fan-out inside a withScopedDb callback", () => {
      expect(
        scan(`withScopedDb(ds, (m) => Promise.all([m.count(A), m.count(B)]));`),
      ).toEqual(["Promise.all"]);
    });

    it("flags a fan-out in a helper handed the transaction's manager", () => {
      expect(
        scan(`async function stats(m: EntityManager) {
                return Promise.allSettled([m.count(A), m.count(B)]);
              }`),
      ).toEqual(["Promise.allSettled"]);
      expect(
        scan(`async function sums(repo: Repository<Transaction>) {
                await mapWithConcurrency(ids, 4, (id) => repo.findOne(id));
              }`),
      ).toEqual(["mapWithConcurrency"]);
    });

    it("flags a fan-out in a callback handed to a local withScopedDb wrapper", () => {
      expect(
        scan(`class S {
                private scoped<T>(fn: (repo: any) => Promise<T>) {
                  return withScopedDb(this.dataSource, (m) =>
                    fn(m.getRepository(User)),
                  );
                }
                run() {
                  return this.scoped((repo) =>
                    Promise.all([repo.count(), repo.count()]),
                  );
                }
              }`),
      ).toEqual(["Promise.all"]);
      expect(
        scan(`const inScope = (fn: (m: any) => Promise<unknown>) =>
                withScopedDb(ds, fn);
              inScope(async (m) => Promise.all([m.count(A), m.count(B)]));`),
      ).toEqual(["Promise.all"]);
    });

    it("leaves a fan-out whose branches each open their own transaction", () => {
      // Only at the top of a request: the scan does not follow calls, so the
      // same method reached from inside a transaction is not seen here.
      expect(
        scan(`const [a, b] = await Promise.all([
                withScopedDb(ds, (m) => m.count(A)),
                withScopedDb(ds, (m) => m.count(B)),
              ]);`),
      ).toEqual([]);
    });

    it("leaves sequential awaits inside a transaction", () => {
      expect(
        scan(`withScopedDb(ds, async (m) => {
                const a = await m.count(A);
                const b = await m.count(B);
                return [a, b] as const;
              });`),
      ).toEqual([]);
    });

    it("stops at runOutsideActiveScopedManager, which leaves the transaction", () => {
      expect(
        scan(`withScopedDb(ds, async (m) => {
                runOutsideActiveScopedManager(() => Promise.all([x(), y()]));
              });`),
      ).toEqual([]);
    });
  });
});
