import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `npm run test:changed` runs the unit specs a change can affect, and prints
 * only the failures. It is the loop an agent runs while it works; the full
 * `test:cov` gate stays the one CI runs before merge.
 *
 * The set is the union of two lists, handed to Jest by path so that one run
 * covers both:
 *  - the specs Jest relates to a file changed since the base ref
 *    (`--changedSince`), and
 *  - every guard spec. A guard walks the tree with `git ls-files` rather than
 *    importing the code it protects, so the import graph never selects it.
 *    The union is also never empty, so no zero-discovery flag is needed
 *    (`jest-config.guard.spec.ts`, REL-001).
 *
 * `failures-only-reporter.cjs` prints the full message of each failing spec file
 * and nothing for a passing one, plus one closing line; `--silent` drops console
 * output. Coverage is off: a threshold means nothing over a subset.
 *
 * A new file is invisible to `--changedSince` until `git add -N` has staged it
 * (`docs/guard-tests.md`). The base is `origin/main`; set `TEST_CHANGED_BASE` to
 * change it. Integration specs need PostgreSQL and are not part of this run.
 */
const BASE = process.env.TEST_CHANGED_BASE || "origin/main";
const GUARD_SPEC =
  "(\\.guard(\\.[\\w-]+)?\\.spec\\.ts|doc-paths\\.spec\\.ts|source-comment-paths\\.spec\\.ts|instruction-files\\.spec\\.ts)$";

const extra = process.argv.slice(2);
if (extra.length > 0) {
  console.error(
    "test:changed takes no arguments. Use `npm run test:unit -- <pattern>` for a chosen scope.",
  );
  process.exit(1);
}

const run = (command, args) =>
  spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const known = run("git", ["rev-parse", "--verify", "--quiet", BASE]);
if (known.status !== 0) {
  console.error(
    `test:changed: base ref "${BASE}" not found. Run \`git fetch origin main\`, or set TEST_CHANGED_BASE.`,
  );
  process.exit(1);
}

const jestBin = ["jest"];
const listTests = (...args) => {
  const result = run("npx", [...jestBin, "--listTests", ...args]);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".spec.ts"));
};

const related = listTests(`--changedSince=${BASE}`);
const guards = listTests("--testPathPatterns", GUARD_SPEC);
const files = [...new Set([...related, ...guards])];

if (guards.length === 0) {
  console.error(
    "test:changed: found no guard specs. The guard pattern no longer matches; fix scripts/test-changed.mjs.",
  );
  process.exit(1);
}

console.log(
  `test:changed: ${files.length} specs (${related.length} related to changes since ${BASE}, ${guards.length} guards)`,
);

const result = spawnSync(
  "npx",
  [
    ...jestBin,
    "--runTestsByPath",
    ...files,
    `--reporters=${fileURLToPath(new URL("./failures-only-reporter.cjs", import.meta.url))}`,
    "--silent",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
