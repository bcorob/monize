import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * `npm run test:changed` (one script per layer) is the loop an agent runs
 * instead of the full coverage gate, so it has to keep three properties that
 * nothing else would notice losing: it selects every guard spec (a guard scans
 * source text, so the import graph never picks it), it refuses arguments rather
 * than ignoring a filter, and it carries no zero-discovery flag (REL-001).
 *
 * The guard patterns are read out of the scripts and run against the tree, so a
 * renamed guard convention fails here instead of silently dropping its guards
 * from the agent's run.
 */
const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

const LAYERS = ["backend", "frontend"] as const;

describeTree("test:changed", () => {
  const root = () => requireRepoRoot(REPO_ROOT);
  const read = (relative: string) =>
    readFileSync(join(root(), relative), "utf8");

  it.each(LAYERS)("is wired in %s/package.json to its script", (layer) => {
    const { scripts } = JSON.parse(read(`${layer}/package.json`)) as {
      scripts: Record<string, string>;
    };
    expect(scripts["test:changed"]).toBe("node scripts/test-changed.mjs");
    expect(existsSync(join(root(), layer, "scripts", "test-changed.mjs"))).toBe(
      true,
    );
  });

  it.each(LAYERS)("%s script carries no zero-discovery flag", (layer) => {
    expect(read(`${layer}/scripts/test-changed.mjs`)).not.toMatch(
      /--pass-?with-?no-?tests|passWithNoTests\s*:\s*true/i,
    );
  });

  it.each(LAYERS)("%s script refuses arguments", (layer) => {
    // Refused before any git or runner call, so this needs no node_modules.
    const result = spawnSync(
      process.execPath,
      [join(root(), layer, "scripts", "test-changed.mjs"), "--foo"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("takes no arguments");
  });

  it("selects every backend guard spec and the tree-walking specs", () => {
    const source = read("backend/scripts/test-changed.mjs");
    const literal = /const GUARD_SPEC =\s*("(?:[^"\\]|\\.)*");/.exec(source);
    expect(literal).not.toBeNull();
    const pattern = new RegExp(JSON.parse(literal![1]) as string);

    const specs = gitListFiles(root(), '-- "backend/src/*.spec.ts"');
    const guards = specs.filter((file) =>
      /\.guard[.\w-]*\.spec\.ts$/.test(file),
    );
    expect(guards.length).toBeGreaterThan(10);
    expect(guards.filter((file) => !pattern.test(file))).toEqual([]);
    for (const named of [
      "doc-paths.spec.ts",
      "source-comment-paths.spec.ts",
      "instruction-files.spec.ts",
    ]) {
      expect(
        specs.some((file) => pattern.test(file) && file.endsWith(named)),
      ).toBe(true);
    }
  });

  it("selects every frontend guard test", () => {
    const source = read("frontend/scripts/test-changed.mjs");
    const literal = /const GUARD_TEST = \/(.+)\/;/.exec(source);
    expect(literal).not.toBeNull();
    const pattern = new RegExp(literal![1]);

    const tests = gitListFiles(
      root(),
      '-- "frontend/src/*.test.ts" "frontend/src/*.test.tsx"',
    );
    const guards = tests.filter((file) => /guard[^/]*\.test\.tsx?$/.test(file));
    expect(guards.length).toBeGreaterThan(10);
    expect(guards.filter((file) => !pattern.test(file))).toEqual([]);
    expect(tests.some((file) => file.endsWith("ui-conventions.test.ts"))).toBe(
      true,
    );
  });
});
