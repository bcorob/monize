import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * `npm run test:changed` runs the Vitest files a change can affect, and prints
 * only the failures. It is the loop an agent runs while it works; the full
 * `test:cov` gate stays the one CI runs before merge.
 *
 * One `vitest related` run takes two lists as its "changed files":
 *  - every file that differs from the merge base with the base ref, in the
 *    working tree or untracked, and
 *  - every guard test. A guard scans source text rather than importing the code
 *    it protects, so the import graph never selects it. The union is also never
 *    empty, so no zero-discovery flag is needed (REL-001).
 *
 * The `dot` reporter prints one character per test and the full message of each
 * failure; `--silent=true` drops console output (spelled with its value: a
 * bare `--silent` takes the next argument, a file path, as its value and
 * Vitest refuses the run). Coverage is off: a threshold means
 * nothing over a subset. The base is `origin/main`; set `TEST_CHANGED_BASE` to
 * change it.
 */
const BASE = process.env.TEST_CHANGED_BASE || "origin/main";
const GUARD_TEST = /(guard[^/]*|ui-conventions)\.test\.tsx?$/;

if (process.argv.length > 2) {
  console.error(
    "test:changed takes no arguments. Use `npm run test -- <pattern>` for a chosen scope.",
  );
  process.exit(1);
}

const git = (...args) =>
  spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (result) =>
  result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const mergeBase = git("merge-base", BASE, "HEAD");
if (mergeBase.status !== 0) {
  console.error(
    `test:changed: base ref "${BASE}" not found. Run \`git fetch origin main\`, or set TEST_CHANGED_BASE.`,
  );
  process.exit(1);
}

// Paths are relative to this directory (`--relative`), which is where Vitest runs.
const changed = lines(
  git("diff", "--name-only", "--relative", mergeBase.stdout.trim()),
);
const untracked = lines(git("ls-files", "--others", "--exclude-standard"));
const guards = lines(git("ls-files", "src")).filter((file) =>
  GUARD_TEST.test(file),
);

if (guards.length === 0) {
  console.error(
    "test:changed: found no guard tests. The guard pattern no longer matches; fix scripts/test-changed.mjs.",
  );
  process.exit(1);
}

// A deleted file is in the diff but cannot be related to anything.
const files = [...new Set([...changed, ...untracked, ...guards])].filter(
  (file) => existsSync(file),
);

console.log(
  `test:changed: ${changed.length + untracked.length} changed files since ${BASE}, ${guards.length} guard tests`,
);

const result = spawnSync(
  "npx",
  ["vitest", "related", "--run", "--reporter=dot", "--silent=true", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
