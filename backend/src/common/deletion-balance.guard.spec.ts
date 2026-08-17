import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/** The file that owns the rule. */
const ALLOWED = new Set(["common/deletion-balance.util.ts"]);

/**
 * Sites that pass a negated row amount to a balance update for a reason other
 * than deleting that row, with the reason. This list may shrink, never grow
 * without one.
 */
const REVIEWED: Record<string, string> = {
  // Reversing a status change, not a deletion: the row stays and its own
  // wasVoid/isVoid transition decides the movement.
  "transactions/transaction-reconciliation.service.ts":
    "status transition, not a deletion -- the row survives",
  "transactions/void-status-transition.util.ts":
    "status transition, not a deletion -- the mirror leg survives",
  "transactions/transaction-split.service.ts":
    "status transition, not a deletion -- split-parent propagation moves the " +
    "surviving counterpart across the VOID boundary from its locked row",
  "transactions/transaction-transfer.service.ts":
    "status transitions and edit reversals, not deletions -- the legs survive " +
    "and their old amounts are reversed from locked reads before re-applying",
};

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
 * Deleting a row reverses exactly what it contributed, and a `VOID` or
 * future-dated row contributed nothing.
 *
 * The rule was written out at nine deletion sites across four services and three
 * omitted the status check -- two of them in the same function as a correct one
 * (recheck RR4-001). It is mechanical, so it gets a scanning test rather than a
 * paragraph: a deletion reversal goes through `deletionBalanceEffect`, and the
 * shape that must not come back is a hand-written `-Number(row.amount)` handed to
 * a balance update.
 */
describe("deletion balance reversal is written once", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never negates a row amount into a balance update outside the shared helper", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel) || REVIEWED[rel]) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `-Number(<something>.amount)` -- or the already-numeric
        // `-<something>.amount` a LockedTransactionRow yields -- as an
        // argument. A legitimate deletion reversal now passes `effect.delta`
        // instead; the numeric form was invisible to the first regex, and the
        // helper's own motivating example (removeParentTransaction) used it.
        if (!/-\s*(?:Number\(\s*)?\w+(\?\.)?\.amount\b/.test(line)) continue;

        // The balance call may be a few lines above (the argument sits on its own
        // line under `updateBalance(` / `updateAccountBalance(`).
        const context = lines
          .slice(Math.max(0, index - 6), index + 2)
          .join("\n");
        if (!/updateBalance\s*\(|updateAccountBalance\s*\(/.test(context)) {
          continue;
        }

        offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps every reviewed exemption documented", () => {
    // A bare list would grow silently; each entry has to say why it is not a
    // deletion.
    for (const [path, reason] of Object.entries(REVIEWED)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(files.some((f) => f.endsWith(path))).toBe(true);
    }
  });
});
