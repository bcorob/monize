"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useFinancialToday } from "@/hooks/useFinancialToday";
import { useReportData } from "@/hooks/useReportData";
import { BOND_OFFER_COUNTRY, isHttpsUrl } from "@/lib/bond-offer";
import { getErrorMessage } from "@/lib/errors";
import { investmentsApi } from "@/lib/investments";
import { cn } from "@/lib/utils";
import type { Security } from "@/types/investment";
import type {
  BondOffer,
  BondTermsSource,
  SecurityBondValuation,
} from "@/types/bond";

interface SecurityIssueLettersProps {
  /**
   * Bumped by the page each time a price refresh completes (whatever its
   * outcome): the bond data the refresh fetched is re-read once, in place.
   */
  refreshVersion?: number;
  security: Security;
  className?: string;
}

interface LetterRow {
  instrumentId: string;
  seriesCode: string;
  held: boolean;
  /** Null when the series carries no source (an older payload). */
  source: BondTermsSource | null;
}

/**
 * The issue letters of a bond-linked security: one row per series the reader
 * holds, then the series on sale now that is not held, each with the official
 * document its stored terms were read from. Nothing is downloaded or stored;
 * the row is a link to the issuer's PDF.
 *
 * The holdings come from the valuation endpoint and the on-sale series from the
 * offer endpoint, the two reads the Breakdown card already makes. They are read
 * again here because that card keeps its payloads private, and sharing them
 * would mean lifting both requests into the page.
 */
export function SecurityIssueLetters({
  security,
  className,
  refreshVersion = 0,
}: SecurityIssueLettersProps) {
  const t = useTranslations("securityDetail");
  const today = useFinancialToday();

  const requestKey = `${security.id}|${today}`;
  const valuationRequest = useReportData<SecurityBondValuation>(
    () => investmentsApi.getSecurityBondValuation(security.id, today),
    [security.id, today, refreshVersion],
    { requestKey },
  );
  const valuation =
    valuationRequest.data !== null && valuationRequest.dataKey === requestKey
      ? valuationRequest.data
      : null;

  const countryCode =
    valuation?.program.issuerCountryCode ?? BOND_OFFER_COUNTRY;
  const offerRequest = useReportData<BondOffer>(
    () => investmentsApi.getBondOffer(countryCode),
    [countryCode, refreshVersion],
  );
  const offer = offerRequest.data;

  const rows = useMemo<LetterRow[]>(() => {
    if (!valuation) return [];
    const held: LetterRow[] = valuation.series.map((s) => ({
      instrumentId: s.instrumentId,
      seriesCode: s.seriesCode,
      held: true,
      source: s.termsSource ?? null,
    }));
    const heldIds = new Set(held.map((r) => r.instrumentId));
    const onSale: LetterRow[] = (offer?.series ?? [])
      .filter(
        (s) =>
          s.programCode === valuation.program.programCode &&
          !heldIds.has(s.instrumentId),
      )
      .sort((a, b) => b.saleWindow.from.localeCompare(a.saleWindow.from))
      .map((s) => ({
        instrumentId: s.instrumentId,
        seriesCode: s.seriesCode,
        held: false,
        source: s.termsSource,
      }));
    return [...held, ...onSale];
  }, [valuation, offer]);

  const renderLetter = (row: LetterRow) => {
    const { source } = row;
    if (source === null) {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("documents.issueLetters.noLetter")}
        </span>
      );
    }
    if (source.provider === "manual") {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("bond.termsManual")}
        </span>
      );
    }
    const label = t("bond.termsSource", { document: source.document });
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-gray-700 dark:text-gray-300">{label}</span>
        {isHttpsUrl(source.url) && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("documents.issueLetters.openNamed", {
              series: row.seriesCode,
            })}
            className="inline-flex items-center gap-1 rounded text-sm font-medium text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          >
            <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
            {t("documents.issueLetters.open")}
          </a>
        )}
      </span>
    );
  };

  const renderBody = () => {
    // A failed read is not an empty list: say it failed rather than "none stored".
    const error = valuationRequest.error ?? offerRequest.error;
    if (valuationRequest.error) {
      return (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(
            valuationRequest.error,
            t("documents.issueLetters.loadFailed"),
          )}
        </p>
      );
    }
    if (!valuation || (offerRequest.isLoading && offer === null && !error)) {
      return (
        <div className="flex justify-center py-4">
          <LoadingSpinner text={t("bond.loading")} />
        </div>
      );
    }
    return (
      <>
        {offerRequest.error && (
          <p
            role="alert"
            className="mb-3 text-sm text-red-600 dark:text-red-400"
          >
            {getErrorMessage(
              offerRequest.error,
              t("documents.issueLetters.loadFailed"),
            )}
          </p>
        )}
        {rows.length === 0 ? (
          !offerRequest.error && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("documents.issueLetters.empty")}
            </p>
          )
        ) : (
          <ul>
            {rows.map((row) => (
              <li
                key={row.instrumentId}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-200 py-2 text-sm first:border-t-0 dark:border-gray-700"
              >
                <span className="w-28 shrink-0 font-medium text-gray-900 dark:text-gray-100">
                  {row.seriesCode}
                </span>
                <Badge variant={row.held ? "blue" : "green"}>
                  {row.held
                    ? t("documents.issueLetters.held")
                    : t("documents.issueLetters.onSale")}
                </Badge>
                {renderLetter(row)}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <Card
      as="section"
      aria-label={t("documents.issueLetters.title")}
      className={cn("p-4", className)}
    >
      <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t("documents.issueLetters.title")}
      </h3>
      {renderBody()}
    </Card>
  );
}
