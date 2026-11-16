"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Th } from "@/components/ui/Table";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { GemAssetRole, GemHistoryEntry } from "@/types/gem-strategy";
import {
  GEM_ROLE_COLOURS,
  GEM_ROLE_ORDER,
  sortHistoryNewestFirst,
} from "@/lib/gem-strategy-view";
import { cn } from "@/lib/utils";
import {
  GemBadge,
  GemCard,
  GemEmptyState,
  GemSecurityLink,
  GemSigned,
  GemSwatch,
  GemUnknown,
} from "./GemPrimitives";
import { useGemLabels } from "./useGemLabels";

interface GemSignalHistoryTableProps {
  history: GemHistoryEntry[];
  /** Rows to show before the "see full history" affordance (omit for all). */
  limit?: number;
  /** Called by the "see full history" button; omit to hide it. */
  onShowAll?: () => void;
  /** Symbols per role for the momentum column headers. */
  symbolByRole: Map<GemAssetRole, string | null>;
  /** Momentum window the columns report, in months. */
  lookbackMonths: number;
}

/**
 * The history of monthly evaluations, as a table -- the primary way to review
 * past signals. Rows expand to the full evaluation detail; asset colours match
 * the performance chart so a winner is recognisable at a glance, and every
 * status also carries a text label.
 */
