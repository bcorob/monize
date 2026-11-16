import {
  MONEY99_CASH_PAIR_ACTIONS,
  translateMoney99Flags,
} from "../model/mny-money99";
import { MnyTransaction, MnyTransfer } from "../model/mny-rows";

/**
 * Money 97-99 `TRN` and `TRN_XFER` rows, rewritten into the shape the mappers
 * read from a Money 2001+ file.
 *
 * Two differences are structural rather than a column alias:
 *
 * - **`grftt` uses another bit layout.** Each row's flags are rebuilt in the
 *   Money Plus layout (`translateMoney99Flags`), so `isVoided`,
 *   `isUnpostedRow` and `isLoanPaymentTemplate` read a Money 99 row correctly.
 * - **Other income and other expenses are a transfer pair.** Money 99 records
 *   one as an investment row carrying the security and the category, paired
 *   through `TRN_XFER` with a plain row in the cash account that carries the
 *   amount. Monize has no investment action for either, so the investment row
 *   is dropped and the cash row stands alone as an ordinary transaction, taking
 *   the category from its partner. A row with no cash partner is left as it
 *   is, and the investment mapper reports its action as unknown.
 */
export function adaptMoney99Transactions(
  transactions: readonly MnyTransaction[],
  transfers: readonly MnyTransfer[],
): { transactions: MnyTransaction[]; transfers: MnyTransfer[] } {
  const translated = transactions.map((row) => ({
    ...row,
    flags: translateMoney99Flags(row.flags),
  }));

  const byHandle = new Map(
    translated
      .filter((row) => row.handle !== null)
      .map((row) => [row.handle as number, row]),
  );
  const partnerOf = new Map<number, number>();
  for (const transfer of transfers) {
    if (transfer.from !== null && transfer.to !== null) {
      partnerOf.set(transfer.from, transfer.to);
      partnerOf.set(transfer.to, transfer.from);
    }
  }

  const dropped = new Set<number>();
  const standalone = new Map<number, MnyTransaction>();
  for (const row of translated) {
    if (
      row.handle === null ||
      row.security === null ||
      !MONEY99_CASH_PAIR_ACTIONS.has(row.action)
    ) {
      continue;
    }
    const partnerHandle = partnerOf.get(row.handle);
    const partner =
      partnerHandle === undefined ? undefined : byHandle.get(partnerHandle);
    if (partner === undefined || partner.security !== null) {
      continue;
    }
    dropped.add(row.handle);
    standalone.set(partnerHandle as number, {
      ...partner,
      linkedAccount: null,
      category: partner.category ?? row.category,
      payee: partner.payee ?? row.payee,
      memo: partner.memo ?? row.memo,
    });
  }

  return {
    transactions: translated
      .filter((row) => row.handle === null || !dropped.has(row.handle))
      .map((row) =>
        row.handle === null ? row : (standalone.get(row.handle) ?? row),
      ),
    transfers: transfers.filter(
      (transfer) =>
        !(transfer.from !== null && dropped.has(transfer.from)) &&
        !(transfer.to !== null && dropped.has(transfer.to)),
    ),
  };
}
