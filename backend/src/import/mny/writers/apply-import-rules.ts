import { EntityManager } from "typeorm";
import { orderByDateStable } from "../../../common/date-order.util";
import { TransactionRulesApplierService } from "../../../transaction-rules/transaction-rules-applier.service";
import { MappedTransaction } from "../model/mny-import-model";
import { INSERT_CHUNK_SIZE, chunk } from "./chunk";

/** What the rule pass did: rows changed, and accounts a structural action moved. */
export interface ApplyImportRulesResult {
  readonly changed: number;
  /**
   * Accounts a structural action credited (conversion target, split transfer
   * targets). The import's post-processing recomputes their balance and net
   * worth after the commit (INV-CACHE-001), exactly as for the accounts the
   * file wrote to.
   */
  readonly affectedAccountIds: ReadonlySet<string>;
  /**
   * Scheduled payments a `settle_loan_installment` claimed an occurrence of;
   * the import's post-processing reprices each template after the commit.
   */
  readonly settledScheduleIds: ReadonlySet<string>;
}

export interface ApplyImportRulesInput {
  readonly transactions: readonly MappedTransaction[];
  /** Ids that really reached the database (`WrittenTransactions`). */
  readonly writtenTransactionIds: ReadonlySet<string>;
  /** Money `hpay` -> the payee's name: the raw payee text of the file. */
  readonly payeeNameByHandle: ReadonlyMap<number, string>;
  /** Banking rows a trade adopts as its cash leg (exempt, design 6.3). */
  readonly investmentCashTransactionIds: ReadonlySet<string>;
}

/**
 * The ids a rule may evaluate: written, regular rows, oldest first and within
 * a date in the file's order (INV-RULE-005), so the chunks walk forward
 * through time. A transfer leg (its own flag or a link) is left to the
 * transfer step, and the row a trade adopts as its cash leg is an investment
 * cash leg, which is exempt.
 */
export function eligibleImportRuleIds(input: ApplyImportRulesInput): string[] {
  const eligible = input.transactions.filter(
    (transaction) =>
      input.writtenTransactionIds.has(transaction.id) &&
      !transaction.isTransfer &&
      transaction.linkedTransactionId === null &&
      transaction.collapsedTradeHandle === null &&
      !input.investmentCashTransactionIds.has(transaction.id),
  );
  return orderByDateStable(eligible, (row) => row.transactionDate).map(
    ({ row }) => row.id,
  );
}

/**
 * One bulk pass of the user's import-trigger rules over the regular rows
 * `writeTransactions` just inserted, on the import's own manager, so a rollback
 * of the import drops the rule effects with the rows. The rules are loaded once
 * and the rows go through the applier in chunks, so the facts (rows, tags,
 * category chains) are read per chunk rather than per row. Returns the number
 * of rows a rule changed and the accounts a structural action moved.
 */
export async function applyImportRules(
  manager: EntityManager,
  applier: TransactionRulesApplierService,
  userId: string,
  input: ApplyImportRulesInput,
): Promise<ApplyImportRulesResult> {
  const affectedAccountIds = new Set<string>();
  const settledScheduleIds = new Set<string>();
  const nothing = { changed: 0, affectedAccountIds, settledScheduleIds };
  const ids = eligibleImportRuleIds(input);
  if (ids.length === 0) return nothing;
  const rules = await applier.loadRulesFor(manager, userId, "import");
  if (rules.length === 0) return nothing;

  const payeeTextById = new Map<string, string | null>();
  for (const transaction of input.transactions) {
    payeeTextById.set(
      transaction.id,
      transaction.payeeHandle === null
        ? null
        : (input.payeeNameByHandle.get(transaction.payeeHandle) ?? null),
    );
  }

  let changed = 0;
  for (const batch of chunk(ids, INSERT_CHUNK_SIZE)) {
    const applied = await applier.applyToNew(manager, userId, batch, "import", {
      rules,
      payeeTextById,
    });
    changed += applied.filter((row) =>
      row.effects.trace.some((entry) => Object.keys(entry.changes).length > 0),
    ).length;
    for (const row of applied) {
      for (const accountId of row.affectedAccountIds) {
        affectedAccountIds.add(accountId);
      }
      for (const scheduleId of row.settledScheduleIds) {
        settledScheduleIds.add(scheduleId);
      }
    }
  }
  return { changed, affectedAccountIds, settledScheduleIds };
}
