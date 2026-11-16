import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";

/**
 * A loan's payment account must be in the loan's currency (audit A26-S15-10).
 *
 * The scheduled bill is written in the loan's currency on the payment
 * account, and every posting is refused (`assertTransactionCurrencyMatchesAccount`)
 * when the two differ, so a setup that accepts the pair schedules a bill that
 * can never post. The one comparison for the three writers: the payment
 * setup and the loan and mortgage creates. Each calls it before it writes.
 * Case-insensitive, as the posting's own check is.
 */
export function assertLoanSourceCurrency(
  sourceCurrencyCode: string,
  loanCurrencyCode: string,
): void {
  const source = String(sourceCurrencyCode).toUpperCase();
  const loan = String(loanCurrencyCode).toUpperCase();
  if (source !== loan) {
    throw new BadRequestException(
      tr(
        "errors.accounts.loanSourceCurrencyMismatch",
        `The payment account is in ${source} and the loan in ${loan}. Choose an account in ${loan}.`,
        { source, loan },
      ),
    );
  }
}
