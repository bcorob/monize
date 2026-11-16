"use client";

import { useTranslations } from "next-intl";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/Button";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { GemAction } from "@/types/gem-strategy";
import { isKnown } from "@/lib/gem-strategy-view";
import {
  GemAccountLinks,
  GemCard,
  GemSecurityLink,
  GemSigned,
  GemStatRow,
  GemUnknown,
} from "./GemPrimitives";
import { useGemLabels } from "./useGemLabels";

interface GemNextActionCardProps {
  action: GemAction | null;
  /** True when the report has no signal at all (first run, failed calculation). */
  signalUnavailable: boolean;
  /** True when the strategy has no account, so there is no portfolio to act on. */
  noAccount?: boolean;
  onMarkExecuted: () => void;
  onAddTransactions: () => void;
  isSaving: boolean;
}

/**
 * Question 4 of the report: what should I do now? Either one concrete operation
 * (sell X, buy Y, with the server's value and cost estimates) or the positive
 * "nothing to do" state -- never an empty form or a button implying a trade the
 * strategy is not asking for.
 */
export function GemNextActionCard({
  action,
  signalUnavailable,
  noAccount = false,
  onMarkExecuted,
  onAddTransactions,
  isSaving,
}: GemNextActionCardProps) {
  const t = useTranslations("strategies");
  const { assetFullLabel } = useGemLabels();
  const { formatCurrency, formatQuantity } = useNumberFormat();

  if (signalUnavailable) {
    return (
      <GemCard title={t("gem.action.title")} hint={t("gem.action.hint")}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("gem.action.signalUnavailable")}
        </p>
      </GemCard>
    );
  }

  // No account is not compliance. `action` is null in both states, and
  // falling through to "your portfolio matches the strategy" told a user with
  // nothing assigned that there was nothing to do.
  if (noAccount) {
    return (
      <GemCard title={t("gem.action.title")} hint={t("gem.action.hint")}>
        <p className="font-medium text-gray-900 dark:text-gray-100">
          {t("gem.portfolio.noAccountTitle")}
        </p>
        <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
          {t("gem.portfolio.noAccountDescription")}
        </p>
      </GemCard>
    );
  }

  if (!action || !action.required) {
    return (
      <GemCard title={t("gem.action.title")} hint={t("gem.action.hint")}>
        <div className="flex items-start gap-2">
          <CheckCircleIcon
            className="mt-0.5 h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {t("gem.action.compliantTitle")}
            </p>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {t("gem.action.compliantDescription")}
            </p>
          </div>
        </div>
      </GemCard>
    );
  }

  const currency = action.currencyCode;

  return (
    <GemCard
      title={t("gem.action.title")}
      hint={t("gem.action.hint")}
      headerRight={
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t("gem.action.signalChanged")}
        </span>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2">
        <div className="min-w-0">
          {/* "Sell", not "current instrument". The operation sells every
              position that is not the target, and naming only the largest
              described a four-fund portfolio as though it were in one of them
              -- while the three the user also has to sell went unnamed. */}
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t("gem.action.sellLabel", { count: action.sellPositions.length })}
          </p>
          {action.sellPositions.length === 0 ? (
            // Spelled out, not dashed: a cash-funded purchase sells nothing,
            // which is a fact about the operation and not a value the server
            // failed to supply.
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("gem.action.nothingToSell")}
            </p>
          ) : (
            <ul className="scrollbar-slim max-h-32 space-y-1 overflow-y-auto pr-1">
              {action.sellPositions.map((position) => (
                <li key={position.securityId ?? position.symbol}>
                  <p className="text-sm font-medium break-words text-gray-900 dark:text-gray-100">
                    <GemSecurityLink securityId={position.securityId}>
                      {assetFullLabel(position)}
                    </GemSecurityLink>
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {isKnown(position.marketValue) ? (
                      formatCurrency(position.marketValue, currency)
                    ) : (
                      <GemUnknown />
                    )}
                    {isKnown(position.quantity) &&
                      ` · ${t("gem.action.units", {
                        units: formatQuantity(position.quantity),
                      })}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* The arrow is decorative; the transition is announced as text. */}
        <span className="mt-5 flex shrink-0 items-center">
          <ArrowRightIcon
            className="h-4 w-4 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <span className="sr-only">{t("gem.action.arrowAriaLabel")}</span>
        </span>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t("gem.action.buyLabel")}
          </p>
          <p className="text-sm font-medium break-words text-gray-900 dark:text-gray-100">
            {action.to ? (
              <GemSecurityLink securityId={action.to.securityId}>
                {assetFullLabel(action.to)}
              </GemSecurityLink>
            ) : (
              <GemUnknown />
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("gem.action.targetWeight", {
              weight: action.targetWeightPercent,
            })}
          </p>
        </div>
      </div>

      <dl className="mt-3 space-y-1 border-t border-gray-200 pt-3 dark:border-gray-700">
        <GemStatRow
          label={t("gem.action.transferValue")}
          value={
            isKnown(action.transferValue) ? (
              formatCurrency(action.transferValue, currency)
            ) : (
              <GemUnknown />
            )
          }
        />
        <GemStatRow
          label={t("gem.action.realized")}
          value={
            <GemSigned
              value={action.realizedGainLoss}
              format={(value) =>
                `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value), currency)}`
              }
            />
          }
        />
        {/* Shown whenever a rate is configured: an estimate that could not be
            made is a dash, not an absent row. See GemTransferCard. */}
        {isKnown(action.taxRatePercent) && (
          <GemStatRow
            label={t("gem.action.taxWithRate", { rate: action.taxRatePercent })}
            value={
              isKnown(action.estimatedTax) ? (
                formatCurrency(action.estimatedTax, currency)
              ) : (
                <GemUnknown label={t("gem.action.taxUnknown")} />
              )
            }
          />
        )}
        {isKnown(action.estimatedCommission) && (
          <GemStatRow
            label={t("gem.action.commissionForTrades", {
              trades: action.estimatedTradeCount,
            })}
            value={formatCurrency(action.estimatedCommission, currency)}
          />
        )}
        <GemStatRow
          label={t("gem.action.accounts")}
          value={
            action.accounts.length > 0 ? (
              <GemAccountLinks accounts={action.accounts} />
            ) : (
              <GemUnknown />
            )
          }
        />
      </dl>

      {/* Reaching here means an operation is required. "Executed" is recorded
          against the signal, but what has to be done is recomputed from the
          accounts every time, so the two can disagree: the trades may not have
          settled yet, or money may have arrived since. Saying only "marked as
          executed" hid a live instruction behind a tick; both facts are shown
          instead, with the way to resolve either of them. */}
      {action.executed ? (
        <>
          <p className="mt-3 flex items-start gap-1.5 text-sm text-gray-500 dark:text-gray-400">
            <CheckCircleIcon
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            {t("gem.action.executedButChanged")}
          </p>
          <div className="mt-3">
            <Button variant="outline" onClick={onAddTransactions} className="gap-1.5">
              <PlusIcon className="h-4 w-4" aria-hidden="true" />
              {t("gem.action.addTransactions")}
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Button onClick={onMarkExecuted} isLoading={isSaving} className="gap-1.5">
            <CheckIcon className="h-4 w-4" aria-hidden="true" />
            {t("gem.action.markExecuted")}
          </Button>
          <Button variant="outline" onClick={onAddTransactions} className="gap-1.5">
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            {t("gem.action.addTransactions")}
          </Button>
        </div>
      )}
    </GemCard>
  );
}
