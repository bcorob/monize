import { spawnSync } from "node:child_process";

/**
 * `npm test` runs the unit suite and then the integration suite, in that order
 * and never at the same time -- the integration suites share one `monize_test`
 * and rebuild its schema, so a second worker is a race rather than a speedup.
 *
 * This is a script rather than an `&&` chain in `package.json` because of what
 * npm does with arguments. In `npm test -- --testPathPatterns=foo`, npm appends
 * the arguments to the *end* of the script string, so a chained command turns
 * them into flags for the second `npm run` -- npm swallows them as its own
 * config, Jest never sees them, and the filtered run the author asked for
 * silently becomes a full one. Refusing them costs a second; discovering it
 * from a five-minute run that "matched everything" costs rather more.
 *
 * `TEST_CHAIN_DRY_RUN=1` prints the stages instead of running them, so the
 * ordering and the refusal are testable without running the suites twice
 * (`src/common/jest-config.guard.spec.ts`).
 */
const STAGES = ["test:unit", "test:integration"];

const extra = process.argv.slice(2);
if (extra.length > 0) {
  console.error(
    [
      "npm test takes no arguments: npm appends them to the chained stage rather than",
      "passing them to Jest, so a filter is silently ignored and everything runs.",
      `Run the scope you meant instead, e.g. npm run ${STAGES[0]} -- ${extra.join(" ")}`,
    ].join("\n"),
  );
  process.exit(1);
}

if (process.env.TEST_CHAIN_DRY_RUN === "1") {
  console.log(STAGES.join("\n"));
  process.exit(0);
}

for (const stage of STAGES) {
  const result = spawnSync("npm", ["run", stage], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
