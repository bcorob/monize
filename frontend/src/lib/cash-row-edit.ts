import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { createLogger } from '@/lib/logger';
import type { InvestmentTransaction } from '@/types/investment';
import type { Transaction } from '@/types/transaction';

const logger = createLogger('CashRowEdit');

interface CashRowEditHandlers {
  /** Open the investment form on the trade behind this row. */
  openInvestment: (transaction: InvestmentTransaction) => void;
  /** Open the cash form on the row itself. */
  openCash: (transaction: Transaction) => void;
  /** Report a lookup that failed, so the surface can say so in its own words. */
  onLookupFailed?: (error: unknown) => void;
}

/**
 * Open the right editor for a row in a cash register.
 *
 * A cash register holds three kinds of row and only one of them is edited as
 * itself:
 *
 *  - **A trade's cash leg** (`linkedInvestmentTransactionId`) is not a cash
 *    transaction the user can meaningfully edit -- its amount, date and payee
 *    are consequences of the trade. Editing it means editing the trade, so the
 *    investment form opens on that.
 *  - **A transfer** needs its counterpart, which the list payload does not
 *    carry, so the full row is fetched before the cash form opens on it.
 *  - **Anything else** opens on the row as listed.
 *
 * It is one function because both cash registers -- the Investments page's and
 * the account detail page's -- draw the same rows, and the detail page's had
 * only the third case: clicking a trade there opened a cash form over a row
 * whose numbers the trade owns, and clicking a transfer opened one that did not
 * know where the money went.
 *
 * A failed lookup falls back to the cash form for a transfer (a partial editor
 * beats none) but never for a trade: an investment row edited as cash is the
 * defect this exists to prevent, so the failure is reported and nothing opens.
 */
export async function editCashRow(
  transaction: Transaction,
  { openInvestment, openCash, onLookupFailed }: CashRowEditHandlers,
): Promise<void> {
  if (transaction.linkedInvestmentTransactionId) {
    try {
      const investmentTransaction = await investmentsApi.getTransaction(
        transaction.linkedInvestmentTransactionId,
      );
      openInvestment(investmentTransaction);
    } catch (error) {
      logger.error('Failed to load linked investment transaction:', error);
      onLookupFailed?.(error);
    }
    return;
  }

  if (transaction.isTransfer) {
    try {
      openCash(await transactionsApi.getById(transaction.id));
    } catch (error) {
      logger.error('Failed to load transaction details:', error);
      openCash(transaction);
    }
    return;
  }

  openCash(transaction);
}
