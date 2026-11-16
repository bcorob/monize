/**
 * How the Date and Payee columns close ranks when the register hides the year.
 *
 * The gap a reader sees between the two is the date cell's right inset plus the
 * payee cell's left inset -- 24px at normal density on a phone, where the payee
 * is the column with nothing to spare. Shortening the date frees width inside
 * the date column; tightening these two insets hands over the width *between*
 * them as well.
 *
 * Both halves are needed and so is the header: a `<th>` and its `<td>` that
 * disagree about their padding put the column label and the values it labels at
 * different offsets. That is why this returns the pair rather than leaving four
 * call sites to spell out the same two classes -- the value is written once, and
 * `TransactionList.test.tsx` asserts the header and the row still match.
 *
 * Only below `sm`, whatever renders in the date cell: the tightening exists to
 * hand width to a payee that has none to spare, which is only true of phones.
 * Above `sm` a shortened date simply leaves whitespace and the table keeps its
 * ordinary inset.
 */
export interface RegisterDateColumnPadding {
  /** Extra class for the Date column's header and cells. */
  date: string;
  /** Extra class for the Payee column's header and cells. */
  payee: string;
}

const TIGHTENED: RegisterDateColumnPadding = {
  date: 'max-sm:pr-1',
  payee: 'max-sm:pl-1',
};

const UNCHANGED: RegisterDateColumnPadding = { date: '', payee: '' };

export function registerDateColumnPadding(
  compactDates: boolean | undefined,
): RegisterDateColumnPadding {
  return compactDates ? TIGHTENED : UNCHANGED;
}
