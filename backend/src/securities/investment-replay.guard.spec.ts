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

  it("never maintains a holding's average cost outside the ledger fold", () => {
    // Issue #1388: `holdings.average_cost` was maintained incrementally --
    // each acquisition blended into the stored average as it arrived -- which
    // makes the stored figure a function of INSERTION order. A back-dated sale
    // entered after a later purchase then relieved basis the replay says the
    // position never held: 15.0000 stored against 16.6667 replayed.
    //
    // The rule is that the column is only ever WRITTEN by a fold over the
    // ledger, in the order INVESTMENT_REPLAY_ORDER gives. Two files own such a
    // fold; anywhere else, a write to the column is a second maintainer of
    // derived state, which is what drifts.
    const WRITERS = new Set([
      // rebuildScopesFromTransactions / rebuildAccountsFromTransactions /
      // rebuildFromTransactions, all over computeHoldingsMap.
      "securities/holdings.service.ts",
      // undo/redo rebuilds the whole account from the same ledger.
      "action-history/action-history.service.ts",
    ]);
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (WRITERS.has(rel)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `holding.averageCost = ...` (the entity write) or `average_cost = `
        // in raw SQL. A read (`Number(h.averageCost)`) is untouched.
        const writesColumn =
          /\.averageCost\s*=[^=]/.test(line) ||
          /\baverage_cost\s*=[^=]/.test(line);
        if (!writesColumn) continue;
        offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has no holdings mutator taking a quantity delta", () => {
    // The deleted shape: `updateHolding(userId, accountId, securityId, delta,
    // price, manager)`. A method that takes "how much the position moved" is
    // an accumulator by construction -- it cannot know where in the ledger the
    // movement belongs. Ledger writers name the SCOPE they touched and the
    // rebuild reads the rows.
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const source = readFileSync(file, "utf8");
      if (/\b(updateHolding|createOrUpdate|adjustQuantity)\s*\(/.test(source)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("orders every investment_transactions replay through the shared constant", () => {
    // Issue #1388: a replay ordered only by `(transaction_date, created_at)` is
    // not a total order -- rows written by one import or one split share
    // `created_at` to the microsecond -- so two replays of the same unchanged
    // ledger can relieve basis in different orders and disagree. The `id` leg
    // is what makes the fold a function of the ledger's contents. The mistake
    // is mechanical, so it is scanned for rather than written down.
    //
    // Only the file that declares the order may spell the columns out.
    const ORDER_OWNER = "securities/investment-replay.util.ts";
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (rel === ORDER_OWNER) continue;

      const source = readFileSync(file, "utf8");
      // Only files that read the investment ledger; a replay is over
      // `investment_transactions` or the entity that maps it.
      const touchesLedger =
        source.includes("investment_transactions") ||
        source.includes("InvestmentTransaction");
      if (!touchesLedger) continue;

      const lines = source.split("\n");
      for (const [index, line] of lines.entries()) {
        const rawOrder =
          /ORDER\s+BY[^`;]*transaction_date\s+ASC/i.test(line) &&
          !/\bid\s+ASC/i.test(line);
        const typeormOrder =
          /order:\s*\{[^}]*transactionDate:\s*["']ASC["']/.test(line) &&
          !/\bid:\s*["']ASC["']/.test(line);
        if (rawOrder || typeormOrder) offenders.push(`${rel}:${index + 1}`);
      }
    }

    // A replay that genuinely is not over the investment ledger orders its own
    // rows; nothing qualifies today, and an addition here states which query it
    // is and why the id tiebreak cannot matter to it.
    expect(offenders).toEqual([]);
  });

  it("never folds a TRANSFER_IN through the purchase branch of a replay", () => {
    // A26-M21 / A26-M22: a `case InvestmentAction.TRANSFER_IN:` sharing a case
    // group with BUY priced the transferred-in lot as an acquisition at its
    // own row's price and rate 1, so a security bought at USD 100 / 1.37 CAD
    // arrived as a basis of 1,000 and a realized gain read 918 instead of 548.
    // A transfer takes the basis its paired TRANSFER_OUT released
    // (`computeHoldingsMap`'s `releasedByTransferOut`, `replayPositionBasis`);
    // a fold that lists it with BUY has no way to say so. Give TRANSFER_IN its
    // own case.
    const FOLDS = [
      "securities/portfolio-calculation.service.ts",
      "securities/position-basis-replay.ts",
      "securities/holdings.service.ts",
    ];
    const labelOf = (line: string) =>
      /^\s*(case\s+[^:]+:)\s*(\{)?\s*$/.exec(line);
    const offenders: string[] = [];

    for (const rel of FOLDS) {
      const lines = readFileSync(join(SRC_ROOT, rel), "utf8").split("\n");
      // A group is a run of adjacent `case` labels (blank and comment lines
      // between them ignored) that share one body; a label that opens `{`
      // closes its group.
      let group: { label: string; line: number }[] = [];
      const flush = () => {
        const labels = group.map((g) => g.label);
        const transferIn = group.find((g) =>
          /InvestmentAction\.TRANSFER_IN\b/.test(g.label),
        );
        if (
          transferIn &&
          labels.some((l) => /InvestmentAction\.(BUY|REINVEST)\b/.test(l))
        ) {
          offenders.push(`${rel}:${transferIn.line}`);
        }
        group = [];
      };
      for (const [index, line] of lines.entries()) {
        if (/^\s*(\/\/.*)?$/.test(line)) continue;
        const label = labelOf(line);
        if (!label) {
          flush();
          continue;
        }
        group.push({ label: label[1], line: index + 1 });
        if (label[2]) flush();
      }
      flush();
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
