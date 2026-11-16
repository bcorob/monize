'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useIsMobile } from '@/hooks/useIsMobile';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { balanceColor } from '@/lib/format';
import { useInvestmentActionInfo } from '@/components/investments/InvestmentTransactionListParts';
import {
  redemptionTotalWithInterest,
  supportsAccruedInterest,
} from '@/lib/investment-actions';
import { isDailyValueComplete } from '@/hooks/useInvestmentDailyValues';
import { dayNoteSpanPosition } from '@/lib/day-note-span';
import { gainLossColor } from '@/lib/format';
import type { MonthGridDay } from '@/components/ui/MonthGrid';
import type { CalendarDayRows } from '@/lib/calendar-rows';
import type { DailyBalanceTotal } from '@/types/account';
import type { DayNote } from '@/types/calendar';
import type { DailyInvestmentValue } from '@/types/net-worth';
import type {
  DailyMovementPoint,
  DailyMovementReason,
  InvestmentTransaction,
} from '@/types/investment';
import type { Transaction } from '@/types/transaction';

interface CalendarDayCellProps {
  day: MonthGridDay;
  /** What falls on this day, or undefined for a day with nothing on it. */
  rows?: CalendarDayRows;
  /** How many chips are drawn before the rest become a "+N more" line. */
  chipLimit: number;
  onOpenDay: (date: string) => void;
  onEditTransaction: (transaction: Transaction) => void;
  /** Opens a brokerage row; absent on a calendar that draws none. */
  onEditInvestment?: (transaction: InvestmentTransaction) => void;
  /**
   * The note covering this day, when there is one.
   *
   * A multi-day note is the SAME object on every day it covers, so the cell
   * draws where this day sits in it rather than repeating the text nine times.
   */
  note?: DayNote;
  /** What the day's figure layer has to say: a balance, a value, a movement. */
  figure?: ReactNode;
}

/**
 * How many dots a phone cell draws.
 *
 * Deliberately one more than `CALENDAR_DAY_CHIP_LIMIT`, and not the same
 * number: a chip is a LINE in a cell of fixed height, so its limit is that
 * height in chips, while the dots wrap onto as many rows as the day needs and
 * six of them are two rows of a phone column. The count beside them is the
 * day's whole total either way, so a day holding more than this still says so.
 */
export const CALENDAR_DAY_DOT_LIMIT = 6;

// A chip is a row, not a line of text: what the row is about reads from the
// left and its figure is pushed to the right edge, so a day's amounts line up
// under each other the way the register's amount column does.
const CHIP =
  'flex w-full items-baseline gap-1 rounded px-1 py-0.5 text-left text-xs transition-opacity motion-reduce:transition-none hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/** What a chip is about: as much as fits, and never at the figure's expense. */
const CHIP_LABEL = 'min-w-0 flex-1 truncate';

/** A chip's figure, at the right-hand edge and never wrapped or shrunk. */
const CHIP_AMOUNT = 'shrink-0 tabular-nums';

/**
 * One day of the Transactions calendar: its number, its chips, and whatever
 * the Balances layer has to say about it.
 *
 * Every figure printed here is the one the server sent for that row or that
 * occurrence. The cell adds nothing up -- a day's total is not a number this
 * calendar claims to know (design I1).
 */
