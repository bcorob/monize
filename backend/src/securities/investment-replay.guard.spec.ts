import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/**
 * The file that owns the reducer, plus the enum that declares the actions.
 * Everything else that folds an action into a share count has to call it.
 */
const ALLOWED = new Set([
  "securities/investment-replay.util.ts",
  "securities/entities/investment-transaction.entity.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * A hand-rolled share-count reducer is the mistake this guard exists to catch,
 * and it is mechanical, so it gets a scanning test rather than a paragraph.
 *
 * Audit finding P5-011: four separate replays folded investment actions into a
 * share count. Three of them added a SPLIT's ratio instead of multiplying by it
 * and omitted ADD_SHARES/REMOVE_SHARES entirely, so a post-split position was
 * 40% light on every history chart while the holdings page was right. Each copy
 * was internally consistent, which is exactly why nothing failed.
 *
 * The rule: fold an action into a quantity with `applyActionToQuantity`, and
 * name the set of share-moving actions with `SHARE_MOVING_ACTIONS`. Do not
 * write a `case InvestmentAction.SPLIT:` that assigns a quantity.
 */
describe("investment action replay is written once", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no SPLIT branch that computes a quantity itself", () => {
    // Dispatching on the SPLIT action is fine -- `applySplit` / `reverseSplit`
    // are called from a `switch` on the action. What must not come back is a
    // SPLIT branch that works the new quantity out inline, which is the shape
    // every one of the wrong reducers had.
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // A `case` label OR an `if` on the SPLIT action. The `if` form was
        // missing when this guard was first written, and the QIF importer's
        // hand-rolled `holding.quantity = currentQuantity * quantity` hid behind
        // exactly that shape.
        const isSplitBranch =
          /case\s+InvestmentAction\.SPLIT\s*:/.test(line) ||
          /case\s+["']SPLIT["']\s*:/.test(line) ||
          /if\s*\([^)]*===\s*InvestmentAction\.SPLIT\s*\)/.test(line) ||
          /if\s*\([^)]*===\s*["']SPLIT["']\s*\)/.test(line);
        if (!isSplitBranch) continue;

        // The branch ends at the next case label; only look that far. The window
        // is generous because a fold often assigns the quantity after the
        // per-action basis treatment rather than inside the branch itself.
        const branch = lines
          .slice(index + 1, index + 26)
          .join("\n")
          .split(/\n\s*case\s/)[0];

        // Allowlisted by what the branch DOES, not by what it avoids saying --
        // a negative regex over arithmetic missed `map.set(key, current + qty)`
        // when this guard was first written. Either the branch folds through
        // the shared reducer, or it hands the split to something that owns the
        // stored quantity/averageCost pair.
        const delegates =
          branch.includes("applyActionToQuantity") ||
          branch.includes("applySplit") ||
          branch.includes("reverseSplit") ||
          branch.includes("rebuildFromTransactions");

        if (!delegates) offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has no hand-listed share-moving action set outside the shared reducer", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const source = readFileSync(file, "utf8");
      // TRANSFER_OUT next to REMOVE_SHARES in one literal list is the
      // "actions that reduce a position" list being spelled out again.
      const listsDisposals =
        /InvestmentAction\.TRANSFER_OUT,\s*\n?\s*InvestmentAction\.REMOVE_SHARES/.test(
          source,
        );
      if (listsDisposals) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("never derives a quantity from a multiplication outside the reducer", () => {
    // The precise shape of the QIF importer's hidden split branch:
    // `holding.quantity = currentQuantity * quantity`. Scaling a share count by
    // anything is a split, and a split belongs to the shared reducer -- the
    // branch-scanning check above cannot see this one, because a legitimate
    // `applyActionToQuantity` call ten lines below vouches for the branch.
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `x.quantity = <something> * ...` / `quantity = <something> * ...`,
        // but not `= applyActionToQuantity(...)`.
        if (!/\bquantity\s*=\s*[^=;]*\*/i.test(line)) continue;
        if (line.includes("applyActionToQuantity")) continue;

        // `applySplit` / `reverseSplit` own the stored quantity/averageCost pair
        // and are where the ratio is legitimately applied to a Holding row; the
        // reducer answers the replay question, these answer the storage one.
        const enclosing = lines
          .slice(Math.max(0, index - 30), index)
          .join("\n");
        if (/\b(applySplit|reverseSplit)\s*\(/.test(enclosing)) continue;

        offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never blends a raw price into a holding for an acquisition", () => {
    // FR-008: the incremental holding update for BUY / REINVEST / TRANSFER_IN
    // passed `Number(price)`, while every rebuild folds the commission into
    // basis. So a 10-share buy at 100 with 10 commission read 100.00 per share
    // live and 101.00 after any recompute -- and the live figure reported the
    // commission as gain on the disposal. The two figures come from one helper
    // or they drift, so the rule is scannable: an acquisition branch that
    // touches a holding passes `acquisitionUnitCost`, never a bare price.
    const offenders: string[] = [];
    const ACQUISITIONS = ["BUY", "REINVEST", "TRANSFER_IN"];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const isAcquisitionBranch = ACQUISITIONS.some(
          (action) =>
            new RegExp(`case\\s+InvestmentAction\\.${action}\\s*:`).test(
              line,
            ) || new RegExp(`case\\s+["']${action}["']\\s*:`).test(line),
        );
        if (!isAcquisitionBranch) continue;

        // Only the branch body, up to the next case label. Fall-through
        // (`case BUY:` immediately followed by `case REINVEST:`) leaves an empty
        // slice, which correctly has nothing to complain about.
        const branch = lines
          .slice(index + 1, index + 26)
          .join("\n")
          .split(/\n\s*case\s/)[0];

        // Only branches that actually write a holding's cost are in scope.
        if (!/updateHolding\s*\(|createOrUpdate\s*\(/.test(branch)) continue;
        if (branch.includes("acquisitionUnitCost")) continue;
        if (branch.includes("acquisitionCost")) continue;

        offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("multiplies rather than adds wherever a split ratio is applied", () => {
    // The specific arithmetic that was wrong, caught by shape: a split ratio
    // added to a running quantity. `*=` is the only correct operator here, and
    // the shared reducer is the only place it should appear at all.
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const source = readFileSync(file, "utf8");
      // e.g. `quantity *= ratio` / `state.quantity *= splitRatio` -- a local
      // ratio multiply means a hand-rolled split branch survived.
      if (/\bquantity\s*\*=/i.test(source)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});