export function GemSignalHistoryTable({
  history,
  limit,
  onShowAll,
  symbolByRole,
  lookbackMonths,
}: GemSignalHistoryTableProps) {
  const t = useTranslations("strategies");
  const {
    roleLabel,
    roleDescription,
    stateLabel,
    actionLabel,
    historicalAssetLabel,
  } = useGemLabels();
  const { formatDate } = useDateFormat();
  const { formatSignedPercent } = useNumberFormat();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const ordered = sortHistoryNewestFirst(history);
  const rows = limit ? ordered.slice(0, limit) : ordered;
  const hasMore = limit !== undefined && ordered.length > limit;

  const toggle = (id: string) =>
    setExpandedId((current) => (current === id ? null : id));

  const columnLabel = (role: GemAssetRole): string =>
    symbolByRole.get(role) ?? roleLabel(role);

  const executedCell = (executed: boolean | null) => {
    if (executed === null) {
      return <GemUnknown label={t("gem.history.executedNotApplicable")} />;
    }
    return (
      <GemBadge tone={executed ? "green" : "gray"}>
        {executed ? t("gem.history.executedYes") : t("gem.history.executedNo")}
      </GemBadge>
    );
  };

  const changeCell = (entry: GemHistoryEntry) => {
    if (!entry.change) {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("gem.history.noChange")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <GemSecurityLink securityId={entry.change.from?.securityId}>
          {historicalAssetLabel(entry.change.from)}
        </GemSecurityLink>
        <ArrowRightIcon className="h-3 w-3 text-gray-400" aria-hidden="true" />
        <span className="sr-only">{t("gem.history.changeTo")}</span>
        <GemSecurityLink
          securityId={entry.change.to?.securityId}
          className="font-medium"
        >
          {historicalAssetLabel(entry.change.to)}
        </GemSecurityLink>
      </span>
    );
  };

  const detail = (entry: GemHistoryEntry) => (
    <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      <div className="flex justify-between gap-3">
        <dt className="text-gray-500 dark:text-gray-400">
          {t("gem.history.colState")}
        </dt>
        <dd>{stateLabel(entry.state)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-gray-500 dark:text-gray-400">
          {t("gem.history.colEffectiveFrom")}
        </dt>
        <dd>{formatDate(entry.effectiveFrom)}</dd>
      </div>
      {GEM_ROLE_ORDER.map((role) => (
        <div key={role} className="flex justify-between gap-3">
          <dt className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
            <GemSwatch colour={GEM_ROLE_COLOURS[role]} />
            {roleLabel(role)}
          </dt>
          <dd className="tabular-nums">
            <GemSigned
              value={entry.momentum[role] ?? null}
              format={(value) => formatSignedPercent(value)}
            />
          </dd>
        </div>
      ))}
      <div className="flex justify-between gap-3">
        <dt className="text-gray-500 dark:text-gray-400">
          {t("gem.history.colChange")}
        </dt>
        <dd>{changeCell(entry)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-gray-500 dark:text-gray-400">
          {t("gem.history.colExecuted")}
        </dt>
        <dd>{executedCell(entry.executed)}</dd>
      </div>
    </dl>
  );

  return (
    <GemCard
      title={t("gem.history.title")}
      hint={t("gem.history.hint")}
      bodyClassName="px-0 pb-0"
    >
      {rows.length === 0 ? (
        <div className="px-4">
          <GemEmptyState
            title={t("gem.history.emptyTitle")}
            description={t("gem.history.emptyDescription")}
          />
        </div>
      ) : (
        <>
          {/* Desktop / tablet: full table with a controlled horizontal scroll. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
              <caption className="sr-only">
                {t("gem.history.caption", { months: lookbackMonths })}
              </caption>
              <thead>
                <tr>
                  <Th scope="col" className="px-4 py-2">
                    {t("gem.history.colEvaluatedOn")}
                  </Th>
                  <Th scope="col" className="px-3 py-2">
                    {t("gem.history.colEffectiveFrom")}
                  </Th>
                  <Th scope="col" className="px-3 py-2">
                    {t("gem.history.colWinner")}
                  </Th>
                  <Th scope="col" className="px-3 py-2">
                    {t("gem.history.colSignal")}
                  </Th>
                  {GEM_ROLE_ORDER.map((role) => (
                    <Th
                      key={role}
                      scope="col"
                      align="right"
                      className="px-3 py-2"
                    >
                      <span className="inline-flex items-center justify-end">
                        {columnLabel(role)}
                        {/* The header is a ticker; the tooltip names the role it
                            fills, as the strategy-assets card does. */}
                        <InfoTooltip
                          text={t("gem.history.colMomentumHint", {
                            role: roleLabel(role),
                            description: roleDescription(role),
                          })}
                          usePortal
                          align="right"
                        />
                      </span>
                    </Th>
                  ))}
                  <Th scope="col" className="px-3 py-2">
                    {t("gem.history.colChange")}
                  </Th>
                  <Th scope="col" className="px-3 py-2">
                    {t("gem.history.colExecuted")}
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                {rows.map((entry) => {
                  const isExpanded = expandedId === entry.id;
                  const Chevron = isExpanded
                    ? ChevronDownIcon
                    : ChevronRightIcon;
                  return (
                    <Fragment key={entry.id}>
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                        <td className="px-4 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => toggle(entry.id)}
                            aria-expanded={isExpanded}
                            // Only while the detail row is in the DOM. The
                            // collapsed row is not rendered, and `aria-controls`
                            // naming an element that is not there sends a screen
                            // reader nowhere -- the same rule `ui/Tabs` states
                            // for an unselected tab's panel.
                            aria-controls={
                              isExpanded
                                ? `gem-history-detail-${entry.id}`
                                : undefined
                            }
                            className="inline-flex items-center gap-1 rounded font-medium text-gray-900 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100 dark:hover:text-blue-400"
                          >
                            <Chevron
                              className="h-3.5 w-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            {formatDate(entry.evaluatedOn)}
                            <span className="sr-only">
                              {t("gem.history.toggleDetails")}
                            </span>
                          </button>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-300">
                          {formatDate(entry.effectiveFrom)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {entry.winner && (
                              <GemSwatch
                                colour={GEM_ROLE_COLOURS[entry.winner.role]}
                              />
                            )}
                            <span className="text-gray-900 dark:text-gray-100">
                              {entry.winner ? (
                                <GemSecurityLink
                                  securityId={entry.winner.securityId}
                                >
                                  {historicalAssetLabel(entry.winner)}
                                </GemSecurityLink>
                              ) : (
                                <GemUnknown />
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <GemBadge
                            tone={entry.state === "RISK_ON" ? "green" : "gray"}
                          >
                            {actionLabel(entry.action)}
                          </GemBadge>
                        </td>
                        {GEM_ROLE_ORDER.map((role) => (
                          <td
                            key={role}
                            className={cn(
                              "px-3 py-2 text-right tabular-nums whitespace-nowrap",
                              entry.winner?.role === role && "font-semibold",
                            )}
                          >
                            <GemSigned
                              value={entry.momentum[role] ?? null}
                              format={(value) => formatSignedPercent(value)}
                            />
                          </td>
                        ))}
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                          {changeCell(entry)}
                        </td>
                        <td className="px-3 py-2">
                          {executedCell(entry.executed)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr
                          id={`gem-history-detail-${entry.id}`}
                          className="bg-gray-50 dark:bg-gray-700/30"
                        >
                          <td
                            colSpan={6 + GEM_ROLE_ORDER.length}
                            className="px-4 py-3"
                          >
                            {detail(entry)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same rows as a list, so no horizontal scrolling is needed. */}
          <ul className="divide-y divide-gray-100 md:hidden dark:divide-gray-700/60">
            {rows.map((entry) => {
              const isExpanded = expandedId === entry.id;
              const Chevron = isExpanded ? ChevronDownIcon : ChevronRightIcon;
              return (
                <li key={entry.id} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(entry.id)}
                    aria-expanded={isExpanded}
                    // As above: the collapsed detail block is not rendered.
                    aria-controls={
                      isExpanded ? `gem-history-mobile-${entry.id}` : undefined
                    }
                    className="flex w-full items-center justify-between gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                        {formatDate(entry.evaluatedOn)}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                        {entry.winner && (
                          <GemSwatch
                            colour={GEM_ROLE_COLOURS[entry.winner.role]}
                          />
                        )}
                        {entry.winner ? (
                          historicalAssetLabel(entry.winner)
                        ) : (
                          <GemUnknown />
                        )}
                        <span aria-hidden="true">&middot;</span>
                        {actionLabel(entry.action)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {executedCell(entry.executed)}
                      <Chevron
                        className="h-4 w-4 text-gray-400"
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                  {isExpanded && (
                    <div id={`gem-history-mobile-${entry.id}`} className="mt-3">
                      {detail(entry)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {hasMore && onShowAll && (
            <div className="border-t border-gray-200 px-4 py-2 text-center dark:border-gray-700">
              <button
                type="button"
                onClick={onShowAll}
                className="rounded text-sm font-medium text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
              >
                {t("gem.history.showAll", { count: ordered.length })}
              </button>
            </div>
          )}
        </>
      )}
    </GemCard>
  );
}
