import { readFileSync } from "fs";
import { join } from "path";

/**
 * The posting prices a loan installment under the lock that authorizes its
 * write (`CONC-001`, INV-LOAN-006).
 *
 * `scheduled-loan-pricing-concurrency.integration.spec.ts` proves the protocol
 * works -- two real connections, a real ledger write queueing behind the held
 * lock. It cannot prove the posting *takes* that lock, because the integration
 * harness stubs `ScheduledTransactionsModule` to break a require cycle and the
 * real `post()` cannot be constructed there. This scan is the other half: every
 * pricing call in the posting path is preceded by the lock.
 *
 * A scan rather than a test of one path because there are two doors into the
 * pricing (the base-split path and the Post dialog's echoed splits), and a
 * third would be added without either existing test noticing.
 */
const SOURCE = join(__dirname, "scheduled-transactions.service.ts");

/** Comments are blanked, line numbers preserved: this file's own prose names
 *  the very calls it bans reaching unguarded. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("scheduled loan pricing runs under the account lock", () => {
  const source = stripComments(readFileSync(SOURCE, "utf8"));

  it("blanks comments while preserving line numbers", () => {
    const stripped = stripComments("a\n// resolvePostingAllocation(x)\nb");
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripped).not.toContain("resolvePostingAllocation");
  });

  it("finds the pricing call sites it is meant to police", () => {
    // A rename that made this match nothing would look like compliance.
    const calls = source.match(/resolvePostingAllocation\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("takes the pricing lock before every pricing call", () => {
    // The lock has to be held BEFORE the debt is read, not merely somewhere in
    // the same transaction: a lock taken afterwards leaves exactly the window
    // it exists to close.
    const unguarded: number[] = [];
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("resolvePostingAllocation(")) return;
      const preceding = lines.slice(Math.max(0, index - 12), index).join("\n");
      if (!preceding.includes("lockLoanLedgerForPricing(")) {
        unguarded.push(index + 1);
      }
    });
    expect(unguarded).toEqual([]);
  });

  it("locks through the shared account primitive, not a hand-rolled statement", () => {
    // Every balance writer already takes this one; a bespoke lock here would
    // serialize against nobody.
    expect(source).toContain("lockAccountsForBalanceWrite(");
    const helper = source.slice(
      source.indexOf("private async lockLoanLedgerForPricing("),
    );
    const body = helper.slice(0, helper.indexOf("\n  }"));
    expect(body).toContain("lockAccountsForBalanceWrite(");
    // Both movers are locked: the source pays and the loan receives.
    expect(body).toContain("sourceAccountId");
    expect(body).toContain("loanAccountId");
  });
});
