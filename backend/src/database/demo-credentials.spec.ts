import { readFileSync } from "fs";
import { join } from "path";
import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../common/repo-tree.util";
import { DEMO_USER_EMAIL, DEMO_USER_PASSWORD } from "./demo-credentials";

/**
 * The demo account's email and password are written once, in
 * `demo-credentials.ts`. The seed, the nightly reset, the start-up probe and
 * the demo seeder all read them from there, because four literal copies of a
 * login that must agree is how a demo site stops accepting its own published
 * credentials. This scan fails a fifth spelling anywhere under `src/`; the
 * client keeps a mirror in `frontend/src/lib/demo-credentials.ts`, and
 * `demo-credentials.contract.test.ts` over there checks the two layers agree.
 */
const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

const MODULE = "backend/src/database/demo-credentials.ts";

describeTree("the demo login", () => {
  const root = () => requireRepoRoot(REPO_ROOT);

  /** Tracked backend sources, specs excluded: a spec may quote the value it asserts on. */
  function backendSources(): string[] {
    return gitListFiles(root(), "backend/src").filter(
      (path) => /\.ts$/.test(path) && !/\.spec\.ts$/.test(path),
    );
  }

  it("is spelled once under backend/src", () => {
    const offenders = backendSources().filter((path) => {
      if (path === MODULE) return false;
      const source = readFileSync(join(root(), path), "utf8");
      return (
        source.includes(DEMO_USER_EMAIL) || source.includes(DEMO_USER_PASSWORD)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("still finds the module, so the rule cannot pass by accident", () => {
    expect(backendSources()).toContain(MODULE);
    const source = readFileSync(join(root(), MODULE), "utf8");
    expect(source).toContain(DEMO_USER_EMAIL);
    expect(source).toContain(DEMO_USER_PASSWORD);
  });

  it("is what the published demo instructions say", () => {
    // `.env.example` tells an operator what login a demo deployment accepts;
    // it is prose the machine does not otherwise read.
    const envExample = readFileSync(join(root(), ".env.example"), "utf8");
    expect(envExample).toContain(`${DEMO_USER_EMAIL} / ${DEMO_USER_PASSWORD}`);
  });
});
