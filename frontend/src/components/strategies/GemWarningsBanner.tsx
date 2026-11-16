"use client";

import { useTranslations } from "next-intl";
import {
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { GemAssetRef, GemWarning, GemWarningCode } from "@/types/gem-strategy";
import { GEM_ROLE_ORDER } from "@/lib/gem-strategy-view";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useGemLabels } from "./useGemLabels";

/**
 * Codes surfaced as a banner. `NO_ACCOUNT` and `NO_POSITION` are intentionally
 * absent: the portfolio and recommendation cards already explain those in place,
 * and repeating them here would say the same thing twice.
 */
const BANNER_CODES: GemWarningCode[] = [
  "SHORT_HISTORY",
  "CALCULATION_FAILED",
  "STALE_PRICES",
  "UNMAPPED_ROLE",
  "INCOMPLETE_HISTORY",
  "LEGACY_PERIODS",
  "FIRST_RUN",
];

const TONES: Record<
  "error" | "warning" | "info",
  { wrapper: string; icon: typeof XCircleIcon }
> = {
  error: {
    wrapper:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-300",
    icon: XCircleIcon,
  },
  warning: {
    wrapper:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-300",
    icon: ExclamationTriangleIcon,
  },
  info: {
    wrapper:
      "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-900/20 dark:text-blue-300",
    icon: InformationCircleIcon,
  },
};

function toneFor(code: GemWarningCode): "error" | "warning" | "info" {
  if (code === "CALCULATION_FAILED" || code === "SHORT_HISTORY") return "error";
  if (code === "FIRST_RUN") return "info";
  return "warning";
}

interface GemWarningsBannerProps {
  warnings: GemWarning[];
  /** Momentum window, named by the incomplete-history warning. */
  lookbackMonths: number;
  /** Role assignments, so SHORT_HISTORY can name the instrument (its symbol). */
  assets: GemAssetRef[];
}

/**
 * Explains why parts of the report may be incomplete -- stale prices, a role
 * with no ETF assigned, missing history, a strategy that has never run. Rendered
 * above the cards so the caveat is read before the numbers.
 */
export function GemWarningsBanner({
  warnings,
  lookbackMonths,
  assets,
}: GemWarningsBannerProps) {
  const t = useTranslations("strategies");
  const { roleLabel } = useGemLabels();
  const { formatDate } = useDateFormat();

  const symbolByRole = new Map(assets.map((asset) => [asset.role, asset.symbol]));

  const shown = BANNER_CODES.flatMap((code) =>
    warnings.filter((warning) => warning.code === code),
  );
  if (shown.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      {shown.map((warning, index) => {
        const tone = TONES[toneFor(warning.code)];
        const Icon = tone.icon;
        // Listed in strategy order, whatever order the server sent them in.
        const roles = GEM_ROLE_ORDER.filter((role) =>
          (warning.roles ?? []).includes(role),
        );
        const isAlert =
          warning.code === "CALCULATION_FAILED" ||
          warning.code === "SHORT_HISTORY";
        return (
          <div
            key={`${warning.code}-${index}`}
            role={isAlert ? "alert" : "status"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tone.wrapper}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {warning.code === "SHORT_HISTORY" ? (
              // Names the instrument (role plus its symbol) and the date its
              // prices must reach back to, then how to fix it -- the security
              // page's "add another year of price history" control.
              <div>
                <p>
                  {t("gem.warnings.SHORT_HISTORY", {
                    from: warning.requiredFrom
                      ? formatDate(warning.requiredFrom)
                      : "",
                  })}
                  {roles.length > 0 && (
                    <span className="font-medium">
                      {" "}
                      {roles
                        .map((role) => {
                          const symbol = symbolByRole.get(role);
                          return symbol
                            ? `${roleLabel(role)} (${symbol})`
                            : roleLabel(role);
                        })
                        .join(", ")}
                    </span>
                  )}
                </p>
                <p className="mt-1">{t("gem.warnings.shortHistoryFix")}</p>
              </div>
            ) : (
              <p>
                {t(`gem.warnings.${warning.code}` as Parameters<typeof t>[0], {
                  months: lookbackMonths,
                  count: warning.count ?? 0,
                })}
                {roles.length > 0 && (
                  <span className="font-medium">
                    {" "}
                    {roles.map((role) => roleLabel(role)).join(", ")}
                  </span>
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
