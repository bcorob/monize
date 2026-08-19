import { readFileSync } from "fs";
import { join } from "path";

const TX_ROOT = __dirname;

/**
 * Every write path a user can reach that alters an existing transaction, and
 * the function inside each that must refuse a reconciled row.
 *
 * The strict lock is only as good as its least-guarded entry point, and this
 * codebase has the scar to prove the general form of that: a refusal added to
 * the single-row transfer route was walked around by `bulkUpdate`, which
 * expands a transfer leg to its counterpart. So the rule is a scan rather than
 * a paragraph -- a new mutation route that locks a transaction row and does not
 * ask this question fails here, wherever it is added.
 *
 * The list may grow. Removing an entry means the route no longer writes to a
 * transaction, which is a change worth arguing for in the diff.
 */
const ENFORCEMENT_SITES: { file: string; fn: string; why: string }[] = [
  {
    file: "transactions.service.ts",
    fn: "async update(",
    why: "PATCH /transactions/:id -- the ordinary edit",
  },
  {
    file: "transactions.service.ts",
    fn: "async remove(",
    why: "DELETE /transactions/:id",
  },
  {
    file: "transaction-reconciliation.service.ts",
    fn: "private async applyStatusTransition(",
    why: "clear, reconcile, unreconcile and PATCH :id/status all resolve here",
  },
  {
    file: "transaction-reconciliation.service.ts",
    fn: "async bulkReconcile(",
    why: "POST /transactions/reconcile/:accountId takes arbitrary ids",
  },
  {
    file: "transaction-transfer.service.ts",
    fn: "async removeTransfer(",
    why: "DELETE /transactions/:id/transfer -- both legs at once",
  },
  {
    file: "transaction-transfer.service.ts",
    fn: "async updateTransfer(",
    why: "PATCH /transactions/:id/transfer",
  },
  {
    file: "transaction-bulk-update.service.ts",
    fn: "async bulkUpdate(",
    why: "POST /transactions/bulk-update, the route a single-row refusal is walked around by",
  },
  {
    file: "transaction-bulk-update.service.ts",
    fn: "async bulkDelete(",
    why: "POST /transactions/bulk-delete",
  },
  {
    file: "transaction-split.service.ts",
    fn: "async updateSplits(",
    why: "PUT /transactions/:id/splits -- replaces a reconciled parent's lines",
  },
  {
    file: "transaction-split.service.ts",
    fn: "async addSplit(",
    why: "POST /transactions/:id/splits",
  },
  {
    file: "transaction-split.service.ts",
    fn: "async removeSplit(",
    why: "DELETE /transactions/:id/splits/:splitId",
  },
];

const ASSERTION = /assertReconciled(?:Rows|Ids)Mutable\s*\(/;

/**
 * The text of `fn` in `source`, from its signature to the start of the next
 * class member.
 *
 * Deliberately not brace counting from the first `{`: three of these
 * signatures open a brace before their body does -- an inline options type
 * (`options?: { createPayeeIfMissing?: boolean }`) or an object return type
 * (`Promise<{ accountId: string; ... }>`) -- so counting from there closes the
 * "body" inside the parameter list and reports every one of them as
 * unguarded. Class members are the only things in these files indented by
 * exactly two spaces, so the next one is where this one ends.
 */
const NEXT_MEMBER =
  /\n {2}(?:\/\*\*|(?:private |protected |public )?(?:readonly |static )?(?:async )?[A-Za-z_$][\w$]*\s*[(<])/;

function methodBody(source: string, signature: string): string | null {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const rest = source.slice(start + signature.length);
  const next = rest.search(NEXT_MEMBER);
  return next === -1 ? source.slice(start) : rest.slice(0, next);
}

describe("the strict reconciled lock is asked on every write path", () => {
  const sources = new Map<string, string>();
  for (const { file } of ENFORCEMENT_SITES) {
    if (!sources.has(file)) {
      sources.set(file, readFileSync(join(TX_ROOT, file), "utf8"));
    }
  }

  it.each(ENFORCEMENT_SITES)("$file $fn ($why)", ({ file, fn }) => {
    const body = methodBody(sources.get(file)!, fn);
    // A null body means the signature moved: update ENFORCEMENT_SITES rather
    // than deleting the entry, or the route silently stops being scanned.
    expect(body).toBeTruthy();
    expect(ASSERTION.test(body!)).toBe(true);
  });

  it("still recognises the assertion, so the rule cannot pass by accident", () => {
    // If the helper is renamed, every case above would silently start failing
    // for the wrong reason -- or, worse, a loosened regex would pass for all of
    // them. Pin the exported names against the module itself.
    const util = readFileSync(join(TX_ROOT, "reconciled-lock.util.ts"), "utf8");
    expect(util).toContain(
      "export async function assertReconciledRowsMutable(",
    );
    expect(util).toContain("export async function assertReconciledIdsMutable(");
  });

  /**
   * The undo window hands half the rule to the caller: `undoWindowFor` makes
   * the assertion *return* for a row reconciled seconds ago instead of
   * throwing, and only the caller knows whether the transition it is about to
   * make is the undo the window exists for. A site that asks for the window
   * and never checks has quietly turned the lock into a ten-second door into
   * every alteration -- and it reads exactly like a site that refuses.
   */
  it("closes the undo window it opens", () => {
    const opened = ENFORCEMENT_SITES.filter(({ file, fn }) => {
      const body = methodBody(sources.get(file)!, fn)!;
      return (
        body.includes("undoWindowFor") && !body.includes("isReconciledUndo(")
      );
    }).map(({ file, fn }) => `${file} ${fn}`);
    expect(opened).toEqual([]);
  });

  it("refuses before the write, not after it", () => {
    // Every assertion has to sit inside the mutation's own transaction: a 409
    // cannot undo a committed row (docs/financial-calculation-contract.md
    // section 7). `withScopedDb` opening before the call is the observable form
    // of that in this codebase.
    const outside = ENFORCEMENT_SITES.filter(({ file, fn }) => {
      const body = methodBody(sources.get(file)!, fn)!;
      const scoped = body.indexOf("withScopedDb");
      const assertion = body.search(ASSERTION);
      return scoped === -1 || assertion < scoped;
    }).map(({ file, fn }) => `${file} ${fn}`);
    expect(outside).toEqual([]);
  });
});
