import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Guard tests for the E2E specs in `e2e/tests`, which live outside `src/` and
 * so outside every other scan in this directory. Same shape as
 * `ui-conventions.test.ts`: a mechanical mistake a reviewer caught once, turned
 * into a rule the machine checks. The rule is in `docs/frontend/testing.md`.
 */
const E2E_TESTS_DIR = resolve(__dirname, "../../../e2e/tests");
const E2E_PUSH_DIR = resolve(__dirname, "../../../e2e/push");

function e2eSpecs(): [string, string][] {
  return readdirSync(E2E_TESTS_DIR)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => [
      `e2e/tests/${name}`,
      readFileSync(resolve(E2E_TESTS_DIR, name), "utf8"),
    ]);
}

/** Everything under `e2e/push` except the harness itself. */
function e2ePushFilesOutsideTheFixture(): [string, string][] {
  return readdirSync(E2E_PUSH_DIR)
    .filter((name) => name.endsWith(".ts") && name !== "fixture.ts")
    .map((name) => [
      `e2e/push/${name}`,
      readFileSync(resolve(E2E_PUSH_DIR, name), "utf8"),
    ]);
}

/** Blank comment bodies, keeping line breaks so a report still points at the source. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) =>
        before + " ".repeat(match.length - before.length),
    );
}

describe("an alert locator is scoped to a region", () => {
  // Next's route announcer is a `role="alert"` on every hydrated page, so a
  // page-wide alert locator resolves to two elements once a panel renders.
  const PAGE_WIDE_ALERT = /\bpage\s*\.\s*getByRole\(\s*['"]alert['"]/;

  it("has no page-wide getByRole('alert') in any E2E spec", () => {
    const offenders = e2eSpecs()
      .map(([path, content]) => [path, withoutComments(content)] as const)
      .filter(([, content]) => PAGE_WIDE_ALERT.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("reads the real spec directory", () => {
    // A guard over an empty list is green for the wrong reason.
    expect(e2eSpecs().length).toBeGreaterThan(10);
  });

  it("would fail the shape it bans", () => {
    expect(PAGE_WIDE_ALERT.test("await expect(page.getByRole('alert')).toBeVisible();")).toBe(true);
    expect(PAGE_WIDE_ALERT.test("page.getByRole('main').getByRole('alert')")).toBe(false);
  });
});

describe("a push spec goes through the harness for both halves of a push", () => {
  // Reading Chromium's notification list is DESTRUCTIVE while a display is in
  // flight: a record whose display has not landed yet is erased rather than
  // reported "not yet", and no later read brings it back. So a push is only
  // observable through `fixture.ts`, which looks once per delivery and repairs
  // a look that came too early by delivering again. A spec that delivers or
  // reads on its own re-opens the flake this suite spent three CI runs on.
  const RAW_DELIVERY = /deliverPushMessage/;
  const RAW_NOTIFICATION_READ = /getNotifications\s*\(/;

  it("delivers only through the fixture", () => {
    const offenders = e2ePushFilesOutsideTheFixture()
      .map(([path, content]) => [path, withoutComments(content)] as const)
      .filter(([, content]) => RAW_DELIVERY.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("reads notifications only through the fixture", () => {
    const offenders = e2ePushFilesOutsideTheFixture()
      .map(([path, content]) => [path, withoutComments(content)] as const)
      .filter(([, content]) => RAW_NOTIFICATION_READ.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("reads the real push directory", () => {
    // A guard over an empty list is green for the wrong reason.
    const files = e2ePushFilesOutsideTheFixture();
    expect(files.map(([path]) => path)).toContain("e2e/push/notifications.spec.ts");
  });

  it("would fail the shapes it bans", () => {
    expect(RAW_DELIVERY.test("cdp.send('ServiceWorker.deliverPushMessage', {})")).toBe(true);
    expect(RAW_NOTIFICATION_READ.test("await registration.getNotifications()")).toBe(true);
    expect(RAW_NOTIFICATION_READ.test("await shown(h.worker)")).toBe(false);
  });
});
