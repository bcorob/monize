import * as fs from "fs";
import * as path from "path";

/**
 * The loan payment waterfall -- interest-first clamp, balance clamps, extra
 * absorbing the shortfall -- lives once, in
 * `accounts/loan-payment-waterfall.util.ts`. Two services used to carry their
 * own ~50-line copies, and the copies drifted (one gated the balance clamps,
 * the other did not; one clamped nothing at all in its first version). This
 * scans `src/` for the shapes a hand-rolled copy cannot avoid:
 *
 * - the interest-first test `<something> > basePayment...`
 * - a local `availableForPrincipal` computation
 *
 * A new caller allocates through `allocateLoanPayment` instead.
 */
describe("loan waterfall guard", () => {
  const srcRoot = path.join(__dirname, "..");
  const utilFile = path.join(__dirname, "loan-payment-waterfall.util.ts");

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!entry.name.endsWith(".ts")) return [];
      if (entry.name.endsWith(".spec.ts")) return [];
      return [full];
    });

  const handRolledMarkers = [
    /\bavailableForPrincipal\b/,
    /\w+\s*>\s*basePayment\w*/,
  ];

  it("finds no hand-rolled waterfall outside the util", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (path.resolve(file) === path.resolve(utilFile)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const marker of handRolledMarkers) {
        if (marker.test(source)) {
          offenders.push(
            `${path.relative(srcRoot, file)} matches ${marker} -- allocate through allocateLoanPayment (accounts/loan-payment-waterfall.util.ts) instead of re-rolling the clamp sequence`,
          );
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still recognises the shapes it scans for", () => {
    expect(
      handRolledMarkers.some((m) =>
        m.test("if (newInterest > basePaymentAmount) {"),
      ),
    ).toBe(true);
    expect(
      handRolledMarkers.some((m) =>
        m.test("const availableForPrincipal = Math.max(0, x);"),
      ),
    ).toBe(true);
  });
});
