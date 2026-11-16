"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { investmentsApi, type UnlinkedTransferPair } from "@/lib/investments";
import { createLogger } from "@/lib/logger";

const logger = createLogger("UnlinkedTransfers");

interface UnlinkedTransfersCardProps {
  /** The page's account filter, as it goes to the chart above this card. */
  accountIds?: string[];
  /** Bumped by the page after a write, so the list follows the ledger. */
  reloadKey?: number;
  /** Called after a pairing, so the page re-reads the figures it changed. */
  onLinked?: () => void;
}

/**
 * Share transfers whose two legs the ledger never paired, and the repair.
 *
 * `transferSecurity` writes `linkedTransactionId` on both rows it creates, and
 * the cost-basis replay matches on exactly that: an unpaired TRANSFER_IN cannot
 * take the basis its source released, so that position's cost -- and the gain
 * over it -- reports as unknown. Rows that arrived by import were written
 * independently and carry no pairing at all, which is the state this gets a
 * reader out of.
 *
 * **A suggestion, not a finding.** Two legs on one day, of one security, for
 * the same shares, in opposite directions, on two accounts of the portfolio is
 * strong evidence of one transfer recorded twice -- and it is still the
 * reader's call, so nothing is linked until they say so. Renders nothing at
 * all when there is nothing to suggest: a card explaining that everything is
 * fine is a card in the way.
 */
export function UnlinkedTransfersCard({
  accountIds,
  reloadKey = 0,
  onLinked,
}: UnlinkedTransfersCardProps) {
  const t = useTranslations("investments");
  const { formatShareQuantity } = useNumberFormat();
  const [pairs, setPairs] = useState<UnlinkedTransferPair[] | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountIdsCsv = accountIds?.length ? accountIds.join(",") : "";

  const load = useCallback(() => {
    // The writes live in the inner function so they run after the request,
    // not during the effect that starts it.
    const run = async () => {
      try {
        const found = await investmentsApi.getUnlinkedTransferPairs(
          accountIdsCsv ? accountIdsCsv.split(",") : undefined,
        );
        setPairs(found);
      } catch (err) {
        logger.error("Failed to load unlinked transfers:", err);
        // Nothing is claimed either way: a failed look is not "none found".
        setPairs(null);
      }
    };
    return run();
  }, [accountIdsCsv]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const link = async (pair: UnlinkedTransferPair) => {
    setLinking(pair.out.transactionId);
    setError(null);
    try {
      await investmentsApi.linkTransferPair({
        outTransactionId: pair.out.transactionId,
        inTransactionId: pair.in.transactionId,
      });
      await load();
      onLinked?.();
    } catch (err) {
      logger.error("Failed to link the transfer legs:", err);
      // The server refuses a pair that no longer holds, and says which
      // condition failed; the reader needs that, not a generic failure.
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? t("unlinkedTransfers.linkFailed"),
      );
    } finally {
      setLinking(null);
    }
  };

  if (!pairs || pairs.length === 0) return null;

  return (
    <Card className="p-4" data-testid="unlinked-transfers">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t("unlinkedTransfers.title")}
      </h3>
      <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        {t("unlinkedTransfers.subtitle")}
      </p>
      <ul className="space-y-2">
        {pairs.map((pair) => (
          <li
            key={pair.out.transactionId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-700/40"
          >
            <span className="text-sm text-gray-700 dark:text-gray-200">
              {t("unlinkedTransfers.pair", {
                quantity: formatShareQuantity(pair.quantity),
                security: pair.symbol ?? pair.securityName ?? "",
                date: pair.transactionDate,
                from: pair.out.accountName,
                to: pair.in.accountName,
              })}
            </span>
            <button
              type="button"
              onClick={() => void link(pair)}
              disabled={linking !== null}
              className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 motion-reduce:transition-none"
            >
              {linking === pair.out.transactionId
                ? t("unlinkedTransfers.linking")
                : t("unlinkedTransfers.link")}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p
          role="status"
          className="mt-3 text-xs text-amber-600 dark:text-amber-500"
        >
          {error}
        </p>
      )}
    </Card>
  );
}