export function CalendarDayCell({
  day,
  rows,
  chipLimit,
  onOpenDay,
  onEditTransaction,
  onEditInvestment,
  note,
  figure,
}: CalendarDayCellProps) {
  const t = useTranslations('calendar');
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();
  const actionInfo = useInvestmentActionInfo();

  const transactions = rows?.transactions ?? [];
  const occurrences = rows?.occurrences ?? [];
  const investments = rows?.investments ?? [];
  const total = transactions.length + occurrences.length + investments.length;
  // The chips a desktop cell has the height for, and the dots a phone cell has
  // the room for -- one order of precedence, two limits.
  const { shownInvestments, shownTransactions, shownOccurrences } = fillDay(
    { transactions, occurrences, investments },
    chipLimit,
  );
  const dots = fillDay({ transactions, occurrences, investments }, CALENDAR_DAY_DOT_LIMIT);
  const hidden =
    total - shownInvestments.length - shownTransactions.length - shownOccurrences.length;

  return (
    <div
      // A phone cell holds a date, a row of dots and a figure; from sm up the
      // cell holds the day's chips and the note's band, so it is half again as
      // tall (7rem -> 10.5rem) and a day with three chips no longer fills it.
      className={`min-h-[6rem] sm:min-h-[10.5rem] flex flex-col gap-0.5 ${
        // The note's band is drawn across the bottom of the week at every
        // width, so a covered day keeps that much room free rather than letting
        // a busy day's last chip end up underneath it. A phone band takes two
        // lines of smaller type, which is taller than the desktop band's one.
        note ? 'pb-8 sm:pb-6' : ''
      }`}
    >
      {/* On a phone the figure goes UNDER the date rather than beside it: a
          balance and a date share a cell barely wide enough for either, and the
          figure is what the reader came to the Balances layer for. */}
      <div className="flex flex-col items-start gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-1">
        <span
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium ${
            day.isToday
              ? 'bg-blue-600 text-white'
              : day.isCurrentMonth
                ? 'text-gray-900 dark:text-gray-100'
                : 'text-gray-400 dark:text-gray-600'
          }`}
        >
          {Number(day.date.slice(-2))}
        </span>
        {figure}
      </div>

      {note && (
        <CalendarDayNoteMarker note={note} date={day.date} label={t('notes.title')} />
      )}


      {/* Below sm the chips are dots and a count: a phone cell has no room for
          a label, and the day panel is the reading surface there. The count is
          what keeps a day with six items from reading like a day with three.

          The dots are decoration and are hidden from assistive technology; the
          count is not, because below sm it is the ONLY thing that says how many
          items a day holds -- the chip list below is `display: none` there, so
          hiding the count too would leave a phone screen reader a month of bare
          dates. The glyph stays `aria-hidden` beside an `sr-only` phrase so the
          number is read as a count of something rather than as a stray digit. */}
      <div className="sm:hidden flex flex-wrap items-center gap-1">
        {/* Dots big enough to tell one colour from another at arm's length, and
            wrapping onto as many rows as the day needs: a phone column fits
            three of them, so a busy day is two rows of dots rather than five
            squeezed into one. */}
        <span className="flex flex-wrap items-center gap-1" aria-hidden="true">
          {dots.shownInvestments.map((chip) => (
            <span key={chip.key} className={`h-2.5 w-2.5 rounded-full ${chip.className}`} />
          ))}
          {dots.shownTransactions.map((chip) => (
            <span key={chip.key} className={`h-2.5 w-2.5 rounded-full ${chip.className}`} />
          ))}
          {dots.shownOccurrences.map((chip) => (
            <span
              key={chip.key}
              className={`h-2.5 w-2.5 rounded-full border border-dashed border-current ${chip.className}`}
            />
          ))}
        </span>
        {total > 0 && (
          <span className="ml-0.5 text-[10px] leading-none text-gray-500 dark:text-gray-400">
            <span aria-hidden="true">{total}</span>
            <span className="sr-only">{t('day.itemCount', { count: total })}</span>
          </span>
        )}
      </div>

      <div className="hidden sm:flex flex-col gap-0.5">
        {shownInvestments.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => onEditInvestment?.(chip.transaction)}
            className={`${CHIP} ${chip.className} ${chip.isVoid ? 'line-through opacity-50' : ''} ${
              chip.isFuture && !chip.isVoid ? 'opacity-60' : ''
            }`}
          >
            <span className={CHIP_LABEL}>
              {chip.transaction.security?.symbol ?? t('chip.noSymbol')}{' '}
              {actionInfo(chip.transaction.action).shortLabel}
            </span>
            <span className={CHIP_AMOUNT}>
              {formatCurrency(
                // The figure the register shows for this row: a redemption's
                // accrued interest moved with its proceeds, so the two are one
                // cash movement.
                supportsAccruedInterest(chip.transaction.action)
                  ? redemptionTotalWithInterest(
                      chip.transaction.totalAmount,
                      chip.transaction.accruedInterest,
                    )
                  : chip.transaction.totalAmount,
                chip.transaction.security?.currencyCode,
              )}
            </span>
          </button>
        ))}

        {shownTransactions.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => onEditTransaction(chip.transaction)}
            className={`${CHIP} ${chip.className} ${chip.isVoid ? 'line-through opacity-50' : ''} ${
              chip.isFuture && !chip.isVoid ? 'opacity-60' : ''
            }`}
          >
            <span className={CHIP_LABEL}>
              {payeeDisplay(chip.transaction) ?? t('chip.noPayee')}
            </span>
            <span className={CHIP_AMOUNT}>
              {formatCurrency(Number(chip.transaction.amount), chip.transaction.currencyCode)}
            </span>
          </button>
        ))}

        {shownOccurrences.map((chip) => (
          <Link
            key={chip.key}
            href={`/bills?highlight=${chip.occurrence.scheduledTransactionId}`}
            className={`${CHIP} border border-dashed border-current ${chip.className}`}
          >
            <span className={`${CHIP_LABEL} inline-flex items-center gap-1`}>
              {chip.isOverdue ? (
                <ExclamationTriangleIcon
                  className="w-3 h-3 shrink-0"
                  aria-label={t('chip.overdue')}
                />
              ) : (
                <ClockIcon className="w-3 h-3 shrink-0" aria-label={t('chip.scheduled')} />
              )}
              <span className="truncate">{chip.schedule.name}</span>
            </span>
            {chip.occurrence.amount === null ? (
              <UnknownAmount className={CHIP_AMOUNT} />
            ) : (
              <span className={CHIP_AMOUNT}>
                {formatCurrency(chip.occurrence.amount, chip.occurrence.currencyCode)}
              </span>
            )}
          </Link>
        ))}
      </div>

      {/* "+N more" counts what the chip list left out, so it belongs only where
          that list is drawn. Below sm the chips are dots and the count beside
          them already says how many items the day holds, which is the whole of
          what this line would add. */}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onOpenDay(day.date)}
          className="mt-auto hidden self-start px-1 text-xs text-gray-500 dark:text-gray-400 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:block"
        >
          {t('day.moreChips', { count: hidden })}
        </button>
      )}
    </div>
  );
}

/**
 * Which of a day's rows a limited number of marks stands for.
 *
 * A trade is what the reader came to the Investments calendar for, so the
 * brokerage rows take the room first; the cash rows and then the scheduled
 * items fill what is left. One order for both the chips and the dots, which is
 * what keeps a phone's marks standing for the same rows a desktop's chips name.
 */
function fillDay(rows: CalendarDayRows, limit: number) {
  const shownInvestments = rows.investments.slice(0, limit);
  const shownTransactions = rows.transactions.slice(
    0,
    Math.max(0, limit - shownInvestments.length),
  );
  const shownOccurrences = rows.occurrences.slice(
    0,
    Math.max(0, limit - shownInvestments.length - shownTransactions.length),
  );
  return { shownInvestments, shownTransactions, shownOccurrences };
}

/**
 * One day's note, for a screen reader.
 *
 * The note is SEEN as a band across the days it covers (`CalendarNoteSpans`),
 * at every width, and that band is decoration the screen reader never meets. So
 * this is what tells a screen reader which days a note covers, and it is
 * `sr-only` everywhere: a second visible copy in the cell would print the same
 * sentence once per covered day.
 *
 * A day in the middle or at the end of a run says only that it is covered --
 * the text belongs to the run, and is carried by the day the run opens on.
 */
function CalendarDayNoteMarker({
  note,
  date,
  label,
}: {
  note: DayNote;
  date: string;
  label: string;
}) {
  const position = dayNoteSpanPosition(note, date);
  const continues = position === 'middle' || position === 'end';

  return (
    <p className="sr-only" data-testid="calendar-day-note-marker" data-note-span={position}>
      <span>{label}</span> {!continues && <span>{note.body.split('\n')[0]}</span>}
    </p>
  );
}

/**
 * The money formatter a day cell's figure reads in, for the width it is drawn
 * at.
 *
 * A phone column is about fifty pixels, where "$13,344.33" either overflows the
 * cell or wraps mid-number; `formatCurrencyTight` renders the same figure as
 * "$13.3K", and "$344" where a thousand does not scale. A real branch and not a
 * breakpoint class: the two renderings are different TEXT, so drawing both and
 * hiding one would read the day's balance to a screen reader twice.
 */
function useDayFigureMoney(): (value: number, currencyCode?: string) => string {
  const { formatCurrency, formatCurrencyTight } = useNumberFormat();
  const isMobile = useIsMobile();
  return isMobile ? formatCurrencyTight : formatCurrency;
}

/**
 * The Balances layer's figure for one day, as the cell prints it.
 *
 * The number, the currency and the projected-or-actual decision are all the
 * server's (design I2): this reads `total` and `isProjected` off the day it was
 * handed and renders them. It never sums, converts, or compares a date with the
 * browser's clock.
 *
 * A `null` total is the unknown marker, never `knownSubtotal` wearing a total's
 * caption -- the partial sum has its own line in the day panel, where there is
 * room to say it is partial.
 */
export function CalendarBalanceFigure({
  point,
  currencyCode,
}: {
  point: DailyBalanceTotal;
  currencyCode: string;
}) {
  const t = useTranslations('calendar');
  const formatMoney = useDayFigureMoney();

  if (point.total === null) {
    // Which unknown this is decides which screen repairs it: a missing pair is
    // a rate to add, an unpriceable projection is a schedule to look at.
    return (
      <UnknownAmount
        reason={point.missingRatePairs.length > 0 ? 'displayFx' : 'scheduledFx'}
        className="text-xs"
      />
    );
  }

  return (
    <span
      className={`inline-flex items-baseline gap-0.5 text-xs tabular-nums ${balanceColor(
        point.total,
      )} ${point.isProjected ? 'italic' : ''}`}
      data-testid={point.isProjected ? 'calendar-balance-projected' : 'calendar-balance-actual'}
    >
      {point.isProjected && (
        <ClockIcon className="w-3 h-3 shrink-0 self-center" aria-label={t('balance.projected')} />
      )}
      {formatMoney(point.total, currencyCode)}
    </span>
  );
}

/**
 * The Values layer's figure for one day, as the cell prints it.
 *
 * A day whose value the server could not work out is the unknown marker, and
 * which flag withheld it decides which repair the marker points at: an unpriced
 * holding is a price to add, a missing pair is a rate. A day after today has no
 * point at all and prints nothing -- a market value is never projected (design
 * decision 7), and blank is not the same rendering as unknown (I3).
 */
export function CalendarValueFigure({
  point,
  currencyCode,
}: {
  point: DailyInvestmentValue;
  currencyCode: string;
}) {
  const formatMoney = useDayFigureMoney();

  if (!isDailyValueComplete(point)) {
    return (
      <UnknownAmount
        reason={
          point.pricesComplete === false
            ? 'noPrice'
            : point.cashComplete === false
              ? 'noCashBalance'
              : 'displayFx'
        }
        className="text-xs"
      />
    );
  }

  return (
    <span
      className="text-xs tabular-nums text-gray-900 dark:text-gray-100"
      data-testid="calendar-value-figure"
    >
      {formatMoney(point.value, currencyCode)}
    </span>
  );
}

/**
 * Which repair a withheld movement points the reader at.
 *
 * The marker carries one `UnknownAmount` cause and the server sent six, so the
 * mapping is made here rather than guessed: an unpriced holding is a price to
 * add, a missing rate or an unconvertible flow is a rate to refresh, and the
 * scope's first day is neither -- there is no earlier value to measure it
 * against and nothing the reader can do about it. Naming a price for a missing
 * display rate, or a rate for a boundary, sends them to a screen where there is
 * nothing to fix; `displayFx` exists because that mistake was made before.
 *
 * `notTradingDay` and `zeroBaseline` never reach here: those days are blank.
 * The banner carries the server's own wording for every reason present in the
 * month; this is the cell's one-glyph share of it.
 */
export function movementUnknownReason(
  reasons: readonly DailyMovementReason[],
): 'noPrice' | 'displayFx' | 'noBaseline' | 'noCashBalance' {
  if (reasons.includes('unpricedHolding')) return 'noPrice';
  // A cash account that reported no balance is neither a price nor a rate: the
  // day's balance is missing, and sending the reader to either screen is the
  // errand `displayFx` exists to avoid.
  if (reasons.includes('cashIncomplete')) return 'noCashBalance';
  // `decide` returns this one alone, so it is not masking another cause.
  if (reasons.includes('noPriorValue')) return 'noBaseline';
  return 'displayFx';
}

/**
 * The Daily change layer's figure for one day, as the cell prints it.
 *
 * Three renderings, and they never share markup (I3): a percentage, the unknown
 * marker, or nothing at all. Which one is decided by `complete` and `reasons`,
 * both the server's -- a weekend carries the previous close forward, so its
 * arithmetic yields exactly zero and would otherwise be indistinguishable from a
 * flat session (design decision 9).
 *
 * Exactly zero is neutral rather than green: `gainLossColor` calls a
 * non-negative number a gain, which is right for a return and wrong for a
 * session that did not move.
 */
export function CalendarChangeFigure({
  point,
  onOpenDetail,
}: {
  point: DailyMovementPoint;
  onOpenDetail: (date: string) => void;
}) {
  const t = useTranslations('calendar');
  const { formatPercent } = useNumberFormat();

  // A day nothing held was priced on is blank: the market had no session to
  // report, which is not a figure the reader is missing.
  if (!point.isTradingDay) return null;

  if (!point.complete) {
    // No baseline to divide by is likewise blank rather than unknown: the day's
    // movement is known, only the percentage is undefined.
    if (point.reasons.includes('zeroBaseline')) return null;
    return <UnknownAmount reason={movementUnknownReason(point.reasons)} className="text-xs" />;
  }

  const percent = point.movementPercent;
  if (percent === null) return null;

  return (
    <button
      type="button"
      onClick={() => onOpenDetail(point.date)}
      aria-label={t('change.openDetail')}
      data-testid="calendar-change-figure"
      className={`rounded px-0.5 text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        percent === 0 ? 'text-gray-500 dark:text-gray-400' : gainLossColor(percent)
      }`}
    >
      {formatPercent(percent)}
    </button>
  );
}
