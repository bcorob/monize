"use client";

import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { gainLossColor } from "@/lib/format";

/** One period's row: a label, a figure, and optionally a figure beneath it. */
export interface PerformancePeriodEntry {
  /** Stable key for the row; the preset it was computed for. */
  period: string;
  /** What the reader sees on the left: "1M", "YTD". */
  label: string;
  /**
   * The headline figure, already formatted by whoever knows what it is. `null`
   * is a period that cannot be reported, and it reads as the unavailable label
   * rather than as a zero: a zero here would be a statement about performance
   * instead of about our data.
   */
  primary: string | null;
  /** The sign the headline is coloured by; no colour when it is absent. */
  primaryValue?: number | null;
  /** A second figure beneath the headline, in the same convention. */
  secondary?: string | null;
  secondaryValue?: number | null;
}

interface PerformancePeriodsCardProps {
  title: string;
  /** One line under the title saying what these figures measure. */
  subtitle?: string;
  entries: readonly PerformancePeriodEntry[];
  /** What a `null` figure reads as; each surface supplies its own catalog's. */
  unavailableLabel: string;
  /**
   * Shown instead of the list when no period can be reported at all AND the
   * caller has no `notice` saying why: a portfolio with no history has nothing
   * to list, but a portfolio whose periods are withheld for a cause has six
   * rows of "n/a" and the cause under them.
   */
  emptyMessage: string;
  /**
   * A one-line qualification in the warning tone, shown above the footnote
   * whenever it is given: the request has not answered, it failed, or the
   * server withheld a period for a cause the reader can act on. Giving it
   * keeps the list on screen even when every figure is unknown, so a failed
   * request or a missing price never reads as "not enough history".
   */
  notice?: string;
  /** A caption under the list: what the figures do and do not include. */
  footnote?: ReactNode;
  /** `warning` is for a footnote that qualifies the figures rather than explaining them. */
  footnoteTone?: "muted" | "warning";
  /** Title attribute for the footnote, where it has more to say. */
  footnoteTitle?: string;
  "data-testid"?: string;
}

/**
 * Figures over the standard trailing periods, in the one layout this app has
 * for them.
 *
 * Two surfaces ask the same question of different subjects -- what a security
 * did, and what the reader's portfolio earned -- and a reader moving between
 * them should not have to re-learn the table. Everything here is presentational:
 * the figures arrive formatted, "n/a" is a period the caller could not report,
 * and the only decision made here is the colour, which is `gainLossColor` over
 * the sign the caller passes beside each figure.
 */
export function PerformancePeriodsCard({
  title,
  subtitle,
  entries,
  unavailableLabel,
  emptyMessage,
  notice,
  footnote,
  footnoteTone = "muted",
  footnoteTitle,
  "data-testid": testId,
}: PerformancePeriodsCardProps) {
  const hasAny = entries.some((entry) => entry.primary !== null);
  const showList = hasAny || notice !== undefined;
  // Whether this caller reports a second figure at all. The security card does
  // not, and an empty column would leave its percentages hanging off a gutter
  // nothing sits in.
  const hasSecondary = entries.some((entry) => entry.secondary !== undefined);

  const figureClass = (
    value: number | null | undefined,
    unavailable: boolean,
  ) =>
    unavailable || value === null || value === undefined
      ? "text-gray-400 dark:text-gray-500"
      : gainLossColor(value);

  return (
    <Card className="flex h-full flex-col p-4" data-testid={testId}>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h3>
      {subtitle && (
        <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {subtitle}
        </p>
      )}
      {showList ? (
        /* One line per period, the same row the security card draws, laid out
           as a GRID rather than a row of flex lines: a column is what makes
           every period's figure start at the same x, so the reader compares
           them down the card instead of re-finding each one. `contents` on the
           group keeps the `dt`/`dd` pairing while letting the grid own the
           columns.

           The second figure, where the caller has one, sits before the
           headline at the headline's own size -- both are figures the reader
           compares, and a money amount set smaller than the ratio beside it
           reads as a footnote to it. Lighter weight is what keeps the headline
           the headline. */
        <dl
          className={`grid items-baseline gap-x-4 gap-y-2 ${
            hasSecondary ? "grid-cols-[1fr_auto_auto]" : "grid-cols-[1fr_auto]"
          }`}
        >
          {entries.map((entry) => (
            <div key={entry.period} className="contents">
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                {entry.label}
              </dt>
              {hasSecondary && (
                <dd
                  className={`text-right text-sm tabular-nums ${figureClass(
                    entry.secondaryValue,
                    entry.secondary === null,
                  )}`}
                >
                  {/* `undefined` is a row this caller has no second figure
                      for, which is not the same as one it could not report:
                      the cell holds the column open and says nothing. */}
                  {entry.secondary === undefined
                    ? null
                    : (entry.secondary ?? unavailableLabel)}
                </dd>
              )}
              <dd
                className={`text-right text-sm font-medium tabular-nums ${figureClass(
                  entry.primaryValue,
                  entry.primary === null,
                )}`}
              >
                {entry.primary === null ? unavailableLabel : entry.primary}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {emptyMessage}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-3 text-xs text-amber-600 dark:text-amber-500"
        >
          {notice}
        </p>
      )}
      {hasAny && footnote && (
        <p
          className={`mt-3 text-xs ${
            footnoteTone === "warning"
              ? "text-amber-600 dark:text-amber-500"
              : "text-gray-500 dark:text-gray-400"
          }`}
          title={footnoteTitle}
        >
          {footnote}
        </p>
      )}
    </Card>
  );
}
